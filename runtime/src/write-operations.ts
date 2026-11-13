/**
 * write-operations — 暂存-提交（two-phase）写入模型。
 *
 * 设计要点：
 * - prepare_* 只在**内存**里保存草稿与哈希，绝不落盘、不建目录；
 * - 草稿绑定 clientId + workspaceId，10 分钟内有效，最多 32 笔，进程重启即丢失；
 * - commit_* 先整批重新校验目标版本（字节级 SHA-256），
 *   再把所有内容写成同目录临时文件，逐个 link/rename 落位，最后逐个读回复核；
 * - 中途失败按已落位文件逆序回滚；回滚不成功会明确报 WRITE_PARTIAL_RECOVERY_REQUIRED，
 *   不会把"部分写入"说成成功；
 * - 本模块不做审批判断：是否允许提交由工具策略 + 本机审批门（主进程对话框）决定。
 *
 * 安全边界：所有路径必须落在工作区内；拒绝符号链接、硬链接、非普通文件、
 * 敏感文件名、隐藏文件名与非常见文本扩展名。
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { McpSecurityError, type McpSecurityBoundary } from "./security-boundary.js";
import { applyFuzzyEdit, findFuzzyMatches, previewEdit } from "./fuzzy-edit.js";

export type WriteMode = "create" | "overwrite";
export type OperationKind = "write" | "replacement" | "scaffold" | "shadcn" | "edit";
export type OperationStatus = "PENDING_LOCAL_APPROVAL" | "COMMITTING" | "FAILED";

const DRAFT_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_OPERATIONS = 32;
const MAX_FILES_PER_OPERATION = 25;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 400;
const MAX_DETAILS = 40;
const MAX_DETAIL_LENGTH = 320;

/** 允许被暂存写入的文本扩展名；未知/可执行类型默认拒绝。 */
export const TEXT_MUTATION_EXTENSIONS = Object.freeze([
  ".md", ".txt", ".rst", ".py", ".ts", ".tsx", ".js", ".jsx", ".css", ".html",
  ".json", ".jsonl", ".yml", ".yaml", ".toml", ".ini", ".xml", ".csv", ".sql",
] as const);
const WRITABLE_EXTENSIONS = new Set<string>(TEXT_MUTATION_EXTENSIONS);

export class WriteOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WriteOperationError";
  }
}

export interface WriteContext {
  readonly boundary: McpSecurityBoundary;
  readonly workspaceId: string;
  readonly clientId: string;
}

interface StoredFile {
  path: string;
  mode: WriteMode;
  content: string;
  beforeContent: Buffer | null;
  beforeSha256: string | null;
  afterSha256: string;
  bytes: number;
}

interface StoredOperation {
  operationId: string;
  clientId: string;
  workspaceId: string;
  workspaceRoot: string;
  kind: OperationKind;
  createdAt: number;
  expiresAt: number;
  status: OperationStatus;
  /** 提交时允许创建缺失的父目录（shadcn 组件目录等）；默认 false。 */
  createDirectories: boolean;
  files: StoredFile[];
}

/** 进程内草稿表：不落盘、不持久化正文。 */
const operations = new Map<string, StoredOperation>();

export interface OperationFileView {
  path: string;
  mode: WriteMode;
  /** 统一用 Base64（与 file_sha256 一致），避免 64 位十六进制被全局脱敏规则遮蔽。 */
  before_sha256_b64: string | null;
  after_sha256_b64: string;
  before_bytes: number | null;
  bytes: number;
}

export interface OperationView {
  operation_id: string;
  status: OperationStatus;
  kind: OperationKind;
  workspace_id: string;
  created_at: string;
  expires_at: string;
  files: OperationFileView[];
  file_count: number;
  added: number;
  modified: number;
  files_changed: 0;
  requires_local_approval: true;
  commit_tool: "commit_operation";
  durability: "MEMORY_ONLY";
  /** prepare_edit 的替换预览（仅展示，不参与提交）。 */
  preview?: string[];
}

export interface CommitFileResult {
  path: string;
  mode: WriteMode;
  bytes: number;
  sha256_b64: string;
  verified: true;
}

