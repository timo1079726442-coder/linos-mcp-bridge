# 依赖审计与供应链清理（v0.1.1 门禁记录）

状态：`release/v0.1.1-hardening`，本地提交，未推送。
执行时间：2026-11-07。执行环境：Windows / Node 24.19（构建）、Electron 33.4.11（内嵌 Node 20.18.3，发行运行时）。

---

## 1. 结论摘要

| 范围 | 清理前 | 清理后 | 是否影响发行包 |
|---|---|---|---|
| `runtime/`（随包分发） | 8 项（3 high / 5 moderate） | **0 项** | 是——直接进入便携包 `runtime/node_modules` |
| 根工程（Electron 应用 + 构建工具） | 28 项（5 critical / 6 high / 17 moderate） | **21 项（3 critical / 3 high / 15 moderate），全部为 devDependencies** | 否——`electron-builder.yml` 的 `files` 不含 `node_modules`，发行包只有 `dist/**` 与 `runtime/**` |

**发行包里现在没有任何已知漏洞依赖。** 剩余问题全部落在"构建/测试工具链"和"Electron 运行时版本"两类，见 §4、§5。

---

## 2. runtime 清理（发行关键路径）

### 2.1 发现：两个声明但从未使用的依赖

`runtime/package.json` 声明了 `@modelcontextprotocol/sdk` 与 `zod`，但审计代码后确认：

- `runtime/src/**` 中 **0 处** import `@modelcontextprotocol/sdk`（本项目自行实现 MCP JSON-RPC 分发）；
- 全仓库（含测试、脚本）**0 处** import `zod`。

它们既没有提供能力，又带来了全部 high 级告警：

| 依赖 | 清理前告警 |
|---|---|
| `@modelcontextprotocol/sdk@1.30.1` | high：OAuth 凭据可能被发往服务器指定的授权端、实验性 tasks 未绑定会话、单请求可耗尽内存、bearer 接受他服务令牌、跨源重定向重发请求体 |
| `zod@3.25.76` | high：超大受限集合校验可耗尽内存 |
| 传递依赖 `hono`/`@hono/node-server`/`fast-uri`/`ip-address`/`qs`/`body-parser` | moderate~high |

### 2.2 处理

1. 先尝试把 SDK 升到最新 1.x（`1.32.2`）验证是否可解 → SDK 自身 high 消失，`zod` high 仍在；
2. 确认两者源码零引用后，**直接移除**这两个依赖；
3. `npm install` 后 `npm audit` → **0 vulnerabilities**；
4. `npm test`（runtime 全量）→ **154/154 通过**。

副作用（正向）：便携包 `runtime/node_modules` 体积明显下降（SDK 依赖树含 hono/ajv/jose/express5 等）。

遗留：`runtime/package.json` 的 `bin` 仍叫 `c2c-runtime-v2`，属刻意保留项，见 `docs/LEGACY_IDENTIFIER_POLICY.md`。

---

## 3. 根工程清理

### 3.1 移除未使用的生产依赖

| 依赖 | 结论 |
|---|---|
| `express` | 根 `src/` 零引用（唯一使用方是 `runtime/`，其自带依赖）→ 移除 |
| `commander` | 全仓库零引用 → 移除 |
| `zustand` | 全仓库零引用 → 移除 |
| `mysql2` | **保留**：`src/main/datasources/MysqlBridge.ts` 用 `await import("mysql2/promise")` 动态加载 |
| `react` / `react-dom` / `react-router-dom` | 保留 |

> 教训：静态 grep `from "mysql2"` 会漏掉动态 import。移除前必须同时搜索 `import(` 形式。

### 3.2 删除源码目录里的编译残留

`runtime/src/` 下曾被提交 5 个**编译产物**：`capability.js`、`main.js`、`secret.js`、`server.js`、`workspace.js`（其中 `server.js` 仅 9.9KB，而现行 `server.ts` 已 59.9KB，属早期版本残留）。

- 它们不会被编译（`tsconfig` 未开 `allowJs`），也不会被加载（运行时只读 `dist/`），但会误导安全评审与代码检索；
- 已删除，并在 `.gitignore` 增加 `runtime/src/**/*.js` 防止回归。

### 3.3 非破坏性升级

`npm audit fix`（未使用 `--force`）后：28 → 21 项，`body-parser`、`shell-quote`、`fast-uri`、`undici`、`source-map-js`、`minimatch` 等可修项已消除。

