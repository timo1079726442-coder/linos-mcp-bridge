import React from "react";
import { Link } from "react-router-dom";
import { FolderPermissionsRoute } from "./security/SecurityRoutes.tsx";

export function WorkspacePermissionsPage(): JSX.Element {
  return (
    <div className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">目录与权限</div>
          <p className="muted v2-subtitle">这是本机目录读写的唯一编辑入口；服务详情只显示摘要。</p>
        </div>
        <Link className="btn secondary" to="/workspace">← 返回工作区</Link>
      </div>
      <FolderPermissionsRoute />
    </div>
  );
}