export interface CommitResult {
  operation_id: string;
  status: "COMMITTED";
  workspace_id: string;
  files_changed: number;
  files: CommitFileResult[];
  readback_verified: true;
  atomic_across_files: false;
}

export interface BatchCommitOutcome {
  operation_id: string;
  status: "COMMITTED" | "BLOCKED" | "SKIPPED";
  reason: string;
  files_changed: number;
}

export interface BatchCommitResult {
  status: "COMMITTED" | "PARTIAL_OR_BLOCKED";
  operations: BatchCommitOutcome[];
  files_changed: number;
  atomic_across_operations: false;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, operation] of operations) {
    if (operation.status === "COMMITTING") continue;
    if (operation.expiresAt <= now) operations.delete(id);
  }
}

function normalizeRelativePath(input: unknown, rootReal?: string): string {
  if (typeof input !== "string") throw new WriteOperationError("PATH_REQUIRED");
  let raw = input;
  if (!raw || raw !== raw.trim()) throw new WriteOperationError("PATH_INVALID");
  if (raw.length > MAX_PATH_LENGTH || raw.includes("\0")) throw new WriteOperationError("PATH_INVALID");
  // 绝对路径：只要落在工作区内就换算成相对路径，越界才拒绝。
  // 之前是一律拒绝绝对路径，导致 ChatGPT 传 C:\workspace\xxx 直接被判"越界"（实测）。
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    if (!rootReal) throw new WriteOperationError("PATH_OUTSIDE_WORKSPACE");
    const absolute = path.resolve(raw);
    const rel = path.relative(path.resolve(rootReal), absolute);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new WriteOperationError("PATH_OUTSIDE_WORKSPACE");
    }
    raw = rel.replaceAll("\\", "/");
  }
  const parts = raw.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new WriteOperationError("PATH_INVALID");
  }
  const relative = parts.join("/");
  if (path.posix.basename(relative).startsWith(".")) throw new WriteOperationError("HIDDEN_TARGET_BLOCKED");
  const extension = path.posix.extname(relative).toLowerCase();
  if (!WRITABLE_EXTENSIONS.has(extension)) throw new WriteOperationError("FILE_TYPE_WRITE_BLOCKED");
  return relative;
}

/** 目录路径（项目骨架用）：与文件路径同样禁止越界/隐藏，但不做扩展名检查。 */
function normalizeRelativeDirectory(input: unknown): string {
  if (typeof input !== "string") throw new WriteOperationError("SCAFFOLD_PATH_INVALID");
  const raw = input;
  if (!raw || raw !== raw.trim() || raw.length > 160 || raw.includes("\0")) {
    throw new WriteOperationError("SCAFFOLD_PATH_INVALID");
  }
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    throw new WriteOperationError("SCAFFOLD_PATH_INVALID");
  }
  const parts = raw.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) {
    throw new WriteOperationError("SCAFFOLD_PATH_INVALID");
  }
  return parts.join("/");
}

function normalizeClientId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value) || value === "unknown") {
    throw new WriteOperationError("CLIENT_ID_REQUIRED");
  }
  return value;
}

function mapBoundaryError(error: unknown): WriteOperationError {
  if (error instanceof WriteOperationError) return error;
  if (error instanceof McpSecurityError) {
    const code = error.code === "path_outside_workspace" ? "PATH_OUTSIDE_WORKSPACE"
      : error.code === "sensitive_path_denied" ? "SENSITIVE_PATH_DENIED"
        : "PATH_UNAVAILABLE";
    return new WriteOperationError(code);
  }
  return new WriteOperationError("TARGET_UNAVAILABLE");
}

interface InspectedTarget {
  absolute: string;
  exists: boolean;
  content: Buffer | null;
  sha256: string | null;
}

