# 安装与使用说明（Windows）

本说明假设你把仓库放在 `C:\workspace\linos-mcp-bridge`（换成你的路径即可）。

---

## 0. 前置条件

| 需要 | 说明 |
|---|---|
| Windows 10 / 11 | 目前只支持 Windows |
| Node.js ≥ 20 | `node -v` 确认；建议 LTS |
| 可选：Cloudflare 账号 | 只有想让公网访问时才需要 |
| 可选：cloudflared | 隧道用；脚本会自动提示下载地址 |

---

## 1. 一键安装（推荐）

在仓库根目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

它会依次做：检查 Node 版本 → 安装主程序依赖 → 安装 runtime 依赖 → 构建 runtime → 构建界面 → 打印后续步骤。

跑完后启动：

```powershell
npm start
```

首次启动是「快速设置」：选工作区目录、端口（默认 48766）、生成配对码。

---

## 2. 手动安装（等价步骤）

```powershell
npm ci
npm run build:runtime
npm run build
npm start
```

只跑类型检查和测试：

```powershell
npm run typecheck
npm test
cd runtime; npm test
```

---

## 3. 三种接入方式，按需选一个

### A. 只在本机用（最安全）

- MCP URL：`http://127.0.0.1:48766/mcp`
- 适合 Cursor、Claude Desktop、自己写的脚本；ChatGPT 网页版**访问不到** 127.0.0.1。

### B. 临时隧道（当天试用，最快）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-quick.ps1
```

- 脚本会启动 `cloudflared tunnel --url http://127.0.0.1:48766`；
- 输出里找到 `https://<随机>.trycloudflare.com`，MCP URL 就是它 + `/mcp`；
- **缺点**：每次重启都换域名，ChatGPT 里的连接器要改 URL；仅适合当天验证。

### C. 自己的域名（长期使用，推荐）

前置：域名已托管在 Cloudflare。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-named.ps1 -Domain mcp.example.com
```

脚本会：

1. 检查 `cloudflared`；
2. 提示你执行一次 `cloudflared tunnel login`（浏览器授权）；
3. 创建命名隧道、写入 `%USERPROFILE%\.cloudflared\config.yml`；
4. 绑定 `mcp.example.com` 到 `http://127.0.0.1:48766`；
5. 启动隧道并验证公网 `/health`。

之后 MCP URL 固定为 `https://mcp.example.com/mcp`。

---

## 4. 接入 ChatGPT

1. 控制中心 → **连接授权** → 「生成配对码」，记下 8 位码（1 小时有效）；
2. ChatGPT → 设置 → 连接器 → 新建自定义连接器，URL 填 `https://<你的域名>/mcp`；
3. 弹出授权页 → 输入配对码 → 允许；
4. 回到控制中心 **总览**，看「ChatGPT 授权」「真实调用」两个灯变绿。

> 如果每次都提示 `connection_intent_required`：确认「已授权客户端重连免配对码」是否勾选（首次授权仍必须配对）。

---

## 5. 打开工具权限（按需）

默认只开只读。要用写文件、命令、Git 提交：

1. **权限与审批 → 危险权限**；
2. 勾选需要的工具（或点「开启开发工具」）；
3. 总览会显示 `工具：X/Y 已启用`。

建议顺序：读 → 写 → 命令 → PowerShell。**PowerShell 等于把整台机器交出去**，只在完全信任时开。

---

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 公网 503，本地 200 | 隧道在线但源站不对（旧进程 / 代理劫持 / 端口写错） | 控制中心「重启隧道」，核对 config.yml 的 local 端口 |
| 界面全灰、自检报 `ENOENT \\.\pipe\...` | 应用重启后旧窗口持有旧管道 | Ctrl+R 刷新窗口 |
| 工具报 `TOOL_DISABLED` | 该工具在当前工作区被关闭 | 权限页开启，或点「开启开发工具」 |
| 工具报 `PATH_OUTSIDE_WORKSPACE` | 目标路径在工作区外 | 换工作区，或把文件放进工作区 |
| ChatGPT 连上但工具为空 | 公网 `/mcp` 未通过 OAuth，或 URL 少了 `/mcp` | 检查 URL 与授权 |
| 临时隧道域名每次变 | trycloudflare 特性 | 改用命名隧道（方案 C） |
| 工具报 `FETCH_PORT_NOT_ALLOWED` | 目标是非默认端口，未授权 | 在白名单 `fetch-allowlist.json` 的 `allow_ports` 里显式加端口（默认 443/80 始终允许） |
| 工具报 `FETCH_SCHEME_DOWNGRADE` | 站点把 https 重定向到 http | 改用 https 地址；该降级被有意禁止 |
| 工具报 `FETCH_PEER_MISMATCH` | 实际连接的对端与校验通过的 IP 不一致 | 视作可疑：检查该域名解析是否被劫持/重绑定，不要放宽限制 |
| 工具报 `FETCH_CONTENT_ENCODING_REJECTED` | 站点返回了 gzip 等压缩响应 | 该工具只接受未压缩文本；改用提供原始内容的接口 |
| **公网 530 / error 1033**，点「重启隧道」无效 | cloudflared 连不上 Cloudflare 边缘（TCP/UDP 7844 被阻断，或本机 TUN/Clash 类代理劫持了 DNS，让 cloudflared 去拨 `198.18.x.x`） | 跑 `powershell -ExecutionPolicy Bypass -File scripts\diagnose-tunnel.ps1 -ProfileDir <profile目录> -PublicUrl https://<你的域名>`；按输出处理：给 `*.argotunnel.com` 加 fake-ip-filter / 直连规则，或放行 7844。**重启隧道只是重跑同一条被阻断的路径，不会自愈** |

---

## 6.1 审计日志能查到什么、持久性到什么程度

- 审计写入 `<profile>/audit/<workspaceId>.journal.jsonl`，逐条 `seq` + `length` + `crc32` + SHA-256 链；
- 校验入口：`GET /admin/tool-audit`（需 admin 令牌），返回 `ok` / `entries` / `pendingOperations` / `durability` / `platform`；
- **Windows 上的持久化等级是 `FILE_SYNC_ONLY`**：文件内容会 `fsync`，但目录项无法同步（Node 在 Windows 上对目录 `fsync` 返回 `EPERM`）。Linux/macOS 为 `FILE_AND_DIRECTORY_SYNC`；
- 这不影响"篡改可被发现"和"审计不可写时高风险操作拒绝执行"，但**不要**对外宣称 Windows 具备目录项级持久性。

---

## 7. 卸载

1. 控制中心 → 关闭隧道与服务；
2. 删除 `%LOCALAPPDATA%\linos-c2c-control-center`（运行时数据）；
3. 删除仓库目录；
4. 若有命名隧道：`cloudflared tunnel delete <name>`。
