# 发行工程记录（v0.1.1）

状态：`release/v0.1.1-hardening`，本地，未推送、未发布。

本文回答"这个包到底装了什么、怎么验证、签名和安装形态怎么定"这几个发行门禁问题。
原则：**只记录已实测的事实**；做不到的写"未完成"而不是"已完成"。

---

## 1. 稳定性验证：10 轮连续全量

| 项 | 结果 |
|---|---|
| 轮次 | 10 轮，串行，失败即停（无重试掩盖） |
| 每轮内容 | `npm --prefix runtime test`（先 `tsc` 构建，再跑全部 `node:test` 用例） |
| 每轮结果 | **154/154 通过**，10 轮全部 `exit=0` |
| 单轮耗时 | 21.1s – 28.7s |
| 日志目录 | `%TEMP%\v011-10round-20261107-130035\round-01..10.log` |

结论：当前提交（`5793703` 系列）满足"10 轮连续全绿"要求。这是**最后代码**的验证，修复过程中出现过的偶发问题（job 状态早于清理完成、heartbeat 回写覆盖、幂等键并发创建）均已修复并有专项用例覆盖。

---

## 2. SBOM 与许可证

工具：`scripts/generate-sbom.mjs`（纯 Node，无外部依赖，CI 可用 `--check` 只校验不写文件）。

| 项 | 结果 |
|---|---|
| 组件总数（含构建工具链） | 661 |
| **随包分发组件** | **68** |
| 许可证分布（随包） | MIT 65、ISC 2、BSD-3-Clause 1 |
| 未知许可证（随包） | **0** |
| 输出 | `dist-release/sbom.json`（CycloneDX 1.5）、`dist-release/sbom-summary.json` |
| 生成时 SBOM 摘要 | `sha256:43c7a71bc5a0e71d826e47cd9b07f4005aa799f0fcbfdaf9a7ec5e749f14edff` |

随包组件只有 68 个，原因是依赖清理后 `runtime/package.json` 仅剩 `express`，且 `electron-builder.yml` 的 `files` 不含 `node_modules`（只打 `dist/**` 与 `runtime/**`）。

许可证全文清单见仓库根 `THIRD_PARTY_NOTICES.md`；SBOM 生成时会计算其 SHA-256（`cca8216f…`）写入摘要，便于核对"清单与 SBOM 是否同一版本"。

---

## 3. 发行资产与校验和

| 资产 | 生成方式 | 校验 |
|---|---|---|
| `LinOS-MCP-Portable-0.1.1-x64.zip` | `npm run build:portable`（`electron-builder --win zip`） | 发布前生成 `SHA256SUMS.txt` |
| `sbom.json` | `node scripts/generate-sbom.mjs` | 摘要写入 `sbom-summary.json` |
| `THIRD_PARTY_NOTICES.md` | 手工维护 | 哈希写入 SBOM 摘要 |

校验和生成（发布时执行一次，产物不入库）：

```powershell
Get-FileHash .\release-portable\LinOS-MCP-Portable-0.1.1-x64.zip -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash.ToLower())  LinOS-MCP-Portable-0.1.1-x64.zip" } |
  Set-Content .\dist-release\SHA256SUMS.txt -Encoding ascii
```

---

## 4. 构建可追溯性（provenance）现状

| 项 | 状态 |
|---|---|
| 源码定位 | ✅ 记录 commit SHA + 分支（本次分支从未推送，发布需先推送并经评审） |
| 构建环境 | ✅ 记录 `node -v`（24.19.0）、`electron -v`（33.4.11）、`npm -v`、OS 版本 |
| 依赖锁定 | ✅ `package-lock.json` + `runtime/package-lock.json` 入库 |
| 构建命令 | ✅ 全部写在 README/INSTALL 与 `package.json` scripts 中，可复现 |
| 制品摘要 | ✅ `SHA256SUMS.txt` |
| 官方证明（sigstore / SLSA attestation） | ❌ **未做**——需要 CI 与 OIDC 身份，本机自签没有意义 |
| 代码签名 | ❌ **未做**，见 §5 |