async function inspectTarget(ctx: WriteContext, relative: string, allowMissingParent = false): Promise<InspectedTarget> {
  const root = ctx.boundary.rootReal;
  const lexical = path.resolve(root, relative);
  const relToRoot = path.relative(root, lexical);
  if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new WriteOperationError("PATH_OUTSIDE_WORKSPACE");
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    stat = await fs.lstat(lexical);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new WriteOperationError("TARGET_UNAVAILABLE");
    }
  }

  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new WriteOperationError("UNSAFE_TARGET");
    }
    if (stat.size > MAX_FILE_BYTES) throw new WriteOperationError("TARGET_TOO_LARGE");
  }

  let resolved;
  try {
    resolved = await ctx.boundary.resolveWritePath(relative, { allowMissing: true });
  } catch (error: unknown) {
    throw mapBoundaryError(error);
  }
  if (!resolved.isPrimary) throw new WriteOperationError("STAGED_WRITE_PRIMARY_ONLY");
  if (resolved.sensitive) throw new WriteOperationError("SENSITIVE_PATH_DENIED");

  if (stat) {
    let content: Buffer;
    try {
      content = await fs.readFile(resolved.absolute);
    } catch {
      throw new WriteOperationError("TARGET_UNAVAILABLE");
    }
    return { absolute: resolved.absolute, exists: true, content, sha256: sha256(content) };
  }

  const parent = path.dirname(resolved.absolute);
  let parentStat;
  try {
    parentStat = await fs.lstat(parent);
  } catch {
    if (allowMissingParent) return { absolute: resolved.absolute, exists: false, content: null, sha256: null };
    throw new WriteOperationError("TARGET_PARENT_MISSING");
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new WriteOperationError("UNSAFE_PARENT");
  return { absolute: resolved.absolute, exists: false, content: null, sha256: null };
}

interface PreparedInputFile {
  path: string;
  content: string;
  mode: WriteMode;
}

async function prepareFiles(
  ctx: WriteContext,
  inputFiles: PreparedInputFile[],
  kind: OperationKind,
  options: { createDirectories?: boolean } = {},
): Promise<OperationView> {
  pruneExpired();
  const clientId = normalizeClientId(ctx.clientId);
  const createDirectories = options.createDirectories === true;
  if (operations.size >= MAX_PENDING_OPERATIONS) throw new WriteOperationError("TOO_MANY_PENDING_OPERATIONS");
  if (!Array.isArray(inputFiles) || inputFiles.length < 1 || inputFiles.length > MAX_FILES_PER_OPERATION) {
    throw new WriteOperationError("INVALID_BATCH_SIZE");
  }

  const seen = new Set<string>();
  const files: StoredFile[] = [];
  let totalBytes = 0;

  for (const input of inputFiles) {
    const relative = normalizeRelativePath(input.path, ctx.boundary.rootReal);
    const duplicateKey = relative.toLowerCase();
    if (seen.has(duplicateKey)) throw new WriteOperationError("DUPLICATE_TARGET");
    seen.add(duplicateKey);

    if (input.mode !== "create" && input.mode !== "overwrite") throw new WriteOperationError("MODE_INVALID");
    if (typeof input.content !== "string" || input.content.includes("\0")) {
      throw new WriteOperationError("BINARY_CONTENT_DENIED");
    }
    const body = Buffer.from(input.content, "utf8");
    if (body.byteLength > MAX_FILE_BYTES) throw new WriteOperationError("BATCH_BYTES_EXCEEDED");
    totalBytes += body.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new WriteOperationError("BATCH_BYTES_EXCEEDED");

    const target = await inspectTarget(ctx, relative, createDirectories);
    if (input.mode === "create" && target.exists) throw new WriteOperationError("TARGET_EXISTS");
    if (input.mode === "overwrite" && !target.exists) throw new WriteOperationError("TARGET_NOT_FOUND");
    const afterSha256 = sha256(body);
    if (target.sha256 === afterSha256) throw new WriteOperationError("NO_CHANGES");

    files.push({
      path: relative,
      mode: input.mode,
      content: input.content,
      beforeContent: target.content,
      beforeSha256: target.sha256,
      afterSha256,
      bytes: body.byteLength,
    });
  }

  const id = randomBytes(16).toString("hex");
  const createdAt = Date.now();
  const operation: StoredOperation = {
    operationId: id,
    clientId,
    workspaceId: ctx.workspaceId,
    workspaceRoot: ctx.boundary.rootReal,
    kind,
    createdAt,
    expiresAt: createdAt + DRAFT_TTL_MS,
    status: "PENDING_LOCAL_APPROVAL",
    createDirectories,
    files,
  };
  operations.set(id, operation);
  return viewOf(operation);
}

