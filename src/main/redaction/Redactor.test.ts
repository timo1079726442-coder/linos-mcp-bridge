import { describe, it, expect } from "vitest";
import { redactString, redactObject, redactJson } from "./Redactor.js";

describe("Redactor (CP9 SECURITY_MODEL_V2 §7)", () => {
  it("redacts runtimeInstanceSecret prefix", () => {
    const out = redactString("secret=c2c_ri_secret_aGVsbG90aGVyZQabc123");
    expect(out).not.toContain("c2c_ri_secret_aGVsbG90aGVyZQabc123");
    expect(out).toContain("[REDACTED:runtimeInstanceSecret]");
  });

  it("redacts adminToken prefix", () => {
    const out = redactString("token: c2c_admin_xyz_123");
    expect(out).not.toContain("c2c_admin_xyz_123");
    expect(out).toContain("[REDACTED:adminToken]");
  });

  it("redacts access/refresh tokens", () => {
    const a = redactString("access=c2c_at_long_token_value");
    const r = redactString("refresh=c2c_rt_long_token_value");
    expect(a).toContain("[REDACTED:accessToken]");
    expect(r).toContain("[REDACTED:refreshToken]");
  });

  it("redacts Authorization Bearer header", () => {
    const out = redactString('Authorization: Bearer abc123def456ghi789jkl012mno345pqr678');
    expect(out).toContain("[REDACTED:bearer]");
    expect(out).not.toContain("abc123def456ghi789");
  });

  it("redacts long hex blobs (likely keys)", () => {
    const hex = "a".repeat(64);
    const out = redactString(`key=${hex}`);
    expect(out).toContain("[REDACTED:hexBlob]");
    expect(out).not.toContain(hex);
  });

  it("redacts client_secret and password fields", () => {
    const out = redactString("client_secret=mysecret123 password=hunter2");
    expect(out).toContain("[REDACTED:clientSecret]");
    expect(out).toContain("[REDACTED:password]");
    expect(out).not.toContain("mysecret123");
    expect(out).not.toContain("hunter2");
  });

  it("redactObject recursively traverses objects/arrays", () => {
    const obj = {
      a: "normal",
      b: { token: "c2c_at_inner_token_xyz" },
      c: ["c2c_admin_in_list", { apiKey: "a".repeat(64) }],
    };
    const out = redactObject(obj) as typeof obj;
    expect(out.a).toBe("normal");
    expect(out.b.token).toContain("[REDACTED:accessToken]");
    expect(out.c[0]).toContain("[REDACTED:adminToken]");
    expect((out.c[1] as { apiKey: string }).apiKey).toContain("[REDACTED:");
  });

  it("redacts short secrets by field name and in diagnostic URLs/arguments", () => {
    const out = redactObject({
      clientSecret: "short-secret",
      publicMcpUrl: "https://example.test/mcp?token=abc123&mode=readonly",
      processCmdline: "--api-key short-key --port 48766",
    });
    const encoded = JSON.stringify(out);
    expect(encoded).not.toContain("short-secret");
    expect(encoded).not.toContain("abc123");
    expect(encoded).not.toContain("short-key");
    expect(encoded).toContain("mode=readonly");
    expect(encoded).toContain("48766");
  });

  it("redactJson produces JSON string with redactions", () => {
    const json = redactJson({
      access: "c2c_at_something_secret",
      profile: { name: "DIAG" },
    });
    expect(json).not.toContain("c2c_at_something_secret");
    expect(json).toContain("[REDACTED:accessToken]");
    expect(json).toContain("DIAG"); // normal fields preserved
  });

  it("non-secret strings pass through", () => {
    expect(redactString("hello world")).toBe("hello world");
    expect(redactString("port 48766")).toBe("port 48766");
  });
});
