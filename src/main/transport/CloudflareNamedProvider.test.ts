import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 不依赖本机是否安装 cloudflared：用一个真实存在的临时假二进制。
const stubBinary = path.join(mkdtempSync(path.join(tmpdir(), "cfbin-")), "cloudflared.exe");
writeFileSync(stubBinary, "stub");

beforeAll(() => {
  // Stub mode: do not actually spawn cloudflared.
  process.env.C2C_TEST_NO_CLOUDFLARED = "1";
});
import { CloudflareNamedProvider } from "./CloudflareNamedProvider.js";

const cfg = {
  provider: "cloudflare-named",
  hostname: "mcp-legacy.example.com",
  zone: "example.com",
  tunnelName: "mcpbridge-tunnel",
  tunnelId: "590b136e-4641-416d-820b-7708bf9179c0",
  // 用临时假二进制，保证在任何机器/CI 上都能通过（不依赖本机是否装了 cloudflared）。
  binaryPath: stubBinary,
  expectedLocalPort: 48765,
};

describe("CloudflareNamedProvider", () => {
  it("starts and reports running URL", async () => {
    const p = new CloudflareNamedProvider(cfg);
    const h = await p.start(48765);
    expect(h.url).toBe(`https://${cfg.hostname}`);
    const s = p.getStatus();
    expect(s.running).toBe(true);
    expect(s.url).toBe(`https://${cfg.hostname}`);
    expect(s.provider).toBe("cloudflare-named");
  });

  it("stops cleanly", async () => {
    const p = new CloudflareNamedProvider(cfg);
    await p.start(48765);
    await p.stop();
    expect(p.getStatus().running).toBe(false);
  });

  it("restart returns a fresh handle", async () => {
    const p = new CloudflareNamedProvider(cfg);
    await p.start(48765);
    const h = await p.restart(48765);
    expect(h.url).toBe(`https://${cfg.hostname}`);
  });

  it("health() returns structured TransportHealth", async () => {
    const p = new CloudflareNamedProvider(cfg);
    await p.start(48765);
    const h = await p.health();
    expect(h.binaryFound).toBe(true);
    expect(h.binaryPath).toBe(cfg.binaryPath);
    expect(h.edge.connected).toBe(true);
    expect(h.edge.ips.length).toBeGreaterThan(0);
  });
});