function viewOf(operation: StoredOperation): OperationView {
  const added = operation.files.filter((file) => file.beforeSha256 === null).length;
  return {
    operation_id: operation.operationId,
    status: operation.status,
    kind: operation.kind,
    workspace_id: operation.workspaceId,
    created_at: nowIso(operation.createdAt),
    expires_at: nowIso(operation.expiresAt),
    files: operation.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      before_sha256_b64: file.beforeSha256 === null ? null : hexToBase64(file.beforeSha256),
      after_sha256_b64: hexToBase64(file.afterSha256),
      before_bytes: file.beforeContent ? file.beforeContent.byteLength : null,
      bytes: file.bytes,
    })),
    file_count: operation.files.length,
    added,
    modified: operation.files.length - added,
    files_changed: 0,
    requires_local_approval: true,
    commit_tool: "commit_operation",
    durability: "MEMORY_ONLY",
  };
}

function getOwnedOperation(ctx: WriteContext, operationId: unknown): StoredOperation {
  pruneExpired();
  if (!isOperationId(operationId)) throw new WriteOperationError("OPERATION_ID_INVALID");
  const operation = operations.get(operationId);
  if (!operation
    || operation.clientId !== ctx.clientId
    || operation.workspaceId !== ctx.workspaceId
    || operation.workspaceRoot !== ctx.boundary.rootReal) {
    throw new WriteOperationError("OPERATION_NOT_FOUND");
  }
  if (operation.expiresAt <= Date.now()) {
    operations.delete(operation.operationId);
    throw new WriteOperationError("OPERATION_EXPIRED");
  }
  return operation;
}

function normalizeMode(value: unknown, fallback: WriteMode = "overwrite"): WriteMode {
  if (value === undefined) return fallback;
  if (value === "create" || value === "overwrite") return value;
  throw new WriteOperationError("MODE_INVALID");
}

/** 供 shadcn 等内部能力复用的暂存入口（仍然走同一套校验与提交模型）。 */
export async function prepareStagedFiles(
  ctx: WriteContext,
  files: Array<{ path: string; content: string; mode: WriteMode }>,
  kind: OperationKind,
  options: { createDirectories?: boolean } = {},
): Promise<OperationView> {
  return await prepareFiles(ctx, files, kind, options);
}

export async function prepareWrite(ctx: WriteContext, args: Record<string, unknown>): Promise<OperationView> {
  // 允许为新建文件自动创建缺失的父目录（例如 C:\workspace\__test__\hello.txt）。
  // 之前默认 false，Agent 写新目录下的文件会直接 TARGET_PARENT_MISSING。
  return prepareFiles(ctx, [{
    path: typeof args.path === "string" ? args.path : "",
    content: typeof args.content === "string" ? args.content : "",
    mode: normalizeMode(args.mode),
  }], "write", { createDirectories: true });
}

export async function prepareBatchWrite(ctx: WriteContext, args: Record<string, unknown>): Promise<OperationView> {
  if (!Array.isArray(args.files)) throw new WriteOperationError("FILES_REQUIRED");
  const files: PreparedInputFile[] = args.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new WriteOperationError("FILE_ENTRY_INVALID");
    const record = entry as Record<string, unknown>;
    return {
      path: typeof record.path === "string" ? record.path : "",
      content: typeof record.content === "string" ? record.content : "",
      mode: normalizeMode(record.mode),
    };
  });
  return prepareFiles(ctx, files, "write");
}

/**
 * 批量精确替换：每个 find 在目标文件中必须**恰好出现一次**，否则拒绝（避免误改多处）。
 * 只生成草稿，不写文件。
 */
