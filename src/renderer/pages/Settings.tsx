import React, { useEffect, useState } from "react";
import type { ProfileConfig } from "../../shared/types.js";
import { useI18n } from "../i18n/index.tsx";

export function SettingsPage(): JSX.Element {
  const { t, lang, setLang } = useI18n();
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loginItem, setLoginItem] = useState<{ openAtLogin: boolean; openAsHidden: boolean } | null>(null);
  const [healthSec, setHealthSec] = useState("30");
  const [portInput, setPortInput] = useState("48766");
  const [tokenInfo, setTokenInfo] = useState<{ configured: boolean; createdAt?: string | null } | null>(null);
  const [tokenPlain, setTokenPlain] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh(): Promise<void> {
    const a = await window.c2c.profile.getActive();
    setProfile(a);
    if (a) setHealthSec(String(a.healthCheckIntervalSec));
    if (a?.transport?.expectedLocalPort) setPortInput(String(a.transport.expectedLocalPort));
    setTokenInfo(await window.c2c.mcpToken.status().catch(() => null));
    try {
      setLoginItem(await window.c2c.settings.autostartStatus());
    } catch {
      setLoginItem(null);
    }
  }

  async function savePort(): Promise<void> {
    const n = Number(portInput);
    if (!Number.isInteger(n) || n < 1024 || n > 65535 || n === 48765) {
      setErr("端口需为 1024–65535，且不能是保留端口 48765。");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await window.c2c.changePort(n);
      await refresh();
      setMsg(r.changed ? `端口已改为 ${r.port}，Runtime 已在新端口启动。` : "端口未变化。");
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setErr(`改端口失败：${text.includes("IN_USE") ? `端口 ${n} 已被占用` : text}`);
    } finally {
      setBusy(false);
    }
  }

  async function generateToken(): Promise<void> {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await window.c2c.mcpToken.generate();
      setTokenPlain(r.token);
      setTokenInfo(await window.c2c.mcpToken.status());
      setMsg("令牌已生成，只显示这一次；复制后保存好。");
    } catch (cause) {
      setErr(`生成令牌失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await window.c2c.mcpToken.revoke();
      setTokenPlain(null);
      setTokenInfo(await window.c2c.mcpToken.status());
      setMsg("令牌已撤销，旧令牌立即失效。");
    } catch (cause) {
      setErr(`撤销失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveAutoStart(patch: { atLogin?: boolean; minimized?: boolean }): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await window.c2c.settings.updateOrdinary({ autoStart: patch });
      await refresh();
      setMsg("自动启动设置已保存，并已注册到 Windows 登录项。");
    } catch (cause) {
      setErr(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveHealth(): Promise<void> {
    const n = Number(healthSec);
    if (!Number.isInteger(n) || n < 5 || n > 3600) {
      setErr("健康检查间隔需为 5–3600 秒的整数。");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await window.c2c.settings.updateOrdinary({ healthCheckIntervalSec: n });
      await refresh();
      setMsg("健康检查间隔已保存。");
    } catch (cause) {
      setErr(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!profile) {
    return (
      <>
        <div className="page-title">设置</div>
        <div className="banner warn">尚未选择配置，请到工作区页面创建或激活一个。</div>
      </>
    );
  }

  return (
    <>
      <div className="page-title">设置</div>

      <div className="card">
        <div className="section-title">{t("settings.language")}</div>
        <div className="kv">
          <div className="k">{t("settings.language")}</div>
          <div className="v">
            <label style={{ marginRight: 14 }}>
              <input type="radio" name="ui-lang" checked={lang === "zh"} onChange={() => setLang("zh")} /> {t("settings.zh")}
            </label>
            <label>
              <input type="radio" name="ui-lang" checked={lang === "en"} onChange={() => setLang("en")} /> {t("settings.en")}
            </label>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t("settings.languageHint")}</div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">ChatGPT 集成</div>
        <div className="kv">
          <div className="k">ChatGPT 打开地址</div>
          <div className="v">{profile.chatgptLaunchUrl}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">本机端口</div>
        <div className="kv">
          <div className="k">监听端口</div>
          <div className="v">
            <input
              className="input"
              style={{ width: 100 }}
              value={portInput}
              disabled={busy}
              onChange={(event) => setPortInput(event.target.value)}
              aria-label="本机端口"
            />
            <button className="btn secondary" type="button" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void savePort()}>
              保存并重启 Runtime
            </button>
          </div>
          <div className="k">说明</div>
          <div className="v">1024–65535，48766 可用；保留端口 48765 永久禁止。修改会重启本机 Runtime（几秒）。</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">自动启动</div>
        {err && <div className="banner error" role="alert">{err}</div>}
        {msg && <div className="banner info" role="status">{msg}</div>}
        <div className="kv">
          <div className="k">登录 Windows 时启动</div>
          <div className="v">
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                data-testid="settings-autostart-login"
                checked={profile.autoStart.atLogin}
                disabled={busy}
                onChange={(event) => void saveAutoStart({ atLogin: event.target.checked })}
              />
              <span>{profile.autoStart.atLogin ? "已开启" : "已关闭"}</span>
            </label>
          </div>
          <div className="k">启动时最小化（只进托盘）</div>
          <div className="v">
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                data-testid="settings-autostart-minimized"
                checked={profile.autoStart.minimized}
                disabled={busy}
                onChange={(event) => void saveAutoStart({ minimized: event.target.checked })}
              />
              <span>{profile.autoStart.minimized ? "已开启" : "已关闭"}</span>
            </label>
          </div>
          <div className="k">Windows 登录项（实际）</div>
          <div className="v">
            {loginItem
              ? (loginItem.openAtLogin ? `已注册${loginItem.openAsHidden ? "（静默启动）" : ""}` : "未注册")
              : "无法读取"}
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          修改会立即写入 Windows 登录项，不只是改配置文件；关闭后下次登录不会自动启动。
        </p>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">自动修复</div>
        <div className="kv">
          <div className="k">策略</div>
          <div className="v">{profile.autoRepair.policy === "STRICT_FAIL_CLOSED" ? "严格安全模式（STRICT_FAIL_CLOSED）" : profile.autoRepair.policy}</div>
          <div className="k">每日最大尝试次数</div>
          <div className="v">{profile.autoRepair.maxRetriesPerDay}</div>
          <div className="k">冷却时间（秒）</div>
          <div className="v">{profile.autoRepair.cooldownSec}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">健康检查</div>
        <div className="kv">
          <div className="k">检查间隔（秒）</div>
          <div className="v">
            <input
              className="input"
              style={{ width: 100 }}
              value={healthSec}
              disabled={busy}
              onChange={(event) => setHealthSec(event.target.value)}
              aria-label="健康检查间隔"
            />
            <button className="btn secondary" type="button" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void saveHealth()}>
              保存
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">其他 AI 客户端（Claude / Cursor / Agent 等）</div>
        <p className="muted" style={{ fontSize: 12 }}>
          ChatGPT 用 OAuth 连接；其他客户端多数不支持动态注册，用这里的长期令牌接入（Bearer）。
        </p>
        <div className="kv">
          <div className="k">MCP 地址</div>
          <div className="v"><code>{profile.transport?.publicMcpUrl ?? `http://127.0.0.1:${profile.transport?.expectedLocalPort ?? 48766}/mcp`}</code></div>
          <div className="k">令牌状态</div>
          <div className="v">{tokenInfo?.configured ? `已生成（${tokenInfo.createdAt ? new Date(tokenInfo.createdAt).toLocaleString() : "时间未知"}）` : "未生成"}</div>
        </div>
        {tokenPlain && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12 }}>令牌只显示这一次，请立刻复制保存：</div>
            <code style={{ display: "block", marginTop: 4, wordBreak: "break-all" }}>{tokenPlain}</code>
            <button className="btn secondary" type="button" style={{ marginTop: 6 }} onClick={() => void navigator.clipboard.writeText(tokenPlain)}>复制令牌</button>
          </div>
        )}
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn" type="button" disabled={busy} onClick={() => void generateToken()}>生成令牌</button>
          <button className="btn secondary" type="button" disabled={busy || !tokenInfo?.configured} onClick={() => void revokeToken()}>撤销令牌</button>
        </div>
        {tokenInfo?.configured && (
          <pre className="muted" style={{ fontSize: 11, marginTop: 10, whiteSpace: "pre-wrap" }}>{`# 任意 MCP 客户端（HTTP）
url: ${profile.transport?.publicMcpUrl ?? `http://127.0.0.1:${profile.transport?.expectedLocalPort ?? 48766}/mcp`}
header: Authorization: Bearer <上面生成的令牌>`}</pre>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">安全状态</div>
        <div className="kv">
          <div className="k">密钥状态</div>
          <div className="v">已安全配置</div>
          <div className="k">可信回调地址</div>
          <div className="v">
            内置 {profile.trustedRedirectPolicy.builtinOrigins.length} 个，用户批准 {profile.trustedRedirectPolicy.userApprovedOrigins.length} 个
          </div>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          密钥只显示状态，不显示任何明文。
        </div>
      </div>
    </>
  );
}