验证：root `npm test` → 76 文件 / **415 passed / 4 skipped**；`npm run typecheck`（main+preload+renderer）通过；`runtime` 全量 154/154 通过。

---

## 4. 剩余项：构建/测试工具链（不随包分发）

| 包 | 级别 | 说明 | 处理决定 |
|---|---|---|---|
| `vitest` + `tinypool` | critical | 测试运行器内部问题 | **v0.2 升级到 vitest 5**；v0.1.1 不升（会牵动全部测试与配置） |
| `happy-dom` | critical | 测试 DOM 实现 | 同上，随 vitest 一起升 |
| `vite` | high | 构建期；发行物是 `dist/**` 静态产物 | **v0.2 升级到 vite 8**（需同步 `@vitejs/plugin-react`） |
| `extract-zip`、`source-map-js`、`electron-builder` 系 | high/moderate | 打包工具链 | 随 `electron-builder` 大版本一起升 |
| `concurrently`、`eslint`/`typescript-eslint` 系 | critical/moderate | 本地开发脚本 | 升级到最新即可，无发行影响 |

这些不进发行包，**不构成 v0.1.1 的用户风险**，但作为工程债登记在案。

---

## 5. 需要单独决策的高风险项：Electron 33

`electron@33.4.11` 有 high 级告警，修复版本是 `electron@45.2.3`。这与其它 dev 依赖不同：**Electron 就是发行外壳**，其 Chromium/Node 版本直接决定用户侧攻击面。

现状与风险：

- 应用不加载远程页面（渲染层只有本地 `dist/renderer`），但仍解析本地文件与 IPC；
- Electron 33 → 45 是跨 12 个大版本，内嵌 Node 从 20.18 升到 22+，会同时影响：`worker_threads` 审计写入、`fsync` 行为、`spawn` 语义、`electron-builder` 目标、以及"无原生模块"的 ADR 前提；
- 因此**不能**在 v0.1.1 里顺手升。

建议（需你确认）：

1. v0.1.1 维持 Electron 33，并在 `SECURITY.md` 与 Release 说明中写明"外壳版本较旧，建议尽快跟进 v0.2"；
2. v0.2 把 Electron 升级作为**独立里程碑**，配套：升级后重跑 10 轮稳定性、干净 Windows 安装、审计持久性复测（Node 22+ 可能改变目录 `fsync` 行为，有机会消除 Windows 阻断项）。

---

## 6. 密钥扫描（Gitleaks）现状与替代方案

- 本机**未安装** `gitleaks` / `trufflehog` / `semgrep` / `osv-scanner`，无法直接跑官方规则集；
- v0.1.1 门禁要求：**全历史 + 全分支 + 全 tag 的密钥扫描**，这条**尚未完成**，不得宣称通过；
- 计划（按优先级）：
  1. 在 CI 中加 `gitleaks detect --log-opts="--all"`，并把 `gitleaks.toml` 纳入仓库；
  2. 本地先用等价正则扫描兜底：`AKIA[0-9A-Z]{16}`、`ghp_[A-Za-z0-9]{36}`、`sk-[A-Za-z0-9]{20,}`、`-----BEGIN [A-Z ]*PRIVATE KEY-----`、`c2c_api_[A-Za-z0-9]{20,}`、`password\s*[:=]\s*["'][^"']{6,}`；
  3. 任何命中先判定"测试夹具 / 示例 / 真实凭据"，真实凭据必须轮换并从历史清除（`git filter-repo`），且因为本分支从未推送，清除成本可控。

---

## 7. 复现命令

```powershell
# runtime（发行关键路径）
npm --prefix runtime audit
npm --prefix runtime test

# 根工程
npm audit
npm test
npm run typecheck

# 发行包内容核对（确认不含 node_modules）
Select-String -Path electron-builder.yml -Pattern 'files:' -Context 0,12
```

---

## 8. 门禁状态

| 项 | 状态 |
|---|---|
| runtime 依赖漏洞 | ✅ 0 |
| 根工程生产依赖漏洞 | ✅ 0（未使用依赖已移除） |
| 根工程 dev 依赖漏洞 | ⚠️ 21 项，登记为 v0.2 工程债 |
| Electron 外壳版本 | ⚠️ 待决策（v0.1.1 维持 33 / v0.2 升级） |
| 全历史密钥扫描 | ❌ 未完成（工具未安装，需 CI 或本地等价扫描） |
| 打包内容最小化 | ✅ `files` 不含 `node_modules`，`runtime/node_modules` 已显著缩小 |
