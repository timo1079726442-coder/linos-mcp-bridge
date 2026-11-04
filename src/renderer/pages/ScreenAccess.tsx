import React, { useEffect, useMemo, useState } from "react";
import type { ProfileConfig, ScreenAccessSnapshot } from "../../shared/types.js";
import { buildScreenAccessViewModel } from "./security/screenAccessModel.ts";
import "./security/securityPages.css";

export interface ScreenAccessPageProps {
  snapshot?: ScreenAccessSnapshot | null;
  apiAvailable?: boolean;
}

interface AnnotationMark {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export function ScreenAccessPage({
  snapshot: snapshotProp,
  apiAvailable,
}: ScreenAccessPageProps): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileReadAt, setProfileReadAt] = useState<string | null>(null);
  const [profileReadFailed, setProfileReadFailed] = useState(false);
  const [liveSnapshot, setLiveSnapshot] = useState<ScreenAccessSnapshot | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenMessage, setScreenMessage] = useState<string | null>(null);
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);
  const [previewNow, setPreviewNow] = useState(Date.now());
  const [annotations, setAnnotations] = useState<AnnotationMark[]>([]);
  const [annotatedDataUrl, setAnnotatedDataUrl] = useState<string | null>(null);
  const [markDraft, setMarkDraft] = useState({ x: "10", y: "10", width: "30", height: "12", label: "标注" });

  const snapshot = snapshotProp ?? liveSnapshot;
  const screenApiAvailable = apiAvailable ?? Boolean(window.c2c?.screen);
  const previewExpiry = snapshot?.capture.preview?.expiresAt;
  const view = buildScreenAccessViewModel(snapshot, screenApiAvailable, previewNow);
  const displayedPreview = view.previewDataUrl ? (annotatedDataUrl ?? view.previewDataUrl) : null;

  async function refreshProfile(): Promise<void> {
    setProfileLoading(true);
    setProfileReadFailed(false);
    try {
      const active = await window.c2c.profile.getActive();
      setProfile(active);
      setProfileReadAt(new Date().toLocaleString());
    } catch {
      setProfile(null);
      setProfileReadFailed(true);
    } finally {
      setProfileLoading(false);
    }
  }

  async function listWindows(): Promise<void> {
    if (!screenApiAvailable || !profile) return;
    setScreenBusy(true);
    setScreenMessage(null);
    try {
      const next = await window.c2c.screen.listWindows();
      setLiveSnapshot(next);
      setSelectedWindowId(next.windowEnumeration.windows[0]?.windowId ?? null);
      setAnnotations([]);
      setAnnotatedDataUrl(null);
      setPreviewNow(Date.now());
      setScreenMessage(next.authorization === "AUTHORIZED"
        ? `已读取 ${next.windowEnumeration.windows.length} 个窗口。请选择目标后再单独确认截图。`
        : "本次窗口访问未获得授权。");
    } catch {
      setScreenMessage("窗口枚举失败或 Profile 在确认期间发生变化；没有返回原始异常文本。");
    } finally {
      setScreenBusy(false);
    }
  }

  async function captureSelectedWindow(): Promise<void> {
    if (!screenApiAvailable || !profile || !selectedWindowId) return;
    setScreenBusy(true);
    setScreenMessage(null);
    try {
      const next = await window.c2c.screen.captureWindow(selectedWindowId);
      setLiveSnapshot(next);
      setAnnotations([]);
      setAnnotatedDataUrl(null);
      setPreviewNow(Date.now());
      setScreenMessage(next.capture.state === "SUCCEEDED"
        ? "截图成功。原图只保存在本机页面短期内存中；如需标注，可在下方生成本机标注副本。"
        : "截图没有成功或本机用户取消了本次操作。");
    } catch {
      setScreenMessage("截图失败或 Profile 在确认期间发生变化；没有向页面暴露底层异常内容。");
    } finally {
      setScreenBusy(false);
    }
  }

  function addAnnotation(): void {
    const x = clampPercent(markDraft.x);
    const y = clampPercent(markDraft.y);
    const width = clampSize(markDraft.width, x);
    const height = clampSize(markDraft.height, y);
    if (x === null || y === null || width === null || height === null) {
      setScreenMessage("标注坐标必须是 0–100 的数字，宽高必须大于 0 且不能超出画面。");
      return;
    }
    const label = markDraft.label.trim().slice(0, 40) || "标注";
    setAnnotations((current) => [...current, { id: Date.now() + current.length, x, y, width, height, label }].slice(-50));
    setAnnotatedDataUrl(null);
    setScreenMessage("标注区域已加入。点击“生成标注副本”后会在本机内存中生成 PNG 副本。");
  }

  async function generateAnnotatedPreview(): Promise<void> {
    if (!view.previewDataUrl || annotations.length === 0) {
      setScreenMessage("需要先有有效截图，并至少添加一个标注区域。");
      return;
    }
    setScreenBusy(true);
    try {
      const image = await loadImage(view.previewDataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas_unavailable");
      context.drawImage(image, 0, 0);
      for (const mark of annotations) {
        const x = mark.x / 100 * canvas.width;
        const y = mark.y / 100 * canvas.height;
        const width = mark.width / 100 * canvas.width;
        const height = mark.height / 100 * canvas.height;
        context.fillStyle = "rgba(0,0,0,0.62)";
        context.fillRect(x, y, width, height);
        context.strokeStyle = "rgba(255,255,255,0.95)";
        context.lineWidth = Math.max(2, Math.round(canvas.width / 500));
        context.strokeRect(x, y, width, height);
        context.fillStyle = "white";
        context.font = `${Math.max(12, Math.round(canvas.width / 70))}px sans-serif`;
        context.fillText(mark.label, x + 6, Math.min(y + 22, y + height - 4));
      }
      setAnnotatedDataUrl(canvas.toDataURL("image/png"));
      setScreenMessage("标注副本已在本机内存生成。它仍不会自动发送给远程 MCP，也不会写入磁盘。");
    } catch {
      setScreenMessage("生成标注副本失败；原始截图没有被修改。");
    } finally {
      setScreenBusy(false);
    }
  }

  useEffect(() => {
    void refreshProfile();
  }, []);

  useEffect(() => {
    if (!previewExpiry) return;
    const expiresAt = Date.parse(previewExpiry);
    const delay = expiresAt - Date.now();
    if (!Number.isFinite(expiresAt) || delay <= 0) {
      setPreviewNow(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setPreviewNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [previewExpiry]);

  const selectedWindow = useMemo(
    () => snapshot?.windowEnumeration.windows.find((item) => item.windowId === selectedWindowId) ?? null,
    [snapshot, selectedWindowId],
  );

  return (
    <div className="security-feature-page" data-testid="screen-access-page">
      <div className="banner info">
        屏幕授权、窗口枚举和截图是三个独立状态。截图原图只有在本机逐次确认后才进入本机短期预览；当前不会直接暴露给远程 MCP。
      </div>

      <div className="security-card">
        <div className="security-card-heading">
          <div>
            <div className="section-title">当前 Profile 与授权边界</div>
            <div className="muted">屏幕权限不得跨 Profile 复用；确认期间 Profile 发生变化会直接拒绝结果。</div>
          </div>
          <button className="btn secondary" onClick={() => void refreshProfile()} disabled={profileLoading || screenBusy}>
            {profileLoading ? "读取中…" : "重读当前 Profile"}
          </button>
        </div>
        <div className="security-facts">
          <div><span className="security-fact-label">当前 Profile</span><strong>{profile ? profile.profileName + " · " + profile.profileType.toUpperCase() : "未知"}</strong></div>
          <div><span className="security-fact-label">配置来源</span><strong>本机 Profile API</strong></div>
          <div><span className="security-fact-label">读取时间</span><strong>{profileReadAt ?? "尚未读取"}</strong></div>
        </div>
        {profileReadFailed && <p className="security-error" role="status">控制面暂不可用：当前无法从 Supervisor 读取 Profile，因此屏幕授权、窗口枚举和截图状态均保持 UNKNOWN；这不代表屏幕接口本身已故障。</p>}
        {screenMessage && <p className="security-evidence-message" role="status">{screenMessage}</p>}
      </div>

      <div className="security-grid">
        <section className="security-card" aria-labelledby="screen-grant-title">
          <div className="section-title" id="screen-grant-title">本机授权与观测</div>
          <dl className="security-definition-list">
            <div><dt>授权状态</dt><dd>{view.authorizationLabel}</dd></div>
            <div><dt>范围</dt><dd>{view.scopeLabel}</dd></div>
            <div><dt>观测新鲜度</dt><dd>{view.freshnessLabel}</dd></div>
            <div><dt>新鲜度原因</dt><dd>{view.freshnessReason}</dd></div>
            <div><dt>观测时间</dt><dd>{view.observedAt ?? "尚无本机观测"}</dd></div>
          </dl>
          <button className="btn" type="button" onClick={() => void listWindows()} disabled={!screenApiAvailable || !profile || screenBusy}>
            {screenBusy ? "处理中…" : "列出窗口（本机确认）"}
          </button>
          {!screenApiAvailable && <p className="security-muted">当前构建没有暴露受控屏幕 IPC，保持 Fail-Closed。</p>}
        </section>

        <section className="security-card" aria-labelledby="screen-scope-title">
          <div className="section-title" id="screen-scope-title">允许的访问范围</div>
          <div className="security-scope-list">
            <div><strong>活动窗口</strong><span>当前不猜测 OS 活动窗口身份</span></div>
            <div><strong>指定窗口</strong><span>已接入；枚举和截图分别需要本机确认</span></div>
            <div><strong>全屏</strong><span>高风险范围仍保持关闭，未提供接口</span></div>
          </div>
          <p className="security-muted">不授予远程鼠标、键盘、窗口控制或任意电脑操作能力。</p>
        </section>

        <section className="security-card" aria-labelledby="screen-windows-title">
          <div className="section-title" id="screen-windows-title">窗口列表</div>
          <p className="security-evidence-message">{view.windowsMessage}</p>
          {snapshot?.windowEnumeration.windows.length ? (
            <ul className="security-window-list">
              {snapshot.windowEnumeration.windows.map((window) => (
                <li key={window.windowId}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
                    <input
                      type="radio"
                      name="screen-window"
                      checked={selectedWindowId === window.windowId}
                      onChange={() => setSelectedWindowId(window.windowId)}
                    />
                    <span>{window.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          <button className="btn" type="button" onClick={() => void captureSelectedWindow()} disabled={!screenApiAvailable || !selectedWindow || screenBusy}>
            截取所选窗口（再次本机确认）
          </button>
        </section>

        <section className="security-card" aria-labelledby="screen-capture-title">
          <div className="section-title" id="screen-capture-title">截图与标注</div>
          <p className="security-evidence-message">{view.captureMessage}</p>
          {displayedPreview ? (
            <>
              <div className="security-preview-frame" style={{ position: "relative" }}>
                <img src={displayedPreview} alt={annotatedDataUrl ? "本机临时标注截图预览" : "本机逐次确认的临时截图预览"} />
                {!annotatedDataUrl && annotations.map((mark) => (
                  <div
                    key={mark.id}
                    aria-label={mark.label}
                    style={{
                      position: "absolute",
                      left: `${mark.x}%`,
                      top: `${mark.y}%`,
                      width: `${mark.width}%`,
                      height: `${mark.height}%`,
                      border: "2px solid currentColor",
                      background: "rgba(0,0,0,0.48)",
                      pointerEvents: "none",
                    }}
                  />
                ))}
                <small>预览到期时间：{view.previewExpiresAt ?? "受控层未提供"}</small>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8, marginTop: 12 }}>
                <label><span className="muted">X %</span><input value={markDraft.x} onChange={(e) => setMarkDraft({ ...markDraft, x: e.target.value })} /></label>
                <label><span className="muted">Y %</span><input value={markDraft.y} onChange={(e) => setMarkDraft({ ...markDraft, y: e.target.value })} /></label>
                <label><span className="muted">宽 %</span><input value={markDraft.width} onChange={(e) => setMarkDraft({ ...markDraft, width: e.target.value })} /></label>
                <label><span className="muted">高 %</span><input value={markDraft.height} onChange={(e) => setMarkDraft({ ...markDraft, height: e.target.value })} /></label>
                <label><span className="muted">标签</span><input value={markDraft.label} onChange={(e) => setMarkDraft({ ...markDraft, label: e.target.value })} /></label>
              </div>
              <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
                <button className="btn secondary" type="button" onClick={addAnnotation}>添加标注区域</button>
                <button className="btn secondary" type="button" onClick={() => void generateAnnotatedPreview()} disabled={annotations.length === 0 || screenBusy}>生成标注副本</button>
                <button className="btn secondary" type="button" onClick={() => { setAnnotations([]); setAnnotatedDataUrl(null); }}>清除标注</button>
              </div>
              <p className="security-muted">标注副本只在本机 Renderer 内存生成；当前没有“导出给 MCP”的按钮。</p>
            </>
          ) : (
            <div className="security-preview-empty">暂无可显示的安全预览。先列出窗口并完成一次本机确认截图。</div>
          )}
        </section>
      </div>
    </div>
  );
}

function clampPercent(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return parsed;
}

function clampSize(value: string, start: number | null): number | null {
  if (start === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100 || start + parsed > 100) return null;
  return parsed;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image_load_failed"));
    image.src = dataUrl;
  });
}
