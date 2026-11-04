/** 本机 Runtime 端口策略：默认 48767，可配置；仅保留实例 48765 永久保留。 */
export const DEFAULT_RUNTIME_PORT = 48767;
/**
 * 只保留保留端口 48765。
 * 48766 曾是 Legacy MCP 的端口；该工具已被本内核替代并停用，
 * 因此不再硬编码禁用（用户可用 48766 作为长期端口）。
 */
export const RESERVED_RUNTIME_PORTS: readonly number[] = [48765];

export function isValidRuntimePort(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1024
    && value <= 65535
    && !RESERVED_RUNTIME_PORTS.includes(value);
}

export function runtimePortError(value: unknown): string {
  return `RUNTIME_PORT_INVALID: ${String(value)}（允许 1024–65535，且不能是保留端口 48765）`;
}

/**
 * 解析首次启动端口：只认严格的 `--port=N` 形式。
 * 缺席返回 null；出现但非法则抛错（调用方按失败关闭处理，绝不静默回退）。
 */
export function parseFirstBootPort(argv: readonly string[]): number | null {
  const flag = argv.find((arg) => arg.startsWith("--port="));
  if (!flag) return null;
  const raw = flag.slice("--port=".length).trim();
  if (!/^\d+$/.test(raw)) throw new Error(runtimePortError(flag));
  const port = Number(raw);
  if (!isValidRuntimePort(port)) throw new Error(runtimePortError(flag));
  return port;
}

/**
 * 首启端口决议（纯函数，可单测）：
 * 只要该 Profile 已经配过 transport（provider !== null），一律沿用现值，
 * CLI 标记永远不得覆盖用户已有配置；只有从未配过的 Profile 才用 CLI 端口或默认值。
 */
export function firstBootPort(
  cliPort: number | null,
  provider: string | null,
  currentPort: number,
  fallbackPort: number,
): number {
  if (provider !== null) return currentPort;
  if (cliPort !== null && isValidRuntimePort(cliPort)) return cliPort;
  return fallbackPort;
}
