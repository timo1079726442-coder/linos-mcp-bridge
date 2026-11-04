import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ProfileConfig } from "../../shared/types.js";

export function ConnectClientsPage(): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.c2c.profile.getActive().then(setProfile).catch(() => undefined);
  }, []);

  const port = profile?.transport.expectedLocalPort ?? 48766;
  const url = profile?.transport.publicMcpUrl ?? `http://127.0.0.1:${port}/mcp`;
  const snippet = JSON.stringify({
    mcpServers: {
      "linos-c2c": {
        url,
        transport: "http",
      },
    },
  }, null, 2);

  return (
    <div className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">其他客户端</div>
          <p className="muted v2-subtitle">Cursor、Claude Desktop 等使用同一个 MCP URL；公网地址需要命名隧道。</p>
        </div>
        <Link className="btn secondary" to="/connect">← 返回连接授权</Link>
      </div>

      <div className="v2-grid-2">
        <section className="v2-card">
          <div className="v2-card-head"><strong>当前服务地址</strong></div>
          <div className="kv">
            <div className="k">Profile</div><div className="v">{profile?.profileName ?? "读取中…"}</div>
            <div className="k">MCP URL</div><div className="v"><code>{url}</code></div>
            <div className="k">公网</div><div className="v">{profile?.transport.publicMcpUrl ? <span className="v2-badge pass">已配置</span> : <span className="v2-badge warn">仅本机</span>}</div>
          </div>
          <button className="btn secondary" type="button" onClick={() => void navigator.clipboard.writeText(url)}>复制 URL</button>
        </section>

        <section className="v2-card">
          <div className="v2-card-head"><strong>MCP 配置片段</strong></div>
          <pre className="v2-pre">{snippet}</pre>
          <button className="btn" type="button" onClick={() => {
            void navigator.clipboard.writeText(snippet);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}>{copied ? "已复制" : "复制配置"}</button>
        </section>
      </div>

      <div className="banner warn">
        URL 必须是公网 HTTPS 才能被远程客户端访问；本机地址只适合同一台电脑上的客户端。
      </div>
    </div>
  );
}
