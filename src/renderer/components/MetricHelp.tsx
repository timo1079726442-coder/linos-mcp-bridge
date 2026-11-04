import React from "react";

const METRIC_HELP: Record<string, string> = {
  "Profile": "配置档案。用于隔离一套 Runtime、Workspace、Transport、OAuth 与权限配置；不同 Profile 之间不得自动复用授权。",
  "Runtime": "C2C 本地运行时服务。负责提供 MCP HTTP 接口、工具注册与工作区只读/受控写入能力。",
  "Runtime Health": "Runtime 健康检查结果。通过只代表本地服务可响应，不等于 OAuth、Tunnel 或真实 MCP 工具调用已成功。",
  "Runtime PID": "Runtime 进程的 Windows 进程 ID，用于确认端口监听者是否属于预期进程。",
  "Supervisor": "C2C 本机控制进程。负责启动 Runtime、权限校验、审批、诊断、恢复和敏感操作隔离。",
  "Supervisor PID": "Supervisor 进程的 Windows 进程 ID。",
  "Watchdog": "看门狗进程。用于检测核心进程异常退出并提供受控恢复依据，不代表一定会自动重启。",
  "Workspace": "当前授权给 C2C 的工作区根目录。MCP 文件工具只能在该边界内访问。",
  "Transport": "连接传输方式。LOCAL_ONLY 表示仅本机；CLOUDFLARE_NAMED 表示通过命名 Cloudflare Tunnel 暴露公网 MCP。",
  "Transport 类型": "当前 Profile 选择的传输方式，例如 LOCAL_ONLY 或 CLOUDFLARE_NAMED。",
  "Tunnel": "把本地 MCP 服务连接到公网的安全隧道。Tunnel 正常不等于 OAuth 或 MCP 工具调用成功。",
  "Tunnel / Transport": "连接传输层。用于判断当前是仅本机模式还是公网隧道模式，以及传输链路是否可用。",
  "Tunnel Provider": "提供隧道能力的实现，例如 Cloudflare Named Tunnel。",
  "Tunnel Edge": "Cloudflare 边缘连接状态。表示 cloudflared 是否与 Cloudflare Edge 建立连接。",
  "Cloudflare Edge": "Cloudflare 的公网边缘节点。Edge 已连接只代表隧道链路建立，不代表 MCP 鉴权或工具调用成功。",
  "OAuth": "开放授权协议。C2C 用它确认客户端身份和授权范围，不应与真实 MCP 调用成功混为一谈。",
  "OAuth Discovery": "OAuth 元数据发现探测。用于确认公网端点是否能正确暴露授权相关元数据；不代表用户已完成授权。",
  "OAuth / 客户端层": "客户端注册与 OAuth 授权层状态。成功只说明客户端身份/授权链成立，不代表 MCP 工具已经被真实调用。",
  "Connector": "客户端连接层。表示 ChatGPT 或其他 AI 客户端与 C2C 的连接/授权状态。",
  "Conversation": "真实对话工具调用层。只有捕获到实际 MCP 调用证据时才应显示通过。",
  "Repository": "Git 仓库层。用于判断当前 Workspace 是否为 Git 仓库及其状态。",
  "MCP": "Model Context Protocol（模型上下文协议）。让 ChatGPT 等 AI 客户端以结构化工具方式调用本地能力。",
  "实际工具调用": "是否存在真实 MCP 工具调用证据。Runtime 可达、OAuth 成功或客户端注册都不能替代这一项。",
  "真实 MCP 调用": "是否存在真实 MCP 工具调用证据。只有实际工具调用成功才应显示已验证。",
  "HTTP": "网页/接口传输协议。这里通常表示公网健康检查返回的 HTTP 状态。",
  "公网 HTTP": "从公网访问当前服务健康端点得到的 HTTP 状态；与本地 Runtime 健康状态分开判断。",
  "公网 Health": "公网健康检查结果。失败只说明公网链路异常，不能直接推断本地 Runtime 已故障。",
  "Host / Port": "服务监听地址与端口。Host 表示主机地址，Port 表示端口号。",
  "本地 Host / Port": "当前 Profile 的本机监听地址和端口。V2 测试环境固定使用 127.0.0.1:48766。",
  "Port": "端口号。用于区分本机不同网络服务；端口有人监听不代表对应业务服务一定健康。",
  "PID": "Process ID（进程 ID）。Windows 用它标识一个具体运行进程。",
  "Diagnostics": "诊断数据。由 Supervisor 汇总 Runtime、Tunnel、OAuth、Workspace 等真实观测后生成。",
  "Diagnostics 探测时间": "本次诊断数据的生成时间。时间过旧时不能继续当作当前状态。",
  "Profile Transport 选择": "当前 Profile 配置的传输模式。它只是配置值，不代表 Tunnel 已启动或公网已可用。",
  "Profile 配置 URL": "当前 Profile 记录的公网 MCP 地址。未配置时通常说明仍处于 LOCAL_ONLY。",
  "未授权 MCP 探测": "匿名访问 MCP 端点的探测。预期通常返回拒绝状态，用于确认鉴权门是否工作。",
  "Transport 模式": "当前连接模式：LOCAL_ONLY 仅本机；CLOUDFLARE_NAMED 通过 Cloudflare 命名隧道对外提供服务。",
  "ChatGPT 启动地址": "用于打开 ChatGPT 的入口地址，本身不是 MCP 服务地址，也不代表连接已建立。",
  "Tunnel 名称": "Cloudflare 中该命名隧道的可读名称，用于区分不同环境和用途。",
  "cloudflared": "Cloudflare Tunnel 客户端程序。负责从本机建立到 Cloudflare Edge 的出站连接。",
  "Git 仓库": "当前 Workspace 是否为 Git 仓库。非 Git 工作区时提交、Diff 等仓库能力不适用。",
  "Readiness": "就绪度分层状态。按 Runtime、Transport、Connector、Conversation、Workspace、Repository 等层分别判断。",
  "LOCAL_ONLY": "仅本机模式。服务只监听本机地址，不通过公网 Tunnel 暴露。",
  "CLOUDFLARE_NAMED": "Cloudflare 命名隧道模式。通过固定 Tunnel 身份把本地 MCP 服务映射到指定公网域名。",
  "Hostname": "公网主机名，例如 c2c-v2-preview.example.com。不能填写受保护的生产域名。",
  "Tunnel ID": "Cloudflare Tunnel 的唯一身份 ID。",
  "Zone": "Cloudflare DNS Zone（域名区域）。通常对应某个根域名的 DNS 管理范围。",
  "Origin": "公网地址的协议 + 域名 + 端口部分，不包含路径、查询参数或敏感信息。",
  "公网 Origin": "当前公网服务的 Origin。界面只显示安全化后的协议与主机部分。",
  "shadcn": "React UI 组件体系。C2C 当前只安全读取本地 shadcn 配置与组件，不自动联网下载或执行 add/init。",
  "Git": "版本控制系统。C2C 将 Git 状态、Diff、提交能力与普通文件写入权限分开控制。",
  "SHA256": "文件内容哈希。用于确认修改前后内容身份以及避免覆盖他人并行改动。",
};

export function metricHelpText(term: string): string | undefined {
  return METRIC_HELP[term.trim()];
}

export function MetricHelp({
  term,
  children,
}: {
  term: string;
  children?: React.ReactNode;
}): JSX.Element {
  const help = metricHelpText(term);
  if (!help) return <>{children ?? term}</>;

  return (
    <span
      className="metric-help"
      title={help}
      tabIndex={0}
      aria-label={term + "：" + help}
    >
      <span>{children ?? term}</span>
      <span className="metric-help-icon" aria-hidden="true">?</span>
    </span>
  );
}
