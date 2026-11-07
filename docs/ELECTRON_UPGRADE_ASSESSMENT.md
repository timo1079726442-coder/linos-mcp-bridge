# Electron 33 → 45 升级可行性评估（实测）

状态：结论已得出；实验分支 `exp/electron-45`（本地，未推送、未合并到 release 分支）。
评估时间：2026-11-07。目的：一次解决两个门禁问题——Electron 的 high 级告警，以及 Windows 目录 `fsync` 可用性。

---

## 1. 结论（先说结果）

| 问题 | 结论 |
|---|---|
| 升级到 Electron 45 能否**修复 Windows 目录 fsync（`FILE_SYNC_ONLY`）**？ | ❌ **不能**。Electron 45.2.3 内嵌 Node **24.22.2**，Windows 上目录 `fsync` 仍返回 **`EPERM`** |
| 升级是否需要改业务代码？ | 只需 **1 行**：`app.setLoginItemSettings` 的 `openAsHidden` 字段已被移除 |
| 升级后类型检查 / 测试 / 打包 / 运行是否通过？ | ✅ 全部通过（见 §4） |
| 升级的代价 | 包体积 **+40MB**（zip 107.40MB → 147.33MB）；内嵌 Node 20.18 → 24.22，需重跑完整验收 |
| 建议 | **v0.2 里程碑**执行升级（安全收益真实），但**不能**用它宣称解决了 Windows 持久性 |

因此：**Windows 审计持久性维持 B 方案**（如实标注 `FILE_SYNC_ONLY`，不引入原生模块）；Electron 升级按独立里程碑推进。

---

## 2. 关键实测：Windows 目录 fsync 仍然不可用

一次性探针（临时目录，未入库）在 Windows 上运行 Electron 45.2.3：

```json
{
  "node": "24.22.2",
  "electron": "45.2.3",
  "platform": "win32",
  "fileSync": "OK",
  "directorySync": "EPERM",
  "directorySyncNote": "EPERM: operation not permitted, fsync",
  "worker": "OK:24.22.2",
  "spawn": "exit=7",
  "apis": { "nodeTestRunner": "function", "fsutimes": "function", "structuredClone": "function" }
}
```

与 Electron 33（Node 20.18.3）对照：

| 运行时 | Node | 文件 fsync | 目录 fsync |
|---|---|---|---|
| Electron 33.4.11 | 20.18.3 | OK | **EPERM** |
| Node 24.19（裸） | 24.19.0 | OK | **EPERM** |
| Electron 45.2.3 | 24.22.2 | OK | **EPERM** |

**结论**：这是 Windows + Node 的平台限制（Windows 上无法以句柄方式打开目录并 flush 目录项），不是 Electron 版本问题。**靠升级 Electron 无法消除该阻断项**；唯一路径仍是引入最小 Win32 辅助（`FlushFileBuffers` 目录项），代价是原生模块 + 构建 + 签名 + 免安装形态重验。

---

## 3. 升级改动面（实际只有 1 行）

在 `exp/electron-45` 分支上执行 `npm install electron@45.2.3 -D` 后：

```
src/main/ipc/handlers.ts: error TS2353: 'openAsHidden' does not exist in type 'Settings'
```

其余 main / preload / renderer 全部零报错。

修复（等价语义，Windows 上本来也只靠 `--hidden` 参数生效）：

```diff
  app.setLoginItemSettings({
    openAtLogin: values.atLogin === true,
-   openAsHidden: values.minimized === true,
    path: process.execPath,
    args: values.minimized === true ? ["--hidden"] : [],
  });
```

说明：`openAsHidden` 是 macOS 专用且已被 Electron 移除；本项目目标平台仅 Windows，删除不改变行为。

---

## 4. 升级验证结果（全部实测）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 类型检查（main/preload/renderer） | `npm run typecheck` | ✅ 通过（改 1 行后） |
| 单元/集成测试 | `npm test` | ✅ 76 文件 / **415 passed / 4 skipped** |
| 便携包构建 | `npm run build:portable` | ✅ 成功 |
| 打包内容静态门禁 | `verify-portable-assets.ps1` | ✅ `STATIC-CHECK=PASS`（715 文件、无禁止项、license 保留） |
| 包内 runtime 冒烟 | `ELECTRON_RUN_AS_NODE` 启动 + `/health` | ✅ `200 {"service":"c2c-bridge","version":"2.0.0","status":"ok"}` |
| 端口释放 | 杀进程后检查 | ✅ 0 监听 |

体积对照：

| 指标 | Electron 33 | Electron 45 |
|---|---|---|
| 解压后总大小 | 272.49 MB | 361.24 MB |
| zip 大小 | 107.40 MB | **147.33 MB** |
| `runtime/node_modules` | 1.21 MB | 1.21 MB（不受影响） |

体积增长全部来自 Electron 本体（Chromium 版本跨度大）。

---

## 5. 升级的真实收益与代价

**收益**

1. 消除 Electron 33 的 high 级告警（Chromium/Node 累积 CVE）；
2. 内嵌 Node 20.18 → 24.22，与本地开发/CI 运行时一致，减少"开发能跑、发行版不能跑"的差异；
3. `worker_threads`、`child_process.spawn`、`node:test`、`fs.utimes` 等本项目依赖的能力在 45 上均正常（已探针验证），审计与后台任务机制不受影响。

**代价 / 风险**

1. zip 增大 ~40MB（对便携分发是可感知的成本）；
2. Node 20 → 24 跨越 4 个大版本，需重跑：10 轮稳定性、Windows 干净环境安装、审计持久性复测、后台任务崩溃恢复演练；
3. Chromium 版本跨度大，渲染层需要人工过一遍界面（IPC/权限/审批页）；
4. `electron-builder` 需同步验证（本次 26.18.1 打包成功，未出现兼容错误）；
5. 与 ADR-0001"不引入原生模块"的前提无关，但会改变 Node 的 `fs`/`spawn` 细节，必须复测。

