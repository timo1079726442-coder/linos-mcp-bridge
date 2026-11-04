import { describe, expect, it } from "vitest";
import { publicProbeLayer } from "./connectionStatus.ts";

describe("public connection probe status", () => {
  it("keeps Cloudflare 530 as a public-link degradation, not a local Runtime failure", () => {
    expect(publicProbeLayer(530, true)).toBe("DEGRADED");
  });

  it("requires a fresh observation and keeps normal/unreachable HTTP outcomes distinct", () => {
    expect(publicProbeLayer(200, true)).toBe("PASS");
    expect(publicProbeLayer(404, true)).toBe("FAIL");
    expect(publicProbeLayer(200, false)).toBe("UNKNOWN");
    expect(publicProbeLayer(null, true)).toBe("UNKNOWN");
  });
});
