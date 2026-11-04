import React, { useCallback, useEffect, useState } from "react";
import flowImage from "../assets/mysql-readonly-flow.png";

interface DataSourceRow {
  id: string;
  kind: "mysql";
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  options: { maxRows: number; timeoutMs: number; allowedTables?: string[] };
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TestResult {
  ok: boolean;
  server_version: string | null;
  current_user: string | null;
  grants: string[];
  write_privileges: string[];
  read_only_account: boolean;
  warnings: string[];
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-elev)",
  color: "var(--text)",
};

/**
 * 数据源面板（只读 MySQL）。
 * 密码只经 IPC 交给主进程并用 DPAPI 保存；列表永远不回显密码。
 */
export function DataSourcesPanel(): JSX.Element {
  const [rows, setRows] = useState<DataSourceRow[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [secretBackend, setSecretBackend] = useState<string>("unknown");
  const [form, setForm] = useState({
    name: "本地 MySQL（只读）",
    host: "127.0.0.1",
    port: "3306",
    database: "",
    user: "linos_ro",
    password: "",
    maxRows: "100",
    timeoutMs: "10000",
    allowedTables: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, TestResult>>({});
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setZoom(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);
  const [generated, setGenerated] = useState<{ password: string; sql: string; user: string; database: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      const info = await window.c2c.datasources.list();
      setRows(info.datasources);
      setWorkspaceId(info.workspaceId);
      setSecretBackend(info.secretBackend);
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
      const parsedPort = Number(form.port);
      const parsedRows = Number(form.maxRows);
      const parsedTimeout = Number(form.timeoutMs);
      await window.c2c.datasources.save({
        name: form.name,
        kind: "mysql",
        host: form.host,
        port: parsedPort,
        database: form.database,
        user: form.user,
        password: form.password,
        options: {
          maxRows: parsedRows,
          timeoutMs: parsedTimeout,
          allowedTables: form.allowedTables.trim()
            ? form.allowedTables.split(",").map((name) => name.trim()).filter(Boolean)
            : undefined,
        },
      });
      setMsg("已保存：密码用 DPAPI 加密保存在本机，列表不会回显。");
      setForm((current) => ({ ...current, password: "" }));
      await load();
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await window.c2c.datasources.remove(id);
      await load();
      setMsg("数据源已删除（含本机加密密码）。");
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const result = await window.c2c.datasources.test(id);
      setTested((current) => ({ ...current, [id]: result as TestResult }));
    } catch (error: unknown) {
      setErr(`测试失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const generate = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const result = await window.c2c.datasources.generateSql({ user: form.user, database: form.database });
      setGenerated(result);
      setForm((current) => ({ ...current, password: result.password }));
      setMsg("已生成只读账号脚本：请用管理员账号执行，然后保存数据源。");
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-section" data-testid="datasources-panel">
      <div className="section-title">数据源（只读 MySQL）</div>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
        元数据按工作区保存（当前：{workspaceId ?? "未激活"}），密码用 {secretBackend} 加密。
        数据库侧必须使用只读账号；控制中心仍会拦截写 SQL、限制行数与超时，并记录不含正文的审计。
      </p>

      {err && <div className="banner error" role="alert">{err}</div>}
      {msg && <div className="banner info">{msg}</div>}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap", marginTop: 10 }}>
        <div style={{ flex: "1 1 520px", minWidth: 0 }}>

      <div className="card" style={{ marginTop: 0 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input aria-label="数据源名称" style={inputStyle} value={form.name} placeholder="名称"
            onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <input aria-label="MySQL 主机" style={{ ...inputStyle, width: 150 }} value={form.host} placeholder="127.0.0.1"
            onChange={(event) => setForm({ ...form, host: event.target.value })} />
          <input aria-label="MySQL 端口" style={{ ...inputStyle, width: 90 }} value={form.port} placeholder="3306"
            onChange={(event) => setForm({ ...form, port: event.target.value })} />
          <input aria-label="数据库名" style={inputStyle} value={form.database} placeholder="数据库名"
            onChange={(event) => setForm({ ...form, database: event.target.value })} />
          <input aria-label="只读用户名" style={inputStyle} value={form.user} placeholder="linos_ro"
            onChange={(event) => setForm({ ...form, user: event.target.value })} />
          <input aria-label="只读密码" type="password" style={inputStyle} value={form.password} placeholder="只读账号密码"
            onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <label className="muted" style={{ fontSize: 12 }}>最大行数
            <input aria-label="最大行数" style={{ ...inputStyle, width: 80, marginLeft: 6 }} value={form.maxRows}
              onChange={(event) => setForm({ ...form, maxRows: event.target.value })} />
          </label>
          <label className="muted" style={{ fontSize: 12 }}>超时(ms)
            <input aria-label="查询超时" style={{ ...inputStyle, width: 100, marginLeft: 6 }} value={form.timeoutMs}
              onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })} />
          </label>
          <input aria-label="允许的表（逗号分隔）" style={{ ...inputStyle, minWidth: 220 }} value={form.allowedTables}
            placeholder="允许的表（可选，逗号分隔）"
            onChange={(event) => setForm({ ...form, allowedTables: event.target.value })} />
          <button className="btn" type="button" disabled={busy || !form.database} onClick={() => void generate()}>
            生成只读账号脚本
          </button>
          <button className="btn" type="button" disabled={busy || !form.database || !form.password} onClick={() => void save()}>
            保存数据源
          </button>
        </div>
        {generated && (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              一次性密码（只会显示这一次）：<code>{generated.password}</code>
            </div>
            <pre style={{ maxHeight: 220, overflow: "auto", fontSize: 12, background: "var(--bg-elev)", padding: 10, borderRadius: 8 }}>
              {generated.sql}
            </pre>
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        {rows.map((row) => {
          const result = tested[row.id];
          return (
            <div key={row.id} className="card" style={{ padding: 10 }}>
              <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <strong style={{ fontSize: 14 }}>{row.name}</strong>
                <code style={{ fontSize: 12 }}>{row.user}@{row.host}:{row.port}/{row.database}</code>
                <span className="muted" style={{ fontSize: 12 }}>
                  行数上限 {row.options.maxRows} · 超时 {row.options.timeoutMs}ms · 密码{row.hasSecret ? "已保存" : "缺失"}
                </span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <button className="btn secondary" type="button" disabled={busy} onClick={() => void test(row.id)}>
                    测试连接
                  </button>
                  <button className="btn secondary" type="button" disabled={busy} onClick={() => void remove(row.id)}>
                    删除
                  </button>
                </div>
              </div>
              {result && (
                <div style={{ marginTop: 8, fontSize: 12 }} data-testid={`datasource-test-${row.id}`}>
                  <div>
                    版本：{result.server_version ?? "-"} · 当前账号：{result.current_user ?? "-"} ·{" "}
                    {result.read_only_account ? "只读账号 ✅" : "⚠ 该账号带写权限"}
                  </div>
                  {result.warnings.map((warning) => (
                    <div key={warning} className="muted">⚠ {warning}</div>
                  ))}
                  <div className="muted" style={{ marginTop: 4, wordBreak: "break-all" }}>
                    {result.grants.slice(0, 4).join(" · ")}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && <div className="muted" style={{ fontSize: 13 }}>还没有数据源。先执行只读账号脚本，再保存连接。</div>}
      </div>

        </div>

        <aside style={{ flex: "0 0 300px", minWidth: 280, maxWidth: 340 }}>
          <div className="card" style={{ padding: 12 }}>
            <div className="section-title" style={{ fontSize: 14 }}>使用说明</div>
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              先用管理员账号建只读账号，再把账号填到左边。点图片可放大。
            </p>
            <img
              src={flowImage}
              alt="MySQL 只读账号创建流程"
              onClick={() => setZoom(true)}
              style={{
                width: "100%",
                borderRadius: 8,
                border: "1px solid var(--border)",
                cursor: "zoom-in",
                display: "block",
              }}
            />
            <button
              className="btn secondary"
              type="button"
              style={{ marginTop: 8, width: "100%" }}
              onClick={() => setZoom(true)}
              aria-label="放大 MySQL 只读账号流程图"
            >
              + 放大图片
            </button>
            <ol className="muted" style={{ fontSize: 12, lineHeight: 1.7, paddingLeft: 18, marginTop: 10 }}>
              <li>root 登录 MySQL（一次性使用）</li>
              <li>创建 <code>c2c_ro</code> 账号（强密码）</li>
              <li>只授 <code>SELECT, SHOW VIEW</code></li>
              <li>验证：SELECT 成功、INSERT 报 1142</li>
              <li>回到左边保存并测试连接</li>
            </ol>
            <p className="muted" style={{ fontSize: 11, margin: 0 }}>
              完整说明：<code>docs/MYSQL_READONLY_GUIDE.md</code>
            </p>
          </div>
        </aside>
      </div>

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="MySQL 只读账号流程图"
          onClick={() => setZoom(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(8, 12, 20, 0.82)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div onClick={(event) => event.stopPropagation()} style={{ maxWidth: "92vw", maxHeight: "92vh", overflow: "auto" }}>
            <img
              src={flowImage}
              alt="MySQL 只读账号创建流程（放大）"
              style={{ display: "block", maxWidth: "92vw", maxHeight: "86vh", borderRadius: 10, background: "#fff" }}
            />
            <button className="btn" type="button" style={{ marginTop: 8 }} onClick={() => setZoom(false)}>
              关闭（Esc）
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

