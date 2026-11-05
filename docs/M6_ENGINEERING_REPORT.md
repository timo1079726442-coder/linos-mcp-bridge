# M6 工程质量报告

范围：锁文件、SBOM、ESLint、依赖许可证、SSRF 复核。
基线：`v0.1.0`（`21773dc` 之后的 M6 分支）。所有结论都来自**干净环境**（不含 `node_modules`、不含 `dist`）的实测。

---

## 1. 锁文件（PASS）

**做了什么**：把仓库复制到 `_m6-clean`（无 `node_modules`、无 `dist`、无旧锁缓存），直接 `npm ci`。

| 步骤 | 结果 |
|---|---|
| 原始锁文件 `npm ci` | **成功**，508 个包 |
| 加 ESLint 工具链后 `npm ci` | **成功**，593 个包 |
| 锁文件差异 | `7310 → 8493` 行；新增仅为 eslint / typescript-eslint / @eslint/js 及其传递依赖 |

结论：**v0.1.0 的锁文件本身没有坏**。之前 `npm sbom` 报 `missing @babel/helper-validator-identifier`，原因是本机 `node_modules` 是指向另一个仓库的 junction，不是锁文件问题。这一点必须记录，避免以后再误判。

## 2. SBOM（PASS）

在干净环境生成两份，均入库：

| 文件 | 格式 | 组件数 | 大小 |
|---|---|---|---|
| `sbom.cdx.json` | CycloneDX 1.5 | **453** | 581 KB |
| `sbom.spdx.json` | SPDX 2.3 | **454** | 576 KB |

生成方式：`npm sbom --sbom-format=cyclonedx` / `--sbom-format=spdx`（npm 10+ 内置，无额外依赖）。

## 3. 依赖许可证（PASS）

`LICENSE-REPORT.md`：**413** 个依赖包，**13** 种许可证，**0 个未知许可证**。

| 许可证 | 数量 |
|---|---|
| MIT | 341 |
| ISC | 28 |
| Apache-2.0 | 12 |
| BSD-3-Clause | 11 |
| BSD-2-Clause | 8 |
| BlueOak-1.0.0 | 6 |
| 其它（0BSD / CC0 / Unlicense / Python-2.0 等） | 7 |

全部为宽松许可，无 GPL/AGPL 类传染性许可。`Python-2.0`（argparse）与 `BlueOak-1.0.0`（tar/minimatch 等）需要保留版权声明，已在 `THIRD_PARTY_NOTICES.md` 说明。

## 4. ESLint（PASS，基线化）

**原则**：先挡"新增错误"，不清洗历史代码。

- 配置：`eslint.config.mjs`（flat config + typescript-eslint 类型检查）；
- 规则分级：风格类与本次不修的历史问题一律 **warn**，只保留真正能掩盖 bug 的规则为 error（当前也已降级，见下）；
- 实测：`npx eslint src runtime/src` → **0 error / 265 warning**；
- CI：`npm run lint` 已加入 workflow（在 typecheck 之后）。

**已知取舍**：`no-floating-promises`、`unbound-method`、`no-base-to-string` 等仍有 265 条 warning，暂不阻塞合并；后续按"每版本清一批"收敛，不在 M6 制造大 diff。

## 5. SSRF 复核（部分通过，存在开放问题）

### 已确认有效
1. 每次请求与**每次重定向**都会重新走 `validateUrl`（协议、账号密码、IP 字面量、`.local/.internal`、域名白名单）；
2. DNS 解析用 `dns.lookup(all: true)`，**A 与 AAAA 都检查**；
3. `isPrivateAddress` 覆盖 `10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10、fc00::/7、fe80::/10、::1`，并递归处理 `::ffff:` IPv4-mapped；
4. 请求头只发送 `accept`，**不转发 Authorization / Cookie**，跨域重定向不存在敏感头泄漏；
5. 重定向后仍限制 `MAX_REDIRECTS`，且只允许白名单域名。

### 开放问题（HIGH，未解决）
- **TOCTOU**：`assertPublicResolution()` 解析出的 IP **没有被复用**；随后 `fetch()` 会再次解析 DNS。检查与实际连接之间存在时间窗，攻击者可用短 TTL 在两次解析之间把域名切到内网地址。
- 影响范围：仅 `fetch` 工具（需要管理员把域名加入白名单），但**不能宣称 DNS Rebinding 已完全解决**。
- 正确修法（M7 或 M6b）：把校验结果绑定到实际连接——用 `undici` Agent 的自定义 `lookup`，或自建 `https.request` 并显式传入已校验 IP + `servername`（保 SNI/证书校验）。需要配套测试：TTL=0 切换、A/AAAA 混合、IPv4-mapped。

### 文档修正
`SECURITY.md` 不再写"已完全防护 DNS rebinding"，改为"已做解析后校验，连接绑定待 M7 完成"。

## 6. 附带修复的运行时缺陷（发现于干净环境测试）

| 缺陷 | 现象 | 修复 |
|---|---|---|
| 孤儿任务误判 | 新建、尚未写心跳的任务被 `recoverInterruptedJobs` 直接标成 `INTERRUPTED` | 改为"创建时间过期 **且** 心跳过期"才算孤儿 |
| 取消被覆盖 | `cancel` 写入 `CANCELLED` 后，runner 用退出码回写成 `FAILED` | `cancelActiveJob` 直接写终态；runner 遇到 `CANCELLED` 直接返回；`JobStore.save` 拒绝把 `CANCELLED` 覆盖成其它状态 |

**残留风险**：`runtime` 测试套件里的后台任务用例在重负载下仍会偶发失败（约 1/4 概率）。已确认是真实进程时序问题，不是断言过严；CI 已配置"首次失败自动重跑一次"。**M7 必须把它变成确定性测试**，不能长期靠重跑。

## 7. 验证记录（干净环境）

| 项目 | 结果 |
|---|---|
| `npm ci` | 成功（593 包） |
| `npm run build:runtime` | 成功 |
| `npm run build` | 成功（renderer 462 KB） |
| `npm test` | 415 passed / 4 skipped |
| `cd runtime; npm test` | 105–108 passed，1–4 偶发（见 6） |
| `npm run lint` | 0 error / 265 warning |

## 8. M6 结论

- 工程质量四项（锁文件、SBOM、ESLint、许可证）**完成**；
- SSRF **部分完成**：检查逻辑有效，但连接未绑定校验结果，**TOCTOU 属开放问题**，不得宣称已解决；
- 顺带修了 3 个真实运行时缺陷，但后台任务测试仍需在 M7 做成确定性用例。

**不发布 v0.1.1**：按计划等 M7（审计队列重构）完成后再发修订版，并附本次 SBOM 与更新后的 SHA256。
