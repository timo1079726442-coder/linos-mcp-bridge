/**
 * shadcn-registry — 官方 shadcn Registry 的只读检索/查看 + 暂存式安装。
 *
 * 边界：
 * - 只访问固定官方地址（index 与 styles 两个官方路径），不接收自定义 registry URL；
 * - 不执行 npx/npm、不安装依赖；add 的真实安装只是把官方源码**暂存**成待本机批准的写入，
 *   commit 时才落盘，且不执行任何脚本；
 * - 网络失败、内容超限、类型不符都明确失败，不伪造成功；
 * - 返回的 registry 元数据一律视为不可信输入，只做字段白名单与长度截断。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { McpSecurityError, type McpSecurityBoundary } from "./security-boundary.js";
import { prepareStagedFiles, type WriteContext } from "./write-operations.js";

const INDEX_URL = "https://ui.shadcn.com/r/index.json";
const ITEM_BASE = "https://ui.shadcn.com/r/styles";
const CACHE_MS = 10 * 60 * 1000;
const MAX_BYTES = 350_000;
const MAX_ITEM_BYTES = 512 * 1024;
const MAX_CONFIG_BYTES = 12_000;
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_QUERY = /^[a-zA-Z0-9 _-]{0,60}$/;
const SAFE_DEP = /^(?:@[-a-z0-9_.]+\/)?[-a-z0-9_.]+(?:@[-a-z0-9._^~]+)?$/i;
const SECRETISH = /(?:cookie|authorization|bearer|password|secret|token|api[_-]?key)/i;
const TEMPLATES = ["next", "vite", "start", "react-router", "laravel", "astro"] as const;

export class ShadcnError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ShadcnError";
  }
}

export interface RegistryItem {
  name: string;
  type: string;
  title: string;
  description: string;
  docsUrl: string | null;
  registryDependencies: string[];
  dependencies: string[];
  fileCount: number;
  fileNames: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max = 160): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (SECRETISH.test(cleaned) || /[a-f0-9]{48,}/i.test(cleaned)) return "[已隐藏]";
  return cleaned.slice(0, max);
}

function parseRegistry(data: unknown): RegistryItem[] {
  if (!Array.isArray(data) || data.length < 1 || data.length > 1000) {
    throw new ShadcnError("OFFICIAL_REGISTRY_INVALID");
  }
  const items: RegistryItem[] = [];
  for (const raw of data) {
    if (!record(raw) || typeof raw.name !== "string" || !SAFE_COMPONENT.test(raw.name)
      || typeof raw.type !== "string" || !/^registry:[a-z]+$/.test(raw.type)) continue;
    const meta = record(raw.meta) ? raw.meta : null;
    const links = meta && record(meta.links) ? meta.links : null;
    const docs = links
      ? ["radix", "base", "aria"].map((key) => {
        const link = links[key];
        return record(link) ? link.docs : null;
      }).find((value): value is string => typeof value === "string" && value.startsWith("https://ui.shadcn.com/docs/"))
      : null;
    const dependencies = Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((value): value is string =>
        typeof value === "string" && value.length < 80 && SAFE_DEP.test(value)).slice(0, 25)
      : [];
    const registryDependencies = Array.isArray(raw.registryDependencies)
      ? raw.registryDependencies.filter((value): value is string =>
        typeof value === "string" && SAFE_COMPONENT.test(value)).slice(0, 25)
      : [];
    const files = Array.isArray(raw.files) ? raw.files.slice(0, 50) : [];
    const fileNames = files.map((file) => record(file) && typeof file.path === "string"
      ? path.posix.basename(file.path.replace(/\\/g, "/"))
      : "").filter((name) => /^[a-z0-9][a-z0-9_.-]{0,80}$/i.test(name));
    items.push({
      name: raw.name,
      type: raw.type,
      title: safeText(raw.title) || raw.name,
      description: safeText(raw.description, 240),
      docsUrl: typeof docs === "string" ? docs : null,
      registryDependencies,
      dependencies,
      fileCount: files.length,
      fileNames,
    });
  }
  if (items.length === 0) throw new ShadcnError("OFFICIAL_REGISTRY_INVALID");
  return items;
}

export interface RegistryFile {
  path: string;
  content: string;
}

export interface RegistryItemDetail {
  name: string;
  type: string;
  dependencies: string[];
  registryDependencies: string[];
  files: RegistryFile[];
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  tooLargeCode: string,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new ShadcnError(tooLargeCode);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function parseRegistryItem(data: unknown, expectedName: string): RegistryItemDetail {
  if (!record(data) || data.name !== expectedName || typeof data.type !== "string"
    || !/^registry:[a-z]+$/.test(data.type)) {
    throw new ShadcnError("OFFICIAL_REGISTRY_INVALID");
  }
  if (!Array.isArray(data.files) || data.files.length < 1 || data.files.length > 30) {
    throw new ShadcnError("OFFICIAL_REGISTRY_INVALID");
  }
  const files: RegistryFile[] = [];
  let total = 0;
  for (const raw of data.files) {
    if (!record(raw) || typeof raw.path !== "string" || typeof raw.content !== "string") {
      throw new ShadcnError("OFFICIAL_REGISTRY_INVALID");
    }
    const relative = raw.path.replaceAll("\\", "/");
    if (!/^[A-Za-z0-9_./-]{1,200}$/.test(relative) || relative.includes("..")) {
      throw new ShadcnError("OFFICIAL_REGISTRY_INVALID");
    }
    if (raw.content.includes("\0")) throw new ShadcnError("OFFICIAL_REGISTRY_INVALID");
    total += Buffer.byteLength(raw.content, "utf8");
    if (total > MAX_ITEM_BYTES) throw new ShadcnError("OFFICIAL_REGISTRY_TOO_LARGE");
    files.push({ path: relative, content: raw.content });
  }
  const dependencies = Array.isArray(data.dependencies)
    ? data.dependencies.filter((value): value is string =>
      typeof value === "string" && value.length < 80 && SAFE_DEP.test(value)).slice(0, 25)
    : [];
  const registryDependencies = Array.isArray(data.registryDependencies)
    ? data.registryDependencies.filter((value): value is string =>
      typeof value === "string" && SAFE_COMPONENT.test(value)).slice(0, 25)
    : [];
  return { name: expectedName, type: data.type, dependencies, registryDependencies, files };
}

/** 优先用项目 style；v4 项目（tailwind>=4）优先试 <style>-v4。 */
export function shadcnStylesFor(style: string | null, preferV4: boolean): string[] {
  const base = typeof style === "string" && /^[a-z0-9-]{1,40}$/.test(style) ? style : "new-york";
  const list = preferV4 ? [`${base}-v4`, base] : [base, `${base}-v4`];
  list.push("new-york-v4", "default");
  return [...new Set(list)];
}

