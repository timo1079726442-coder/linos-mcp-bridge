# 第三方依赖与许可

本项目依赖以下主要第三方组件，各自遵循其原始许可：

| 组件 | 用途 | 许可 |
|---|---|---|
| Electron | 桌面运行时 | MIT |
| React / React DOM | 界面 | MIT |
| react-router-dom | 路由 | MIT |
| Vite | 前端构建 | MIT |
| TypeScript | 语言与编译 | Apache-2.0 |
| Vitest | 测试框架 | MIT |
| electron-builder | 打包 | MIT |
| Express | HTTP 服务（runtime） | MIT |
| Cloudflare cloudflared | 公网隧道（可选，外部二进制） | Apache-2.0 |

完整依赖树与版本见 `package.json` / `package-lock.json` 与 `runtime/package.json`。

> 若你分发二进制包，请一并附上本文件与各组件许可原文。
