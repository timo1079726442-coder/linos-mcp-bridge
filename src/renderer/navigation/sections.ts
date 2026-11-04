export interface PrimarySection {
  id: "overview" | "connect" | "services" | "jobs" | "collaboration" | "workspace" | "security" | "diagnostics" | "settings";
  label: string;
  path: string;
}

export const primarySections = [
  { id: "overview", label: "总览", path: "/" },
  { id: "connect", label: "连接授权", path: "/connect" },
  { id: "services", label: "MCP 服务", path: "/services" },
  { id: "jobs", label: "后台任务", path: "/jobs" },
  { id: "collaboration", label: "开发协作", path: "/collaboration" },
  { id: "workspace", label: "工作区", path: "/workspace" },
  { id: "security", label: "权限与审批", path: "/security" },
  { id: "diagnostics", label: "诊断与日志", path: "/diagnostics" },
  { id: "settings", label: "设置", path: "/settings" },
] as const satisfies readonly PrimarySection[];

export type PrimarySectionId = (typeof primarySections)[number]["id"];

export const legacyRouteRedirects = {
  "/dashboard": "/",
  "/advanced": "/settings/advanced",
  "/about": "/settings/about",
  "/logs": "/diagnostics",
  "/diagnostics/timeline": "/diagnostics/history",
  "/diagnostics/logs": "/diagnostics",
  "/diagnostics/audit": "/diagnostics/history",
  "/connections": "/connect",
  "/connections/clients": "/connect/clients",
  "/connections/mcp": "/services",
  "/connections/48765": "/services/48765",
  "/connections/tunnel": "/services",
  "/security/write": "/services/48765",
} as const;

export const connectionTabs = [
  { label: "ChatGPT 网页版", path: "/connect" },
  { label: "其他客户端", path: "/connect/clients" },
] as const;

export const collaborationTabs = [
  { label: "概览", path: "/collaboration" },
  { label: "Git 变更", path: "/collaboration/git" },
  { label: "测试与构建", path: "/collaboration/tests" },
  { label: "Harness 任务", path: "/collaboration/tasks" },
  { label: "输出与 Review", path: "/collaboration/review" },
] as const;

export const securityTabs = [
  { label: "写入审批", path: "/security/approvals" },
  { label: "屏幕访问", path: "/security/screen" },
  { label: "危险权限", path: "/security/dangerous" },
] as const;

export const diagnosticsTabs = [
  { label: "实时诊断", path: "/diagnostics" },
  { label: "故障知识库", path: "/diagnostics/knowledge" },
  { label: "快速修复", path: "/diagnostics/fixes" },
  { label: "修复历史", path: "/diagnostics/history" },
  { label: "项目看板", path: "/diagnostics/board" },
  { label: "AI 请求", path: "/diagnostics/requests" },
  { label: "MCP 进度", path: "/diagnostics/progress" },
  { label: "日志", path: "/diagnostics/logs" },
] as const;

export const settingsTabs = [
  { label: "基础设置", path: "/settings" },
  { label: "高级设置", path: "/settings/advanced" },
  { label: "其他 AI 接入", path: "/settings/clients" },
  { label: "备份与恢复", path: "/settings/backup" },
  { label: "关于", path: "/settings/about" },
] as const;

export function getLegacyRedirectTarget(pathname: string): string | undefined {
  const normalized = normalizePath(pathname);
  return legacyRouteRedirects[normalized as keyof typeof legacyRouteRedirects];
}

export function canonicalizePath(pathname: string): string {
  const normalized = normalizePath(pathname);
  return getLegacyRedirectTarget(normalized) ?? normalized;
}

export function getPrimarySectionForPath(pathname: string): (typeof primarySections)[number] {
  const path = canonicalizePath(pathname);
  if (path === "/") return primarySections[0];

  return primarySections.find((section) =>
    path === section.path || (section.path !== "/" && path.startsWith(section.path + "/")),
  ) ?? primarySections[0];
}

function normalizePath(pathname: string): string {
  const withoutTrailingSlash = pathname.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}
