import React, { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AboutPage } from "./pages/About.tsx";
import { AdvancedPage } from "./pages/Advanced.tsx";
import { DashboardPage } from "./pages/Dashboard.tsx";
import { QuickSetupPage } from "./pages/QuickSetup.tsx";
import { DiagnosticsPage } from "./pages/Diagnostics.tsx";
import { BoardPage } from "./pages/BoardPage.tsx";
import { RequestsPage } from "./pages/RequestsPage.tsx";
import { ProgressPage } from "./pages/ProgressPage.tsx";
import { LogsPage } from "./pages/Logs.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SettingsClientsPage } from "./pages/SettingsClientsPage.tsx";
import { BackupPage } from "./pages/BackupPage.tsx";
import { ScreenAccessPage } from "./pages/ScreenAccess.tsx";
import { DangerousPermissionsPage } from "./pages/DangerousPermissions.tsx";
import { WriteApprovalsRoute } from "./pages/security/SecurityRoutes.tsx";
import { WorkspacePage } from "./pages/Workspace.tsx";
import { ServicesPage } from "./pages/ServicesPage.tsx";
import { NewServicePage } from "./pages/NewServicePage.tsx";
import { ServiceDetailPage } from "./pages/ServiceDetailPage.tsx";
import { WorkspacePermissionsPage } from "./pages/WorkspacePermissionsPage.tsx";
import { WorkspaceDataSourcesPage } from "./pages/WorkspaceDataSourcesPage.tsx";
import { JobConsolePage } from "./pages/JobConsolePage.tsx";
import { CollaborationPage } from "./pages/Collaboration.tsx";
import { ConnectPage } from "./pages/ConnectPage.tsx";
import { ConnectClientsPage } from "./pages/ConnectClientsPage.tsx";
import {
  FaultKnowledgeBaseView,
  QuickFixCenterView,
  RepairHistoryView,
} from "./domains/collaboration-diagnostics/ConnectedDiagnosticsViews.tsx";
import { ApplicationShell } from "./components/shell/ApplicationShell.tsx";
import { LegacyRouteRedirect } from "./components/shell/LegacyRouteRedirect.tsx";
import { SectionTabs } from "./components/shell/SectionTabs.tsx";
import {
  collaborationTabs,
  diagnosticsTabs,
  securityTabs,
  settingsTabs,
} from "./navigation/sections.ts";

function CollaborationSection({ view }: { view: "overview" | "git" | "tests" | "tasks" | "review" }): JSX.Element {
  return (
    <SectionTabs
      title="开发协作"
      description="汇总真实的代码变化、测试证据、Harness 任务输出和 Review 结果。"
      tabs={collaborationTabs}
    >
      <CollaborationPage view={view} />
    </SectionTabs>
  );
}

/**
 * 首次使用自动进入引导：本机还没有 Profile 时，打开应用直接落到 /setup。
 * 只判断一次，避免打断已在正常使用的用户。
 */
function FirstRunRedirect(): null {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    let mounted = true;
    window.c2c.profile
      .getActive()
      .then((p) => {
        if (!mounted) return;
        if (!p && location.pathname !== "/setup") navigate("/setup", { replace: true });
      })
      .catch(() => {
        /* 读不到就不跳，避免误把故障当首次使用 */
      });
    return () => {
      mounted = false;
    };
  }, [navigate, location.pathname]);
  return null;
}

