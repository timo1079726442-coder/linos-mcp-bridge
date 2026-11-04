import React, { useEffect, useState } from "react";
import type { ProfileConfig } from "../../shared/types.js";

type Step = 1 | 2 | 3;
type Mode = "local" | "quick-tunnel" | "named";

/**
 * 首次使用引导（三步）：
 *   1. 选文件夹 → 建本机 Profile（含回读校验）
 *   2. 选连接方式：仅本机 / 临时公网地址
 *   3. 生成配对码 + 连接器地址，去 ChatGPT 添加
 *
 * 原则：每台电脑独立配置，不从别处带入 Token / Cookie / 配对信息。
 */
function parseRuntimePort(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return null;
  if (parsed === 48765) return null; // 48765 为保留端口，永久保留
  return parsed;
}

export function QuickSetupPage(): JSX.Element {
  const [active, setActive] = useState<ProfileConfig | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [done, setDone] = useState(false);
  const [port, setPort] = useState("48767");

  const [mode, setMode] = useState<Mode>("local");
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelRunning, setTunnelRunning] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [codeExpires, setCodeExpires] = useState<number | null>(null);
  const [connectorUrl, setConnectorUrl] = useState<string | null>(null);

  // 命名隧道（用户自己的 Cloudflare 域名）
  const [cfStatus, setCfStatus] = useState<{
    cloudflaredPath: string | null;
    loggedIn: boolean;
    certPath: string;
    tunnels: Array<{ id: string; name: string }>;
    detail: string;
  } | null>(null);
  const [hostname, setHostname] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  const [provSteps, setProvSteps] = useState<Array<{ step: string; ok: boolean; detail: string }>>([]);
  const [fixedUrl, setFixedUrl] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    window.c2c.profile
      .getActive()
      .then((p) => {
        if (!mounted) return;
        setActive(p);
        setState("ready");
        const ok = Boolean(p?.currentWorkspace?.root);
        setDone(ok);
        // 端口以已落盘配置为准；本机已有 Profile 时不允许在这里改（改端口需重装 --port 或服务设置）。
        if (p?.transport?.expectedLocalPort) setPort(String(p.transport.expectedLocalPort));
        if (ok) setStep(2);
      })
      .catch(() => {
        if (mounted) setState("failed");
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function configure(): Promise<void> {
    if (busy) return;
    const targetPort = parseRuntimePort(port);
    if (!targetPort) {
      setNotice("端口无效：请填 1024–65535，且不能使用保留端口 48765。");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const folder = await window.c2c.workspace.pick();
      if (!folder) {
        setNotice("已取消选择；不会修改任何配置。");
        return;
      }
      const info = await window.c2c.workspace.validate(folder);
      if (!info.exists || !info.root || !info.workspaceId) throw Error("WORKSPACE_DIRECTORY_UNAVAILABLE");

      const current = await window.c2c.profile.getActive();
      if (current?.currentWorkspace?.root) {
        setActive(current);
        setDone(true);
        setStep(2);
        setNotice("这台电脑已有工作区配置。若要更换目录，请到「工作区」页面手动切换；未覆盖旧配置。");
        return;
      }
      if (!current) {
        const created = await window.c2c.profile.create({
          profileName: "本机 HOME",
          profileType: "home",
          initialWorkspaceRoot: info.root,
          expectedLocalPort: targetPort,
        });
        if (!created?.profileId) throw Error("PROFILE_NOT_CREATED");
        await window.c2c.profile.setActive(created.profileId);
      } else {
        await window.c2c.workspace.changePrepare({ profileId: current.profileId, newWorkspaceRoot: info.root });
        await window.c2c.workspace.changeCommit({ profileId: current.profileId });
      }
      const actual = await window.c2c.profile.getActive();
      const sameRoot =
        actual?.currentWorkspace?.root?.replaceAll("\\", "/").toLowerCase() ===
        info.root.replaceAll("\\", "/").toLowerCase();
      if (!actual || actual.currentWorkspace?.workspaceId !== info.workspaceId || !sameRoot) {
        setState("failed");
        throw Error("PROFILE_WORKSPACE_READBACK_MISMATCH");
      }
      setActive(actual);
      setDone(true);
      setState("ready");
      setStep(2);
      setNotice("本机配置已创建并回读确认。");
    } catch {
      setNotice("配置未能确认完成。请检查本机 Supervisor 状态，然后在「工作区」页核对；不会删除旧数据。");
    } finally {
      setBusy(false);
    }
  }

  async function applyMode(next: Mode): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice("");
    setMode(next);
    try {
      if (next === "local") {
        await window.c2c.tunnel.stop().catch(() => undefined);
        setTunnelRunning(false);
        setTunnelUrl(null);
        setNotice("已切换为仅本机模式：不对外开放。");
      } else {
        const r = await window.c2c.tunnel.start(active?.transport.expectedLocalPort ?? parseRuntimePort(port) ?? 48767);
        setTunnelRunning(r.running);
        setTunnelUrl(r.url);
        setNotice(
          r.running && r.url
            ? "临时公网地址已生成。地址会随隧道重启而变化，仅用于临时试用。"
            : "未能启动临时隧道。请确认本机已安装 cloudflared（可用环境变量 C2C_CLOUDFLARED_PATH 指定路径）。",
        );
      }
    } catch (e) {
      setNotice(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshCloudflare(): Promise<void> {
    try {
      setCfStatus(await window.c2c.namedTunnel.status());
    } catch (e) {
      setNotice(`读取 Cloudflare 状态失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function pickCf(): Promise<void> {
    try {
      const r = await window.c2c.namedTunnel.pick();
      setNotice(r.ok ? `已记住路径：${r.path}` : r.reason ?? "已取消");
      await refreshCloudflare();
    } catch (e) {
      setNotice(`选择失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function installCf(): Promise<void> {
    setBusy(true);
    setNotice("正在从 Cloudflare 官方下载 cloudflared（约 25-40 MB），请稍候……");
    try {
      const r = await window.c2c.namedTunnel.install();
      setNotice(r.detail);
      await refreshCloudflare();
    } catch (e) {
      setNotice(`安装失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function cloudflareLogin(): Promise<void> {
    setBusy(true);
    setNotice("已打开浏览器，请在浏览器里完成 Cloudflare 授权……");
    try {
      const r = await window.c2c.namedTunnel.login();
      setNotice(r.detail);
      await refreshCloudflare();
    } catch (e) {
      setNotice(`登录失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function provision(): Promise<void> {
    if (provisioning) return;
    const profile = active ?? (await window.c2c.profile.getActive());
    if (!profile?.profileId) {
      setNotice("还没有本机配置，请先完成第一步。");
      return;
    }
    const ok = window.confirm(
      `接下来会在你的 Cloudflare 账号里：\n\n` +
        `1) 创建隧道 linos-c2c-${hostname.split(".")[0] || "home"}（已存在则复用）\n` +
        `2) 把 ${hostname || "你填写的域名"} 的 DNS 指向这条隧道\n\n` +
        `这会真实修改你的 Cloudflare 账号。确定继续吗？`,
    );
    if (!ok) {
      setNotice("已取消，不会修改你的 Cloudflare 账号。");
      return;
    }
    setProvisioning(true);
    setNotice("");
    try {
      const r = await window.c2c.namedTunnel.provision({
        hostname,
        tunnelName: `linos-c2c-${hostname.split(".")[0] || "home"}`,
        port: profile.transport.expectedLocalPort,
      });
      setProvSteps(r.steps);
      if (!r.ok) {
        setNotice("创建未全部成功，请看下面每一步的结果。");
        return;
      }
      await window.c2c.profile.updateServiceSettings({
        expectedProfileId: profile.profileId,
        provider: "CLOUDFLARE_NAMED",
        hostname: r.hostname,
        tunnelName: r.tunnelName,
        tunnelId: r.tunnelId,
        zone: r.zone,
        credentialPath: r.credentialPath,
        // 必须落盘 cloudflared 绝对路径：家用机通常没把它加进 PATH，
        // 只写裸名会让 Transport 启动时 spawn ENOENT。
        binaryPath: r.binaryPath,
      } as Parameters<typeof window.c2c.profile.updateServiceSettings>[0]);
      await window.c2c.service.restartTransport().catch(() => undefined);
      // Runtime 启动时用 publicMcpUrl 决定 OAuth issuer；不重启就仍是 127.0.0.1，
      // ChatGPT 会因 issuer 与连接器域名不一致而拒绝授权。
      await window.c2c.service.restartRuntime().catch(() => undefined);
      setFixedUrl(`https://${r.hostname}/mcp`);
      setConnectorUrl(`https://${r.hostname}/mcp`);
      setNotice("已创建隧道、绑定域名并写入本机配置。");
      await refreshCloudflare();
    } catch (e) {
      setNotice(`创建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProvisioning(false);
    }
  }

  async function generateCode(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const profile = await window.c2c.profile.getActive();
      const targetPort = profile?.transport.expectedLocalPort ?? parseRuntimePort(port) ?? 48767;
      const r = await window.c2c.service.createPairing(targetPort);
      setCode(r.code);
      setCodeExpires(r.expiresAt);
      try {
        const info = await window.c2c.peer.inspect(targetPort);
        setConnectorUrl(info.chatgptConnectorUrl ?? info.publicBaseUrl ?? null);
      } catch {
        /* 忽略 */
      }
      setNotice("配对码已生成，一次性有效。");
    } catch (e) {
      setNotice(`生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const steps: Array<{ n: Step; label: string }> = [
    { n: 1, label: "选择工作区" },
    { n: 2, label: "选择连接方式" },
    { n: 3, label: "生成配对码" },
  ];

  return (
    <section className="page-section" data-testid="portable-quick-setup">
      <div className="page-title">欢迎使用 LinOS MCP</div>
      <p className="muted">
        每台电脑独立配置，不会从另一台电脑带入 Token、Cookie 或配对信息。下面三步做完就能用。
      </p>

      <div className="row" style={{ gap: 8, margin: "14px 0", flexWrap: "wrap" }}>
        {steps.map((s) => {
          const activeStep = step === s.n;
          const passed = step > s.n;
          return (
            <button
              key={s.n}
              type="button"
              className={activeStep || passed ? "btn" : "btn secondary"}
              style={{ padding: "5px 14px", fontSize: 13, opacity: activeStep || passed ? 1 : 0.6 }}
              onClick={() => setStep(s.n)}
              data-testid={`setup-step-${s.n}`}
            >
              {passed ? "✓ " : ""}
              {s.n}. {s.label}
            </button>
          );
        })}
      </div>

      {state === "loading" && <div className="card">正在检查本机配置……</div>}
      {state === "failed" && (
        <div className="banner warn">
          本机配置服务暂时不可访问。请先到「诊断与日志」检查 Supervisor 是否正常，再回到本页。
        </div>
      )}

      {state === "ready" && step === 1 && (
        <div className="card">
          <div className="section-title">{done ? "本机配置已完成" : "第一步 · 选择工作区文件夹"}</div>
          <p className="muted">
            {done
              ? `当前工作区：${active?.currentWorkspace?.root ?? "待核实"}`
              : "选一个你希望 Agent 读取的代码或文档目录。本机将自动创建独立配置。"}
          </p>
          {!done && (
            <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <label className="muted" style={{ fontSize: 12 }}>本机端口</label>
              <input
                className="input"
                aria-label="本机端口"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                disabled={Boolean(active)}
                style={{ width: 100 }}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                {active
                  ? "端口已按首次安装时的参数固定；要换端口请用 --port 重装或到服务设置修改。"
                  : "默认 48767（也可用 48766）；不能是保留端口 48765。"}
              </span>
            </div>
          )}
          <div className="row" style={{ flexWrap: "wrap", marginTop: 12 }}>
            {!done && (
              <button type="button" className="btn" disabled={busy} onClick={() => void configure()}>
                {busy ? "配置中……" : "选择文件夹并完成本机配置"}
              </button>
            )}
            {done && (
              <button type="button" className="btn" onClick={() => setStep(2)}>
                下一步 · 选择连接方式
              </button>
            )}
          </div>
        </div>
      )}

      {state === "ready" && step === 2 && (
        <div className="card">
          <div className="section-title">第二步 · 选择连接方式</div>
          <p className="muted">决定 ChatGPT 怎么访问这台电脑上的服务。</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            {[
              {
                id: "local" as Mode,
                title: "仅本机（推荐先选这个）",
                desc: "不对外开放。适合先确认程序和工具都正常。",
              },
              {
                id: "quick-tunnel" as Mode,
                title: "临时公网地址（仅临时调试）",
                desc: "用 cloudflared 生成临时 https 地址，重启后会变；地址一变，ChatGPT 授权就会失效。正式连接请选下面的固定域名。",
              },
              {
                id: "named" as Mode,
                title: "我的域名（固定地址，推荐长期用）",
                desc: "用你自己的 Cloudflare 域名建一条固定隧道；地址不会变，重启也能用。",
              },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => void applyMode(opt.id)}
                disabled={busy}
                data-testid={`setup-mode-${opt.id}`}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${mode === opt.id ? "var(--accent)" : "var(--border)"}`,
                  background: "transparent",
                  color: "inherit",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 14 }}>
                  {mode === opt.id ? "● " : "○ "}
                  {opt.title}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                  {opt.desc}
                </div>
              </button>
            ))}
          </div>

          {mode === "named" && (
            <div style={{ marginTop: 12, padding: "12px", borderRadius: 8, border: "1px solid var(--border)" }}>
              <div className="section-title" style={{ fontSize: 14 }}>用自己的 Cloudflare 域名（固定地址）</div>
              {!cfStatus ? (
                <button className="btn secondary" type="button" style={{ marginTop: 8 }} onClick={() => void refreshCloudflare()}>
                  检查 cloudflared 与登录状态
                </button>
              ) : (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="muted" style={{ fontSize: 12 }}>{cfStatus.detail}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    cloudflared：{cfStatus.cloudflaredPath ?? "未找到"}
                  </div>
                  {!cfStatus.cloudflaredPath && (
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void installCf()}
                      data-testid="btn-install-cloudflared"
                    >
                      {busy ? "下载中……" : "自动下载并安装 cloudflared"}
                    </button>
                  )}
                  {!cfStatus.cloudflaredPath && (
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => void pickCf()}
                      data-testid="btn-pick-cloudflared"
                    >
                      我已经装了，手动选 cloudflared.exe
                    </button>
                  )}
                  {!cfStatus.loggedIn && (
                    <button className="btn" type="button" disabled={busy} onClick={() => void cloudflareLogin()}>
                      {busy ? "等待浏览器授权……" : "登录 Cloudflare（会打开浏览器）"}
                    </button>
                  )}
                  {cfStatus.loggedIn && (
                    <>
                      <label className="muted" style={{ fontSize: 12 }}>
                        要用的域名（需在你自己的 Cloudflare 账号里）
                      </label>
                      <input
                        value={hostname}
                        onChange={(e) => setHostname(e.target.value)}
                        placeholder="例如 mcp-home.example.com"
                        style={{
                          width: "100%",
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid var(--border)",
                          background: "var(--bg-elev)",
                          color: "var(--text)",
                          fontSize: 14,
                        }}
                        data-testid="setup-hostname-input"
                      />
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <button
                          className="btn"
                          type="button"
                          disabled={provisioning || !hostname.trim()}
                          onClick={() => void provision()}
                          data-testid="btn-provision-named"
                        >
                          {provisioning ? "创建中……" : "创建隧道并绑定域名"}
                        </button>
                        <button className="btn secondary" type="button" onClick={() => void refreshCloudflare()}>
                          重新检查
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {provSteps.length > 0 && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                  {provSteps.map((s, i) => (
                    <div key={i} style={{ fontSize: 12, color: s.ok ? "var(--green)" : "var(--red)" }}>
                      {s.ok ? "✓" : "✗"} {s.step}：{s.detail}
                    </div>
                  ))}
                </div>
              )}
              {fixedUrl && (
                <div className="banner info" style={{ marginTop: 10 }}>
                  固定地址：<code>{fixedUrl}</code>
                </div>
              )}
            </div>
          )}

          {tunnelRunning && tunnelUrl && (
            <div className="banner info" style={{ marginTop: 10 }}>
              临时地址：<code>{tunnelUrl}</code>
            </div>
          )}

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={() => setStep(3)}>
              下一步 · 生成配对码
            </button>
            <button type="button" className="btn secondary" onClick={() => void applyMode(mode)} disabled={busy}>
              {busy ? "处理中……" : "重新应用当前选择"}
            </button>
          </div>
        </div>
      )}

      {state === "ready" && step === 3 && (
        <div className="card">
          <div className="section-title">第三步 · 生成配对码并连接 ChatGPT</div>
          <p className="muted">
            在 ChatGPT 的「应用 / 连接器」里添加下方地址，授权页出现时输入这里的配对码即可。
          </p>
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void generateCode()}>
              {busy ? "生成中……" : code ? "重新生成配对码" : "生成配对码"}
            </button>
            <a className="btn secondary" href="#/connect">
              打开连接授权
            </a>
          </div>

          {code && (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <span className="muted" style={{ fontSize: 12 }}>
                  配对码（一次性）
                </span>
                <div style={{ fontSize: 26, letterSpacing: 6, fontWeight: 700, marginTop: 4 }} data-testid="setup-pairing-code">
                  {code}
                </div>
                {codeExpires && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    有效期至 {new Date(codeExpires).toLocaleString()}
                  </div>
                )}
              </div>
              <div>
                <span className="muted" style={{ fontSize: 12 }}>
                  连接器地址
                </span>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  {connectorUrl ?? "（尚未配置公网地址；仅本机模式下请用本机连接器）"}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {notice && (
        <p role="status" className="banner info" style={{ marginTop: 12 }}>
          {notice}
        </p>
      )}

      <p className="muted" style={{ marginTop: 12 }}>
        文件写入、删除和命令执行权限不会因为完成引导而自动开启，需要在「权限与审批」里单独打开。
      </p>
    </section>
  );
}

