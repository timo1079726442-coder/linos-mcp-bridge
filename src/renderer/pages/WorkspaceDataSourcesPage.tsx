import React from "react";
import { Link } from "react-router-dom";
import { DataSourcesPanel } from "../components/DataSourcesPanel.tsx";

export function WorkspaceDataSourcesPage(): JSX.Element {
  return (
    <div className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">MySQL 只读数据源</div>
          <p className="muted v2-subtitle">只读账号、Schema 与查询；密码只保存在主进程。</p>
        </div>
        <Link className="btn secondary" to="/workspace">← 返回工作区</Link>
      </div>
      <DataSourcesPanel />
    </div>
  );
}
