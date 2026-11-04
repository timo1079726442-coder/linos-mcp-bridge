import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagnosticsReport, LayerState } from "../../shared/types.js";
import { useI18n } from "../i18n/index.tsx";

const LAYERS: Array<keyof DiagnosticsReport["readiness"]["layers"]> = [
  "runtime",
  "transport",
  "connector",
  "conversation",
  "workspace",
  "repository",
];

const TONE: Record<string, { dot: string; text: string }> = {
  PASS: { dot: "#16a34a", text: "#166534" },
  DEGRADED: { dot: "#d97706", text: "#92400e" },
  FAIL: { dot: "#dc2626", text: "#991b1b" },
  UNKNOWN: { dot: "#94a3b8", text: "#475569" },
  NOT_APPLICABLE: { dot: "#cbd5e1", text: "#64748b" },
  NOT_STARTED: { dot: "#cbd5e1", text: "#64748b" },
};

const TONE_KEY: Record<string, string> = {
  PASS: "common.normal",
  DEGRADED: "common.problem",
  FAIL: "common.failure",
  UNKNOWN: "common.unknown",
  NOT_APPLICABLE: "common.notApplicable",
  NOT_STARTED: "common.notStarted",
};

interface ToolStat {
  total: number;
  enabled: number;
  disabled: number;
  manual: number;
}

type FixAction = "restart_service" | "restart_tunnel" | "pair";