export async function prepareReplacements(ctx: WriteContext, args: Record<string, unknown>): Promise<OperationView> {
  if (!Array.isArray(args.replacements)) throw new WriteOperationError("REPLACEMENTS_REQUIRED");
  if (args.replacements.length < 1 || args.replacements.length > MAX_FILES_PER_OPERATION) {
    throw new WriteOperationError("INVALID_BATCH_SIZE");
  }
  const files: PreparedInputFile[] = [];
  const seen = new Set<string>();
  for (const entry of args.replacements) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new WriteOperationError("REPLACEMENT_INVALID");
    const record = entry as Record<string, unknown>;
    const relative = normalizeRelativePath(record.path, ctx.boundary.rootReal);
    if (seen.has(relative.toLowerCase())) throw new WriteOperationError("DUPLICATE_TARGET");
    seen.add(relative.toLowerCase());
    if (typeof record.find !== "string" || record.find.length < 1 || record.find.length > 20_000) {
      throw new WriteOperationError("REPLACEMENT_INVALID");
    }
    if (typeof record.replace !== "string" || record.replace.length > MAX_FILE_BYTES || record.replace.includes("\0")) {
      throw new WriteOperationError("REPLACEMENT_INVALID");
    }
    const target = await inspectTarget(ctx, relative);
    if (!target.exists || !target.content) throw new WriteOperationError("TARGET_NOT_FOUND");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(target.content);
    } catch {
      throw new WriteOperationError("INVALID_UTF8_TARGET");
    }
    const occurrences = text.split(record.find).length - 1;
    if (occurrences !== 1) throw new WriteOperationError("REPLACEMENT_NOT_UNIQUE");
    files.push({ path: relative, mode: "overwrite", content: text.replace(record.find, record.replace) });
  }
  return prepareFiles(ctx, files, "replacement");
}

/**
 * 模糊块替换预演：`find` 按"折叠空白后的行"匹配，唯一命中后生成新内容并走既有暂存流程。
 * 命中 0 次 → EDIT_NOT_FOUND；≥2 次 → EDIT_NOT_UNIQUE（要求调用方给出更具体的上下文）。
 */
export async function prepareEdit(ctx: WriteContext, args: Record<string, unknown>): Promise<OperationView> {
  const relative = normalizeRelativePath(args.path, ctx.boundary.rootReal);
  if (typeof args.find !== "string" || args.find.length < 1 || args.find.length > 20_000) {
    throw new WriteOperationError("EDIT_FIND_INVALID");
  }
  if (typeof args.replace !== "string" || args.replace.length > MAX_FILE_BYTES || args.replace.includes("\0")) {
    throw new WriteOperationError("EDIT_REPLACE_INVALID");
  }
  const target = await inspectTarget(ctx, relative);
  if (!target.exists || !target.content) throw new WriteOperationError("TARGET_NOT_FOUND");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(target.content);
  } catch {
    throw new WriteOperationError("INVALID_UTF8_TARGET");
  }
  let content: string;
  let preview: string[] = [];
  try {
    const matches = findFuzzyMatches(text, args.find, 2);
    if (matches.length === 0) throw new WriteOperationError("EDIT_NOT_FOUND");
    if (matches.length > 1) throw new WriteOperationError("EDIT_NOT_UNIQUE");
    const edited = applyFuzzyEdit(text, args.find, args.replace);
    content = edited.content;
    preview = previewEdit(matches[0]!, args.replace);
  } catch (error) {
    if (error instanceof WriteOperationError) throw error;
    throw new WriteOperationError(error instanceof Error ? error.message : "EDIT_FAILED");
  }
  const operation = await prepareFiles(ctx, [{ path: relative, mode: "overwrite", content }], "edit");
  return { ...operation, preview };
}

/**
 * 项目骨架预演：只接受**已存在**的项目目录与 `.brainn` 目录，预演阶段不创建任何东西。
 * overwrite=false 时四个目标必须都不存在。
 */
