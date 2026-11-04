import React from "react";
import { Link } from "react-router-dom";
import { McpServerWizard } from "../components/McpServerWizard.tsx";

export function NewServicePage(): JSX.Element {
  return (
    <div className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">新建 MCP 服务</div>
          <p className="muted v2-subtitle">目录、端口、公网方式一次配好；完成后直接给出 URL 和配对码。</p>
        </div>
        <Link className="btn secondary" to="/services">← 返回服务列表</Link>
      </div>
      <McpServerWizard />
    </div>
  );
}
