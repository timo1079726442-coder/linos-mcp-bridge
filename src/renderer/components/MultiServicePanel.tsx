import React, { useCallback, useEffect, useState } from "react";
import type { ManagedServiceView } from "../../shared/multiService.js";

/** 同时运行的额外 MCP 服务：每个服务一条命名隧道、一个独立端口/Profile。 */
export function MultiServicePanel(): JSX.Element {
  const [services, setServices] = useState<ManagedServiceView[]>([]);
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [port, setPort] = useState("");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      setServices(await window.c2c.multiService.list());
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function pick(): Promise<void> {
    const picked = await window.c2c.workspace.pick();
    if (picked) setWorkspace(picked);
  }

  async function create(): Promise<void> {
    if (busy) return;
    setErr(null);
    setMsg(null);
    const parsed = Number(port);
    if (!workspace.trim()) return setErr("请选择工作区目录。");
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535 || parsed === 48765) {
      return setErr("端口无效：1024–65535，且不能是保留端口 48765。");
    }
    if (!hostname.trim()) return setErr("请填写这条命名隧道要绑定的域名。");
    setBusy(true);
    try {
      const result = await window.c2c.multiService.create({
        name: name.trim() || `MCP 服务 ${parsed}`,
        workspace: workspace.trim(),
        port: parsed,
        hostname: hostname.trim(),
      });
      setCodes((previous) => ({ ...previous, [result.service.id]: result.pairingCode }));
      setMsg(`服务已启动：端口 ${result.service.port}，域名 ${result.service.hostname ?? ""}`);
      setName("");
      setPort("");
      setHostname("");
      await load();
    } catch (cause) {
      setErr(`创建失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function pairing(service: ManagedServiceView): Promise<void> {
    try {
      const result = await window.c2c.service.createPairing(service.port);
      setCodes((previous) => ({ ...previous, [service.id]: result.code }));
    } catch (cause) {
      setErr(`生成配对码失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function start(service: ManagedServiceView): Promise<void> {
    setBusy(true);
    try {
      await window.c2c.multiService.start(service.id);
      setMsg(`已启动：${service.name}`);
      await load();
    } catch (cause) {
      setErr(`启动失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function stop(service: ManagedServiceView): Promise<void> {    if (!window.confirm(`停止服务「${service.name}」？配置会保留，之后可重新启动。`)) return;
    setBusy(true);
    try {
      await window.c2c.multiService.stop(service.id);
      setMsg(`已停止：${service.name}`);
      await load();
    } catch (cause) {
      setErr(`停止失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }} data-testid="multi-service-panel">
      <div className="section-title">同时运行的服务</div>
      <p className="muted" style={{ marginTop: 0 }}>
        默认只跑一个服务。需要给第二个 ChatGPT 窗口独立工作区/端口时，在这里新增；
        每个服务独立 Supervisor、独立端口、独立命名隧道和审计，互不影响。
      </p>

      {err && <div className="banner error" role="alert">{err}</div>}
      {msg && <div className="banner info" role="status">{msg}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10, marginTop: 8 }}>
        <label className="muted" style={{ fontSize: 12 }}>名称
          <input className="input" style={{ width: "100%", marginTop: 4 }} value={name}
            onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>工作区
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <input className="input" style={{ flex: 1 }} value={workspace}
              onChange={(event) => setWorkspace(event.target.value)} />
            <button className="btn secondary" type="button" onClick={() => void pick()}>选择</button>
          </div>
        </label>
        <label className="muted" style={{ fontSize: 12 }}>端口
          <input className="input" style={{ width: "100%", marginTop: 4 }} value={port}
            onChange={(event) => setPort(event.target.value)} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>域名（命名隧道）
          <input className="input" style={{ width: "100%", marginTop: 4 }} value={hostname}
            placeholder="mcp-two.example.com"
            onChange={(event) => setHostname(event.target.value)} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" type="button" disabled={busy} onClick={() => void create()}>
          {busy ? "创建中…" : "新增并启动服务"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>会真实创建 Cloudflare 隧道并绑定 DNS。</span>
      </div>

      {services.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
          {services.map((service) => (
            <div key={service.id} className="list-item" style={{ display: "block" }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>{service.name}</strong>{" "}
                  <span className="tag">{service.status === "RUNNING" ? "运行中" : "已停止"}</span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {service.status !== "RUNNING" && (
                    <button className="btn secondary" type="button" disabled={busy} onClick={() => void start(service)}>
                      启动
                    </button>
                  )}
                  <button className="btn secondary" type="button" onClick={() => void pairing(service)}>
                    配对码
                  </button>
                  <button className="btn secondary" type="button" disabled={busy} onClick={() => void stop(service)}>
                    停止
                  </button>
                </div>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                端口 {service.port} · {service.publicMcpUrl ?? "未配置公网 URL"} · {service.workspace}
              </div>
              {codes[service.id] && (
                <div style={{ marginTop: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }}>配对码：</span>
                  <code style={{ fontSize: 16, letterSpacing: 2 }}>{codes[service.id]}</code>
                  <button className="btn secondary" type="button" style={{ marginLeft: 8 }}
                    onClick={() => void navigator.clipboard.writeText(codes[service.id] ?? "")}>
                    复制
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
