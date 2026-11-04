import React, { useEffect, useMemo, useState } from "react";
import type { WritePolicy, WriteAuditEntry, WritePolicyUpdate, WriteToolId, WriteToolToggles } from "../../shared/types.js";

const ACTOR = "owner";

const TOOL_CATALOG: Array<{ id: WriteToolId; name: string; description: string }> = [
  { id: "createFile", name: "新建文件", description: "允许新建文本文件（Python、JS、TXT、Markdown 等），仅限授权目录。" },
  { id: "updateFile", name: "修改已有文件", description: "允许覆盖与补丁修改已有代码，带版本检查；修改前自动备份，可回滚。" },
  { id: "deleteFile", name: "删除文件", description: "允许删除单个授权文件，需精确版本号；删除前自动备份，可凭备份恢复。" },
  { id: "executeCommand", name: "受限命令执行", description: "允许运行测试与构建命令（python / pytest / npm / git），无 Shell 管道；可能执行项目代码，非沙箱。" },
  { id: "gitCommit", name: "Git 提交", description: "允许提交已暂存的变更，不自动暂存，从不推送。" },
  { id: "powershell", name: "完整 PowerShell", description: "允许以当前 Windows 用户权限运行任意 PowerShell，高风险；不受文件白名单限制。" },
];

