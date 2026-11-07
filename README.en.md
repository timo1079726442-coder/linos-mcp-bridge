# LinOS MCP Bridge

[中文说明](README.md) · **English**

![CI](https://github.com/timo1079726442-coder/linos-mcp-bridge/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

A self-hosted **MCP (Model Context Protocol) server** that turns your local machine into a safe pair of hands for AI: file read/write, command execution, Git, and long-running jobs — exposed to ChatGPT and any MCP client (Cursor, Claude Desktop, Codex, VS Code…), with a desktop control center, audit chain, and resumable hand-offs.

> ⚠️ **Security first**: this app lets AI act as **your Windows user**. Read-only tools are on by default; writing, command execution, PowerShell and screen capture must be enabled explicitly. Never run “full permission” mode on a machine you do not trust.

---

## Why this exists

| Pain point | What this project does |
|---|---|
| Web ChatGPT cannot touch local files | Local MCP server + optional Cloudflare tunnel (public HTTPS endpoint) |
| OAuth setup for MCP clients is fiddly | Built-in OAuth 2.1 + PKCE + dynamic client registration + 8-character pairing code |
| AI file edits are not trustworthy | Two-phase writes: `prepare_write` (dry-run, hash, nothing written) → `commit_operation` (re-check, backup, write, read back) |
| Long tasks die when the chat disconnects | Background jobs (`start_job` / `job_status` / `job_resume`) with checkpoints |
| Switching AI loses all context | Project board (`.c2c/projects/*.json`) + one-click hand-off card any agent can read |
| No idea what the AI actually did | Hash-chained audit of every tool call (tool, path, result, file SHA256, caller) |
| Non-MCP web AIs (DeepSeek / Gemini / Qwen) | Bundled browser extension (Chrome/Edge) that calls your local tools from the page |

## Architecture

```
Electron main (window / tray / IPC)
 ├─ Supervisor child        named pipe + capability MAC
 │   └─ Runtime child      HTTP 127.0.0.1:48766/mcp (JSON-RPC 2.0)
 └─ cloudflared child (optional)  public named tunnel
```

- The renderer has no Node access; it can only call whitelisted IPC exposed by preload.
- Every IPC channel requires the caller to present the expected capability string.
- Every runtime path must resolve inside the workspace; anything else is rejected.
- Command execution is allowlisted (git / npm / python / pytest / node) and rejects shell metacharacters and `-c` / `--exec`.
- Audit entries are chained (`prevHash` + `hash`) so tampering is detectable.

## Quick start

Requires Windows 10/11 and Node.js ≥ 20.

```powershell
git clone https://github.com/timo1079726442-coder/linos-mcp-bridge.git
cd linos-mcp-bridge
npm ci
npm run build:runtime
npm run build
npm start
```

First launch opens a quick setup: choose workspace folder → choose port (default `48766`) → generate a pairing code.

### One-command setup

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

It checks Node, installs dependencies, builds runtime + app, and prints the exact next steps.

## Public access: pick one

| Option | Good for | How |
|---|---|---|
| **Local only** (default) | Trying it out, privacy | Nothing to do; MCP URL is `http://127.0.0.1:48766/mcp` |
| **Temporary tunnel** (quick) | Same-day testing with ChatGPT | `.\scripts\tunnel-quick.ps1` → prints a `https://xxx.trycloudflare.com` URL that changes every run |
| **Your own domain** (named) | Daily use, stable URL | `.\scripts\tunnel-named.ps1 -Domain mcp.example.com` → follow the printed cloudflared steps once, then the URL is permanent |

Details and troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).

## Download and verify (portable)

If you would rather not build from source, use the release artifact:

| File | Purpose |
|---|---|
| `LinOS-MCP-Portable-<version>-x64.zip` | Unzip and run. No Node.js install, no registry writes |
| `SHA256SUMS.txt` | Verify the download is intact and untampered |
| `sbom.json` | Dependency inventory (CycloneDX) for third-party review |

```powershell
Get-FileHash .\LinOS-MCP-Portable-0.1.1-x64.zip -Algorithm SHA256   # must match SHA256SUMS.txt
Expand-Archive .\LinOS-MCP-Portable-0.1.1-x64.zip -DestinationPath D:\LinOS-MCP
# then run D:\LinOS-MCP\LinOS MCP.exe
```

Two things to know up front:

- **Not code-signed yet**: the first launch shows the SmartScreen "unknown publisher" prompt. Verify the SHA256 above; signing is planned for a later release.
- **Windows audit durability**: the audit journal `fsync`s file contents, but Windows cannot `fsync` directory entries, so the runtime reports `FILE_SYNC_ONLY`. Tamper detection and fail-closed behaviour (high-risk calls are refused when auditing cannot be persisted) are unaffected.


## Connect ChatGPT

1. Control center → **连接授权 / Connect** → generate pairing code;
2. ChatGPT → Settings → Connectors → create custom connector, URL = `https://<your-domain>/mcp`;
3. Enter the pairing code on the OAuth page → allow.

## Connect other clients

- **Cursor / Claude Desktop / Codex / VS Code**: Settings → “其他 AI 接入” generates a long-lived token and ready-to-paste config snippets.
- **Web AIs (DeepSeek / Gemini / Qwen)**: install the browser extension from `extension/`; a panel appears on the page.

## Security model (read this)

| Capability | Default | Notes |
|---|---|---|
| Read files / search / Git read | ✅ on | Read-only, low risk |
| Write files | ⚠️ confirm | Two-phase write, backup, read-back |
| Command execution | ❌ off | Allowlisted binaries only |
| PowerShell | ❌ off | Enabling means “run anything as your user” |
| Screen capture | ❌ off | Not implemented yet; calls return “not available” |
| Public tunnel | ❌ off | Exposes `/mcp` publicly; protected by OAuth/token |

Recommended path: read-only first → enable writes once you trust the workflow → enabling commands and PowerShell last.

## Repository layout

```
src/main          Electron main process (IPC, supervisor adapter, tray, health)
src/preload       whitelisted API exposed to the renderer
src/renderer      React UI (dashboard, connect, workspace, diagnostics, board, progress)
runtime/src       MCP server (HTTP/OAuth, tools, audit, job engine)
extension/        Chrome/Edge extension
scripts/          setup and verification scripts
```

## Tests

```powershell
npm test                 # main package (~420 tests)
cd runtime; npm test     # runtime (~109 tests)
```

## Status

Early but usable (`0.1.0`). APIs and configuration may change; evaluate the security boundary before production use.

## License

MIT — see [LICENSE](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Contributing

This project was written to be handed over, not hoarded. Everyone is welcome.

| I want to… | Start here |
|---|---|
| Report a bug / request a feature | [Issues](../../issues) (templates included; report vulnerabilities privately, see [SECURITY.md](SECURITY.md)) |
| Pick up a task | [ROADMAP.md](ROADMAP.md) — `good first issue` is the entry point |
| Send code | [CONTRIBUTING.md](CONTRIBUTING.md): `npm run typecheck` + both test suites must pass |
| Discuss a design | Open an issue with "problem + proposal + trade-offs" before writing a big PR |
| Improve docs / translate | English INSTALL, more client recipes — all needed |

**Principles**: secure by default (new capabilities ship off), verifiable (a fix comes with reproduction steps), reversible (destructive actions need backup and rollback).

## One-click

1. Double-click `install.cmd` (deps + build + launch)
2. Afterwards use `start.cmd`
3. To expose it publicly: `scripts\tunnel-quick.ps1` (same-day trial) or `scripts\tunnel-named.ps1 -Domain your.domain` (stable)