/** 状态灯 + 一键自检 + 一键修复。默认手动刷新，可选自动复查。 */
export function HealthStrip(): JSX.Element {
  const { t } = useI18n();
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);
  const [gitPath, setGitPath] = useState("");
  const [toolStat, setToolStat] = useState<ToolStat | null>(null);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(() => localStorage.getItem("c2c.health.auto") === "1");
  const [intervalSec, setIntervalSec] = useState<number>(() => Number(localStorage.getItem("c2c.health.interval") ?? 30) || 30);
  const busyRef = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const next = await window.c2c.diagnostics.run();
        setReport(next);
        setCheckedAt(new Date().toLocaleTimeString());
        lastError = null;
        break;
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
    if (lastError) setError(lastError);
    setBusy(false);
    busyRef.current = false;
  }, []);

  const loadTools = useCallback(async (): Promise<void> => {
    try {
      const profile = await window.c2c.profile.getActive();
      const port = profile?.transport?.expectedLocalPort;
      if (!port) return;
      const info = (await window.c2c.peer.inspect(port)) as { tools?: Array<{ enabled?: boolean; approval?: string }> };
      const tools = info.tools ?? [];
      const enabled = tools.filter((tool) => tool.enabled !== false);
      setToolStat({
        total: tools.length,
        enabled: enabled.length,
        disabled: tools.length - enabled.length,
        manual: enabled.filter((tool) => tool.approval === "manual").length,
      });
    } catch {
      setToolStat(null);
    }
  }, []);

  useEffect(() => {
    void run();
    void loadTools();
  }, [run, loadTools]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void run();
      void loadTools();
    }, Math.max(5, intervalSec) * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, intervalSec, run, loadTools]);

  async function act(action: FixAction): Promise<void> {
    setBusy(true);
    try {
      if (action === "restart_service") await window.c2c.service.restartRuntime();
      else if (action === "restart_tunnel") await window.c2c.service.restartTransport();
      else {
        const res = await window.c2c.service.createPairing();
        setFixResult(`${t("health.act.pair")}: ${res.code}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await run();
      await loadTools();
    } catch (cause) {
      setFixResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function fix(action: string): Promise<void> {
    setBusy(true);
    try {
      const res = await window.c2c.fixes.run(action, action === "git_init" ? gitPath : undefined);
      setFixResult(res.output);
      await run();
      await loadTools();
    } catch (cause) {
      setFixResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const layers = report?.readiness?.layers;
  const problems = LAYERS.filter((key) => {
    const state = layers?.[key] as LayerState | undefined;
    return state === "FAIL" || state === "DEGRADED";
  });

  function explain(key: keyof DiagnosticsReport["readiness"]["layers"]): { text: string; action?: FixAction; actionLabel?: string } {
    if (key === "runtime") {
      return { text: t("health.cause.runtime"), action: "restart_service", actionLabel: t("health.act.restartService") };
    }
    if (key === "transport") {
      const status = report?.transport?.publicHealthStatus ?? null;
      if (status === 503) return { text: t("health.cause.transport503"), action: "restart_tunnel", actionLabel: t("health.act.restartTunnel") };
      if (status && status !== 200) return { text: t("health.cause.transportOther", { status }), action: "restart_tunnel", actionLabel: t("health.act.restartTunnel") };
      return { text: t("health.cause.transportDown"), action: "restart_tunnel", actionLabel: t("health.act.restartTunnel") };
    }
    if (key === "connector") return { text: t("health.cause.connector"), action: "pair", actionLabel: t("health.act.pair") };
    if (key === "conversation") return { text: t("health.cause.conversation") };
    return { text: t("health.cause.generic") };
  }

  return (
    <section className="page-section" aria-label={t("health.title")}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div className="section-title" style={{ margin: 0 }}>{t("health.title")}</div>
        <button className="btn" type="button" onClick={() => void run()} disabled={busy}>
          {busy ? t("health.checking") : t("health.selfCheck")}
        </button>
        <a className="btn secondary" href="#/diagnostics/fixes">{t("health.goFix")}</a>
        <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={autoRefresh}
            onChange={(e) => { setAutoRefresh(e.target.checked); localStorage.setItem("c2c.health.auto", e.target.checked ? "1" : "0"); }} />
          {t("health.autoRefresh")}
        </label>
        <select className="input" style={{ width: 92 }} value={intervalSec} disabled={!autoRefresh}
          onChange={(e) => { const v = Number(e.target.value) || 30; setIntervalSec(v); localStorage.setItem("c2c.health.interval", String(v)); }}>
          {[15, 30, 60, 120, 300].map((s) => <option key={s} value={s}>{s} {t("common.seconds")}</option>)}
        </select>
        {checkedAt && <span className="muted" style={{ fontSize: 12 }}>{t("health.lastCheck")} {checkedAt}</span>}
        {problems.length > 0 && <span style={{ fontSize: 12, color: "#991b1b" }}>{t("health.needAttention", { count: problems.length })}</span>}
      </div>

      {error && (
        <div className="err" style={{ marginTop: 8, fontSize: 13 }}>
          {t("health.controlPlaneDown")}{error}
          <button className="btn secondary" type="button" style={{ marginLeft: 8 }} onClick={() => void run()}>{t("common.retry")}</button>
          <button className="btn secondary" type="button" style={{ marginLeft: 6 }} onClick={() => window.location.reload()}>{t("health.refreshWindow")}</button>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t("health.controlPlaneHint")}</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
        {LAYERS.map((key) => {
          const state = String(layers?.[key] ?? "UNKNOWN");
          const tone = TONE[state] ?? TONE.UNKNOWN!;
          return (
            <div key={key} title={t(`health.hint.${key}`)}
              style={{ minWidth: 132, border: "1px solid #e2e8f0", borderRadius: 10, padding: "8px 10px", background: "#fff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: tone.dot, display: "inline-block" }} />
                <strong style={{ fontSize: 13 }}>{t(`health.layer.${key}`)}</strong>
              </div>
              <div style={{ fontSize: 12, color: tone.text, marginTop: 2 }}>{t(TONE_KEY[state] ?? "common.unknown")}</div>
              <div className="muted" style={{ fontSize: 11 }}>{t(`health.hint.${key}`)}</div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="input" style={{ width: 220 }} placeholder={t("health.fixRepoDir")}
          value={gitPath} onChange={(e) => setGitPath(e.target.value)} />
        <button className="btn secondary" type="button" disabled={busy} onClick={() => void fix("git_init")}>
          {t("health.gitInit")}
        </button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => void fix("enable_dev_tools")}>
          {t("health.enableDevTools")}
        </button>
        {fixResult && <span className="muted" style={{ fontSize: 12 }}>{fixResult}</span>}
      </div>

      {toolStat && (
        <p style={{ fontSize: 13, marginTop: 10 }}>
          {t("health.toolsLine", { enabled: toolStat.enabled, total: toolStat.total })}
          {toolStat.disabled > 0
            ? <span style={{ color: "#991b1b" }}>{t("health.toolsSome", { count: toolStat.disabled })}</span>
            : <span style={{ color: "#166534" }}>{t("health.toolsAll")}</span>}
          {" · "}{t("common.manualReview")} <strong>{toolStat.manual}</strong>
          {" · "}<a href="#/security/dangerous">{t("common.viewAll")}</a>
        </p>
      )}

      {problems.length > 0 && (
        <div style={{ marginTop: 10, border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 10, padding: "8px 12px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#991b1b" }}>{t("health.problemsTitle")}</div>
          {problems.map((key) => {
            const cause = explain(key);
            return (
              <div key={key} style={{ marginTop: 6, fontSize: 12, color: "#7f1d1d" }}>
                <strong>{t(`health.layer.${key}`)}</strong>（{t(TONE_KEY[String(layers?.[key])] ?? "common.unknown")}）：{cause.text}
                {cause.action && (
                  <button className="btn secondary" type="button" style={{ marginLeft: 8, padding: "2px 8px" }}
                    disabled={busy} onClick={() => void act(cause.action!)}>
                    {cause.actionLabel}
                  </button>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 12, marginTop: 6 }}>
            {t("health.more")}：<a href="#/diagnostics">{t("nav.diagnostics")}</a>
          </div>
        </div>
      )}

      {problems.length === 0 && layers && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{t("health.noProblems")}</p>
      )}
    </section>
  );
}
