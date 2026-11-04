import React, { useCallback, useEffect, useState } from "react";
import { annotateTool } from "../lib/toolGlossary.ts";

interface ToolRow {
  name: string;
  group: string;
  description: string;
  risk: string;
  enabled: boolean;
  approval: "auto" | "manual";
  conditional: boolean;
}

type Mode = "auto" | "manual";
type Policy = Record<string, { enabled: boolean; approval: Mode }>;

const MUTED = "var(--text-muted)";
const RISK_COLOR: Record<string, string> = {
  low: "var(--text-muted)",
  medium: "var(--yellow)",
  high: "var(--red)",
  critical: "var(--red)",
};
const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高", critical: "极高" };
const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const CONFIRM_PHRASE = "ENABLE DANGEROUS MODE";

/**
 * 工具权限：逐工具开关 + 危险等级 + 审批方式。
 * 另有"危险模式"总开关：本人输入一次确认短语即全部放开，不逐次打扰。
 */
export function ToolPolicyPanel({ port, profile }: { port?: number; profile?: { transport?: { expectedLocalPort?: number } } | null }): JSX.Element {
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [policy, setPolicy] = useState<Policy>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [onlyOff, setOnlyOff] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [ackOpen, setAckOpen] = useState(false);
  const [ackText, setAckText] = useState("");
  const [dangerOn, setDangerOn] = useState(false);
  const [policySource, setPolicySource] = useState<"workspace" | "profile" | "default" | null>(null);
  const [policyWorkspaceId, setPolicyWorkspaceId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      // 端口必须来自当前 Profile，不能写死（内部 48766 / 远端 48767）。
      // 传入 profile 时不再重复读取，避免重复 IPC 与竞态。
      const activeProfile = profile !== undefined ? profile : await window.c2c.profile.getActive().catch(() => null);
      const activePort = port ?? activeProfile?.transport?.expectedLocalPort ?? 0;
      if (!activePort) throw new Error("未取得当前 Profile 的本机端口，请先完成快速设置。");
      const info = await window.c2c.peer.inspect(activePort);
      const rows = (info.tools as unknown as ToolRow[]).map((t) => ({
        name: t.name,
        group: t.group ?? "",
        description: t.description ?? "",
        risk: t.risk ?? "medium",
        enabled: t.enabled !== false,
        approval: (t.approval === "manual" ? "manual" : "auto") as Mode,
        conditional: Boolean(t.conditional),
      }));
      rows.sort(
        (a, b) =>
          (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9) ||
          (a.group || "").localeCompare(b.group || "") ||
          a.name.localeCompare(b.name),
      );
      setTools(rows);
      const p = await window.c2c.toolPolicy.get();
      const next: Policy = {};
      for (const r of rows) {
        next[r.name] = p.tools[r.name] ?? { enabled: r.enabled, approval: r.approval };
      }
      setPolicy(next);
      setPolicySource(p.source);
      setPolicyWorkspaceId(p.workspaceId);
      setDangerOn(
        rows.length > 0 && rows.every((r) => next[r.name]?.enabled && next[r.name]?.approval === "auto"),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: Policy): Promise<void> => {
    if (tools.length === 0) { setMsg("工具清单没读出来，已拒绝保存，避免把全部工具写成关闭。"); return; }
    setBusy(true);
    setMsg(null);
    try {
      await window.c2c.toolPolicy.set(next);
      setPolicy(next);
      setMsg("已保存，调用时立即生效。");
    } catch (e) {
      setMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const patch = (name: string, entry: Partial<{ enabled: boolean; approval: Mode }>): void => {
    const cur = policy[name] ?? { enabled: true, approval: "manual" as Mode };
    void save({ ...policy, [name]: { ...cur, ...entry } });
  };

  const bulk = (enabled: boolean): void => {
    const next: Policy = { ...policy };
    for (const r of tools) {
      if (filter && !`${r.name} ${r.group} ${r.description}`.toLowerCase().includes(filter.toLowerCase())) continue;
      next[r.name] = { ...(next[r.name] ?? { approval: "manual" as Mode }), enabled };
    }
    void save(next);
  };

  const bulkApproval = (mode: Mode): void => {
    const next: Policy = { ...policy };
    for (const r of tools) {
      if (filter && !`${r.name} ${r.group} ${r.description}`.toLowerCase().includes(filter.toLowerCase())) continue;
      next[r.name] = { ...(next[r.name] ?? { enabled: true }), approval: mode };
    }
    void save(next);
  };

  const applyPreset = (preset: "read" | "dev" | "full" | "data"): void => {
    const blocked = new Set(["写入", "屏幕", "数据源", "命令"]);
    const next: Policy = {};
    for (const tool of tools) {
      let enabled = true;
      let approval: Mode = "auto";
      if (preset === "read") {
        enabled = !blocked.has(tool.group);
        if (["workflow_commit", "commit_operation", "commit_operations", "mysql_query"].includes(tool.name)) {
          approval = "manual";
        }
      } else if (preset === "dev") {
        enabled = tool.group !== "屏幕" && tool.group !== "数据源" && tool.group !== "命令";
        if (tool.group === "写入" || tool.name === "workflow_commit") approval = "manual";
        if (tool.name.startsWith("prepare_") || tool.name === "batch_prepare_write"
          || tool.name === "batch_replace_text" || tool.name === "list_pending_operations"
          || tool.name === "cancel_pending_operation") approval = "auto";
      } else if (preset === "full") {
        enabled = true;
        approval = blocked.has(tool.group) || tool.name === "workflow_commit" ? "manual" : "auto";
      } else {
        enabled = tool.group !== "写入" && tool.group !== "屏幕" && tool.group !== "命令";
        if (tool.name === "mysql_query" || tool.name === "workflow_commit"
          || tool.name === "commit_operation" || tool.name === "commit_operations") approval = "manual";
      }
      next[tool.name] = { enabled, approval };
    }
    const labels = { read: "只读查阅", dev: "开发写入", full: "全权限（逐次确认）", data: "数据只读" } as const;
    void save(next).then(() => setMsg(`已应用预设：${labels[preset]}（只影响当前工作区）。`));
  };

  const enableDanger = async (): Promise<void> => {
    if (ackText.trim().toUpperCase() !== CONFIRM_PHRASE) {
      setMsg("确认短语不匹配，未做任何修改。");
      return;
    }
    const next: Policy = {};
    for (const r of tools) next[r.name] = { enabled: true, approval: "auto" };
    await save(next);
    setDangerOn(true);
    setAckOpen(false);
    setAckText("");
    setMsg("危险模式已开启：全部工具可用，调用时不再逐次询问。");
  };

  const disableDanger = async (): Promise<void> => {
    const next: Policy = {};
    for (const r of tools) {
      const high = r.risk === "high" || r.risk === "critical";
      next[r.name] = { enabled: !high, approval: high ? "manual" : "auto" };
    }
    await save(next);
    setDangerOn(false);
    setMsg("危险模式已关闭：高风险工具回到关闭 + 人工审批。");
  };

  const shown = tools.filter((t) =>
    (onlyOff ? !(policy[t.name]?.enabled) || policy[t.name]?.approval === "manual" : true) &&
    filter ? `${t.name} ${t.group} ${t.description} ${t.risk}`.toLowerCase().includes(filter.toLowerCase()) : true,
  );
  const enabledCount = tools.filter((t) => policy[t.name]?.enabled).length;

  return (
    <div className="security-card" style={{ marginBottom: 16 }} data-testid="tool-policy-panel">
      <div className="security-card-heading">
        <div>
          <div className="section-title">工具权限（逐项开关 + 审批方式）</div>
          <div className="muted">
            共 {tools.length} 个，已开启 {enabledCount} 个，关闭 {tools.length - enabledCount} 个。
            <label style={{ marginLeft: 10, fontSize: 12 }}>
              <input type="checkbox" checked={onlyOff} onChange={(e) => setOnlyOff(e.target.checked)} /> 只看"关闭/需确认"
            </label>
          </div>
          <div className="muted" style={{ marginTop: 4 }} data-testid="policy-source">
            {policySource === "workspace"
              ? `当前生效：工作区级策略 · ${policyWorkspaceId ?? "当前工作区"}`
              : policySource === "profile"
                ? "当前生效：Profile 级旧策略（保存后写入当前工作区，不再影响其它工作区）"
                : policySource === "default"
                  ? "当前生效：内置默认（保存后写入当前工作区）"
                  : "正在确认策略来源…"}
          </div>
        </div>
        <button className="btn secondary" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "读取中…" : "重新读取"}
        </button>
      </div>

      <div
        style={{
          margin: "10px 0",
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${dangerOn ? "var(--red)" : "var(--border)"}`,
          background: dangerOn ? "rgba(192,57,43,0.10)" : "transparent",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14 }}>危险模式</strong>
          <span style={{ fontSize: 12, color: MUTED }}>
            {dangerOn ? "已开启：全部工具可用，调用时不再逐次询问" : "默认关闭：高风险工具关闭、写入类需人工审批"}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {!dangerOn && (
              <button className="btn" type="button" onClick={() => setAckOpen(true)} data-testid="btn-enable-danger">
                开启危险模式
              </button>
            )}
            {dangerOn && (
              <button
                className="btn secondary"
                type="button"
                onClick={() => void disableDanger()}
                data-testid="btn-disable-danger"
              >
                关闭危险模式
              </button>
            )}
          </div>
        </div>

        {ackOpen && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              请准确输入 <code>{CONFIRM_PHRASE}</code> 以确认：
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={ackText}
                onChange={(e) => setAckText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg-elev)",
                  color: "var(--text)",
                  minWidth: 260,
                }}
                data-testid="input-danger-confirm"
              />
              <button className="btn" type="button" onClick={() => void enableDanger()} data-testid="btn-confirm-danger">
                确认开启
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  setAckOpen(false);
                  setAckText("");
                }}
              >
                取消
              </button>
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              开启后：写入、删除、移动、屏幕截取、命令执行都可被调用方直接使用，不再每次弹审批。
            </div>
          </div>
        )}
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="按名称/分组/说明筛选"
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg-elev)",
            color: "var(--text)",
            minWidth: 220,
          }}
        />
        <button className="btn secondary" type="button" disabled={busy} onClick={() => bulk(true)}>
          全部开启
        </button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => bulk(false)}>
          全部关闭
        </button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => bulkApproval("manual")}>
          全部人工审批
        </button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => bulkApproval("auto")}>
          全部自动审批
        </button>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>工作区能力预设：</span>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => applyPreset("read")} data-testid="preset-read">
          只读查阅
        </button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => applyPreset("dev")} data-testid="preset-dev">
          开发写入
        </button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => applyPreset("full")} data-testid="preset-full">
          全权限（逐次确认）
        </button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => applyPreset("data")} data-testid="preset-data">
          数据只读
        </button>
        <span className="muted" style={{ fontSize: 11 }}>预设只改当前工作区；危险模式仍需在下方单独确认。</span>
      </div>

      {err && <div className="banner warn">读取失败：{err}</div>}
      {msg && <div className="banner info">{msg}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
        {shown.map((t) => {
          const cur = policy[t.name] ?? { enabled: t.enabled, approval: t.approval };
          const a = annotateTool(t.name, t.description, t.group);
          return (
            <div
              key={t.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                borderLeft: `3px solid ${cur.enabled ? "var(--green)" : "var(--border-strong)"}`,
                opacity: cur.enabled ? 1 : 0.6,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <code style={{ fontSize: 12 }}>{t.name}</code>
                  {a.group ? <span style={{ fontSize: 11, color: MUTED }}>{a.group}</span> : null}
                  <span style={{ fontSize: 11, color: RISK_COLOR[t.risk] ?? MUTED }}>
                    危险：{RISK_LABEL[t.risk] ?? t.risk}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2, lineHeight: 1.7 }}>
                  {a.zh || "（无说明）"}
                </div>
              </div>

              <select
                value={cur.approval}
                disabled={busy}
                onChange={(e) => patch(t.name, { approval: e.target.value === "manual" ? "manual" : "auto" })}
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg-elev)",
                  color: "var(--text)",
                  fontSize: 12,
                }}
                data-testid={`approval-${t.name}`}
              >
                <option value="manual">人工审批</option>
                <option value="auto">自动</option>
              </select>

              <button
                className={cur.enabled ? "btn" : "btn secondary"}
                type="button"
                disabled={busy}
                style={{ padding: "4px 14px", fontSize: 12, minWidth: 74 }}
                onClick={() => patch(t.name, { enabled: !cur.enabled })}
                data-testid={`toggle-${t.name}`}
              >
                {cur.enabled ? "已开启" : "已关闭"}
              </button>
            </div>
          );
        })}
        {shown.length === 0 && <div className="muted" style={{ fontSize: 13 }}>没有匹配的工具。</div>}
      </div>
    </div>
  );
}