诚实结论：当前只能提供"可复现 + 摘要 + 环境记录"，**不能**声称有可验证的构建来源证明。若公开发布需要，必须在 GitHub Actions 里用 `actions/attest-build-provenance` 重做一次构建。

---

## 5. Windows 签名与安装形态（评估结论）

### 5.1 安装形态：维持便携 ZIP，不做 NSIS/MSI

现状 `electron-builder.yml` 只产出 `zip`，`asar: false`（两个子进程必须是真实文件）。

| 方案 | 结论 |
|---|---|
| 便携 ZIP（当前） | ✅ 保持：无安装器、无注册表、无自动升级，符合"每台设备自行授权"的模型 |
| NSIS 安装器 | ❌ 不采用：会引入安装/卸载写注册表与 Program Files 权限问题，与"便携 + 最小足迹"冲突 |
| MSI | ❌ 同上 |

因此"评估 NSIS"这项的结论是**明确不采用**，不是待办。

### 5.2 代码签名：v0.1.1 不签名，但必须告知

| 项 | 事实 |
|---|---|
| 现状 | 无签名；用户首次运行会看到 SmartScreen"未知发布者"提示 |
| 代价 | OV/EV 代码签名证书按年计费，EV 还需硬件令牌或云 HSM；签名后每次发版都要走签名流程 |
| 不签名的风险 | 用户无法用系统机制验证"这个 zip 来自本项目"；只能靠 SHA256 与 GitHub Release 渠道 |
| 决定 | v0.1.1 **不签名**，在 README 与 Release 说明中明确写出该提示与校验方法；签名作为独立议题（涉及采购与密钥保管），不阻塞本次发布 |

---

## 6. 打包内容核对（已做，发现并修掉 3 个真实问题）

新增静态核对脚本：`scripts/verify-portable-assets.ps1`（纯 ASCII 输出，兼容 Windows PowerShell 5.1）。
它只做静态检查，不启动 GUI：算 SHA256 → 解压到空目录 → 校验必需文件 → 校验禁止项 → 打印体积。

首轮运行抓出三个**真实打包缺陷**：

| 问题 | 事实 | 处理 |
|---|---|---|
| 渲染层依赖被打进包 | `resources/app/node_modules` 里有 `react`/`react-dom`/`react-router-dom`/`scheduler`（约 9.6MB），但渲染层已由 Vite 打包，主进程不引用 React | 把三者移到 `devDependencies`，`dependencies` 只剩 `mysql2`（主进程动态 `import("mysql2/promise")`，必须随包） |
| 编译器被打进包 | `runtime/node_modules/typescript` 19MB 被 `runtime/node_modules/**/*` 整体打进去 | 在 `electron-builder.yml` 增加负极模式，排除 `typescript`、`@types`、`.bin`、tests/docs/examples、`*.d.ts`、`*.map`、`*.md` |
| LICENSE 被误删 | 我最初写的 `!**/node_modules/**/LICENSE*` 是"排除"语义，导致第三方许可证从包里消失 | 删除该行；复核包内保留 **65 个 LICENSE 文件** |

修正后的实测结果：

| 指标 | 修正前 | 修正后 |
|---|---|---|
| zip 体积 | 113.30 MB | **107.40 MB** |
| 包内文件数 | 966 | 715 |
| `runtime/node_modules` | 21.21 MB | **1.21 MB** |
| 包内第三方 LICENSE | 0（被误删） | **65** |
| 静态核对 | FAIL | **PASS** |

其他打包修正：

- 补上应用图标（`win.icon: assets/icon-256.png`）；打包日志不再出现 `default Electron icon is used`；
- exe 元数据：`ProductName=LinOS MCP`、`FileVersion=0.1.0`。

---

## 6.1 打包产物冒烟（已做）

