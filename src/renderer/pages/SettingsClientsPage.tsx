import { useEffect, useState } from "react";
import type { ProfileConfig } from "../../shared/types.js";

/**
 * 其他 AI 客户端接入：一个长期令牌 + 现成的配置片段。
 * 非 OAuth 客户端（Cursor / Claude / Codex / VS Code）用这个接。
 */
export function SettingsClientsPage(): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [tokenInfo, setTokenInfo] = useState<{ configured: boolean; createdAt?: string | null } | null>(null);
  const [tokenPlain, setTokenPlain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportPath, setExportPath] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setProfile(await window.c2c.profile.getActive().catch(() => null));
      setTokenInfo(await window.c2c.mcpToken.status().catch(() => null));
    })();
  }, []);

  const localUrl = profile?.transport?.expectedLocalPort
    ? `http://127.0.0.1:${profile.transport.expectedLocalPort}/mcp`
    : "http://127.0.0.1:<端口>/mcp";
  const publicUrl = profile?.transport?.publicMcpUrl ?? null;
  const url = publicUrl ?? localUrl;

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await window.c2c.mcpToken.generate();
      setTokenPlain(res.token);
      setTokenInfo(await window.c2c.mcpToken.status());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    setBusy(true);
    try {
      await window.c2c.mcpToken.revoke();
      setTokenPlain(null);
      setTokenInfo(await window.c2c.mcpToken.status());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const token = tokenPlain ?? "<令牌>";
  const snippets: Array<{ name: string; file: string; code: string }> = [
    {
      name: "Cursor",
      file: ".cursor/mcp.json",
      code: JSON.stringify({ mcpServers: { "linos-c2c": { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
    {
      name: "Claude 桌面版",
      file: "claude_desktop_config.json",
      code: JSON.stringify({ mcpServers: { "linos-c2c": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
    {
      name: "Codex CLI",
      file: "~/.codex/config.toml",
      code: `[mcp_servers.linos-c2c]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`,
    },
    {
      name: "VS Code + Copilot",
      file: ".vscode/mcp.json",
      code: JSON.stringify({ servers: { "linos-c2c": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
  ];

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div>
          <h1>其他 AI 接入</h1>
          <p>ChatGPT 用 OAuth 连接器；Cursor / Claude / Codex / VS Code 这类客户端用这里的长期令牌。</p>
        </div>
      </div>

      {error && <p className="err">{error}</p>}

      <section className="card">
        <div className="section-title">1. 地址</div>
        <div className="kv">
          <div className="k">本机地址</div><div className="v"><code>{localUrl}</code></div>
          <div className="k">外网地址</div><div className="v">{publicUrl ? <code>{publicUrl}</code> : "未开启公网（去「MCP 服务 → 公网隧道」开）"}</div>
          <div className="k">令牌状态</div>
          <div className="v">{tokenInfo?.configured ? `已生成（${tokenInfo.createdAt ? new Date(tokenInfo.createdAt).toLocaleString() : "时间未知"}）` : "未生成"}</div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="section-title">2. 生成令牌（只显示一次）</div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" type="button" disabled={busy} onClick={() => void generate()}>生成令牌</button>
          <button className="btn secondary" type="button" disabled={busy || !tokenInfo?.configured} onClick={() => void revoke()}>撤销令牌</button>
        </div>
        {tokenPlain && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12 }}>立刻复制保存，关掉就不再显示：</div>
            <code style={{ display: "block", marginTop: 4, wordBreak: "break-all" }}>{tokenPlain}</code>
            <button className="btn secondary" type="button" style={{ marginTop: 6 }}
              onClick={() => void navigator.clipboard.writeText(tokenPlain)}>复制令牌</button>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="section-title">3. 粘贴到客户端配置</div>
        {snippets.map((snippet) => (
          <div key={snippet.name} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{snippet.name} <span className="muted" style={{ fontWeight: 400 }}>（{snippet.file}）</span></div>
            <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 12, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 8 }}>{snippet.code}</pre>
            <button className="btn secondary" type="button" style={{ marginTop: 4 }}
              onClick={() => void navigator.clipboard.writeText(snippet.code)}>复制这段</button>
          </div>
        ))}
      </section>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="section-title">网页版 AI（DeepSeek / Gemini / 千问，本身不支持 MCP）</div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          这些网页无法直接接 MCP。一键方案是装我们的浏览器扩展：网页右下角出现 C2C 面板，选工具、执行、复制结果回对话。
        </p>
        <div className="kv">
          <div className="k">扩展下载</div>
          <div className="v"><code>（本仓库 Releases 页）</code> → 下载 <code>LinOS-C2C-Extension-0.1.0.zip</code></div>
          <div className="k">安装（Chrome）</div>
          <div className="v">打开 <code>chrome://extensions</code> → 开启「开发者模式」→「加载已解压的扩展程序」→ 选解压后的 extension 目录</div>
          <div className="k">Edge</div>
          <div className="v"><code>edge://extensions</code> → 开启「开发人员模式」→「加载解压缩的扩展」</div>
          <div className="k">配置</div>
          <div className="v">点网页右下角 C2C → ⚙ → 填上面的地址与令牌 → 保存 → 点「列出工具」</div>
        </div>
        <button className="btn" type="button" style={{ marginTop: 8, marginRight: 8 }}
          onClick={() => {
            void window.c2c.extension.exportBundle()
              .then((r) => { setExportPath(r.path); })
              .catch((e: unknown) => setExportPath(`导出失败：${e instanceof Error ? e.message : String(e)}`));
          }}>
          导出扩展到这个电脑
        </button>
        {exportPath && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{exportPath}</div>}
        <button className="btn secondary" type="button" style={{ marginTop: 8 }}
          onClick={() => void navigator.clipboard.writeText(`1) 下载扩展：（本仓库 Releases 页） （LinOS-C2C-Extension-0.1.0.zip）\n2) Chrome 打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序\n3) 选择解压后的 extension 目录\n4) 打开网页版 AI，点右下角 C2C → ⚙ 填地址 ${url} 与令牌\n5) 点“列出工具”，选工具执行，复制结果回对话`)}>
          复制安装步骤
        </button>
      </section>
      <section className="card" style={{ marginTop: 12 }}>
        <div className="section-title">4. 不装客户端也能验证</div>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{`$t = "Bearer <令牌>"\n$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'\nInvoke-RestMethod -Uri "${url}" -Method Post -Headers @{ Authorization = $t } -ContentType "application/json" -Body $body |\n  Select-Object -ExpandProperty result | Select-Object -ExpandProperty tools | Measure-Object`}</pre>
        <p className="muted" style={{ fontSize: 12 }}>返回工具数量（几十个）就说明令牌有效。</p>
      </section>
    </div>
  );
}
