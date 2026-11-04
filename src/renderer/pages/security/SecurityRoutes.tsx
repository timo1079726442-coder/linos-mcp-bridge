import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalDecisionActions,
  ApprovalQueueSnapshot,
  FolderAclSnapshot,
} from "../../../shared/security.js";
import { FolderPermissionsPage } from "./FolderPermissionsPage.tsx";
import { WriteApprovalsPage } from "./WriteApprovalsPage.tsx";

type LoadState = "loading" | "error" | undefined;

interface SnapshotState<T> {
  snapshot: T | null;
  loadState: LoadState;
}

const LOAD_ERROR = "本机安全接口暂不可用；请在诊断与日志中检查 Supervisor 与当前授权状态。";

function useSecuritySnapshot<T>(load: () => Promise<T>): {
  snapshot: T | null;
  loadState: LoadState;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<SnapshotState<T>>({ snapshot: null, loadState: "loading" });
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setState({ snapshot: null, loadState: "loading" });
    try {
      const snapshot = await load();
      if (version === requestVersion.current) setState({ snapshot, loadState: undefined });
    } catch {
      if (version === requestVersion.current) setState({ snapshot: null, loadState: "error" });
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    return () => { requestVersion.current += 1; };
  }, [refresh]);

  return { ...state, refresh };
}

/** Live route container: every snapshot and action crosses the typed preload API. */
export function FolderPermissionsRoute(): JSX.Element {
  const load = useCallback(() => window.c2c.security.folderAcl.get(), []);
  const { snapshot, loadState, refresh } = useSecuritySnapshot<FolderAclSnapshot>(load);
  const actions = useMemo(() => ({
    add: (input: Parameters<typeof window.c2c.security.folderAcl.add>[0]) => window.c2c.security.folderAcl.add(input),
    remove: (input: Parameters<typeof window.c2c.security.folderAcl.remove>[0]) => window.c2c.security.folderAcl.remove(input),
    check: (input: Parameters<typeof window.c2c.security.folderAcl.check>[0]) => window.c2c.security.folderAcl.check(input),
    pickFolder: () => window.c2c.security.folderAcl.pick(),
  }), []);

  return (
    <FolderPermissionsPage
      snapshot={snapshot}
      loadState={loadState}
      errorMessage={loadState === "error" ? LOAD_ERROR : undefined}
      actions={actions}
      refresh={refresh}
    />
  );
}

/** Live route container: approval decisions and execution call distinct preload actions. */
export function WriteApprovalsRoute(): JSX.Element {
  const load = useCallback(() => window.c2c.security.approvals.list(), []);
  const { snapshot, loadState, refresh } = useSecuritySnapshot<ApprovalQueueSnapshot>(load);
  const actions = useMemo<ApprovalDecisionActions>(() => ({
    decide: async (request, decision) => { await window.c2c.security.approvals.decide(request, decision); },
    execute: async (request) => {
      const result = await window.c2c.security.approvals.execute(request);
      if (result.status !== "UNAVAILABLE") throw new Error("APPROVAL_UNEXPECTED_EXECUTION_RESULT");
      throw new Error(result.code);
    },
    revoke: async (request) => { await window.c2c.security.approvals.revoke(request); },
  }), []);

  return (
    <>
      <div className="page-section" aria-label="原有单文件审批流程">
        <div className="section-title">本机审批队列 · 独立审批流程</div>
        <p className="muted">只处理已经通过 Supervisor 安全校验的请求。上方 MCP 批量预览不能直接在这里批准。</p>
        <WriteApprovalsPage
          snapshot={snapshot}
          loadState={loadState}
          errorMessage={loadState === "error" ? LOAD_ERROR : undefined}
          actions={actions}
          refresh={refresh}
        />
      </div>
    </>
  );
}
