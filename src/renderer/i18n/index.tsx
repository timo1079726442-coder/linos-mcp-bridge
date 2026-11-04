import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Lang = "zh" | "en";

type Dict = Record<string, string>;

const zh: Dict = {
  "app.name": "MCP 控制中心",
  "app.tagline": "统一工具 · 本机 / 远端",
  "common.refresh": "刷新",
  "common.retry": "重试",
  "common.copy": "复制",
  "common.copyCode": "复制配对码",
  "common.unknown": "未知",
  "common.normal": "正常",
  "common.problem": "有问题",
  "common.failure": "故障",
  "common.notApplicable": "不适用",
  "common.notStarted": "未启动",
  "common.enabled": "已启用",
  "common.disabled": "已关闭",
  "common.manualReview": "需人工确认",
  "common.viewAll": "逐项查看/调整",
  "common.seconds": "秒",

  "nav.overview": "总览",
  "nav.connect": "连接授权",
  "nav.services": "MCP 服务",
  "nav.jobs": "后台任务",
  "nav.collaboration": "开发协作",
  "nav.workspace": "工作区",
  "nav.security": "权限与审批",
  "nav.diagnostics": "诊断与日志",
  "nav.settings": "设置",
  "nav.main": "主导航",
  "nav.group.work": "工作",
  "nav.group.resources": "资源",
  "nav.group.system": "系统",
  "nav.help.overview": "总览：今天该做什么、哪里不正常，一键进入对应页面",
  "nav.help.connect": "连接授权：把 ChatGPT 或其他客户端接到某个 MCP 服务",
  "nav.help.services": "MCP 服务：端口、隧道、配对、权限和审计都围绕服务组织",
  "nav.help.jobs": "后台任务：查看长任务状态、输出并取消；新任务由客户端发起",
  "nav.help.collaboration": "开发协作：当前项目/分支/改动、测试、任务与 Review 证据",
  "nav.help.workspace": "工作区：当前项目目录、目录权限和只读数据源",
  "nav.help.security": "权限与审批：写入审批、屏幕访问和危险能力总闸",
  "nav.help.diagnostics": "诊断与日志：出问题先来这里看实时诊断、修复与日志",
  "nav.help.settings": "设置：语言、本机 Profile、备份恢复、高级选项与关于",

  "health.title": "现在怎么样",
  "health.selfCheck": "一键自检",
  "health.checking": "自检中…",
  "health.goFix": "去修复",
  "health.autoRefresh": "自动复查",
  "health.lastCheck": "上次检查",
  "health.needAttention": "{count} 项需要处理",
  "health.layer.runtime": "本机服务",
  "health.layer.transport": "公网隧道",
  "health.layer.connector": "ChatGPT 授权",
  "health.layer.conversation": "真实调用",
  "health.layer.workspace": "工作区",
  "health.layer.repository": "Git",
  "health.hint.runtime": "本地服务是否响应",
  "health.hint.transport": "公网地址 + 匿名拦截 + 发现接口",
  "health.hint.connector": "OAuth 是否已授权",
  "health.hint.conversation": "最近是否真的调过工具",
  "health.hint.workspace": "地址与身份是否匹配",
  "health.hint.repository": "是否 Git 仓库",
  "health.cause.runtime": "本地 Runtime 没有响应（进程可能没起来或端口被占）。",
  "health.cause.transport503": "公网返回 503：隧道在线但源站/代理不通（常见于代理软件劫持 cloudflared 出口，或隧道连到旧进程）。",
  "health.cause.transportOther": "公网返回 {status}：隧道或 DNS 指向有问题。",
  "health.cause.transportDown": "公网探测未通过（隧道未连上或匿名访问未被 401 拦截）。",
  "health.cause.connector": "本机没有有效的 OAuth 授权（或授权已过期）。",
  "health.cause.conversation": "最近没有真实的工具调用记录；连上但没调用过时属正常。",
  "health.cause.generic": "这一层需要人工判断。",
  "health.act.restartService": "重启本机服务",
  "health.act.restartTunnel": "重启隧道",
  "health.act.pair": "生成配对码",
  "health.toolsLine": "工具：{enabled}/{total}",
  "health.toolsAll": "（全部启用）",
  "health.toolsSome": "（{count} 个关闭）",
  "health.noProblems": "没有发现故障层；「不适用」表示这一项在当前配置下不需要。",
  "health.problemsTitle": "发现的问题（含原因与一键动作）",
  "health.controlPlaneDown": "控制面暂时连不上（通常是应用刚重启）：",
  "health.controlPlaneHint": "这不是「工具没开」，也不是要重新连接 ChatGPT；只是界面与 Supervisor 的管道断了一次。",
  "health.refreshWindow": "刷新窗口",
  "health.fixRepoDir": "仓库目录（相对工作区，留空=根）",
  "health.gitInit": "初始化 Git 仓库",
  "health.enableDevTools": "开启开发工具（命令 / 任务 / 提交）",
  "health.more": "更多",

  "dash.title": "总览",
  "dash.subtitle": "先看异常，再决定连接、授权还是排障。",
  "dash.refreshState": "刷新状态",
  "dash.newService": "+ 新建 MCP 服务",
  "dash.nextStep": "下一步",
  "dash.checkRecent": "检查最近开发任务",
  "dash.checkRecentDesc": "前往开发协作查看真实 Git、测试和执行摘要。",
  "dash.openCollab": "打开开发协作",
  "dash.connectChatGpt": "连接 ChatGPT",
  "dash.quickTitle": "常用操作 · 一处开始",
  "dash.quickMcp": "需要调整 MCP 授权或查看本机审批？",
  "dash.quickMcpLink": "打开 MCP 控制中心",
  "dash.detailsTitle": "系统详细检查 · 6 项状态（点击展开）",
  "dash.detailsHint": "只有真实检测到的状态才能显示为通过；未验证与无数据不能当作正常。",
  "dash.currentWorkspace": "当前工作区",
  "dash.runtime": "Runtime",
  "dash.pending": "待审批",
  "dash.recentJob": "最近任务",
  "dash.workspace": "工作区",

  "settings.language": "界面语言",
  "settings.languageHint": "切换后立即生效，保存在本机。",
  "settings.zh": "中文",
  "settings.en": "English",
};

