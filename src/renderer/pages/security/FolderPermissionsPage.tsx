import React, { useState } from "react";
import { FILE_TYPE_PRESETS, parseExtensionSelection, toggleExtension, validateFileTypeAcl } from "./fileTypePresets.js";
import {
  formatFolderAccess,
  isSnapshotStale,
  type FolderAccessCheckInput,
  type FolderAccessEntry,
  type FolderAccessVerdict,
  type FolderAclAddInput,
  type FolderAclRemoveInput,
  type FolderAccessSnapshot,
} from "../../domain/workspaceSecurity.js";

export interface FolderPermissionsPageActions {
  add(input: FolderAclAddInput): Promise<FolderAccessEntry>;
  remove(input: FolderAclRemoveInput): Promise<{ removed: boolean; revision: number }>;
  check(input: FolderAccessCheckInput): Promise<FolderAccessVerdict>;
  pickFolder?(): Promise<string | null>;
}

export interface FolderPermissionsPageProps {
  snapshot?: FolderAccessSnapshot | null;
  loadState?: "loading" | "error";
  errorMessage?: string;
  actions?: FolderPermissionsPageActions;
  refresh?: () => Promise<void>;
}

function extensionSummary(policy: FolderAccessEntry["extensionPolicy"]): string {
  const denied = policy.deniedExtensions.length ? `；拒绝：${policy.deniedExtensions.join(", ")}` : "";
  if (policy.mode === "ALLOW_ALL") return `允许全部${denied}`;
  return `允许：${policy.allowedExtensions.join(", ") || "无扩展名"}${denied}`;
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  const known = new Set([
    "COMPANY_PROFILE_PROTECTED", "SECURITY_WORKSPACE_REQUIRED", "ACL_PATH_NOT_ABSOLUTE", "ACL_PATH_UNAVAILABLE",
    "ACL_RULE_PATH_NOT_DIRECTORY", "ACL_OUTSIDE_WORKSPACE", "ACL_PATH_UNRESOLVABLE", "ACL_WORKSPACE_UNAVAILABLE",
    "ACL_SCOPE_MISMATCH", "ACL_STALE_REVISION", "ACL_BAD_EXTENSION", "ACL_BAD_PERMISSION", "ACL_STORE_UNAVAILABLE",
    "ACL_CONFIRMATION_CANCELLED", "ACL_CONFIRMATION_WINDOW_UNAVAILABLE", "ACL_PROFILE_OR_WORKSPACE_CHANGED",
    "ACL_RULE_NOT_FOUND", "ACL_RULE_CHANGED_DURING_CONFIRMATION", "ACL_LOCAL_CONFIRMATION_REQUIRED", "ACL_BAD_REQUEST",
  ]);
  return known.has(code) ? code : "ACL_OPERATION_FAILED";
}

function displayAclError(code: string): string {
  const messages: Record<string, string> = {
    COMPANY_PROFILE_PROTECTED: "Legacy Profile 已锁定，不能修改本机 ACL。",
    SECURITY_WORKSPACE_REQUIRED: "当前 Profile 没有已验证的 Workspace。",
    ACL_PATH_NOT_ABSOLUTE: "请选择或输入完整目录路径。",
    ACL_PATH_UNAVAILABLE: "目录不存在或当前不可访问。",
    ACL_RULE_PATH_NOT_DIRECTORY: "授权目标必须是目录。",
    ACL_OUTSIDE_WORKSPACE: "目录不在当前 Workspace 范围内。",
    ACL_PATH_UNRESOLVABLE: "目录路径无法安全解析。",
    ACL_WORKSPACE_UNAVAILABLE: "当前 Workspace 无法验证。",
    ACL_SCOPE_MISMATCH: "ACL 与当前 Profile/Workspace 不匹配，已拒绝操作。",
    ACL_STALE_REVISION: "规则版本已变化，请刷新后重试。",
    ACL_BAD_EXTENSION: "扩展名限制无效。",
    ACL_BAD_PERMISSION: "权限选项无效。",
    ACL_STORE_UNAVAILABLE: "ACL 真源暂时不可用。",
    ACL_CONFIRMATION_CANCELLED: "本机确认已取消，ACL 没有变更。",
    ACL_CONFIRMATION_WINDOW_UNAVAILABLE: "本机确认窗口不可用，ACL 没有变更。",
    ACL_PROFILE_OR_WORKSPACE_CHANGED: "确认期间 Profile 或 Workspace 已变化，ACL 操作已拒绝。",
    ACL_RULE_NOT_FOUND: "规则已不存在，请刷新后重试。",
    ACL_RULE_CHANGED_DURING_CONFIRMATION: "确认期间规则发生变化，ACL 操作已拒绝。",
    ACL_LOCAL_CONFIRMATION_REQUIRED: "必须通过本机确认后才能修改 ACL。",
    ACL_BAD_REQUEST: "ACL 请求格式无效，未执行变更。",
    ACL_OPERATION_FAILED: "本机权限操作失败；刷新并查看诊断信息。",
  };
  return messages[code] ?? messages.ACL_OPERATION_FAILED!;
}

