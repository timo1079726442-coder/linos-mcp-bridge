import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ProfileConfig } from "../../shared/types.js";
import type { ManagedServiceView } from "../../shared/multiService.js";

interface Target {
  id: string;
  name: string;
  port: number;
  url: string;
  publicUrl: boolean;
  status: "PASS" | "WARN" | "FAIL" | "UNKNOWN";
}

export function ConnectPage(): JSX.Element {
  const [active, setActive] = useState<ProfileConfig | null>(null);
  const [extras, setExtras] = useState<ManagedServiceView[]>([]);
  const [selected, setSelected] = useState("current");
  const [code, setCode] = useState<string | null>(null);
  const [allowReconnect, setAllowReconnect] = useState(false);
  const [reconnectFile, setReconnectFile] = useState<string>("");
  useEffect(() => {
    void window.c2c.oauthReconnect.get().then((res) => { setAllowReconnect(res.allowReconnectWithoutIntent); setReconnectFile(res.file); }).catch(() => undefined);
  }, []);
  async function saveReconnect(next: boolean): Promise<void> {
    setAllowReconnect(next);
    try {
      const res = await window.c2c.oauthReconnect.set(next);
      setReconnectFile(res.file);
    } catch (cause) {
      setAllowReconnect(!next);
      window.alert(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  /** 全权模式：ChatGPT 获得与 Agent 同等的全部工具权限（写入 / 命令 / 后台任务）。 */
  const [allPower, setAllPower] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [profile, services] = await Promise.all([
        window.c2c.profile.getActive(),
        window.c2c.multiService.list().catch(() => []),
      ]);
      setActive(profile);
      setExtras(services);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const targets: Target[] = [];
  if (active) {
    const publicUrl = active.transport.publicMcpUrl;
    targets.push({
      id: "current",
      name: active.profileName,
      port: active.transport.expectedLocalPort,
      url: publicUrl ?? `http://127.0.0.1:${active.transport.expectedLocalPort}/mcp`,
      publicUrl: Boolean(publicUrl),
      status: publicUrl ? "PASS" : "WARN",
    });
  }
  for (const service of extras) {
    targets.push({
      id: service.id,
      name: service.name,
      port: service.port,
      url: service.publicMcpUrl ?? `http://127.0.0.1:${service.port}/mcp`,
      publicUrl: Boolean(service.publicMcpUrl),
      status: service.status === "RUNNING" ? "PASS" : "FAIL",
    });
  }
  const target = targets.find((item) => item.id === selected) ?? targets[0] ?? null;

  async function generate(): Promise<void> {
    if (!target || busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      // ChatGPT 的 DCR 会先打到 /oauth/register，Runtime 要求存在"本机连接意图"，
      // 否则返回 503 connection_intent_required，ChatGPT 侧表现为
      // "部分应用设置未通过验证"。所以必须先建意图，再发配对码。
      if (target.id === "current") {
        // 全权模式：把本机全部 scope 作为本次授权上限，ChatGPT 才能用写入/命令/后台任务。
        await window.c2c.intent.create({ grantAllScopes: allPower }).catch(() => undefined);
      }
      const result = await window.c2c.service.createPairing(target.port);
      setCode(result.code);
      setExpiresAt(result.expiresAt);
      setMsg(allPower
        ? "已创建「全权」连接意图并生成配对码。请在 ChatGPT 里重新授权该连接器（移除后重新添加），新令牌才带全部权限。"
        : "配对码已生成，60 分钟内有效。请在 ChatGPT 里立即添加连接器并输入它。");
    } catch (cause) {
      setErr(`生成失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">连接授权</div>
          <p className="muted v2-subtitle">把 ChatGPT 或其他客户端接到某个 MCP 服务；服务本身的端口、隧道和权限在「MCP 服务」里。</p>
        </div>
        <Link className="btn secondary" to="/services">管理 MCP 服务</Link>
      </div>

      {err && <div className="banner error" role="alert">{err}</div>}
      {msg && <div className="banner info" role="status">{msg}</div>}

      <div className="v2-grid-2">
        <section className="v2-card">
          <div className="v2-card-head"><strong>接入目标服务</strong></div>
          {targets.length === 0 ? (
            <p className="muted">还没有服务。先去 <Link to="/services/new">新建 MCP 服务</Link>。</p>
          ) : (
            <>
              <label className="muted" style={{ fontSize: 12 }}>选择要授权给 ChatGPT 的服务
                <select className="input" style={{ width: "100%", marginTop: 6 }} value={target?.id}
                  onChange={(event) => { setSelected(event.target.value); setCode(null); }}>
                  {targets.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}（端口 {item.port}，{item.publicUrl ? "公网" : "仅本机"}）
                    </option>
                  ))}
                </select>
              </label>
              <div className="kv" style={{ marginTop: 12 }}>
                <div className="k">MCP URL</div>
                <div className="v"><code>{target?.url}</code></div>
                <div className="k">公网状态</div>
                <div className="v">
                  {target?.publicUrl
                    ? <span className="v2-badge pass">可用于 ChatGPT</span>
                    : <span className="v2-badge warn">仅本机 · ChatGPT 网页版无法访问</span>}
                </div>
              </div>
              {!target?.publicUrl && (
                <div className="banner warn" style={{ marginTop: 10 }}>
                  当前服务没有公网 URL，ChatGPT 网页版访问不到。
                  <Link className="btn" style={{ marginLeft: 8 }} to="/setup" data-testid="connect-configure-tunnel">
                    去配置命名隧道 / 临时隧道
                  </Link>
                </div>
              )}
              {target?.id === "current" && (
                <label
                  data-testid="connect-all-power"
                  style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={allPower}
                    onChange={(event) => setAllPower(event.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ fontSize: 13 }}>
                    <strong>全权模式</strong>：让 ChatGPT 拥有与 Agent 同等的全部工具权限
                    （写入文件、执行命令、后台长任务）。勾选后需在 ChatGPT 里移除并重新添加连接器，
                    新令牌才会带全部权限。关闭则仅只读。
                  </span>
                </label>
              )}
              <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button className="btn secondary" type="button" disabled={!target} onClick={() => void navigator.clipboard.writeText(target?.url ?? "")}>复制 MCP URL</button>
                <button className="btn" type="button" disabled={!target || busy} onClick={() => void generate()}>
                  {busy ? "生成中…" : "获取配对码"}
                </button>
                <button className="btn secondary" type="button" onClick={() => void window.c2c.intent.openChatgpt()}>打开 ChatGPT</button>
              </div>
            </>
          )}
        </section>

        <section className="v2-card">
          <div className="v2-card-head"><strong>配对码</strong><span className="v2-badge pass">一次性</span></div>
          {code ? (
            <>
              <div className="v2-code">{code}</div>
              <p className="muted" style={{ fontSize: 12 }}>有效期至 {expiresAt ? new Date(expiresAt).toLocaleTimeString() : "—"}</p>
              <button className="btn secondary" type="button" onClick={() => void navigator.clipboard.writeText(code)}>复制配对码</button>
            </>
          ) : (
            <p className="muted">先生成配对码，再在 ChatGPT 的 OAuth 授权页输入。配对码不能替代 OAuth 本机确认。</p>
          )}
          <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={allowReconnect} disabled={busy}
              onChange={(e) => void saveReconnect(e.target.checked)} />
            已授权过的客户端重连时免配对码（默认关闭）
          </label>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            开启后：只要本机仍有未撤销、未过期的授权，ChatGPT 掉线重连不会再要求输入 8 位配对码；
            第一次授权、或授权已被撤销/过期时，仍必须在本机生成配对码。{reconnectFile ? `（保存于 ${reconnectFile}）` : ""}
          </p>
          <ol className="v2-steps">
            <li>复制 MCP URL。</li>
            <li>ChatGPT → 设置 → Connectors → 添加自定义连接器，粘贴 URL。</li>
            <li>在打开的 OAuth 页面输入配对码，完成授权。</li>
          </ol>
        </section>
      </div>

      <section className="v2-card v2-note">
        <strong>其他客户端</strong>
        <p className="muted">Cursor、Claude Desktop 等使用同一 MCP URL；配置片段在 <Link to="/connect/clients">其他客户端</Link>。</p>
      </section>
    </div>
  );
}