export async function resolveShadcnItems(
  catalog: Pick<ShadcnCatalog, "item">,
  names: string[],
  styles: string[],
): Promise<{ items: RegistryItemDetail[]; styleUsed: string }> {
  const seen = new Set<string>();
  const queue = [...names];
  const items: RegistryItemDetail[] = [];
  let styleUsed = styles[0]!;
  while (queue.length > 0) {
    if (items.length >= 10) throw new ShadcnError("SHADCN_TOO_MANY_ITEMS");
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    if (!SAFE_COMPONENT.test(name)) throw new ShadcnError("INVALID_COMPONENTS");
    seen.add(name);
    const resolved = await catalog.item(name, styles);
    styleUsed = resolved.style;
    items.push(resolved.item);
    for (const dependency of resolved.item.registryDependencies) {
      if (!seen.has(dependency)) queue.push(dependency);
    }
  }
  return { items, styleUsed };
}

async function readPackageDependencies(
  boundary: McpSecurityBoundary,
  projectRelative: string,
): Promise<Set<string>> {
  const relative = projectRelative === "." ? "package.json" : `${projectRelative}/package.json`;
  const resolved = await boundary.resolveWorkspacePath(relative).catch(() => null);
  if (!resolved || resolved.sensitive) return new Set();
  try {
    const stat = await fs.stat(resolved.absolute);
    if (!stat.isFile() || stat.size > 128 * 1024) return new Set();
    const parsed = JSON.parse(await fs.readFile(resolved.absolute, "utf8")) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies"]) {
      const block = record(parsed[key]) ? parsed[key] as Record<string, unknown> : {};
      for (const name of Object.keys(block)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("@");
    return parts.slice(0, 2).join("@");
  }
  return specifier.split("@")[0]!;
}

/** 把 registry 里的文件路径映射到项目 alias 目录；不允许越界。 */
export function mapShadcnFile(
  registryPath: string,
  config: ComponentsConfig,
  projectRelative: string,
  rootReal: string,
): string {
  const normalized = registryPath.replaceAll("\\", "/");
  const baseName = path.posix.basename(normalized);
  if (!/^[a-z0-9][a-z0-9_.-]{0,80}$/i.test(baseName) || !/\.(tsx|ts|jsx|js|css)$/i.test(baseName)) {
    throw new ShadcnError("SHADCN_FILE_PATH_UNSUPPORTED");
  }
  let base: string;
  if (/(^|\/)ui\//.test(normalized)) {
    base = config.aliases.ui ?? "components/ui";
  } else if (/(^|\/)lib\//.test(normalized)) {
    const utils = config.aliases.utils;
    base = utils ? path.posix.dirname(utils) : (config.aliases.lib ?? "lib");
    if (base === ".") base = "lib";
  } else if (/(^|\/)hooks\//.test(normalized)) {
    base = config.aliases.hooks ?? "hooks";
  } else {
    throw new ShadcnError("SHADCN_FILE_PATH_UNSUPPORTED");
  }
  const prefix = projectRelative === "." ? "" : `${projectRelative}/`;
  const relative = path.posix.normalize(path.posix.join(prefix, base, baseName));
  const within = path.relative(rootReal, path.resolve(rootReal, relative));
  if (within.startsWith("..") || path.isAbsolute(within)) throw new ShadcnError("SHADCN_FILE_PATH_UNSUPPORTED");
  return relative;
}

export class ShadcnCatalog {
  private cached: { at: number; items: RegistryItem[] } | null = null;

  constructor(private readonly request: typeof fetch = fetch) {}

  private async load(): Promise<RegistryItem[]> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.items;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7_000);
    try {
      const response = await this.request(INDEX_URL, {
        signal: controller.signal,
        redirect: "error",
        headers: { accept: "application/json" },
      });
      if (!response.ok || response.url !== INDEX_URL
        || !(response.headers.get("content-type") ?? "").includes("application/json")
        || Number(response.headers.get("content-length") ?? 0) > MAX_BYTES
        || !response.body) {
        throw new ShadcnError("OFFICIAL_REGISTRY_UNAVAILABLE");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > MAX_BYTES) throw new ShadcnError("OFFICIAL_REGISTRY_TOO_LARGE");
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      const items = parseRegistry(parsed);
      this.cached = { at: Date.now(), items };
      return items;
    } catch (error: unknown) {
      if (error instanceof ShadcnError) throw error;
      throw new ShadcnError("OFFICIAL_REGISTRY_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }

  async search(args: { query?: unknown; limit?: unknown; offset?: unknown }): Promise<Record<string, unknown>> {
    const query = args.query === undefined || args.query === null ? "" : args.query;
    if (typeof query !== "string" || !SAFE_QUERY.test(query) || SECRETISH.test(query)) {
      throw new ShadcnError("INVALID_SEARCH_QUERY");
    }
    const limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ShadcnError("INVALID_SEARCH_LIMIT");
    }
    const offset = args.offset === undefined ? 0 : args.offset;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 5000) {
      throw new ShadcnError("INVALID_SEARCH_OFFSET");
    }
    const all = await this.load();
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? all.filter((item) => item.name.includes(needle) || item.title.toLowerCase().includes(needle))
      : all;
    const results = filtered.slice(offset, offset + limit).map((item) => ({
      name: item.name,
      title: item.title,
      type: item.type,
      description: item.description,
      docs_url: item.docsUrl,
    }));
    return {
      registry: "@shadcn",
      source: INDEX_URL,
      query: needle,
      results,
      total: filtered.length,
      offset,
      limit,
      has_more: offset + limit < filtered.length,
      read_only: true,
      untrusted_registry_metadata: true,
    };
  }

  async view(items: unknown): Promise<Record<string, unknown>> {
    if (!Array.isArray(items) || items.length < 1 || items.length > 12
      || items.some((item) => typeof item !== "string" || !SAFE_COMPONENT.test(item))) {
      throw new ShadcnError("INVALID_REGISTRY_ITEMS");
    }
    const all = await this.load();
    const byName = new Map(all.map((item) => [item.name, item]));
    if (items.some((item) => !byName.has(item))) throw new ShadcnError("OFFICIAL_REGISTRY_ITEM_NOT_FOUND");
    return {
      registry: "@shadcn",
      source: INDEX_URL,
      items: items.map((item) => ({ ...byName.get(item)! })),
      metadata_only: true,
      includes_component_source: false,
      read_only: true,
      installation_performed: false,
      note: "只显示官方组件的结构、依赖与文档，不返回可执行组件源码，也不会安装。",
    };
  }

  /** 取某个组件的官方源码（固定官方地址；只用于已暂存、待本机批准的写入）。 */
  async item(name: string, styles: string[]): Promise<{ item: RegistryItemDetail; style: string }> {
    if (typeof name !== "string" || !SAFE_COMPONENT.test(name)) throw new ShadcnError("INVALID_REGISTRY_ITEMS");
    if (!Array.isArray(styles) || styles.length < 1 || styles.length > 6) throw new ShadcnError("OFFICIAL_REGISTRY_UNAVAILABLE");
    for (const style of styles) {
      if (!/^[a-z0-9-]{1,40}$/.test(style)) continue;
      const cached = this.itemCache.get(`${style}:${name}`);
      if (cached && Date.now() - cached.at < CACHE_MS) return { item: cached.item, style };
      const url = `${ITEM_BASE}/${style}/${name}.json`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7_000);
      try {
        const response = await this.request(url, {
          signal: controller.signal,
          redirect: "error",
          headers: { accept: "application/json" },
        });
        if (response.status === 404) continue;
        if (!response.ok || response.url !== url
          || !(response.headers.get("content-type") ?? "").includes("application/json")
          || Number(response.headers.get("content-length") ?? 0) > MAX_ITEM_BYTES
          || !response.body) {
          throw new ShadcnError("OFFICIAL_REGISTRY_UNAVAILABLE");
        }
        const text = await readBoundedBody(response.body, MAX_ITEM_BYTES, "OFFICIAL_REGISTRY_TOO_LARGE");
        const item = parseRegistryItem(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(text)), name);
        this.itemCache.set(`${style}:${name}`, { at: Date.now(), item });
        return { item, style };
      } catch (error: unknown) {
        if (error instanceof ShadcnError) throw error;
        throw new ShadcnError("OFFICIAL_REGISTRY_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ShadcnError("OFFICIAL_REGISTRY_ITEM_NOT_FOUND");
  }

  private readonly itemCache = new Map<string, { at: number; item: RegistryItemDetail }>();
}

let sharedCatalog: ShadcnCatalog | null = null;

export function getShadcnCatalog(): ShadcnCatalog {
  if (!sharedCatalog) sharedCatalog = new ShadcnCatalog();
  return sharedCatalog;
}

interface ComponentsConfig {
  configured: boolean;
  style: string | null;
  tsx: boolean;
  aliases: { ui: string | null; utils: string | null; hooks: string | null; lib: string | null };
}

async function readComponentsConfig(boundary: McpSecurityBoundary, projectRelative: string): Promise<ComponentsConfig> {
  const file = projectRelative === "." ? "components.json" : `${projectRelative}/components.json`;
  let resolved;
  try {
    resolved = await boundary.resolveWorkspacePath(file);
  } catch (error: unknown) {
    if (error instanceof McpSecurityError && error.code === "path_not_found") {
      return { configured: false, style: null, tsx: false, aliases: { ui: null, utils: null, hooks: null, lib: null } };
    }
    throw new ShadcnError("PROJECT_CONFIG_UNAVAILABLE");
  }
  if (resolved.sensitive) throw new ShadcnError("PROJECT_CONFIG_UNAVAILABLE");
  let raw: string;
  try {
    const stat = await fs.stat(resolved.absolute);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new ShadcnError("PROJECT_CONFIG_TOO_LARGE");
    raw = await fs.readFile(resolved.absolute, "utf8");
  } catch (error: unknown) {
    if (error instanceof ShadcnError) throw error;
    throw new ShadcnError("PROJECT_CONFIG_UNAVAILABLE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShadcnError("PROJECT_CONFIG_INVALID");
  }
  if (!record(parsed)) throw new ShadcnError("PROJECT_CONFIG_INVALID");
  const aliases = record(parsed.aliases) ? parsed.aliases : null;
  const aliasOf = (key: string): string | null => {
    const value = aliases?.[key];
    if (typeof value !== "string" || value.length > 120) return null;
    if (!/^(?:@\/|~\/|\.\/|src\/)/.test(value)) return null;
    return value.replace(/^(?:@\/|~\/|\.\/)/, "").replace(/\/+$/, "") || null;
  };
  return {
    configured: true,
    style: safeText(parsed.style, 40) || null,
    tsx: parsed.tsx === true,
    aliases: { ui: aliasOf("ui"), utils: aliasOf("utils"), hooks: aliasOf("hooks"), lib: aliasOf("lib") },
  };
}

async function resolveProject(boundary: McpSecurityBoundary, cwd: unknown): Promise<{ relative: string; absolute: string }> {
  if (cwd !== undefined && typeof cwd !== "string") throw new ShadcnError("PROJECT_PATH_NOT_ALLOWED");
  const input = typeof cwd === "string" && cwd !== "" ? cwd : ".";
  if (input.length > 180 || input.includes("\0") || /^[a-z]:[\\/]/i.test(input)
    || input.startsWith("/") || input.startsWith("\\")) {
    throw new ShadcnError("PROJECT_PATH_NOT_ALLOWED");
  }
  let resolved;
  try {
    resolved = await boundary.resolveWorkspacePath(input);
  } catch {
    throw new ShadcnError("PROJECT_PATH_NOT_ALLOWED");
  }
  if (resolved.sensitive) throw new ShadcnError("PROJECT_PATH_NOT_ALLOWED");
  const stat = await fs.stat(resolved.absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new ShadcnError("PROJECT_NOT_DIRECTORY");
  return { relative: resolved.relative, absolute: resolved.absolute };
}

async function targetState(absolute: string): Promise<{ exists: boolean; safe: boolean; kind: string }> {
  try {
    const stat = await fs.lstat(absolute);
    return {
      exists: true,
      safe: stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "unsafe",
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { exists: false, safe: true, kind: "missing" };
    throw new ShadcnError("PROJECT_IO_UNAVAILABLE");
  }
}

/**
 * shadcn_add 预演：只给候选目标、依赖与风险，不下载源码、不写文件。
 * `dry_run:false` 明确失败——真实安装需要独立的本机批准与安全 Writer。
 */
export async function planShadcnAdd(
  ctx: WriteContext,
  args: Record<string, unknown>,
  catalog: ShadcnCatalog = getShadcnCatalog(),
): Promise<Record<string, unknown>> {
  const boundary = ctx.boundary;
  const components = args.components;
  if (!Array.isArray(components) || components.length < 1 || components.length > 12
    || components.some((name) => typeof name !== "string" || !SAFE_COMPONENT.test(name))
    || new Set(components).size !== components.length) {
    throw new ShadcnError("INVALID_COMPONENTS");
  }
  const project = await resolveProject(boundary, args.cwd);
  const config = await readComponentsConfig(boundary, project.relative);
  if (!config.configured) throw new ShadcnError("SHADCN_NOT_INITIALIZED");
  const dryRun = args.dry_run !== false;

  if (dryRun) {
    const official = await catalog.view(components) as { items: RegistryItem[] };
    const uiBase = (config.aliases.ui ?? "components/ui").replaceAll("\\", "/").replace(/^\/+/, "");
    const projectPrefix = project.relative === "." ? "" : `${project.relative}/`;
    const candidates: string[] = [];
    for (const item of official.items) {
      for (const fileName of item.fileNames) {
        if (!/^[a-z0-9_.-]{1,80}$/i.test(fileName)) continue;
        const relative = path.posix.normalize(path.posix.join(projectPrefix, uiBase, fileName));
        // components.json 里的 alias 可能是 "../x"：只接受仍落在工作区内的候选。
        const within = path.relative(boundary.rootReal, path.resolve(boundary.rootReal, relative));
        if (within.startsWith("..") || path.isAbsolute(within)) throw new ShadcnError("PROJECT_PATH_NOT_ALLOWED");
        candidates.push(relative);
      }
    }
    const targets = [];
    for (const relative of [...new Set(candidates)]) {
      const absolute = path.resolve(boundary.rootReal, relative);
      const state = await targetState(absolute);
      targets.push({
        relative_path: relative,
        already_exists: state.exists,
        safe: state.safe,
        requires_manual_review: state.exists || !state.safe,
        exact_cli_target_unverified: true,
      });
    }
    return {
      status: "DRY_RUN_ONLY",
      operation: "shadcn_add",
      workspace_id: ctx.workspaceId,
      cwd: project.relative,
      requested_components: [...components],
      registry: "@shadcn",
      installed: false,
      files_changed: 0,
      commands_executed: 0,
      package_downloads: 0,
      overwrite_requested: args.overwrite === true,
      overwrite_authorized: false,
      components: official.items.map((item) => ({
        name: item.name,
        dependencies: item.dependencies,
        registry_dependencies: item.registryDependencies,
        registry_file_names: item.fileNames,
        source_reviewed: false,
      })),
      candidate_targets: targets,
      plan_accuracy: "REGISTRY_METADATA_ONLY_NOT_OFFICIAL_CLI_DIFF",
      warnings: [
        "需要审查依赖许可证、版本兼容性与实际 CLI 安装路径",
        "这不是官方 CLI dry-run，未读取完整组件源码或 lockfile",
        ...(targets.some((target) => target.already_exists) ? ["发现候选同名文件，禁止自动覆盖"] : []),
      ],
      note: "预演不会下载源码或写文件；dry_run:false 会把官方组件源码暂存为待本机批准的操作。",
      required_before_execution: "commit_operation",
    };
  }

  // 真实安装：只抓官方源码并“暂存”，本机确认后才落盘；不执行 npm install。
  const preferV4 = await detectTailwindV4(boundary, project.relative);
  const styles = shadcnStylesFor(config.style, preferV4);
  const { items, styleUsed } = await resolveShadcnItems(catalog, components, styles);
  const fileMap = new Map<string, string>();
  const npmDependencies = new Set<string>();
  for (const item of items) {
    for (const dependency of item.dependencies) npmDependencies.add(packageNameOf(dependency));
    for (const file of item.files) {
      const relative = mapShadcnFile(file.path, config, project.relative, boundary.rootReal);
      const previous = fileMap.get(relative);
      if (previous !== undefined && previous !== file.content) throw new ShadcnError("SHADCN_FILE_CONFLICT");
      fileMap.set(relative, file.content);
    }
  }
  if (fileMap.size === 0) throw new ShadcnError("OFFICIAL_REGISTRY_ITEM_NOT_FOUND");
  if (fileMap.size > 25) throw new ShadcnError("SHADCN_TOO_MANY_FILES");

  const overwrite = args.overwrite === true;
  const files: Array<{ path: string; content: string; mode: "create" | "overwrite" }> = [];
  const overwriting: string[] = [];
  const unchanged: string[] = [];
  for (const [relative, content] of fileMap) {
    const absolute = path.resolve(boundary.rootReal, relative);
    const state = await targetState(absolute);
    if (state.exists && !state.safe) throw new ShadcnError("UNSAFE_TARGET");
    if (state.exists) {
      const current = await fs.readFile(absolute, "utf8").catch(() => null);
      if (current === content) {
        unchanged.push(relative);
        continue;
      }
      if (!overwrite) throw new ShadcnError("SHADCN_TARGET_EXISTS");
      overwriting.push(relative);
    }
    files.push({ path: relative, content, mode: state.exists ? "overwrite" : "create" });
  }
  if (files.length === 0) throw new ShadcnError("SHADCN_ALREADY_INSTALLED");

  const installed = await readPackageDependencies(boundary, project.relative);
  const missing = [...npmDependencies].filter((name) => !installed.has(name)).sort();
  const operation = await prepareStagedFiles(ctx, files, "shadcn", { createDirectories: true });
  return {
    ...operation,
    operation: "shadcn_add",
    install_mode: "STAGED_WRITE",
    cwd: project.relative,
    registry: "@shadcn",
    style_used: styleUsed,
    requested_components: [...components],
    registry_components: items.map((entry) => entry.name),
    files_to_write: files.map((entry) => entry.path),
    overwriting,
    unchanged,
    npm_dependencies_required: [...npmDependencies].sort(),
    missing_npm_dependencies: missing,
    commands_executed: 0,
    package_installs_performed: 0,
    warnings: [
      ...(missing.length > 0 ? [`以下 npm 依赖不在 package.json 中，需要自行安装：${missing.join(", ")}`] : []),
      ...(overwriting.length > 0 ? ["将覆盖同名组件文件；commit 前请确认差异"] : []),
      "组件源码来自官方 Registry，未做人工代码审查；请确认差异、许可证与版本兼容性。",
    ],
    note: "已暂存、尚未写文件；用 commit_operation 经本机确认后落盘。不会执行 npm install。",
    required_before_execution: "commit_operation",
  };
}

async function detectTailwindV4(boundary: McpSecurityBoundary, projectRelative: string): Promise<boolean> {
  const relative = projectRelative === "." ? "package.json" : `${projectRelative}/package.json`;
  const resolved = await boundary.resolveWorkspacePath(relative).catch(() => null);
  if (!resolved || resolved.sensitive) return false;
  try {
    const parsed = JSON.parse(await fs.readFile(resolved.absolute, "utf8")) as Record<string, unknown>;
    const dependencies = {
      ...(record(parsed.dependencies) ? parsed.dependencies : {}),
      ...(record(parsed.devDependencies) ? parsed.devDependencies : {}),
    } as Record<string, unknown>;
    const version = dependencies.tailwindcss;
    return typeof version === "string" && /(?:^|[^0-9])4(?:\.|$)/.test(version);
  } catch {
    return false;
  }
}

/** shadcn_init 预演：只检查 Node 项目与配置，不执行初始化。 */
export async function planShadcnInit(
  ctx: WriteContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const boundary = ctx.boundary;
  const project = await resolveProject(boundary, args.cwd);
  const config = await readComponentsConfig(boundary, project.relative);
  const packageRelative = path.posix.join(project.relative === "." ? "" : project.relative, "package.json");
  const packageState = await targetState(path.resolve(boundary.rootReal, packageRelative));
  if (!packageState.exists || !packageState.safe) throw new ShadcnError("NODE_PROJECT_PACKAGE_JSON_REQUIRED");
  const template = args.template === undefined || args.template === null ? null : args.template;
  if (template !== null && (typeof template !== "string" || !(TEMPLATES as readonly string[]).includes(template))) {
    throw new ShadcnError("UNSUPPORTED_TEMPLATE");
  }
  const base = args.base === undefined || args.base === null ? null : args.base;
  if (base !== null && base !== "radix" && base !== "base") throw new ShadcnError("UNSUPPORTED_BASE");
  const style = typeof args.style === "string" && /^[a-z0-9-]{1,40}$/.test(args.style)
    ? args.style
    : "new-york";
  const overwrite = args.overwrite === true;
  if (config.configured && !overwrite) throw new ShadcnError("SHADCN_ALREADY_INITIALIZED");

  const prefix = project.relative === "." ? "" : `${project.relative}/`;
  const preferV4 = await detectTailwindV4(boundary, project.relative);
  const componentsJson = {
    $schema: "https://ui.shadcn.com/schema.json",
    style,
    rsc: args.rsc === true,
    tsx: args.tsx !== false,
    tailwind: {
      config: preferV4 ? "" : "tailwind.config.js",
      css: "src/index.css",
      baseColor: "neutral",
      cssVariables: true,
      prefix: "",
    },
    aliases: {
      components: "@/components",
      utils: "@/lib/utils",
      ui: "@/components/ui",
      lib: "@/lib",
      hooks: "@/hooks",
    },
    iconLibrary: "lucide",
  };
  const utils = [
    'import { clsx, type ClassValue } from "clsx";',
    'import { twMerge } from "tailwind-merge";',
    "",
    "export function cn(...inputs: ClassValue[]) {",
    "  return twMerge(clsx(inputs));",
    "}",
    "",
  ].join("\n");
  const files = [
    { path: path.posix.join(prefix, "components.json"), content: `${JSON.stringify(componentsJson, null, 2)}\n` },
    { path: path.posix.join(prefix, "src/lib/utils.ts"), content: utils },
  ];
  // 已存在且内容一致的文件跳过；需要覆盖的先确认 overwrite。
  const staged: Array<{ path: string; content: string; mode: "create" | "overwrite" }> = [];
  const existing: string[] = [];
  const unchanged: string[] = [];
  for (const file of files) {
    const absolute = path.resolve(boundary.rootReal, file.path);
    const state = await targetState(absolute);
    if (state.exists) {
      const current = await fs.readFile(absolute, "utf8").catch(() => null);
      if (current === file.content) {
        unchanged.push(file.path);
        continue;
      }
      if (!overwrite) throw new ShadcnError("SHADCN_TARGET_EXISTS");
      existing.push(file.path);
      staged.push({ ...file, mode: "overwrite" });
    } else {
      staged.push({ ...file, mode: "create" });
    }
  }
  if (staged.length === 0) throw new ShadcnError("SHADCN_ALREADY_INITIALIZED");

  const installed = await readPackageDependencies(boundary, project.relative);
  const required = ["clsx", "tailwind-merge", ...(preferV4 ? [] : ["tailwindcss"])].filter((name) => !installed.has(name));
  const operation = await prepareStagedFiles(ctx, staged, "shadcn", { createDirectories: true });
  return {
    ...operation,
    status: "STAGED_WRITE",
    operation: "shadcn_init",
    install_mode: "STAGED_WRITE",
    cwd: project.relative,
    has_components_json: config.configured,
    selected_template: template,
    selected_base: base,
    style_used: style,
    tailwind_v4: preferV4,
    files_to_write: staged.map((file) => file.path),
    overwriting: existing,
    unchanged,
    npm_dependencies_required: ["clsx", "tailwind-merge"],
    missing_npm_dependencies: required,
    packages_installed: 0,
    commands_executed: 0,
    initialization_performed: false,
    warnings: [
      ...(existing.length > 0 ? ["将覆盖已存在的 components.json / src/lib/utils.ts"] : []),
      ...(required.length > 0 ? [`需要自行安装依赖：${required.join(", ")}`] : []),
      "还需按项目情况确认 Tailwind 指令（@tailwind/@import）与 tsconfig paths；本工具不修改这些文件。",
    ],
    note: "已暂存 components.json 与 src/lib/utils.ts；用 commit_operation 本机确认后落盘。不执行 npx/npm。",
    required_before_execution: "commit_operation",
  };
}
