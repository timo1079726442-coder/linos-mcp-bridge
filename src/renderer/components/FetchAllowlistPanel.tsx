import React, { useCallback, useEffect, useState } from "react";

/**
 * fetch 白名单（按工作区）。
 * 控制中心只保存允许的域名；runtime 的 fetch 工具只读这些域名，逐跳校验。
 */
export function FetchAllowlistPanel(): JSX.Element {
  const [text, setText] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [source, setSource] = useState<"workspace" | "profile" | "default">("default");
  const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      const info = await window.c2c.network.getAllowlist();
      setText(info.domains.join("\n"));
      setAllowHttp(info.allowHttp);
      setSource(info.source);
      setFile(info.file);
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const domains = text.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
      const result = await window.c2c.network.setAllowlist({ domains, allowHttp });
      setMsg(`已保存 ${result.domains} 个域名；fetch 调用立即生效。`);
      await load();
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-section" data-testid="fetch-allowlist-panel">
      <div className="section-title">联网白名单（fetch）</div>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
        只有列在这里的域名才允许被 fetch 读取；默认 https，逐跳校验，10s 超时、1MB 上限。
        支持 <code>*.example.com</code>（匹配子域名，不含裸域）。空列表 = 完全禁止联网读取。
      </p>
      {err && <div className="banner error" role="alert">{err}</div>}
      {msg && <div className="banner info">{msg}</div>}
      <div className="card">
        <textarea
          aria-label="允许的域名"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          placeholder={"example.com\n*.githubusercontent.com"}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg-elev)",
            color: "var(--text)",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
          }}
        />
        <div className="row" style={{ gap: 12, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="muted" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={allowHttp} onChange={(event) => setAllowHttp(event.target.checked)} />
            允许 http（不建议；默认只允许 https）
          </label>
          <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
            保存白名单
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            来源：{source === "workspace" ? "工作区级" : source === "profile" ? "Profile 级（旧版）" : "默认（空）"}
            {file ? ` · ${file}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
