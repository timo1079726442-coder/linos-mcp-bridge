# CI 门禁说明（v0.1.1）

目的：把已经手工验证过的门禁固化到 CI，避免后续改动悄悄回退。所有门禁都在本机跑过对应命令。

---

## 1. 工作流一览

| 文件 | 触发 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | push 到 `main`/`release/**`、所有 PR、手动 | 三阶段：`verify`（构建+类型+lint+测试）、`security`（密钥扫描+依赖审计+SBOM 校验）、`package`（打 tag 或手动时构建便携包并做静态门禁） |
| `.github/workflows/codeql.yml` | push、PR、每周一 03:23 | CodeQL `javascript-typescript` 语义分析，`build-mode: none` |

---

## 2. `verify` 阶段

| 步骤 | 命令 | 本机结果 |
|---|---|---|
| 安装 | `npm ci` + `npm --prefix runtime ci` | ✅ |
| 构建 | `npm run build:runtime` / `npm run build` | ✅ |
| 类型 | `npm run typecheck`（main+preload+renderer） | ✅ 0 error |
| Lint | `npm run lint` | ✅ **0 error / 284 warning**（基线） |
| 应用测试 | `npm test` | ✅ 76 文件 / 419 passed / 4 skipped |
| runtime 测试 | `npm --prefix runtime test` | ✅ 182/182；本地连续 10 轮全绿 |

**重要变更：删除了旧的"失败自动重跑一次"逻辑。**
旧 `ci.yml` 对 runtime 测试写了 `continue-on-error` + 重跑一次，这属于**用重试掩盖不稳定**。既已在本机证明连续 10 轮 154/154 全绿（`docs/RELEASE_ENGINEERING.md` §1），CI 必须一次通过；若出现偶发失败，应按缺陷修，不得恢复重试。

---

## 3. `security` 阶段

| 步骤 | 说明 |
|---|---|
| gitleaks（官方 CLI） | `fetch-depth: 0`，扫**全部历史**；配置 `.gitleaks.toml`（内置规则 + 仅对夹具做精确放行）。**不用 `gitleaks-action@v2`**：它内置的下载地址指向已迁移的旧仓库 `zricethezav/gitleaks`，安装步骤必然 404；现改为从 `gitleaks/gitleaks` release 取 `8.30.1` 并用官方 checksums 校验后执行 |
| 本地规则扫描 | `node scripts/secret-scan.mjs`，与官方规则集互补（含本项目 `c2c_api_` 令牌模式） |
| 依赖审计（runtime） | `npm --prefix runtime audit --omit=dev --audit-level=high` → 当前 **0 漏洞** |
| 依赖审计（app） | `npm audit --omit=dev --audit-level=high` → 当前 **0 漏洞**（dev 依赖问题登记在 `docs/DEPENDENCY_AUDIT.md`，不阻塞发布） |
| SBOM 校验 | `node scripts/generate-sbom.mjs --check`：随包组件 68 个、许可证未知 **0** |

注意：**只对 `--omit=dev` 拦截**。根工程的 devDependencies（vitest/vite/electron-builder 等）还有 21 项告警，那些不进发行包，作为 v0.2 工程债登记，不在 CI 里制造假红。

---

## 4. `package` 阶段（tag / 手动）

| 步骤 | 说明 |
|---|---|
| 构建 | `npm run build:portable` |
| 静态门禁 | `scripts/verify-portable-assets.ps1`：必需文件、禁止项（dev 依赖进包、sourcemap、测试产物、已移除依赖）、体积统计 |
| 产物 | `sbom.json`、`sbom-summary.json`、`SHA256SUMS.txt`、便携 zip 作为 artifact 上传（保留 14 天） |

发布时把 artifact 里的 zip + SHA256SUMS + sbom 一起挂到 Release，不要在本地另打一次包。

---

## 4.1 首次真实运行的结论与修复（2026-11-13）

此前 CI 一直是**红**的，但原因全在配置，不在代码：

| 现象 | 根因 | 处理 |
|---|---|---|
| `security` 在 "安装 gitleaks" 失败：`Unexpected HTTP response: 404` | `gitleaks-action@v2` 写死了已迁移的旧仓库下载地址 | 改为官方 CLI + checksums 校验（见 §3） |
| 手动触发返回 `422 Workflow does not have 'workflow_dispatch' trigger` | `package` 作业条件里写了 `workflow_dispatch`，但 `on:` 里从未声明 | 补上触发器，打包路径才可演练 |
| 动作告警 `Node.js 20 is deprecated` | `checkout/setup-node/upload-artifact` 仍为 v4 | 升到 v5 |

修完后 gitleaks 真正跑起来，报出 **2 处命中**：`src/main/redaction/Redactor.test.{ts,js}` 第 5-7 行的 `c2c_ri_secret_aGVsbG90aGVyZQabc123`。该串 base64 段解码为 `hellothere`，是脱敏测试自造的夹具（断言"脱敏后不再包含明文"），已在 `.gitleaks.toml` 里按**精确字面量**放行并注明证据位置——没有加宽泛通配。

**实测结果**：

| 运行 | 结论 |
|---|---|
| push `main`（`c3190c2`） | `verify` ✅ / `security` ✅ / `package` skipped（符合预期） |
| `workflow_dispatch`（`c018b02`） | `verify` ✅ / `security` ✅ / **`package` ✅**，产出 `portable-package` artifact（约 136 MB） |
| `codeql` | ✅ 每次 push 均通过 |

`package` 作业实测步骤：`npm ci` → `runtime ci` → `build:portable` → **静态门禁 PASS** → SBOM + 校验和 → artifact 上传。

---

## 5. 本地等价命令（提交前自检）

```powershell
npm ci; npm --prefix runtime ci
npm run build:runtime; npm run build; npm run typecheck; npm run lint; npm test
npm --prefix runtime test
node scripts/secret-scan.mjs
npm --prefix runtime audit --omit=dev --audit-level=high
npm audit --omit=dev --audit-level=high
node scripts/generate-sbom.mjs --check
```

---

## 6. 尚未接入 / 已知缺口

| 项 | 状态 |
|---|---|
| 构建来源证明（SLSA / sigstore attestation） | ❌ 未接入，需要 CI OIDC；接入后可在 `package` 阶段加 `actions/attest-build-provenance` |
| 干净 Windows 安装自动化 | ❌ 需要 VM/runner 镜像，当前为人工清单（`docs/CLEAN_WINDOWS_ACCEPTANCE.md`） |
| dev 依赖漏洞门禁 | ❌ 故意不拦（会长期红）；跟踪项见 `docs/DEPENDENCY_AUDIT.md` §4 |
| Electron 版本门禁 | ❌ 未设置；升级到 45 后应加"最低版本"检查，避免回退 |
