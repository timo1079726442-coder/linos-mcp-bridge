import { describe, it, expect } from "vitest";
import { TrustedRedirectPolicy } from "./TrustedRedirectPolicy.js";

describe("TrustedRedirectPolicy (CP7 DCR Safety)", () => {
  it("rejects unknown redirect_uri by default (FAIL CLOSED)", () => {
    const p = new TrustedRedirectPolicy({
      builtinOrigins: [],
      userApprovedOrigins: [],
      signedPolicyUpdates: [],
    });
    const r = p.check("https://chatgpt.com/oauth/callback");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("redirect_uri_unknown");
  });

  it("rejects wildcard redirect_uri regardless of source", () => {
    const p = new TrustedRedirectPolicy({
      builtinOrigins: [],
      userApprovedOrigins: ["https://*.openai.com/cb"],
      signedPolicyUpdates: [],
    });
    expect(p.check("https://*.openai.com/cb").ok).toBe(false);
  });

  it("accepts user-approved exact origin (no wildcards)", () => {
    const p = new TrustedRedirectPolicy({
      builtinOrigins: [],
      userApprovedOrigins: ["https://chatgpt.com/oauth/callback"],
      signedPolicyUpdates: [],
    });
    expect(p.check("https://chatgpt.com/oauth/callback").ok).toBe(true);
  });

  it("rejects http redirect except localhost (development)", () => {
    const p = new TrustedRedirectPolicy({
      builtinOrigins: [],
      userApprovedOrigins: ["http://chatgpt.com/cb"],
      signedPolicyUpdates: [],
    });
    expect(p.check("http://chatgpt.com/cb").ok).toBe(false);
    expect(p.check("http://localhost/cb").ok).toBe(true);
  });

  it("rejects malformed redirect_uri", () => {
    const p = new TrustedRedirectPolicy({ builtinOrigins: [], userApprovedOrigins: [], signedPolicyUpdates: [] });
    expect(p.check("not-a-url").ok).toBe(false);
  });

  it("signed policy update accepted if not expired", () => {
    const p = new TrustedRedirectPolicy({
      builtinOrigins: [],
      userApprovedOrigins: [],
      signedPolicyUpdates: [{
        origin: "https://chatgpt.com/cb",
        signature: "stub",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    expect(p.check("https://chatgpt.com/cb").ok).toBe(true);
  });
});