function formatTimestamp(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function arraysEqualUnordered(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export function WriteAuthorizationPage(): JSX.Element {
  const [policy, setPolicy] = useState<WritePolicy | null>(null);
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftPowershell, setDraftPowershell] = useState(false);
  const [draftTools, setDraftTools] = useState<WriteToolToggles>({
    createFile: false, updateFile: false, deleteFile: false,
    executeCommand: false, gitCommit: false, powershell: false,
  });
  const [draftDirectories, setDraftDirectories] = useState<string[]>([]);
  const [draftFiles, setDraftFiles] = useState<string[]>([]);
  const [newDirectory, setNewDirectory] = useState("");
  const [newFile, setNewFile] = useState("");
  const [dirty, setDirty] = useState({ enabled: false, powershell: false, tools: false, directories: false, files: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<WriteAuditEntry[]>([]);

  const refresh = async (): Promise<void> => {
    try {
      const next = await window.c2c.writePolicy.get();
      setPolicy(next);
      setDraftEnabled(next.enabled);
      setDraftPowershell(next.powershellEnabled);
      setDraftTools({ ...next.tools });
      setDraftDirectories(next.allowedDirectories.slice());
      setDraftFiles(next.allowedFiles.slice());
      setDirty({ enabled: false, powershell: false, tools: false, directories: false, files: false });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const refreshAudit = async (): Promise<void> => {
    try {
      setAudit(await window.c2c.writePolicy.audit({ limit: 20 }));
    } catch {
      // Audit display failure does not change the local policy.
    }
  };

  useEffect(() => {
    void refresh();
    void refreshAudit();
  }, []);

  const updateEnabledDraft = (enabled: boolean): void => {
    setDraftEnabled(enabled);
    setDirty((current) => ({ ...current, enabled: enabled !== (policy?.enabled ?? false) }));
  };

  const updatePowershellDraft = (enabled: boolean): void => {
    setDraftPowershell(enabled);
    setDraftTools((current) => ({ ...current, powershell: enabled }));
    setDirty((current) => ({ ...current, powershell: enabled !== (policy?.powershellEnabled ?? false) }));
  };

  const updateToolDraft = (id: WriteToolId, enabled: boolean): void => {
    const next = { ...draftTools, [id]: enabled };
    setDraftTools(next);
    const baseline = policy?.tools;
    setDirty((current) => ({
      ...current,
      tools: TOOL_CATALOG.some((tool) => next[tool.id] !== (baseline?.[tool.id] ?? false)),
    }));
    if (id === "powershell") {
      setDraftPowershell(enabled);
      setDirty((current) => ({ ...current, powershell: enabled !== (policy?.powershellEnabled ?? false) }));
    }
  };

  const updateDirectoriesDraft = (directories: string[]): void => {
    setDraftDirectories(directories);
    setDirty((current) => ({
      ...current,
      directories: !arraysEqualUnordered(policy?.allowedDirectories ?? [], directories),
    }));
  };

  const updateFilesDraft = (files: string[]): void => {
    setDraftFiles(files);
    setDirty((current) => ({
      ...current,
      files: !arraysEqualUnordered(policy?.allowedFiles ?? [], files),
    }));
  };

  const onApply = async (): Promise<void> => {
    const update: WritePolicyUpdate = {};
    if (dirty.enabled) update.enabled = draftEnabled;
    if (dirty.powershell) update.powershellEnabled = draftPowershell;
    if (dirty.tools) {
      const baseline = policy?.tools;
      const changed: Partial<WriteToolToggles> = {};
      for (const tool of TOOL_CATALOG) {
        if (draftTools[tool.id] !== (baseline?.[tool.id] ?? false)) changed[tool.id] = draftTools[tool.id];
      }
      update.tools = changed;
    }
    if (dirty.directories) update.allowedDirectories = draftDirectories;
    if (dirty.files) update.allowedFiles = draftFiles;
    setPending(true);
    setError(null);
    try {
      await window.c2c.writePolicy.set({ update, actor: ACTOR, requireConfirmation: true });
      await refresh();
      await refreshAudit();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const enabledPill = useMemo(() => {
    if (!policy) return { text: "加载中", tone: "neutral" as const };
    return policy.enabled
      ? { text: "已启用", tone: "ok" as const }
      : { text: "未启用", tone: "warn" as const };
  }, [policy]);

  const hasDirtyChanges = dirty.enabled || dirty.powershell || dirty.tools || dirty.directories || dirty.files;

  return (
    <div data-testid="write-auth-page" style={{ display: "grid", gap: 16, padding: 16 }}>
      {error ? <div className="error-banner" data-testid="write-auth-error">{error}</div> : null}

      <div className="banner info" role="note">
        本页只影响 <strong>Codex 48765</strong> 的写入/PowerShell 策略，不改变 C2C Runtime（48767）的目录权限。
        C2C Runtime 的目录读写请到「文件夹权限（C2C）」。
      </div>

      <section className="card" data-testid="write-auth-identity-card">
        <h3 style={{ margin: 0 }}>当前授权绑定</h3>
        <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px" }}>
          <dt>设备</dt><dd><code>{policy?.deviceId ?? "本机策略"}</code></dd>
          <dt>连接/Profile</dt><dd><code>{policy?.profileId ?? "Codex 48765（独立于 C2C Profile）"}</code></dd>
          <dt>48765 工作区 ID</dt><dd><code>{policy?.workspaceId ?? "尚未绑定"}</code></dd>
          <dt>48765 工作区目录</dt><dd><code>{policy?.workspaceRoot ?? "尚未绑定"}</code></dd>
        </dl>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          授权绑定读取 48765 桥报告的工作区，不跟随 C2C 当前打开的项目；内部/远端各自的本机策略互不共享。
        </p>
      </section>

      <section className="card" data-testid="write-auth-toggle-card">
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h3 style={{ margin: 0 }}>本地文件写入开关</h3>
            <p style={{ margin: 0, color: "var(--muted)" }}>
              开启后，仅 Codex 48765 MCP 可在下方明确授权的目录或文件中创建、修改和覆盖文件；不会逐文件弹窗。此策略目前不改变 C2C 48767 Runtime 的 Supervisor／审批策略。
            </p>
          </div>
          <span className={`pill pill-${enabledPill.tone}`} data-testid="write-auth-status">{enabledPill.text}</span>
        </header>
        <label className="switch" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            data-testid="write-auth-enabled"
            checked={draftEnabled}
            onChange={(event) => updateEnabledDraft(event.target.checked)}
          />
          <span>启用本地文件写入</span>
        </label>
      </section>

      <section className="card" data-testid="write-auth-powershell-card">
        <header>
          <h3 style={{ margin: 0 }}>完整 PowerShell 开关（独立高风险）</h3>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            此开关只控制 run_powershell。受限 execute_command 与 git_commit 使用下方各自独立开关，不再与 PowerShell 绑定。完整 PowerShell 以当前 Windows 用户权限执行任意命令，不受文件白名单限制，也不是 OS 沙箱，因此默认关闭。
          </p>
        </header>
        <label className="switch" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            data-testid="write-auth-powershell"
            checked={draftPowershell}
            onChange={(event) => updatePowershellDraft(event.target.checked)}
          />
          <span>启用完整 PowerShell（高风险）</span>
        </label>
        <p style={{ margin: "8px 0 0", color: "var(--muted)", fontSize: 12 }}>
          当前状态：{policy?.powershellEnabled ? "已启用" : "未启用"}。打开需本机确认；关闭只会立即拒绝新的完整 PowerShell，不影响单独授权的受限命令与 Git commit。
        </p>
      </section>

      <section className="card" data-testid="write-auth-tools-card">
        <header>
          <h3 style={{ margin: 0 }}>MCP 功能开关（按工具独立控制）</h3>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            每个开关对应 ChatGPT 可调用的一组 MCP 工具，默认全部关闭。勾选后才生效，改动需本机确认；取消勾选立即拒绝该类新操作。开关只控制“能不能调”，OAuth 授权与审计链始终生效。
          </p>
        </header>
        <ul className="dir-list" style={{ marginTop: 12 }}>
          {TOOL_CATALOG.map((tool) => (
            <li key={tool.id} className="dir-item" data-testid={`write-auth-tool-${tool.id}`}>
              <label className="switch" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  data-testid={`write-auth-tool-${tool.id}-toggle`}
                  checked={draftTools[tool.id]}
                  onChange={(event) => updateToolDraft(tool.id, event.target.checked)}
                />
                <span>
                  <strong>{tool.name}</strong>
                  <span style={{ display: "block", color: "var(--muted)", fontSize: 12 }}>{tool.description}</span>
                  <span style={{ display: "block", color: "var(--muted)", fontSize: 12 }}>
                    当前：{policy?.tools[tool.id] ? "已启用" : "未启用"}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" data-testid="write-auth-dirs-card">
        <header>
          <h3 style={{ margin: 0 }}>允许写入的目录</h3>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            目录中的文件可被创建、修改或覆盖。请填写明确的绝对路径；不会自动扩大到整个磁盘。
          </p>
        </header>
        <ul className="dir-list" data-testid="write-auth-dir-list">
          {draftDirectories.length === 0 ? <li className="empty">尚未添加任何目录</li> : draftDirectories.map((directory) => (
            <li key={directory} className="dir-item" data-testid="write-auth-dir-item">
              <code>{directory}</code>
              <button className="btn btn-danger btn-sm" onClick={() => updateDirectoriesDraft(draftDirectories.filter((entry) => entry !== directory))} data-testid="write-auth-dir-remove">
                移除
              </button>
            </li>
          ))}
        </ul>
        <div className="add-row" style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="C:\workspace\\docs"
            value={newDirectory}
            onChange={(event) => setNewDirectory(event.target.value)}
            data-testid="write-auth-dir-input"
            className="path-input"
          />
          <button
            className="btn"
            onClick={() => {
              const value = newDirectory.trim();
              if (!value || draftDirectories.includes(value)) return;
              updateDirectoriesDraft([...draftDirectories, value]);
              setNewDirectory("");
            }}
            disabled={!newDirectory.trim()}
            data-testid="write-auth-dir-add"
          >添加</button>
        </div>
      </section>

      <section className="card" data-testid="write-auth-files-card">
        <header>
          <h3 style={{ margin: 0 }}>允许写入的单个文件</h3>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            仅放行所列的精确文件路径；适合只需要修改少数配置或脚本文件的情况。
          </p>
        </header>
        <ul className="dir-list" data-testid="write-auth-file-list">
          {draftFiles.length === 0 ? <li className="empty">尚未添加任何文件</li> : draftFiles.map((file) => (
            <li key={file} className="dir-item" data-testid="write-auth-file-item">
              <code>{file}</code>
              <button className="btn btn-danger btn-sm" onClick={() => updateFilesDraft(draftFiles.filter((entry) => entry !== file))} data-testid="write-auth-file-remove">
                移除
              </button>
            </li>
          ))}
        </ul>
        <div className="add-row" style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="C:\workspace\\scripts\\build.ps1"
            value={newFile}
            onChange={(event) => setNewFile(event.target.value)}
            data-testid="write-auth-file-input"
            className="path-input"
          />
          <button
            className="btn"
            onClick={() => {
              const value = newFile.trim();
              if (!value || draftFiles.includes(value)) return;
              updateFilesDraft([...draftFiles, value]);
              setNewFile("");
            }}
            disabled={!newFile.trim()}
            data-testid="write-auth-file-add"
          >添加文件</button>
        </div>
      </section>

      <section className="card" data-testid="write-auth-apply-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <strong>{hasDirtyChanges ? "有未应用的变更" : "所有变更已同步"}</strong>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
              上次更新：{policy?.updatedAt ? formatTimestamp(policy.updatedAt) : "—"} · 操作者：{policy?.updatedBy ?? "—"}
            </p>
          </div>
          <button className="btn btn-primary" onClick={onApply} disabled={!hasDirtyChanges || pending} data-testid="write-auth-apply">
            {pending ? "提交中…" : "应用变更"}
          </button>
        </div>
        <p style={{ marginTop: 8, color: "var(--muted)", fontSize: 12 }}>
          新增授权路径或打开写入开关时会弹出本机确认框；确认后才保存到 write-policy.json。
        </p>
      </section>

      <section className="card" data-testid="write-auth-audit-card">
        <header>
          <h3 style={{ margin: 0 }}>最近 20 条操作审计</h3>
          <p style={{ margin: 0, color: "var(--muted)" }}>合并显示当前 C2C Profile 与 Codex 48765 桥的文件、命令和提交记录；不显示文件正文或命令正文。</p>
        </header>
        {audit.length === 0 ? <p style={{ color: "var(--muted)" }}>暂无文件操作记录。</p> : (
          <table className="audit-table" data-testid="write-auth-audit-table">
            <thead><tr><th>时间</th><th>来源</th><th>操作</th><th>结果</th><th>客户端</th><th>路径/工作区</th><th>字节</th></tr></thead>
            <tbody>{audit.map((entry) => (
              <tr key={`${entry.source}-${entry.sequence}-${entry.timestamp}`} data-testid="write-auth-audit-row">
                <td>{formatTimestamp(entry.timestamp)}</td>
                <td>{entry.source === "legacy" ? "legacy" : "runtime"}</td>
                <td>{entry.operation}</td>
                <td>{entry.outcome}{entry.reasonCode ? ` · ${entry.reasonCode}` : ""}</td>
                <td><code>{entry.actor.clientId}</code></td>
                <td><code>{entry.relativePath}</code></td>
                <td>{entry.bytesWritten}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
