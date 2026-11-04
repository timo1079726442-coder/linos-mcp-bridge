import { describe, expect, it } from "vitest";
import { firstBootPort, isValidRuntimePort, parseFirstBootPort } from "./localPort.js";

describe("parseFirstBootPort", () => {
  it("缺席返回 null", () => {
    expect(parseFirstBootPort(["node", "app.js"])).toBeNull();
    expect(parseFirstBootPort([])).toBeNull();
  });

  it("接受严格的 --port=N", () => {
    expect(parseFirstBootPort(["LinOS MCP.exe", "--port=48800"])).toBe(48800);
    expect(parseFirstBootPort(["--port=1024"])).toBe(1024);
  });

  it("非法值抛错不回退", () => {
    expect(() => parseFirstBootPort(["--port=48765"])).toThrow(/RUNTIME_PORT_INVALID/);
    expect(parseFirstBootPort(["--port=48766"])).toBe(48766); // 48766 已解禁（Legacy MCP 停用）
    expect(() => parseFirstBootPort(["--port=abc"])).toThrow(/RUNTIME_PORT_INVALID/);
    expect(() => parseFirstBootPort(["--port=80"])).toThrow(/RUNTIME_PORT_INVALID/);
    expect(() => parseFirstBootPort(["--port="])).toThrow(/RUNTIME_PORT_INVALID/);
    // 非严格形式一律忽略，不误伤 Electron 自带参数
    expect(parseFirstBootPort(["--port", "48800"])).toBeNull();
  });
});

describe("firstBootPort", () => {
  it("已有配置时 CLI 永远不得覆盖", () => {
    expect(firstBootPort(48800, "LOCAL_ONLY", 48766, 48766)).toBe(48766);
    expect(firstBootPort(48800, "CLOUDFLARE_NAMED", 49999, 48766)).toBe(49999);
  });

  it("从未配置时用 CLI 端口，否则用默认值", () => {
    expect(firstBootPort(48800, null, 48766, 48766)).toBe(48800);
    expect(firstBootPort(null, null, 48766, 48766)).toBe(48766);
    expect(firstBootPort(48765, null, 48766, 48766)).toBe(48766);
  });

  it("isValidRuntimePort 永不放行内部/对端端口", () => {
    expect(isValidRuntimePort(48765)).toBe(false);
    expect(isValidRuntimePort(48766)).toBe(true);
    expect(isValidRuntimePort(48766)).toBe(true);
  });
});