---

## 6. 建议的推进方式（v0.2）

| 阶段 | 内容 | 门槛 |
|---|---|---|
| E1 | 在独立分支合入 Electron 45 + `openAsHidden` 修正 | `typecheck` + `npm test` 绿 |
| E2 | 重跑 10 轮 runtime 稳定性 + 后台任务崩溃/取消/恢复演练 | 10 轮全绿，无重试 |
| E3 | 重跑打包静态门禁 + 包内 runtime 冒烟 | `STATIC-CHECK=PASS` |
| E4 | 干净 Windows 环境安装/使用/升级/卸载 | 8 项验收全绿 |
| E5 | 渲染层人工回归（IPC/权限/审批/诊断页） | 无功能回退 |
| E6 | 体积决策：接受 +40MB 或评估裁剪（如移除未用语言包） | 明确记录 |

**在 E1–E6 完成前，v0.1.1 维持 Electron 33**，并在 SECURITY.md / Release 说明中写明"外壳版本较旧、建议跟进 v0.2"。

---

## 7. 复现方式

```powershell
# 探针（临时目录，不污染仓库）
mkdir $env:TEMP\electron45-probe; cd $env:TEMP\electron45-probe
npm init -y; npm i electron@45 --no-audit --no-fund
node node_modules/electron/install.js    # 若 postinstall 被跳过
$env:ELECTRON_RUN_AS_NODE=1
.\node_modules\electron\dist\electron.exe probe.mjs

# 完整升级验证
git worktree add D:\CODE\worktrees\linos-electron45 -b exp/electron-45 <commit>
cd D:\CODE\worktrees\linos-electron45
npm install; npm --prefix runtime install
npm i -D electron@45.2.3; node node_modules/electron/install.js
npm run typecheck; npm test; npm run build:portable
powershell -ExecutionPolicy Bypass -File scripts\verify-portable-assets.ps1 -ZipPath <zip> -DestDir <dir>
```

实验分支：`exp/electron-45`（提交 `fbde573`），仅本地。

---

## 9. 实施记录：E1–E3（分支 `release/v0.2-electron45`）

执行时间：2026-11-07。分支从 `release/v0.1.1-hardening` 的 `bf25fab` 切出，未合并、未推送。

### E1 升级与代码修正（提交 `920e18e`）

```diff
- "electron": "^33.0.0"
+ "electron": "45.2.3"

  app.setLoginItemSettings({
    openAtLogin: values.atLogin === true,
-   openAsHidden: values.minimized === true,
    path: process.execPath,
    args: values.minimized === true ? ["--hidden"] : [],
  });
```

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 error |
| `npm run lint` | ✅ 0 error / 277 warning（较基线 +2 警告，无新增错误） |
| `npm test` | ✅ 76 文件 / 415 passed / 4 skipped |
| 内嵌运行时 | Electron 45.2.3 / Node **24.22.2** |

### E2 稳定性：10 轮（Node 运行）

| 项 | 结果 |
|---|---|
| 轮次 | 10 轮串行、失败即停 |
| 每轮 | **154/154 通过**，`exit=0` |
| 耗时 | 31.0s – 64.1s / 轮 |
| 日志 | `%TEMP%\e45-node10-20261107-150900\round-01..10.log` |

**环境限制（已实测，非产品缺陷）**：无法用开发目录里的 `electron.exe` 跑测试套件。`ELECTRON_RUN_AS_NODE=1` 下该进程访问 `%TEMP%` 时全部返回 `EPERM`：

```json
{ "mkdtemp": "EPERM", "mkdir": "EPERM", "writeFile": "EPERM" }
```

导致 114 个用例因 `mkdtemp` 失败。因此"在目标 Electron 内嵌 Node 上跑全量单测"这条路在本机不可行；Electron 侧的真实性由 E3（打包后运行）覆盖。

### E3 打包与冒烟

| 项 | 结果 |
|---|---|
| `npm run build:portable` | ✅ |
| 静态门禁 | ✅ `STATIC-CHECK=PASS`（715 文件、11 项必需文件、无禁止项） |
| zip | 147.33 MB，`sha256=4de3e1f8…7f500c` |
| 包内 runtime 冒烟 | ✅ `/health` 200；state 目录写出 `exec_runtime_ready.json`；`node=24.22.2` |
| 进程结束 | ✅ 端口 48903 释放为 0 |

### 结论与剩余（E4–E6）

E1–E3 全部通过：升级改动面小、行为可验证。剩余：

| 阶段 | 内容 | 状态 |
|---|---|---|
| E4 | 干净 Windows 安装/使用/升级/卸载（按 `docs/CLEAN_WINDOWS_ACCEPTANCE.md` 15 项） | ⏳ 需干净机器 |
| E5 | 渲染层人工回归（IPC/权限/审批/诊断页） | ⏳ 需人工过界面 |
| E6 | 体积决策：接受 zip 107.40 → 147.33 MB，或评估裁剪语言包/资源 | ⏳ 待决策 |

在 E4–E6 完成前，`release/v0.2-electron45` 不合并到 `main`、不发布；v0.1.1 仍基于 Electron 33。


| 门禁 | 变化 |
|---|---|
| Windows 审计持久性 | **无变化**：仍是阻断项，B 方案继续有效；升级 Electron 不能解锁 |
| Electron 安全告警 | 从"待决策"变为"已评估，v0.2 执行" |
| 干净 Windows 安装验收 | 若先升 Electron，则该验收必须针对新外壳重做一次——**这也是不把升级塞进 v0.1.1 的原因** |
