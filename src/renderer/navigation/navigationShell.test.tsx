import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { LegacyRouteRedirect } from "../components/shell/LegacyRouteRedirect.tsx";
import { PrimaryNavigation } from "../components/shell/PrimaryNavigation.tsx";
import {
  diagnosticsTabs,
  getLegacyRedirectTarget,
  getPrimarySectionForPath,
  legacyRouteRedirects,
  primarySections,
} from "./sections.ts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("v2 service-hub navigation contract", () => {
  it("renders the nine canonical primary destinations once", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <PrimaryNavigation />
        </MemoryRouter>,
      );
    });

    expect(primarySections.map((section) => section.label)).toEqual([
      "总览",
      "连接授权",
      "MCP 服务",
      "后台任务",
      "开发协作",
      "工作区",
      "权限与审批",
      "诊断与日志",
      "设置",
    ]);
    expect(new Set(primarySections.map((section) => section.id)).size).toBe(9);
    expect(new Set(primarySections.map((section) => section.path)).size).toBe(9);
    expect(diagnosticsTabs.map((tab) => tab.label)).toEqual(["实时诊断", "故障知识库", "快速修复", "修复历史", "项目看板", "AI 请求", "MCP 进度", "日志"]);
    expect(container.querySelectorAll("a.nav-item")).toHaveLength(9);
    expect([...container.querySelectorAll(".nav-index")].map((item) => item.textContent)).toEqual([
      "01", "02", "03", "04", "05", "06", "07", "08", "09",
    ]);
    expect([...container.querySelectorAll(".nav-group-title")].map((item) => item.textContent)).toEqual(["工作", "资源", "系统"]);
    const navigationTargets = [...container.querySelectorAll<HTMLAnchorElement>("a.nav-item")].map((item) => item.getAttribute("href"));
    expect(new Set(navigationTargets).size).toBe(9);
    expect(navigationTargets).toContain("/connect");
    expect(navigationTargets).toContain("/services");
    expect(navigationTargets).toContain("/jobs");
    expect(navigationTargets).toContain("/security");
    expect(container.textContent).toContain("连接授权");
    expect(container.textContent).not.toContain("高级设置");
    expect(container.textContent).not.toContain("关于");

    await act(async () => root.unmount());
  });

  it("redirects each legacy route to its owning page", async () => {
    expect(legacyRouteRedirects).toEqual({
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
    });

    for (const [oldPath, target] of Object.entries(legacyRouteRedirects)) {
      expect(getLegacyRedirectTarget(oldPath)).toBe(target);
      const router = createMemoryRouter([
        { path: oldPath, element: <LegacyRouteRedirect /> },
        { path: target, element: <div data-testid="route-target">{target}</div> },
      ], { initialEntries: [oldPath] });
      const container = document.createElement("div");
      const root = createRoot(container);

      await act(async () => {
        root.render(<RouterProvider router={router} />);
      });

      expect(router.state.location.pathname).toBe(target);
      expect(container.querySelector("[data-testid='route-target']")?.textContent).toBe(target);

      await act(async () => root.unmount());
      router.dispose();
    }
  });

  it("keeps nested tabs under the right primary destination", () => {
    expect(getPrimarySectionForPath("/settings/advanced").id).toBe("settings");
    expect(getPrimarySectionForPath("/diagnostics/logs").id).toBe("diagnostics");
    expect(getPrimarySectionForPath("/connect/clients").id).toBe("connect");
    expect(getPrimarySectionForPath("/services/current").id).toBe("services");
    expect(getPrimarySectionForPath("/workspace/permissions").id).toBe("workspace");
    expect(getPrimarySectionForPath("/connections/tunnel").id).toBe("services");
  });
});

describe("shell layout contract", () => {
  it("provides responsive navigation and visible keyboard focus at desktop and compact widths", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const css = await readFile(resolve(process.cwd(), "src/renderer/styles/global.css"), "utf8");

    expect(css).toMatch(/@media\s*\(max-width:\s*800px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*620px\)/);
    expect(css).toMatch(/@media\s*\(max-height:\s*700px\)/);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("--status-unknown");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain(".quick-action-grid");
    expect(css).toContain(".status-details");
    expect(css).toContain(".nav-group-title");
  });
});