用**打包后的 exe**（`ELECTRON_RUN_AS_NODE=1`）直接启动包内 runtime，验证"精简后的 node_modules 仍能跑"：

```
LinOS MCP.exe resources\app\runtime\dist\main.js \
  --workspace <temp> --device-id smoke-dev --profile-id smoke-prof \
  --runtime-id smoke-rt --runtime-instance-id smoke-inst-001 \
  --port 48899 --state-root <temp>
```

| 观察项 | 结果 |
|---|---|
| 进程启动 | 未退出，PID 正常 |
| 端口监听 | `127.0.0.1:48899 Listen` |
| `/health` | `200 {"service":"c2c-bridge","version":"2.0.0","status":"ok",...}` |
| 结束后端口释放 | 监听数 0 |

> `/health` 里的 `"service":"c2c-bridge"` 是**刻意保留**的服务识别字段（`ServiceDiscovery` 用它区分自身与旧桥），见 `docs/LEGACY_IDENTIFIER_POLICY.md` 类别 J。

**卸载/无残留核对（便携形态）**：

| 检查 | 结果 |
|---|---|
| `HKCU\Software\com.linos.mcp.portable` | 不存在 |
| `HKCU\Software\LinOS MCP` | 不存在 |
| 卸载列表中的本项目条目 | 无（同一机器上另有第三方 `LinOS Handoff Hub` 条目，与本项目无关） |
| 进程/端口残留 | 无 |
| 状态目录 | 只写调用方指定的 `--state-root`，不写用户目录 |

---

## 7. 干净 Windows 环境验证（未完成，发布阻断）

上面 §6/§6.1 已覆盖"包内容正确 + 包内 runtime 能启动 + 无系统残留"，但**仍不是干净机器验证**。发布前还需在无开发环境残留的机器/虚拟机上完成：

| 步骤 | 验收点 | 状态 |
|---|---|---|
| 下载 zip → 解压到新目录 | 不依赖 `node_modules`、不依赖已装 Node | ⏳ 待做（需干净机器） |
| 首次启动 GUI | 生成 Profile、选工作区、端口默认 48766、无残留旧配置 | ⏳ 待做 |
| 连接 MCP 客户端 | 至少两个不同客户端能连上并列出工具 | ⏳ 待做 |
| 只读工具可用 | `read_file` / `git_status` 正常 | ⏳ 待做 |
| 写入需确认 | 未开启写入时拒绝；开启后两阶段写入成功 | ⏳ 待做 |
| 审计可查 | `GET /admin/tool-audit` 返回 `ok=true` 且 `durability=FILE_SYNC_ONLY`（Windows） | ⏳ 待做 |
| 升级（覆盖解压） | 保留 Profile/工作区配置与审计链 | ⏳ 待做 |
| 卸载（删除目录） | 无注册表残留、无后台进程、无计划任务 | ✅ 便携形态已核对（§6.1），VM 复核待做 |

---

## 7. 门禁总表（截至本记录）

| 门禁 | 状态 |
|---|---|
| P0 后台任务恢复 | ✅ |
| P0 审计持久化 | ✅（Windows 持久性已如实标注 `FILE_SYNC_ONLY`） |
| P1 SSRF（DNS 绑定） | ✅ |
| 公开产品清理（可见面） | ✅ 可见面完成；`.c2c/`、`C2C_*` 迁移登记为待办 |
| runtime 依赖漏洞 | ✅ 0 |
| 全历史密钥扫描 | ✅ 本地等价扫描（官方 gitleaks 待接入 CI） |
| SBOM / 许可证 | ✅ |
| 10 轮稳定性 | ✅ |
| 构建来源证明 / 签名 | ❌ 未做（已评估并写明结论） |
| 干净 Windows 安装全流程 | ❌ **未完成**——发布前必须做 |

**在最后一行完成前，不发布 v0.1.1、不建 Release、不合并 main。**
