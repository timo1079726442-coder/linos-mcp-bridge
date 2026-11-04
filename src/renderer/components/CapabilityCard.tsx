import { useEffect, useState } from "react";
import type { ProfileConfig } from "../../shared/types.js";

interface CapabilitySnapshot {
  workspaceRoot: string | null;
  port: number | null;
  publicUrl: string | null;
  provider: string | null;
  tools: { total: number; enabled: number; auto: number } | null;
  scopes: string[];
  error: string | null;
}

const SCOPE_LABEL: Record<string, string> = {
  "workspace.read": "读文件",
  "workspace.search": "搜索",
  "git.read": "看 Git",
  "execution.read": "看任务输出",
  "workspace.write": "写文件",
  "workspace.shell": "执行命令",
  offline_access: "离线续期",
};

/**
 * 能力总览：用大白话回答"这台机器现在能干什么"。
 * 数据全部实时读取（端口、工具数、权限范围），不写死任何值。
 */
export function CapabilityCard({ profile }: { profile: ProfileConfig | null }): JSX.Element {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>({
    workspaceRoot: null, port: null, publicUrl: null, provider: null, tools: null, scopes: [], error: null,
  });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const next: CapabilitySnapshot = {
        workspaceRoot: profile?.currentWorkspace?.root ?? null,
        port: profile?.transport?.expectedLocalPort ?? null,
        publicUrl: profile?.transport?.publicMcpUrl ?? null,
        provider: profile?.transport?.provider ?? null,
        tools: null,
        scopes: [],
        error: null,
      };
      try {
        if (next.port) {
          const info = (await window.c2c.peer.inspect(next.port)) as { tools?: Array<{ enabled?: boolean; approval?: string }> };
          const tools = info.tools ?? [];
          next.tools = {
            total: tools.length,
            enabled: tools.filter((t) => t.enabled !== false).length,
            auto: tools.filter((t) => t.enabled !== false && t.approval !== "manual").length,
          };
        }
        const policy = await window.c2c.toolPolicy.get().catch(() => null);
        if (policy) {
          const enabledNames = Object.entries(policy.tools ?? {}).filter(([, v]) => v?.enabled).length;
          if (next.tools) next.tools.enabled = enabledNames;
        }
        const settings = await window.c2c.profile.getServiceSettings().catch(() => null);
        next.scopes = (settings as unknown as { grantedScopes?: string[] } | null)?.grantedScopes ?? [];
      } catch (cause) {
        next.error = cause instanceof Error ? cause.message : String(cause);
      }
      if (alive) setSnapshot(next);
    })();
    return () => { alive = false; };
  }, [profile]);

  const tools = snapshot.tools;
  return (
    <section className="v2-card" aria-label="能力总览">
      <div className="v2-card-head">
        <strong>这台机器现在能干什么</strong>
        <span className="muted" style={{ fontSize: 12 }}>全部实时读取，不是写死的说明</span>
      </div>

      <div className="kv">
        <div className="k">让 AI 操作哪个文件夹</div>
        <div className="v">{snapshot.workspaceRoot ?? "还没选（去「工作区」选一个目录）"}</div>

        <div className="k">本机地址</div>
        <div className="v">{snapshot.port ? `http://127.0.0.1:${snapshot.port}/mcp` : "未启动"}</div>

        <div className="k">外网地址</div>
        <div className="v">{snapshot.publicUrl ?? "仅本机可用（想出外网去「MCP 服务 → 公网隧道」开）"}</div>

        <div className="k">可用工具</div>
        <div className="v">
          {tools ? `共 ${tools.total} 个，已开启 ${tools.enabled} 个（其中 ${tools.auto} 个免确认）` : "读取中…"}
        </div>

        <div className="k">允许 AI 做什么</div>
        <div className="v">
          {snapshot.scopes.length > 0
            ? snapshot.scopes.map((s) => SCOPE_LABEL[s] ?? s).join("、")
            : "未授权任何连接器（去「连接授权」配对）"}
        </div>
      </div>

      {snapshot.error && <p className="muted" style={{ fontSize: 12 }}>部分数据读取失败：{snapshot.error}</p>}
    </section>
  );
}
