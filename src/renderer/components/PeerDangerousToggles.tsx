import React, { useCallback, useEffect, useState } from "react";

interface DangerousMode {
  enabled: boolean;
  autoApprovePreparedWrites: boolean;
  exposeDirectWriteFile: boolean;
  allowCreate: boolean;
  allowOverwrite: boolean;
  allowDelete: boolean;
  allowMove: boolean;
  allowShell: boolean;
}

const MUTED = "var(--text-muted)";
const AMBER = "var(--yellow)";
const RED = "var(--red)";
const GREEN = "var(--green)";

const SWITCHES: Array<{ key: keyof DangerousMode; label: string; risk: string; note: string }> = [
  { key: "enabled", label: "危险模式总开关", risk: "高", note: "关闭后下面各项一律不生效" },
  { key: "autoApprovePreparedWrites", label: "自动批准预备写入", risk: "高", note: "写入不再逐次询问" },
  { key: "exposeDirectWriteFile", label: "暴露直接写文件入口", risk: "中", note: "允许一步完成写入" },
  { key: "allowCreate", label: "允许新建文件", risk: "中", note: "可在授权目录内创建新文件" },
  { key: "allowOverwrite", label: "允许覆盖已有文件", risk: "高", note: "会改掉原文件内容" },
  { key: "allowDelete", label: "允许删除文件", risk: "极高", note: "删除后无法从本工具恢复" },
  { key: "allowMove", label: "允许移动/重命名", risk: "高", note: "路径会变，引用可能失效" },
  { key: "allowShell", label: "允许执行 Shell 命令", risk: "极高", note: "等同把命令行交给远程调用方" },
];

/**
 * Legacy MCP 的危险模式开关（真实读写其 config.json）。
 * 只改 dangerous_mode 字段；写前自动备份，写后复读校验。
 */
export function PeerDangerousToggles(): JSX.Element {
  const [mode, setMode] = useState<DangerousMode | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const r = await window.c2c.peer.inspect(48766);
      setMode(r.dangerousMode ?? null);
      setFile(r.publicBaseUrl ? "~/.local-files-mcp/config.json" : "~/.local-files-mcp/config.json");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (key: keyof DangerousMode): Promise<void> => {
    if (!mode) return;
    setBusy(key);
    setMsg(null);
    setErr(null);
    try {
      const r = await window.c2c.peer.setDangerous({ [key]: !mode[key] });
      setMode(r.dangerousMode as DangerousMode);
      setMsg(
        `已写入（备份：${r.backup ? r.backup.split(/[\\/]/).pop() : "无"}）。多数实现需要重启该服务才生效。`,
      );
    } catch (e) {
      setErr(`写入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (err && !mode) {
    return (
      <div className="security-card" style={{ marginBottom: 16 }}>
        <div className="section-title">Legacy MCP 危险开关</div>
        <div className="banner warn">读取失败：{err}（该服务可能未安装或未启动）</div>
      </div>
    );
  }

  return (
    <div className="security-card" style={{ marginBottom: 16 }} data-testid="peer-dangerous-toggles">
      <div className="security-card-heading">
        <div>
          <div className="section-title">Legacy MCP 危险开关</div>
          <div className="muted">
            直接读写该服务的 <code>{file ?? "~/.local-files-mcp/config.json"}</code>
            。写入前自动备份，写入后复读校验。
          </div>
        </div>
        <button className="btn secondary" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "读取中…" : "重新读取"}
        </button>
      </div>

      <div className="banner warn" style={{ margin: "10px 0" }}>
        这些开关只影响 <strong>Legacy MCP</strong>，不影响我们的 V2 Runtime，也不影响 48765 生产服务。
        改完通常需要重启该服务才生效。
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {SWITCHES.map((s) => {
          const on = mode ? mode[s.key] : false;
          const riskColor = s.risk === "极高" ? RED : s.risk === "高" ? AMBER : MUTED;
          return (
            <div
              key={s.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.08)",
                borderLeft: `3px solid ${on ? GREEN : "rgba(255,255,255,0.12)"}`,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14 }}>{s.label}</div>
                <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>{s.note}</div>
              </div>
              <span style={{ color: riskColor, fontSize: 12, minWidth: 40 }}>{s.risk}</span>
              <button
                className={on ? "btn" : "btn secondary"}
                type="button"
                style={{ padding: "4px 14px", fontSize: 13, minWidth: 72 }}
                disabled={busy !== null || !mode}
                onClick={() => void toggle(s.key)}
                data-testid={`toggle-dangerous-${s.key}`}
              >
                {busy === s.key ? "…" : on ? "已开启" : "已关闭"}
              </button>
            </div>
          );
        })}
      </div>

      {msg && (
        <div className="banner info" role="status" style={{ marginTop: 10 }}>
          {msg}
        </div>
      )}
      {err && mode && (
        <div className="banner warn" role="status" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}
    </div>
  );
}
