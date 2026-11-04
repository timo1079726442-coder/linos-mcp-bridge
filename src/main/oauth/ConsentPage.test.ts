import { describe, it, expect } from "vitest";
import { renderConsentPage } from "./ConsentPage.js";

describe("ConsentPage (CP7 Replaces Legacy Pairing Code)", () => {
  it("renders workspace + client + redirect + scopes; NO pairing code input", () => {
    const html = renderConsentPage({
      workspaceName: "C:\workspace",
      workspaceId: "ws_example",
      clientName: "ChatGPT",
      redirectUri: "https://chatgpt.com/oauth/callback",
      scopes: ["workspace.read", "git.read"],
    });
    expect(html).toContain("C:\workspace");
    expect(html).toContain("ws_example");
    expect(html).toContain("ChatGPT");
    expect(html).toContain("https://chatgpt.com/oauth/callback");
    expect(html).toContain("Read files in this workspace");
    expect(html).toContain("Read git status and diffs");
    // Single Allow / Deny decision (no pairing code)
    expect(html).toMatch(/name="decision"\s+value="allow"/);
    expect(html).toMatch(/name="decision"\s+value="deny"/);
    // Verify NO <input> named pairing_code exists (Legacy pattern we replaced)
    expect(html).not.toMatch(/<input[^>]*name=["']?pairing[-_]?code/i);
    // The visible explanatory text may mention "no pairing code" — that's correct.
    expect(html.toLowerCase()).toContain("no pairing code");
  });

  it("escapes HTML special characters in user-controlled fields", () => {
    const html = renderConsentPage({
      workspaceName: "<script>alert(1)</script>",
      workspaceId: "ws\"id",
      clientName: "name&<>",
      redirectUri: "https://x.com/cb?a=b&c=d",
      scopes: ["scope<x>"],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("name&amp;&lt;&gt;");
    expect(html).toContain("scope&lt;x&gt;");
  });
});