export async function prepareScaffold(ctx: WriteContext, args: Record<string, unknown>): Promise<OperationView> {
  const rawPath = typeof args.project_path === "string" ? args.project_path : "";
  const projectPath = rawPath === "" || rawPath === "." ? "." : normalizeRelativeDirectory(rawPath);
  if (projectPath !== "." && projectPath.length > 160) {
    throw new WriteOperationError("SCAFFOLD_PATH_INVALID");
  }
  const profile = args.profile === undefined ? "generic" : args.profile;
  if (profile !== "generic" && profile !== "python" && profile !== "node") {
    throw new WriteOperationError("SCAFFOLD_PROFILE_INVALID");
  }
  const overwrite = args.overwrite === true;

  const root = ctx.boundary.rootReal;
  const projectAbsolute = path.resolve(root, projectPath);
  const projectStat = await fs.lstat(projectAbsolute).catch(() => null);
  if (!projectStat?.isDirectory() || projectStat.isSymbolicLink()) {
    throw new WriteOperationError("SCAFFOLD_DIRECTORY_MISSING");
  }
  const brainDir = path.join(projectAbsolute, ".brainn");
  const brainStat = await fs.lstat(brainDir).catch(() => null);
  if (!brainStat?.isDirectory() || brainStat.isSymbolicLink()) {
    throw new WriteOperationError("SCAFFOLD_CREATE_BRAINN_DIR_FIRST");
  }

  const projectName = path.basename(projectAbsolute).replace(/[\r\n\t]/g, " ").slice(0, 80);
  const join = (name: string): string => (projectPath === "." ? name : `${projectPath}/${name}`);
  const templates: Array<{ file: string; content: string }> = [
    {
      file: join("PROJECT.md"),
      content: `# ${projectName}\n\n## 目标\n\n待填写。\n\n## 技术栈\n\n${profile}\n\n## 风险与边界\n\n待填写。\n`,
    },
    {
      file: join("LLM.md"),
      content: "# Agent 协作说明\n\n必须尊重当前工作区边界与权限审批。危险操作先取得明确授权。\n\n## 项目入口\n\n参见 PROJECT.md 与 STATUS.md。\n",
    },
    {
      file: join("STATUS.md"),
      content: "# 当前进度\n\n## 已完成\n\n- 待填写\n\n## 下一步\n\n- 待填写\n\n## 待验收\n\n- 待填写\n",
    },
    {
      file: join(".brainn/project.json"),
      content: `${JSON.stringify({ schemaVersion: 1, project: projectName, profile, status: "DRAFT_NOT_APPROVED" }, null, 2)}\n`,
    },
  ];

  const files: PreparedInputFile[] = [];
  for (const template of templates) {
    const target = await inspectTarget(ctx, template.file);
    if (target.exists && !overwrite) throw new WriteOperationError("SCAFFOLD_TARGET_ALREADY_EXISTS");
    files.push({ path: template.file, mode: target.exists ? "overwrite" : "create", content: template.content });
  }
  return prepareFiles(ctx, files, "scaffold");
}

export function listPendingOperations(ctx: WriteContext): {
  operations: OperationView[];
  total_pending: number;
  scope: "SAME_CLIENT_SAME_RUNTIME";
  durability: "MEMORY_ONLY";
  payloads_included: false;
} {
  pruneExpired();
  const mine = [...operations.values()]
    .filter((operation) => operation.clientId === ctx.clientId
      && operation.workspaceId === ctx.workspaceId
      && operation.workspaceRoot === ctx.boundary.rootReal)
    .sort((left, right) => right.createdAt - left.createdAt);
  return {
    operations: mine.map(viewOf),
    total_pending: mine.length,
    scope: "SAME_CLIENT_SAME_RUNTIME",
    durability: "MEMORY_ONLY",
    payloads_included: false,
  };
}

export function cancelPendingOperation(ctx: WriteContext, operationId: unknown): {
  operation_id: string;
  status: "CANCELLED";
  files_changed: 0;
} {
  const operation = getOwnedOperation(ctx, operationId);
  if (operation.status === "COMMITTING") throw new WriteOperationError("OPERATION_BUSY");
  operations.delete(operation.operationId);
  return { operation_id: operation.operationId, status: "CANCELLED", files_changed: 0 };
}

/** 供本机审批对话框使用：只给路径/模式/大小/哈希，不含正文。 */
export function describeOperationForApproval(ctx: WriteContext, operationId: unknown): {
  summary: string;
  details: string[];
} {
  const operation = getOwnedOperation(ctx, operationId);
  return describeOperations([operation]);
}

export function describeOperationsForApproval(ctx: WriteContext, operationIds: unknown): {
  summary: string;
  details: string[];
} {
  if (!Array.isArray(operationIds) || operationIds.length < 1 || operationIds.length > MAX_FILES_PER_OPERATION) {
    throw new WriteOperationError("OPERATION_IDS_INVALID");
  }
  const unique = new Set<string>();
  const operationsToDescribe: StoredOperation[] = [];
  for (const id of operationIds) {
    if (!isOperationId(id)) throw new WriteOperationError("OPERATION_ID_INVALID");
    if (unique.has(id)) throw new WriteOperationError("DUPLICATE_OPERATION_ID");
    unique.add(id);
    operationsToDescribe.push(getOwnedOperation(ctx, id));
  }
  return describeOperations(operationsToDescribe);
}