export function App(): JSX.Element {
  // Use router state, not window.hash, to support Electron reloads and navigation.
  const currentRoute=useLocation();
  return (
    <ApplicationShell>
      <FirstRunRedirect />
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/setup" element={<QuickSetupPage />} />
        <Route path="/dashboard" element={<LegacyRouteRedirect />} />

        <Route path="/workspace" element={<WorkspacePage />} />
        <Route path="/workspace/permissions" element={<WorkspacePermissionsPage />} />
        <Route path="/workspace/datasources" element={<WorkspaceDataSourcesPage />} />

        <Route path="/connect" element={<ConnectPage />} />
        <Route path="/connect/clients" element={<ConnectClientsPage />} />

        <Route path="/services" element={<ServicesPage />} />
        <Route path="/services/new" element={<NewServicePage />} />
        <Route path="/services/:serviceId" element={<ServiceDetailPage />} />
        <Route path="/jobs" element={<JobConsolePage />} />

        <Route path="/connections" element={<Navigate to="/connect" replace />} />
        <Route path="/connections/clients" element={<Navigate to="/connect/clients" replace />} />
        <Route path="/connections/mcp" element={<Navigate to="/services" replace />} />
        <Route path="/connections/48765" element={<Navigate to="/services/48765" replace />} />
        <Route path="/connections/tunnel" element={<Navigate to="/services" replace />} />

        <Route
          path="/collaboration"
          element={<CollaborationSection view="overview" />}
        />
        <Route
          path="/collaboration/git"
          element={<CollaborationSection view="git" />}
        />
        <Route
          path="/collaboration/tests"
          element={<CollaborationSection view="tests" />}
        />
        <Route
          path="/collaboration/tasks"
          element={<CollaborationSection view="tasks" />}
        />
        <Route
          path="/collaboration/review"
          element={<CollaborationSection view="review" />}
        />

        <Route path="/security" element={<Navigate to="/security/approvals" replace />} />
        <Route path="/security/approvals" element={<SectionTabs title="权限与审批" description="审批决定与文件执行状态分开显示；当前未提供安全文件执行器。" tabs={securityTabs}><WriteApprovalsRoute /></SectionTabs>} />
        <Route path="/security/screen" element={<SectionTabs title="权限与审批" description="屏幕授权状态来自本机控制层；尚未接入的能力会明确显示未知。" tabs={securityTabs}><ScreenAccessPage /></SectionTabs>} />
        <Route path="/security/dangerous" element={<SectionTabs title="权限与审批" description="Shell 与其他高风险能力默认关闭；没有可信状态接口时显示未知。" tabs={securityTabs}><DangerousPermissionsPage /></SectionTabs>} />
        <Route path="/security/write" element={<Navigate to="/services/48765" replace />} />

        <Route
          path="/diagnostics"
          element={
            <SectionTabs
              title="诊断与日志"
              description="查看本机实时状态、故障知识、快速修复和修复历史。"
              tabs={diagnosticsTabs}
            >
              <DiagnosticsPage />
            </SectionTabs>
          }
        />
        <Route
          path="/diagnostics/knowledge"
          element={
            <SectionTabs title="诊断与日志" description="查看本机实时状态、故障知识、快速修复和修复历史。" tabs={diagnosticsTabs}>
              <FaultKnowledgeBaseView />
            </SectionTabs>
          }
        />
        <Route
          path="/diagnostics/fixes"
          element={
            <SectionTabs title="诊断与日志" description="查看本机实时状态、故障知识、快速修复和修复历史。" tabs={diagnosticsTabs}>
              <QuickFixCenterView />
            </SectionTabs>
          }
        />
        <Route
          path="/diagnostics/history"
          element={
            <SectionTabs title="诊断与日志" description="查看本机实时状态、故障知识、快速修复和修复历史。" tabs={diagnosticsTabs}>
              <RepairHistoryView />
            </SectionTabs>
          }
        />

        <Route
          path="/diagnostics/logs"
          element={
            <SectionTabs title="诊断与日志" description="查看本机实时状态、故障知识、快速修复、修复历史与日志。" tabs={diagnosticsTabs}>
              <LogsPage />
            </SectionTabs>
          }
        />

        <Route
          path="/diagnostics/board"
          element={
            <SectionTabs title="诊断与日志" description="项目的总目标、里程碑、支线与耗时。" tabs={diagnosticsTabs}>
              <BoardPage />
            </SectionTabs>
          }
        />

        <Route
          path="/diagnostics/requests"
          element={
            <SectionTabs title="诊断与日志" description="AI 通过写文件提交的能力请求，批准后执行低风险动作。" tabs={diagnosticsTabs}>
              <RequestsPage />
            </SectionTabs>
          }
        />
        <Route
          path="/diagnostics/progress"
          element={
            <SectionTabs title="诊断与日志" description="按时间聚合的 MCP 会话进度与交接卡。" tabs={diagnosticsTabs}>
              <ProgressPage />
            </SectionTabs>
          }
        />
        <Route path="/diagnostics/timeline" element={<LegacyRouteRedirect />} />
        <Route path="/diagnostics/audit" element={<LegacyRouteRedirect />} />

        <Route
          path="/settings"
          element={
            <SectionTabs title="设置" description="集中管理基础配置、高级选项、备份恢复和产品信息。" tabs={settingsTabs}>
              <SettingsPage />
            </SectionTabs>
          }
        />
        <Route
          path="/settings/advanced"
          element={
            <SectionTabs title="设置" description="集中管理基础配置、高级选项、备份恢复和产品信息。" tabs={settingsTabs}>
              <AdvancedPage />
            </SectionTabs>
          }
        />
        <Route
          path="/settings/clients"
          element={
            <SectionTabs title="设置" description="给 Cursor / Claude / Agent 等客户端接入本机 MCP。" tabs={settingsTabs}>
              <SettingsClientsPage />
            </SectionTabs>
          }
        />
        <Route
          path="/settings/backup"
          element={
            <SectionTabs title="设置" description="集中管理基础配置、高级选项、备份恢复和产品信息。" tabs={settingsTabs}>
              <BackupPage />
            </SectionTabs>
          }
        />
        <Route
          path="/settings/about"
          element={
            <SectionTabs title="设置" description="集中管理基础配置、高级选项、备份恢复和产品信息。" tabs={settingsTabs}>
              <AboutPage />
            </SectionTabs>
          }
        />

        <Route path="/advanced" element={<LegacyRouteRedirect />} />
        <Route path="/about" element={<LegacyRouteRedirect />} />
        <Route path="/logs" element={<LegacyRouteRedirect />} />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </ApplicationShell>
  );
}
