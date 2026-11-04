/**
 * ServiceDiscovery — 自动发现本机有哪些 MCP 服务，而不是把端口写死。
 *
 * 发现来源（按可靠性排序）：
 *   1. 本控制中心当前 Profile 的 transport.expectedLocalPort（我方 V2 runtime）
 *   2. Legacy MCP 自己的 ~/.local-files-mcp/config.json → server.port
 *   3. 少量已知端口（48765 Legacy 桥、48766、8765）
 *
 * 判定靠响应体特征，不靠端口号猜：
 *   - 有 workspaceId              → company-bridge（Legacy 生产桥）
 *   - 有 mcp_path / auth_mode     → local-files-mcp
 *   - 有 healthFingerprint 或 service==="c2c-bridge" 且版本 2.x → our-runtime
 *   - 其它能返回 /health 的        → unknown（仍然显示，标明未知）
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ServiceKind = "our-runtime" | "local-files-mcp" | "company-bridge" | "unknown";

export interface DiscoveredService {
  port: number;
  reachable: boolean;
  kind: ServiceKind;
  name: string | null;
  version: string | null;
  /** 这个端口是从哪来的：profile / peer-config / known */
  source: "profile" | "peer-config" | "known";
  /** 是否支持 /tools 诊断 */
  hasTools: boolean | null;
}

export interface ExpectedSlot {
  kind: ServiceKind;
  label: string;
  present: boolean;
  port: number | null;
}

export interface DiscoveryResult {
  services: DiscoveredService[];
  expected: ExpectedSlot[];
  checkedPorts: number[];
  checkedAt: number;
}

const LABELS: Record<ServiceKind, string> = {
  "our-runtime": "我们的服务（V2 Runtime）",
  "local-files-mcp": "Legacy MCP",
  "company-bridge": "保留实例桥",
  unknown: "未知服务",
};

async function readJsonSafe<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function probe(port: number, timeoutMs = 700): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
      redirect: "error",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeTools(port: number, timeoutMs = 900): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tools`, {
      signal: controller.signal,
      redirect: "error",
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function classify(body: Record<string, unknown>): ServiceKind {
  const version = typeof body.version === "string" ? body.version : "";
  if (typeof body.workspaceId === "string" && body.workspaceId.length > 0) return "company-bridge";
  if (typeof body.mcp_path === "string" || typeof body.auth_mode === "string") return "local-files-mcp";
  if (typeof body.healthFingerprint === "string") return "our-runtime";
  if (body.service === "c2c-bridge" && /^2\./.test(version)) return "our-runtime";
  if (body.service === "c2c-bridge") return "company-bridge";
  return "unknown";
}

/** 我方 Profile 期望的本地端口 */
async function ourProfilePort(stateRoot: string): Promise<number | null> {
  const dir = path.join(stateRoot, "profiles");
  try {
    const ids = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const id of ids) {
      const cfg = await readJsonSafe<{ transport?: { expectedLocalPort?: number } }>(
        path.join(dir, id, "config.json"),
      );
      const p = cfg?.transport?.expectedLocalPort;
      if (typeof p === "number" && p >= 1024 && p <= 65535) return p;
    }
  } catch {
    /* 无 Profile */
  }
  return null;
}

/** Legacy MCP 自称的端口 */
async function peerPort(): Promise<number | null> {
  const dirs = [
    path.join(os.homedir(), ".local-files-mcp"),
    path.join(process.env.LOCALAPPDATA ?? "", "local-files-mcp"),
  ];
  for (const d of dirs) {
    const cfg = await readJsonSafe<{ server?: { port?: number } }>(path.join(d, "config.json"));
    const p = cfg?.server?.port;
    if (typeof p === "number" && p >= 1024 && p <= 65535) return p;
  }
  return null;
}

export async function discoverServices(stateRoot: string): Promise<DiscoveryResult> {
  const candidates = new Map<number, DiscoveredService["source"]>();
  const add = (port: number | null, source: DiscoveredService["source"]): void => {
    if (port && port >= 1024 && port <= 65535 && !candidates.has(port)) candidates.set(port, source);
  };

  add(await ourProfilePort(stateRoot), "profile");
  add(await peerPort(), "peer-config");
  for (const p of [48765, 48766, 48767, 8765]) add(p, "known");

  const services: DiscoveredService[] = [];
  for (const [port, source] of candidates) {
    const body = await probe(port);
    if (!body) {
      services.push({
        port,
        reachable: false,
        kind: "unknown",
        name: null,
        version: null,
        source,
        hasTools: null,
      });
      continue;
    }
    const kind = classify(body);
    const name =
      typeof body.name === "string"
        ? body.name
        : typeof body.service === "string"
          ? body.service
          : null;
    const version =
      typeof body.version === "string"
        ? body.version
        : typeof body.server_version === "string"
          ? body.server_version
          : null;
    services.push({
      port,
      reachable: true,
      kind,
      name,
      version,
      source,
      hasTools: await probeTools(port),
    });
  }

  services.sort((a, b) => a.port - b.port);

  const kinds: ServiceKind[] = ["our-runtime", "local-files-mcp", "company-bridge"];
  const expected: ExpectedSlot[] = kinds.map((kind) => {
    const hit = services.find((s) => s.reachable && s.kind === kind);
    return {
      kind,
      label: LABELS[kind],
      present: Boolean(hit),
      port: hit?.port ?? null,
    };
  });

  return {
    services,
    expected,
    checkedPorts: [...candidates.keys()],
    checkedAt: Date.now(),
  };
}

export { LABELS as SERVICE_LABELS };