function describeOperations(items: StoredOperation[]): { summary: string; details: string[] } {
  const files = items.reduce((total, item) => total + item.files.length, 0);
  const added = items.reduce((total, item) => total + item.files.filter((file) => file.beforeSha256 === null).length, 0);
  const summary = items.length === 1
    ? `暂存写入 1 笔操作、${files} 个文件（新增 ${added} / 修改 ${files - added}）`
    : `暂存写入 ${items.length} 笔操作、${files} 个文件（新增 ${added} / 修改 ${files - added}）`;
  const details: string[] = [];
  for (const item of items) {
    details.push(`操作 ${item.operationId} · ${kindLabel(item.kind)} · 到期 ${nowIso(item.expiresAt)}`);
    for (const file of item.files) {
      const before = file.beforeContent ? `${file.beforeContent.byteLength} B` : "无";
      details.push(`  ${file.path} · ${file.mode === "create" ? "新增" : "覆盖"} · ${before} → ${file.bytes} B · ${file.afterSha256.slice(0, 12)}…`);
    }
  }
  const total = details.length;
  const bounded = details
    .slice(0, total > MAX_DETAILS ? MAX_DETAILS - 1 : MAX_DETAILS)
    .map((line) => line.slice(0, MAX_DETAIL_LENGTH));
  if (total > MAX_DETAILS) bounded.push(`…另有 ${total - (MAX_DETAILS - 1)} 条明细未显示（共 ${total} 条）`);
  return { summary, details: bounded };
}

function kindLabel(kind: OperationKind): string {
  if (kind === "replacement") return "批量替换";
  if (kind === "scaffold") return "项目骨架";
  if (kind === "shadcn") return "shadcn 组件";
  return "文件写入";
}

async function stageBytes(targetAbsolute: string, payload: Buffer): Promise<string> {
  const temp = path.join(
    path.dirname(targetAbsolute),
    `.${path.basename(targetAbsolute)}.linos-stage-${randomBytes(12).toString("hex")}`,
  );
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temp;
}

interface StagedFile {
  file: StoredFile;
  absolute: string;
  temp: string | null;
  applied: boolean;
}

