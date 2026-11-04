import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { FolderPermissionsPage } from "./FolderPermissionsPage.js";
import type { FolderAccessSnapshot } from "../../domain/workspaceSecurity.js";

const base: FolderAccessSnapshot = {
  profileId: "home", profileName: "Home", profileType: "home",
  workspaceId: "ws-a", observedAt: new Date().toISOString(), staleAfterMs: 60_000,
  revision: 0, entries: [], mutationAvailability: "AVAILABLE", mutationBlockReason: null,
};
const actions = {
  add: async () => { throw new Error("no mutation in UI render test"); },
  remove: async () => ({removed:false,revision:0}),
  check: async () => {throw new Error("not executed");},
};
describe("Existing FolderPermissionsPage reuse, file type preset UI", () => {
  it("shows the new quick choices inside the existing ACL editor", () => {
    const html = renderToStaticMarkup(<FolderPermissionsPage snapshot={base} actions={actions} />);
    expect(html).toContain("文件类型快捷选择");
    expect(html).toContain("切换文件类型 .har");
    expect(html).toContain("切换文件类型 .md");
    expect(html).toContain("切换文件类型 .py");
    expect(html).toContain("切换文件类型 .xlsx");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("选择类型不会直接打开 MCP 权限");
  });
  it("stays disabled when existing Legacy profile protects ACL mutations", () => {
    const html = renderToStaticMarkup(<FolderPermissionsPage snapshot={{
      ...base, profileType:"company", mutationAvailability:"PROFILE_PROTECTED",
      mutationBlockReason:"COMPANY_PROFILE_PROTECTED",
    }} actions={actions} />);
    expect(html).toContain("Legacy Profile 已保护");
    expect(html).toContain("文件类型快捷选择");
    expect(html).toContain('disabled=""');
  });
});
