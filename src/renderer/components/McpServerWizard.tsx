import React, { useState } from "react";

type Exposure = "local" | "quick" | "named";

interface CreatedServer {
  profileId: string;
  port: number;
  exposure: Exposure;
  mcpUrl: string;
  pairingCode: string;
  expiresAt: number;
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 && value !== 48765;
}

/**
 * 一键新建 MCP 服务：目录 → 端口 → 隧道 → 公网 URL → 配对码。
 * 只创建一个 Profile（一个稳定端口）；需要多窗口时再建第二个。
 */
export function McpServerWizard(): JSX.Element {
  const [name, setName] = useState("本机 MCP 服务");
  const [root, setRoot] = useState("");
  const [port, setPort] = useState("");
  const [exposure, setExposure] = useState<Exposure>("quick");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedServer | null>(null);

  async function chooseFolder(): Promise<void> {
    setError(null);
    try {
      const picked = await window.c2c.workspace.pick();
      if (picked) setRoot(picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function pickFreePort(): Promise<number> {
    for (let candidate = 48766; candidate <= 48820; candidate += 1) {
      if (!validPort(candidate)) continue;
      const result = await window.c2c.service.portAvailable(candidate);
      if (result.available) return candidate;
    }
    throw new Error("找不到空闲端口（48766–48820），请手动填写。");
  }

  async function waitHealthy(targetPort: number): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await window.c2c.peer.inspect(targetPort);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw new Error(`Runtime 在端口 ${targetPort} 上 30 秒内没有就绪。`);
  }

  async function create(): Promise<void> {
    if (busy) return;
    setError(null);
    setCreated(null);
    if (!root.trim()) {
      setError("请先选择工作区目录。");
      return;
    }
    const requested = port.trim() ? Number(port) : NaN;
    if (port.trim() && !validPort(requested)) {
      setError("端口无效：1024–65535，且不能是保留端口 48765。");
      return;
    }
    if (exposure === "named" && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostname.trim())) {
      setError("请填写要绑定的域名，例如 mcp-home.example.com。");
      return;
    }
    setBusy(true);
    try {
      setStep("检查目录");
      const info = await window.c2c.workspace.validate(root.trim());
      if (!info.exists || !info.root) throw new Error("目录不可用，请重新选择。");

      setStep("选择端口");
      const targetPort = Number.isFinite(requested) ? requested : await pickFreePort();
      const availability = await window.c2c.service.portAvailable(targetPort);
      if (!availability.available) throw new Error(`端口 ${targetPort} 已被占用（${availability.reason ?? "UNKNOWN"}）。`);

      setStep("创建本机 Profile");
      const profile = await window.c2c.profile.create({
        profileName: name.trim() || `MCP 服务 ${targetPort}`,
        profileType: "local",
        initialWorkspaceRoot: info.root,
        expectedLocalPort: targetPort,
      });
      await window.c2c.profile.setActive(profile.profileId);

      setStep("等待 Runtime 就绪");
      await waitHealthy(targetPort);

      let mcpUrl = `http://127.0.0.1:${targetPort}/mcp`;
      if (exposure === "quick") {
        setStep("创建临时隧道");
        const tunnel = await window.c2c.tunnel.start(targetPort);
        if (!tunnel.running || !tunnel.url) throw new Error("临时隧道没有返回公网地址。");
        mcpUrl = `${tunnel.url.replace(/\/$/, "")}/mcp`;
      } else if (exposure === "named") {
        setStep("打开 Cloudflare 授权（浏览器）");
        const login = await window.c2c.namedTunnel.login();
        if (!login.ok) throw new Error(`Cloudflare 授权未完成：${login.detail}`);
        setStep("创建命名隧道并绑定 DNS");
        const provisioned = await window.c2c.namedTunnel.provision({
          hostname: hostname.trim(),
          tunnelName: `linos-${hostname.trim().split(".")[0] || "local"}`,
          port: targetPort,
        });
        if (!provisioned.ok) throw new Error("隧道创建未全部成功，请查看 Cloudflare 侧配置。");
        await window.c2c.profile.updateServiceSettings({
          expectedProfileId: profile.profileId,
          provider: "CLOUDFLARE_NAMED",
          hostname: provisioned.hostname,
          tunnelName: provisioned.tunnelName,
          tunnelId: provisioned.tunnelId,
          zone: provisioned.zone,
          credentialPath: provisioned.credentialPath,
        } as Parameters<typeof window.c2c.profile.updateServiceSettings>[0]);
        await window.c2c.service.restartTransport().catch(() => undefined);
        mcpUrl = `https://${provisioned.hostname}/mcp`;
      }

      setStep("生成配对码");
      const pairing = await window.c2c.service.createPairing(targetPort);
      setCreated({
        profileId: profile.profileId,
        port: targetPort,
        exposure,
        mcpUrl,
        pairingCode: pairing.code,
        expiresAt: pairing.expiresAt,
      });
      setStep("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStep("");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string): Promise<void> {
    await navigator.clipboard.writeText(text).catch(() => undefined);
  }

  return (
    <section className="card" style={{ marginBottom: 16 }} data-testid="mcp-server-wizard">
      <div className="section-title">一键新建 MCP 服务</div>
      <p className="muted" style={{ marginTop: 0 }}>
        选目录、端口和公网方式，一次完成 Runtime、隧道、URL 和配对码。每个服务一个稳定端口；
        需要给多个 ChatGPT 窗口用时再建第二个。
      </p>

      {error && <div className="banner error" role="alert">{error}</div>}

      <div className="card-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
        <label className="muted" style={{ fontSize: 12 }}>名称
          <input className="input" style={{ width: "100%", marginTop: 4 }} value={name}
            onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>工作区目录
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <input className="input" style={{ flex: 1 }} value={root} placeholder="选择或粘贴目录"
              onChange={(event) => setRoot(event.target.value)} />
            <button className="btn secondary" type="button" onClick={() => void chooseFolder()} disabled={busy}>
              选择
            </button>
          </div>
        </label>
        <label className="muted" style={{ fontSize: 12 }}>端口（留空自动）
          <input className="input" style={{ width: "100%", marginTop: 4 }} value={port} placeholder="自动选空闲端口"
            onChange={(event) => setPort(event.target.value)} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>公网方式
          <select className="input" style={{ width: "100%", marginTop: 4 }} value={exposure}
            onChange={(event) => setExposure(event.target.value as Exposure)}>
            <option value="quick">临时隧道（地址会变）</option>
            <option value="named">命名隧道（自己的域名）</option>
            <option value="local">仅本机（不建隧道）</option>
          </select>
        </label>
        {exposure === "named" && (
          <label className="muted" style={{ fontSize: 12 }}>域名
            <input className="input" style={{ width: "100%", marginTop: 4 }} value={hostname}
              placeholder="mcp-home.example.com"
              onChange={(event) => setHostname(event.target.value)} />
          </label>
        )}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn" type="button" onClick={() => void create()} disabled={busy || !root.trim()}>
          {busy ? step || "创建中…" : "创建并连接"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          会新建一个 Profile 并切换为当前服务；原来的服务不会删除。
        </span>
      </div>

      {created && (
        <div className="card" style={{ marginTop: 12, borderColor: "var(--green)" }} data-testid="mcp-server-created">
          <div className="section-title" style={{ fontSize: 14 }}>服务已就绪</div>
          <div className="kv">
            <div className="k">端口</div><div className="v">{created.port}</div>
            <div className="k">MCP URL</div><div className="v"><code>{created.mcpUrl}</code></div>
            <div className="k">配对码</div><div className="v"><code style={{ fontSize: 16, letterSpacing: 2 }}>{created.pairingCode}</code></div>
            <div className="k">有效期至</div><div className="v">{new Date(created.expiresAt).toLocaleTimeString()}</div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button className="btn secondary" type="button" onClick={() => void copy(created.mcpUrl)}>复制 MCP URL</button>
            <button className="btn secondary" type="button" onClick={() => void copy(created.pairingCode)}>复制配对码</button>
            <button className="btn" type="button" onClick={() => void window.c2c.intent.openChatgpt()}>打开 ChatGPT</button>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            在 ChatGPT「添加自定义连接器」里粘贴 URL，OAuth 页面输入上面的配对码即可。
          </p>
        </div>
      )}
    </section>
  );
}