const en: Dict = {
  "app.name": "MCP Control Center",
  "app.tagline": "One tool · local / remote",
  "common.refresh": "Refresh",
  "common.retry": "Retry",
  "common.copy": "Copy",
  "common.copyCode": "Copy pairing code",
  "common.unknown": "Unknown",
  "common.normal": "Healthy",
  "common.problem": "Degraded",
  "common.failure": "Failing",
  "common.notApplicable": "N/A",
  "common.notStarted": "Not started",
  "common.enabled": "enabled",
  "common.disabled": "disabled",
  "common.manualReview": "needs review",
  "common.viewAll": "Review each one",
  "common.seconds": "sec",

  "nav.overview": "Overview",
  "nav.connect": "Connect",
  "nav.services": "MCP services",
  "nav.jobs": "Background jobs",
  "nav.collaboration": "Development",
  "nav.workspace": "Workspace",
  "nav.security": "Permissions",
  "nav.diagnostics": "Diagnostics",
  "nav.settings": "Settings",
  "nav.main": "Main navigation",
  "nav.group.work": "Work",
  "nav.group.resources": "Resources",
  "nav.group.system": "System",
  "nav.help.overview": "Overview: what to do today, what is broken, jump straight to the right page",
  "nav.help.connect": "Connect: attach ChatGPT or another client to an MCP service",
  "nav.help.services": "MCP services: ports, tunnel, pairing, permissions and audit live here",
  "nav.help.jobs": "Jobs: watch long-running tasks, read output, cancel; clients start them",
  "nav.help.collaboration": "Development: current project/branch/changes, tests, tasks and reviews",
  "nav.help.workspace": "Workspace: project folder, folder permissions, read-only data sources",
  "nav.help.security": "Permissions: write approvals, screen access and the dangerous-capability gate",
  "nav.help.diagnostics": "Diagnostics: live checks, fixes and logs when something breaks",
  "nav.help.settings": "Settings: language, local profile, backup, advanced options and about",

  "health.title": "How is it now",
  "health.selfCheck": "Run check",
  "health.checking": "Checking…",
  "health.goFix": "Fix it",
  "health.autoRefresh": "Auto re-check",
  "health.lastCheck": "Last checked",
  "health.needAttention": "{count} item(s) need attention",
  "health.layer.runtime": "Local service",
  "health.layer.transport": "Public tunnel",
  "health.layer.connector": "ChatGPT auth",
  "health.layer.conversation": "Real calls",
  "health.layer.workspace": "Workspace",
  "health.layer.repository": "Git",
  "health.hint.runtime": "Does the local service respond",
  "health.hint.transport": "Public URL + anonymous block + discovery",
  "health.hint.connector": "Is OAuth authorized",
  "health.hint.conversation": "Any real tool call recently",
  "health.hint.workspace": "Does the identity match",
  "health.hint.repository": "Is it a Git repository",
  "health.cause.runtime": "Local runtime is not responding (not started, or the port is taken).",
  "health.cause.transport503": "Public endpoint returns 503: the tunnel is up but the origin/代理 is wrong (a proxy hijacking cloudflared egress, or the tunnel points at an old process).",
  "health.cause.transportOther": "Public endpoint returns {status}: tunnel or DNS points somewhere wrong.",
  "health.cause.transportDown": "Public probe failed (tunnel down, or anonymous access is not blocked with 401).",
  "health.cause.connector": "No valid OAuth grant on this machine (or it expired).",
  "health.cause.conversation": "No real tool calls recently; normal when connected but never used.",
  "health.cause.generic": "This layer needs a human decision.",
  "health.act.restartService": "Restart local service",
  "health.act.restartTunnel": "Restart tunnel",
  "health.act.pair": "Generate pairing code",
  "health.toolsLine": "Tools: {enabled}/{total}",
  "health.toolsAll": "(all enabled)",
  "health.toolsSome": "({count} disabled)",
  "health.noProblems": "No failing layer; N/A means this check is not needed in the current setup.",
  "health.problemsTitle": "Problems found (cause + one-click action)",
  "health.controlPlaneDown": "Control plane unreachable (usually right after a restart):",
  "health.controlPlaneHint": "This is not a disabled-tools problem and you do not need to reconnect ChatGPT; the UI just lost its pipe to the Supervisor.",
  "health.refreshWindow": "Reload window",
  "health.fixRepoDir": "Repo folder (relative to workspace, empty = root)",
  "health.gitInit": "Init Git repository",
  "health.enableDevTools": "Enable dev tools (commands / jobs / commit)",
  "health.more": "More",

  "dash.title": "Overview",
  "dash.subtitle": "Look for anomalies first, then decide connect, authorize or troubleshoot.",
  "dash.refreshState": "Refresh",
  "dash.newService": "+ New MCP service",
  "dash.nextStep": "Next step",
  "dash.checkRecent": "Review recent development work",
  "dash.checkRecentDesc": "Open Development to see real Git, test and execution summaries.",
  "dash.openCollab": "Open Development",
  "dash.connectChatGpt": "Connect ChatGPT",
  "dash.quickTitle": "Common actions · start here",
  "dash.quickMcp": "Need to adjust MCP permissions or review local approvals?",
  "dash.quickMcpLink": "Open MCP control center",
  "dash.detailsTitle": "System detail · 6 layers (click to expand)",
  "dash.detailsHint": "Only verified observations count as passing; unknown is not normal.",
  "dash.currentWorkspace": "Current workspace",
  "dash.runtime": "Runtime",
  "dash.pending": "Pending approvals",
  "dash.recentJob": "Recent job",
  "dash.workspace": "Workspace",

  "settings.language": "Interface language",
  "settings.languageHint": "Applies immediately and is stored locally.",
  "settings.zh": "中文",
  "settings.en": "English",
};

const DICTS: Record<Lang, Dict> = { zh, en };
const STORAGE_KEY = "c2c.lang";

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (saved === "zh" || saved === "en") return saved;
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "zh";
  return nav.startsWith("zh") ? "zh" : "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang): void => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 隐私模式下忽略 */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const template = DICTS[lang][key] ?? DICTS.zh[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      );
    },
    [lang],
  );

  const value = useMemo<I18nValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** 组件在 Provider 之外渲染时回退到默认语言，避免测试/独立挂载直接崩。 */
const FALLBACK: I18nValue = {
  lang: "zh",
  setLang: () => undefined,
  t: (key: string, vars?: Record<string, string | number>): string => {
    const template = zh[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
    );
  },
};

export function useI18n(): I18nValue {
  return useContext(I18nContext) ?? FALLBACK;
}