function PermissionEditor({
  snapshot,
  actions,
  disabled,
  refresh,
}: {
  snapshot: FolderAccessSnapshot;
  actions?: FolderPermissionsPageActions;
  disabled: boolean;
  refresh?: () => Promise<void>;
}): JSX.Element | null {
  const [folderPath, setFolderPath] = useState("");
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<FolderAclAddInput["access"]>("READ_ONLY");
  const [extensionMode, setExtensionMode] = useState<"ALLOW_LIST" | "ALLOW_ALL">("ALLOW_LIST");
  const [extensions, setExtensions] = useState(".md, .txt, .json");
  const [checkPath, setCheckPath] = useState("");
  const [checkOperation, setCheckOperation] = useState<FolderAccessCheckInput["operation"]>("read");
  const [checkResult, setCheckResult] = useState<FolderAccessVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  if (!actions) return null;

  async function perform(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setFailureCode(null);
    try {
      await action();
      await refresh?.();
    } catch (error) {
      setFailureCode(safeErrorCode(error));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFolder(): Promise<void> {
    if (!actions?.pickFolder) return;
    setBusy(true);
    setFailureCode(null);
    try {
      const picked = await actions.pickFolder();
      if (picked) setFolderPath(picked);
    } catch (error) {
      setFailureCode(safeErrorCode(error));
    } finally {
      setBusy(false);
    }
  }

  const mutationDisabled = disabled || busy || snapshot.mutationAvailability !== "AVAILABLE";
  const extensionError = validateFileTypeAcl(access, extensionMode, extensions);
  return (
    <section className="page-section" aria-label="文件夹权限操作">
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-title">新增目录授权</div>
        <p className="muted" style={{ fontSize: 12 }}>规则只对当前 Profile 和 Workspace 生效；无规则时默认拒绝。读写权限仍会在每次操作时重新校验。</p>
        {snapshot.mutationAvailability === "PROFILE_PROTECTED" && (
          <div className="banner warn" role="status">Legacy Profile 已保护，ACL 仅可查看。</div>
        )}
        <label htmlFor="acl-folder-path" style={{ display: "grid", gap: 6 }}>目录路径</label>
        <div className="row" style={{ alignItems: "stretch", marginTop: 6 }}>
          <input id="acl-folder-path" className="input" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="选择当前 Workspace 内的目录" disabled={mutationDisabled} />
          {actions.pickFolder && <button className="btn secondary" type="button" disabled={mutationDisabled} onClick={() => void chooseFolder()}>选择目录</button>}
        </div>
        <div className="row" style={{ alignItems: "end", marginTop: 12, flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 6, minWidth: 180 }}>授权名称<input className="input" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} placeholder="可选" disabled={mutationDisabled} /></label>
          <label style={{ display: "grid", gap: 6, minWidth: 180 }}>权限<select className="input" value={access} onChange={(event) => setAccess(event.target.value as FolderAclAddInput["access"])} disabled={mutationDisabled}>
            <option value="READ_ONLY">只读</option><option value="READ_WRITE">读写</option><option value="DENY">禁止</option>
          </select></label>
          <label style={{ display: "grid", gap: 6, minWidth: 200 }}>扩展名策略<select className="input" value={extensionMode} onChange={(event) => setExtensionMode(event.target.value as "ALLOW_LIST" | "ALLOW_ALL")} disabled={mutationDisabled}>
            <option value="ALLOW_LIST">仅允许指定扩展名</option><option value="ALLOW_ALL">允许全部扩展名</option>
          </select></label>
        </div>
        {extensionMode === "ALLOW_LIST" && (
          <label style={{ display: "grid", gap: 6, marginTop: 10 }}>允许的扩展名（逗号分隔）
            <input className="input" value={extensions} onChange={(event) => setExtensions(event.target.value)} placeholder=".md, .txt" disabled={mutationDisabled} />
          </label>
        )}
        {extensionMode === "ALLOW_LIST" && (
          <fieldset aria-label="文件类型快捷选择" disabled={mutationDisabled}
            style={{ marginTop: 12, border: "1px solid #445", borderRadius: 8, padding: 12 }}>
            <legend style={{ padding: "0 6px", fontWeight: 600 }}>文件类型快捷选择（支持手动增减）</legend>
            <p className="muted" style={{ fontSize: 12 }}>
              复用原有文件夹授权。选择类型不会直接打开 MCP 权限，真正权限还需本机审批与服务端校验。
            </p>
            {FILE_TYPE_PRESETS.map((group) => (
              <div key={group.id} style={{ marginBottom: 8 }}>
                <span className="muted" style={{ display: "block", fontSize: 12 }}>{group.label}</span>
                <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  {group.extensions.map((ext) => {
                    const chosen = parseExtensionSelection(extensions).includes(ext);
                    return <button key={ext} type="button" className="btn secondary"
                      aria-label={"切换文件类型 " + ext} aria-pressed={chosen}
                      onClick={() => setExtensions(current => toggleExtension(current, ext))}
                      style={{ padding: "5px 9px", fontSize: 12 }}>{chosen ? "✓ " : ""}{ext}</button>;
                  })}
                </div>
              </div>
            ))}
          </fieldset>
        )}
        {extensionMode === "ALLOW_LIST" && parseExtensionSelection(extensions).includes(".har") && (
          <p className="banner warn" role="status" style={{ marginTop: 10 }}>
            HAR 可能包含 Cookie、Token 和接口敏感参数。只读授权不等于内容自动脱敏；建议使用安全 HAR 预览工具，正式授权前核查读取与搜索的脱敏边界。
          </p>
        )}
        {extensionError && <p role="alert" className="banner warn" style={{ marginTop: 10 }}>{extensionError}</p>}
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          HAR、办公文档、图片与压缩包在此仅开放只读配置；它们的修改需要独立处理器与审批。
        </p>
        <button
          className="btn"
          type="button"
          style={{ marginTop: 12 }}
          disabled={mutationDisabled || !folderPath.trim() || extensionError !== null}
          onClick={() => void perform(() => actions.add({
            path: folderPath.trim(),
            access,
            label: label.trim() || undefined,
            extensionPolicy: extensionMode === "ALLOW_ALL"
              ? { mode: "ALLOW_ALL" }
              : { mode: "ALLOW_LIST", allowedExtensions: parseExtensionSelection(extensions) },
          }))}
        >
          添加授权规则
        </button>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-title">检查目标访问权限</div>
        <div className="row" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
          <input className="input" aria-label="检查目标路径" value={checkPath} onChange={(event) => setCheckPath(event.target.value)} placeholder="输入 Workspace 内文件路径" disabled={busy} />
          <select className="input" aria-label="检查操作" value={checkOperation} onChange={(event) => setCheckOperation(event.target.value as FolderAccessCheckInput["operation"])} disabled={busy}>
            <option value="read">读取</option><option value="write">写入</option>
          </select>
          <button className="btn secondary" type="button" disabled={busy || !checkPath.trim()} onClick={() => void perform(async () => setCheckResult(await actions.check({ path: checkPath.trim(), operation: checkOperation })))}>检查权限</button>
        </div>
        {checkResult && (
          <div className={`banner ${checkResult.allowed ? "info" : "warn"}`} role="status" style={{ marginTop: 10 }}>
            {checkResult.allowed ? `当前判定允许${checkResult.operation === "read" ? "读取" : "写入"}，ACL 修订 r${checkResult.aclRevision}。` : `当前判定拒绝：${checkResult.reason}。`}
            {checkResult.canonicalPath && <div style={{ overflowWrap: "anywhere" }}>规范化路径：{checkResult.canonicalPath}</div>}
          </div>
        )}
      </div>
      {failureCode && <div className="banner error" role="alert">{displayAclError(failureCode)}</div>}
    </section>
  );
}

/** Displays the live ACL projection and provides only typed, Supervisor-backed actions. */
export function FolderPermissionsPage({ snapshot = null, loadState, errorMessage, actions, refresh }: FolderPermissionsPageProps): JSX.Element {
  const [removingRuleId, setRemovingRuleId] = useState<string | null>(null);
  const [removeFailureCode, setRemoveFailureCode] = useState<string | null>(null);
  const [aclQuery, setAclQuery] = useState("");

  async function removeRule(entry: FolderAccessEntry): Promise<void> {
    if (!actions) return;
    setRemovingRuleId(entry.ruleId);
    setRemoveFailureCode(null);
    try {
      await actions.remove({ ruleId: entry.ruleId, expectedRevision: entry.revision });
      await refresh?.();
    } catch (error) {
      setRemoveFailureCode(safeErrorCode(error));
    } finally {
      setRemovingRuleId(null);
    }
  }

  if (loadState === "loading") {
    return <div data-testid="folder-permissions-page"><div className="section-empty-state"><div className="empty-state-mark">…</div><div><h2>正在读取文件夹授权</h2><p>等待本机 ACL 真源返回范围和更新时间。</p></div></div></div>;
  }

  if (loadState === "error") {
    return <div data-testid="folder-permissions-page"><div className="banner error" role="alert">文件夹授权读取失败（UNKNOWN）：{errorMessage || "本机 ACL 接口不可用。"}</div></div>;
  }

  if (!snapshot) {
    return (
      <div data-testid="folder-permissions-page">
      <div className="section-empty-state" data-testid="folder-acl-no-data">
        <div className="empty-state-mark">?</div>
        <div>
          <h2>文件夹 ACL 尚无可用快照 · NO_DATA</h2>
          <p>当前 Profile/Workspace 或 ACL 真源尚未验证。页面不推断任何目录已授权、只读或禁止访问。</p>
          <p className="empty-state-note">MCP 继续保持只读；新增、撤销和访问检查必须由本机 Supervisor 按当前 Profile、Workspace 与规范化路径复核。</p>
        </div>
        <span className="status-badge status-unknown">未验证</span>
      </div>
      </div>
    );
  }

  const stale = isSnapshotStale(snapshot.observedAt, snapshot.staleAfterMs);
  const disabled = stale;
  return (
    <div data-testid="folder-permissions-page">
      <div className={`banner ${stale ? "warn" : "info"}`}>
        Profile {snapshot.profileName} ({snapshot.profileType}) · Workspace <code>{snapshot.workspaceId}</code> · 读取于 {snapshot.observedAt}
        {stale ? " · 数据已过期，刷新后才能操作。" : " · 每次访问仍会由 Supervisor 重新计算。"}
      </div>
      <PermissionEditor snapshot={snapshot} actions={actions} disabled={disabled} refresh={refresh} />
      {snapshot.entries.length === 0 ? (
        <div className="section-empty-state" data-testid="folder-acl-empty">
          <div className="empty-state-mark">—</div>
          <div><h2>当前没有 ACL 规则</h2><p>无规则表示当前没有目录获得额外访问授权；可在上方添加最小范围规则。</p></div>
          <span className="status-badge status-unknown">默认拒绝</span>
        </div>
      ) : (
        <div className="page-section" aria-label="文件夹权限列表">
          <div className="v2-card" style={{ padding: 0 }}>
            <div className="row" style={{ gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 220 }}
                value={aclQuery}
                onChange={(event) => setAclQuery(event.target.value)}
                placeholder="搜索路径、标签或 Profile…"
                aria-label="搜索目录权限"
              />
              <span className="muted" style={{ fontSize: 12 }}>共 {snapshot.entries.length} 条</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="acl-table">
                <thead>
                  <tr><th>目录</th><th>权限</th><th>扩展名</th><th>Profile / Workspace</th><th>更新</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {snapshot.entries
                    .filter((entry) => {
                      const text = `${entry.folderPath} ${entry.profileName ?? ""}`.toLowerCase();
                      return !aclQuery.trim() || text.includes(aclQuery.trim().toLowerCase());
                    })
                    .map((entry) => (
                      <tr key={entry.ruleId}>
                        <td>
                          <strong style={{ overflowWrap: "anywhere" }}>{entry.folderPath}</strong>
                          
                        </td>
                        <td>
                          <span className={`status-badge ${entry.access === "DENY" ? "status-danger" : entry.access === "READ_WRITE" ? "status-warning" : "status-success"}`}>
                            {formatFolderAccess(entry.access)}
                          </span>
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>{extensionSummary(entry.extensionPolicy)}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{entry.profileName ?? "—"}<br /><code>{entry.workspaceId}</code></td>
                        <td className="muted" style={{ fontSize: 12 }}>r{entry.revision}<br />{entry.updatedAt}</td>
                        <td>
                          {actions && (
                            <button className="btn secondary" type="button" disabled={disabled || removingRuleId !== null || snapshot.mutationAvailability !== "AVAILABLE"} onClick={() => void removeRule(entry)}>
                              {removingRuleId === entry.ruleId ? "撤销中…" : "撤销"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {snapshot.entries.filter((entry) => {
              const text = `${entry.folderPath} ${entry.profileName ?? ""}`.toLowerCase();
              return !aclQuery.trim() || text.includes(aclQuery.trim().toLowerCase());
            }).length === 0 && (
              <div className="muted" style={{ padding: 16 }}>没有匹配的目录规则。</div>
            )}
          </div>
        </div>
      )}
      {removeFailureCode && <div className="banner error" role="alert">{displayAclError(removeFailureCode)} ACL 撤销未确认成功；刷新后核对当前规则。</div>}
      {snapshot.mutationAvailability === "PROFILE_PROTECTED" && <p className="muted" style={{ fontSize: 12 }}>Legacy Profile 仅提供只读视图，不允许新增或撤销 ACL。</p>}
      <p className="muted" style={{ fontSize: 12 }}>授权仅覆盖当前 Profile 与 Workspace；ACL 变更和文件操作都必须再次检查目标路径、有效规则及扩展名策略。</p>
    </div>
  );
}

