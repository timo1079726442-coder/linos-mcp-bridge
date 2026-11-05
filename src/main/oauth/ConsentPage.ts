/**
 * ConsentPage — HTML rendering for the OAuth Consent screen.
 *
 * Per CP1 CONSENT_ENDPOINT_SPEC_V2 + CP7:
 *   - Replaces Legacy Pairing Page
 *   - Single Allow / Deny decision (NO pairing code)
 *   - Shows: Workspace name + ID, Client name, Redirect URI, Scopes
 *   - Default-deny any Unknown Redirect before this page even renders
 */

export interface ConsentRenderRequest {
  workspaceName: string;
  workspaceId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
}

export function renderConsentPage(req: ConsentRenderRequest): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const scopeList = req.scopes
    .map((s) => `<li>${esc(scopeLabel(s))}</li>`)
    .join("\n");
  const formAction = "/oauth/authorize";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP Bridge — Consent</title>
<style>
:root { color-scheme: dark; }
body {
  background: #0f1115; color: #e6e8ee; font: 14px -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;
}
.card {
  background: #1c2230; border: 1px solid #2a3142; border-radius: 12px;
  padding: 32px 36px; max-width: 520px; width: 90%; box-shadow: 0 4px 24px rgba(0,0,0,.3);
}
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: #9aa1b3; margin-bottom: 22px; }
.workspace { background: #161a21; border-radius: 8px; padding: 12px 14px; margin-bottom: 18px; }
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 12px; font-size: 13px; }
.kv .k { color: #9aa1b3; }
.kv .v { word-break: break-all; font-family: ui-monospace, monospace; }
.scopes { padding-left: 18px; margin: 12px 0 22px; color: #cdd2dc; }
.scopes li { margin: 4px 0; }
.btns { display: flex; gap: 12px; margin-top: 24px; }
button {
  flex: 1; padding: 12px 14px; font: inherit; font-weight: 600; border: 0;
  border-radius: 8px; cursor: pointer;
}
.allow { background: #4ade80; color: #0f1115; }
.deny { background: transparent; color: #f87171; border: 1px solid #2a3142; }
.warn { color: #f87171; font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
<div class="card">
  <h1>MCP Bridge</h1>
  <p class="sub">${esc(req.clientName)} is requesting access to this workspace.</p>
  <div class="workspace">
    <div class="kv">
      <div class="k">Workspace</div><div class="v">${esc(req.workspaceName)}</div>
      <div class="k">Workspace ID</div><div class="v">${esc(req.workspaceId)}</div>
      <div class="k">Client</div><div class="v">${esc(req.clientName)}</div>
      <div class="k">Redirect URI</div><div class="v">${esc(req.redirectUri)}</div>
    </div>
  </div>
  <p>It will receive these permissions:</p>
  <ul class="scopes">${scopeList}</ul>
  <form method="POST" action="${esc(formAction)}">
    <input type="hidden" name="request_id" value="${esc(extractRequestId(req.redirectUri))}">
    <div class="btns">
      <button type="submit" name="decision" value="deny" class="deny">Deny</button>
      <button type="submit" name="decision" value="allow" class="allow">Allow</button>
    </div>
  </form>
  <p class="warn">No pairing code is required. The bridge uses standard OAuth 2.1.</p>
</div>
</body>
</html>`;
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    "workspace.read": "Read files in this workspace",
    "workspace.search": "Search this workspace",
    "git.read": "Read git status and diffs",
    "execution.read": "Read Codex execution summaries",
    "offline_access": "Stay connected between sessions",
  };
  return labels[scope] ?? scope;
}

function extractRequestId(redirectUri: string): string {
  // The actual request_id is supplied by the OAuth router; for now stub it.
  return redirectUri.slice(-32).replace(/[^A-Za-z0-9_-]/g, "");
}