export async function commitOperation(ctx: WriteContext, operationId: unknown): Promise<CommitResult> {
  const operation = getOwnedOperation(ctx, operationId);
  if (operation.status === "COMMITTING") throw new WriteOperationError("OPERATION_BUSY");
  if (operation.status !== "PENDING_LOCAL_APPROVAL") throw new WriteOperationError("OPERATION_NOT_COMMITTABLE");

  operation.status = "COMMITTING";
  const staged: StagedFile[] = [];
  try {
    // 1) 全批预检 + 落同目录临时文件；任何一项不通过都还没动目标文件。
    for (const file of operation.files) {
      const target = await inspectTarget(ctx, file.path, operation.createDirectories);
      if (target.sha256 !== file.beforeSha256) throw new WriteOperationError("VERSION_CHANGED");
      if (file.mode === "create" && target.exists) throw new WriteOperationError("TARGET_EXISTS");
      if (file.mode === "overwrite" && !target.exists) throw new WriteOperationError("TARGET_MISSING");
      if (operation.createDirectories && !target.exists) {
        const parent = path.dirname(target.absolute);
        try {
          await fs.mkdir(parent, { recursive: true });
          const parentStat = await fs.lstat(parent);
          if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("unsafe");
        } catch {
          throw new WriteOperationError("TARGET_PARENT_UNAVAILABLE");
        }
      }
      const temp = await stageBytes(target.absolute, Buffer.from(file.content, "utf8"));
      staged.push({ file, absolute: target.absolute, temp, applied: false });
    }

    // 2) 逐个落位；CREATE 用硬链接保证不覆盖并发出现的目标，OVERWRITE 用同目录 rename。
    for (const entry of staged) {
      const { file } = entry;
      const target = await inspectTarget(ctx, file.path);
      if (target.sha256 !== file.beforeSha256) throw new WriteOperationError("VERSION_CHANGED");
      try {
        if (file.mode === "create") {
          await fs.link(entry.temp!, entry.absolute);
          await fs.unlink(entry.temp!);
          entry.temp = null;
        } else {
          await fs.rename(entry.temp!, entry.absolute);
          entry.temp = null;
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new WriteOperationError("VERSION_CHANGED");
        throw new WriteOperationError("WRITE_FAILED");
      }
      entry.applied = true;

      // 3) 独立读回复核，不以"写调用返回成功"为准。
      const readback = await fs.readFile(entry.absolute).catch(() => null);
      if (!readback || sha256(readback) !== file.afterSha256) throw new WriteOperationError("READBACK_MISMATCH");
    }

    operations.delete(operation.operationId);
    return {
      operation_id: operation.operationId,
      status: "COMMITTED",
      workspace_id: operation.workspaceId,
      files_changed: operation.files.length,
      files: operation.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        bytes: file.bytes,
        sha256_b64: hexToBase64(file.afterSha256),
        verified: true,
      })),
      readback_verified: true,
      atomic_across_files: false,
    };
  } catch (error: unknown) {
    const rolledBack = await rollbackApplied(staged);
    operations.delete(operation.operationId);
    if (!rolledBack) throw new WriteOperationError("WRITE_PARTIAL_RECOVERY_REQUIRED");
    if (error instanceof WriteOperationError) throw error;
    throw new WriteOperationError("WRITE_FAILED");
  } finally {
    for (const entry of staged) {
      if (entry.temp) await fs.rm(entry.temp, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * 只回滚"仍是我们刚写进去的内容"的文件；被外部改过的目标保持原样并报恢复失败，
 * 绝不覆盖并发用户的修改。
 */
async function rollbackApplied(staged: StagedFile[]): Promise<boolean> {
  let ok = true;
  for (const entry of staged.slice().reverse()) {
    if (!entry.applied) continue;
    try {
      const current = await fs.readFile(entry.absolute).catch(() => null);
      if (!current || sha256(current) !== entry.file.afterSha256) {
        ok = false;
        continue;
      }
      if (entry.file.beforeContent === null) {
        await fs.unlink(entry.absolute);
      } else {
        const restored = await stageBytes(entry.absolute, entry.file.beforeContent);
        try {
          await fs.rename(restored, entry.absolute);
        } finally {
          await fs.rm(restored, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      ok = false;
    }
  }
  return ok;
}

export async function commitOperations(
  ctx: WriteContext,
  operationIds: unknown,
  continueOnError: boolean,
): Promise<BatchCommitResult> {
  if (!Array.isArray(operationIds) || operationIds.length < 1 || operationIds.length > MAX_FILES_PER_OPERATION) {
    throw new WriteOperationError("OPERATION_IDS_INVALID");
  }
  const seen = new Set<string>();
  for (const id of operationIds) {
    if (!isOperationId(id)) throw new WriteOperationError("OPERATION_ID_INVALID");
    if (seen.has(id)) throw new WriteOperationError("DUPLICATE_OPERATION_ID");
    seen.add(id);
  }

  const outcomes: BatchCommitOutcome[] = [];
  let filesChanged = 0;
  let stopped = false;
  for (const id of operationIds) {
    if (stopped && !continueOnError) {
      outcomes.push({ operation_id: id, status: "SKIPPED", reason: "STOP_ON_FIRST_ERROR", files_changed: 0 });
      continue;
    }
    try {
      const result = await commitOperation(ctx, id);
      filesChanged += result.files_changed;
      outcomes.push({ operation_id: id, status: "COMMITTED", reason: "READBACK_VERIFIED", files_changed: result.files_changed });
    } catch (error: unknown) {
      const reason = error instanceof WriteOperationError ? error.code : "WRITE_FAILED";
      outcomes.push({ operation_id: id, status: "BLOCKED", reason, files_changed: 0 });
      stopped = true;
    }
  }
  return {
    status: outcomes.every((outcome) => outcome.status === "COMMITTED") ? "COMMITTED" : "PARTIAL_OR_BLOCKED",
    operations: outcomes,
    files_changed: filesChanged,
    atomic_across_operations: false,
  };
}

/** 测试用：清空草稿表，避免跨用例串状态。 */
export function __resetWriteOperationsForTest(): void {
  operations.clear();
}
