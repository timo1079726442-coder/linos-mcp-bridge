# P1 安全方案：SSRF 的 DNS TOCTOU 修复（校验 IP 与实际连接 IP 绑定）

- 状态：**已审查定稿（Approved）· Q1–Q6 已决策 · 进入 S1–S4 实施**
- 分支：`release/v0.1.1-hardening`（本地，未推送、未合并）
- 关联：`runtime/src/fetch-tool.ts`、`runtime/test/fetch-tool.test.js`、`runtime/src/mcp-tools.ts`
- 运行时事实：打包产物由 Electron `33.4.11` 以 `ELECTRON_RUN_AS_NODE=1` 启动，内嵌 **Node 20.18.3**（已本机实测）
- 发布阻断项提醒：**Windows 审计目录 `FILE_SYNC_ONLY` 仍未解决**，本方案不改变该阻断状态

---

## 0. 结论摘要

**根因**：`fetchUrl` 先用 `dns.lookup()` 校验域名解析结果，再调用全局 `fetch()` 发起请求；`fetch`（undici）会**独立再解析一次**主机名。两次解析之间没有任何绑定关系，因此校验通过并不保证连接的对手是同一个 IP —— 这就是 DNS Rebinding 可利用的 TOCTOU 窗口（`fetch-tool.ts:189` 与 `:194`）。

**推荐架构**：把"解析"和"连接"合并为一次受控解析，并使用 **Node core `node:https` / `node:http` 的自定义 `lookup`** 把已验证的唯一 IP 直接交给 socket，同时：

- `host` / `servername` 保持原始域名 → **TLS 证书校验与 SNI 仍针对域名**（不降级、不关闭校验）；
- 连接建立后**读回 `socket.remoteAddress` 与固定 IP 比对**，不一致即失败关闭；
- 每一跳重定向重新"解析→校验→固定"，并为每跳使用 `agent: false`（禁用连接池）以避免连接复用污染。

**零新增依赖**：不引入 `undici`、不引入原生模块，符合便携包与 Electron 33（Node 20.18）约束。

**关键证据（已在本机目标运行时实测，见 §7.3）**：

| 验证项 | Electron 33.4.11 / Node 20.18.3 结果 |
|---|---|
| 自定义 `lookup` 只被调用 1 次（`all: true`） | `lookupCallCountForOneRequest = 1` |
| 实际建立连接的地址 = 固定地址 | `pinnedRemoteAddress = 127.0.0.1`（该地址由 lookup 返回，非再次解析） |
| TLS SNI 仍为原始域名 | 服务端 `req.socket.servername = "example.test"` |
| 证书仍按域名校验（错误域名必须失败） | `ERR_TLS_CERT_ALTNAME_INVALID` |
| 固定到一个无人监听的地址 → 连接失败（证明连接跟随 lookup 结果） | `ECONNREFUSED` |

---

## 1. 当前调用链与漏洞位置

### 1.1 调用链（生产路径）

```
MCP client  POST /mcp  {"method":"tools/call","params":{"name":"fetch",...}}
  └─ runtime/src/server.ts            → dispatchMcp(...)                 ← P0 审计包装在此（INTENT→RESULT）
      └─ runtime/src/mcp-tools.ts:2047  case "fetch"
          └─ mcp-tools.ts:2050          fetchUrl(profileDir, workspaceId, {url, max_bytes})
              └─ fetch-tool.ts:181      loadFetchAllowlist()            （白名单，工作区优先→Profile 回退）
              └─ fetch-tool.ts:182      validateUrl()                   （scheme/凭据/IP 字面量/localhost/白名单）
              └─ fetch-tool.ts:187-219  for redirect 0..3
                  ├─ :189  if (request === fetch) await assertPublicResolution(hostname)   ← 第 1 次 DNS 解析
                  ├─ :194  await request(url, {redirect:"manual"})                          ← 第 2 次独立 DNS 解析（undici 内部）
                  └─ :217  重定向 → validateUrl(next) → 回到 :189
              └─ :221-256   状态/类型/大小/截断处理
```

### 1.2 漏洞与缺陷清单

| 编号 | 位置 | 问题 | 可利用后果 |
|---|---|---|---|
| **V1（核心）** | `fetch-tool.ts:189` + `:194` | 校验用 `dns.lookup` 与连接用 undici 内部解析**相互独立**；校验返回后 DNS 可被改写（TTL=0、攻击者权威 NS），连接时解析到内网 | SSRF：访问 `127.0.0.1` / RFC1918 / 云元数据，读取本机或内网敏感接口 |
| V2 | `fetch-tool.ts:189` | `request === fetch` 才做校验；一旦调用方传入自定义 `request`，DNS 校验被**整体跳过** | 任何复用该注入口的代码路径都会绕过校验（"测试专用"靠约定而非类型约束） |
| V3 | `fetch-tool.ts:119-127` | `dns.lookup(..., {all:true})` 返回空数组时 for 循环零次迭代 → **放行** | 异常解析器/空答案场景下缺少失败关闭 |
| V4 | `fetch-tool.ts:130-144` | 私有地址判定为手写部分枚举，**非"仅公网"白名单**：漏 `192.0.0.0/24`、`198.18.0.0/15`、`198.51.100.0/24`、`203.0.113.0/24`、`224.0.0.0/4`、`240.0.0.0/4`；IPv6 漏 `ff00::/8`、`2001:db8::/32`、`2002::/16`（6to4）、`2001::/32`（Teredo）、`64:ff9b::/96`（NAT64）、`::/96`（IPv4-compatible） | 部分保留/文档/多播段被视为"公网"；6to4/Teredo/NAT64 可间接指向内网 |
| V5 | `fetch-tool.ts:132-134` | `startsWith("fc")`/`"fd"` 的字符串前缀匹配 + `::ffff:` 递归；未做规范化（如 `fc00:0:0:0:0:0:0:1` 压缩形式、大小写、`::` 展开） | 边界地址可能漏判 |
| V6 | `fetch-tool.ts:191` | 超时按**跳**计 10s，最坏 4×10s=40s；无总预算 | 慢速攻击/资源占用 |
| V7 | `fetch-tool.ts:156` | 只按 scheme 判定，未限制端口；白名单公网域名可被访问任意端口 | 探测公网主机非 HTTP 服务 / 内网映射端口 |
| V8 | `fetch-tool.ts:156-158` + `:211-218` | 允许 `https → http` 降级（当 `allow_http` 打开时） | 中间人可降级窃听（对"只读抓取敏感页面"是实质风险） |
| V9 | `fetch-tool.ts:190-206` | 建立了连接但**从不校验对端地址**，也没有断言；即使将来 pinning 写错也无从发现 | 无法证明"连接用的就是校验过的 IP" |
| V10 | `fetch-tool.ts:228-241` | 仅按解压后字节计数；全局 `fetch` 会自动协商 gzip 并解压 | 压缩炸弹在解压侧消耗 CPU/内存（当前上限 1MB 解压后，风险可控但不应依赖） |

> 说明：V2/V9 在**当前**生产代码下不可由外部直接触发（生产只走 `request === fetch`），但它们使"安全"依赖调用约定；本方案把不变量写进类型与断言，消除这类隐性假设。

---

## 2. 威胁模型

**攻击者能力假设**

- 可控制一个**已在白名单内**的域名（用户为业务需要加入，例如自有 CDN 子域或第三方数据源）；
- 可控制该域名的权威 DNS，返回任意 TTL 与任意 A/AAAA 记录；
- 可控制该域名的 HTTP(S) 服务并返回任意 `Location`；
- 不能篡改本机信任根、不能读取进程内存、不能修改已安装的二进制。

**不在范围内**：本机管理员级恶意软件、内核级劫持、白名单本身被用户配置为内网域名（用户显式授权，另行提示）。

**攻击路径**

1. **Rebinding**：第 1 次解析返回公网 IP（校验通过）→ 立刻把记录改为 `127.0.0.1` 或 `169.254.169.254` → `fetch` 第 2 次解析拿到内网 → 读取内网/元数据。
2. **混合答案**：同一响应里 `A` 记录同时含公网与内网地址；底层可能选中内网那条。
3. **重定向绕过**：首跳合法，302 到内网地址或非白名单域名；若每跳未重新解析并绑定，或只校验首跳，即可绕过。
4. **IPv4-mapped / 特例形式**：`::ffff:127.0.0.1`、`::ffff:7f00:1`、`0177.0.0.1`（八进制，URL 解析器归一化后由我们再做一次严格解析判断）、`[::1]`、`[fe80::1%eth0]`（zone id）。
5. **连接复用污染**：连接池把上一跳已建立的 socket 复用于下一跳（不同主机名/不同固定 IP），导致"绑定"形同虚设。
6. **降级与端口**：302 到 `http://`（当 allow_http 开启）或到公网主机的 `:6379`/`:11211`。

---

## 3. 目标不变量（Acceptance Invariants）

实施与验收以这 8 条为准，逐条给出可执行断言：

| ID | 不变量 | 验证方式 |
|---|---|---|
| **I1** | 对任一跳，域名解析只发生一次；该次结果即连接目标 | 注入 resolver 计数；`lookup` 回调调用次数 == 1/跳 |
| **I2** | 连接的 TCP 对端地址 == 被校验的地址 | 连接后比较 `socket.remoteAddress` 与固定地址（**规范化**后），不等则 `FETCH_PEER_MISMATCH` 并中止 |
| **I3** | TLS 证书校验、SNI、Host 头均使用**原始域名**，任何情况下不关闭校验 | 错误域名证书 → `ERR_TLS_CERT_ALTNAME_INVALID`；服务端观测 SNI == 域名 |
| **I4** | 每次重定向重新解析 + 重新校验 + 重新固定；`agent:false` 每跳新连接 | 重定向测试：每跳 resolver 计数 +1，socket 不复用 |
| **I5** | 地址必须属于**全局可路由单播**；任何非公网/保留/特殊段一律拒绝（默认拒绝而非枚举拒绝） | 地址矩阵测试（§8.2）全绿 |
| **I6** | 多答案中**只要有一个**非公网就整体拒绝；空答案拒绝 | 混合/空答案用例 |
| **I7** | 明确的硬上限：DNS 3s、连接 5s、单跳响应 10s、**总预算 20s（全局共享，不按跳重置）**、重定向 ≤3、响应体 ≤1MB、URL ≤2000 字符 | 超时/超限用例逐个触发对应错误码 |
| **I8** | 不跟随到非 http(s)、不允许降级到更弱 scheme、端口仅允许"默认端口或管理员显式授权" | 重定向/端口矩阵用例 |
| **I9** | **选路保留 DNS 返回顺序**，不引入 IPv4/IPv6 优先级；"取第一条"仅在**全部答案已通过判定**之后成立 | 顺序保持用例 + 混合答案拒绝用例 |

### 3.1 审查新增的四项强制约束（M1–M4）

审查意见追加以下 4 条，作为**验收硬条件**，与 I1–I9 同等强制：

| ID | 约束 | 落地方式 | 对应测试 |
|---|---|---|---|
| **M1** | **所有** DNS 答案必须整体通过检查：任一条非公网即整体拒绝；空答案拒绝；不得"取第一条安全 IP 而忽略危险答案" | `resolveOnce` 先对 `addresses[]` 全量判定，全部通过后才选路；任一条失败立即抛错 | T3、T4、T33、T34 |
| **M2** | 对端 IP 用**规范化比较**（IPv4 / IPv6 / IPv4-mapped / 不同 IPv6 文本表示），禁止字符串比较 | `parseAddress` 归一化为 `{family, value:bigint}`；`sameAddress()` 比较 family+value；mapped 形式先降为 v4 | T11、T35、T36、T37 |
| **M3** | 重定向共享**全局截止时间**，不得每跳重置；同时限制响应体大小 | `deadline = now + 20s` 只在入口计算一次，每跳用 `remaining = deadline - now` 裁剪 DNS/连接/读取超时；已过截止时间立即失败 | T14、T31、T38 |
| **M4** | `allow_ports` **只能由管理员**在控制面配置，MCP 调用者不得通过请求参数指定端口 | 端口来源仅 `fetch-allowlist.json`（Profile/工作区文件）；`fetch` 工具参数保持 `url` / `max_bytes` 两项，**不新增任何端口参数**；`validateUrl` 只读取 allowlist | T32、T39 |

> M4 的端口授权是**控制面权限**：写入 `fetch-allowlist.json` 需要文件系统访问（控制中心），MCP 调用方无法触及。工具 schema 必须保持 `additionalProperties: false`，避免有人日后通过参数注入。

---

## 4. 方案比较

### 4.1 候选方案

| 方案 | 做法 | 能否证明 IP 绑定 | 新依赖 | Electron 33 / Node 20.18 | 性能 | 维护成本 |
|---|---|---|---|---|---|---|
| **A（推荐）** | `node:https`/`node:http` + 自定义 `lookup` 返回唯一已验证 IP；`agent:false`；读回 `remoteAddress` 断言 | ✅ 强（同一 socket 层） | 无 | ✅ 已实测（§7.3） | 每跳新建连接，无 keep-alive；单次抓取增加 ~1 RTT | 中：自持一个精简传输层（约 300–400 行），Node 20/22 均稳定 |
| B | `undici` 的 `Agent({ connect: { lookup } })` + `undici.fetch` | ✅ 可以，但取决于 dispatcher 正确传参 | `undici`（根 `node_modules` 有 6.29.0，但 **runtime 未声明**；需打包进 runtime） | ⚠️ 需与 Electron 内嵌 undici 版本对齐；Node 20.18 自带 undici 6.x，版本漂移是长期风险 | 可保留 keep-alive，略快 | 中高：新增依赖、连接池必须按固定 IP 隔离或每跳新建并 close，否则复用污染 |
| C | 猴子补丁 `dns.lookup` / `dns.setDefaultResultOrder` | ❌ 不可靠 | 无 | ✅ | 无 | ❌ 进程级副作用，影响所有 DNS 使用者；不可接受 |
| D | 校验后把 URL host 改写为 IP 直连，再手动设 `Host` 与 `servername` | ⚠️ 取决于实现；容易被后续重构破坏 | 无 | ✅ | 同 A | 高：需处理 IPv6 方括号、证书 SNI、Cookie/重定向基准 URL；URL 语义被破坏，易出 bug |
| E | 维持 `fetch`，只做"二次校验"（连接前后各查一次，或不定期再查） | ❌ 只是把窗口变窄，未消除 | 无 | ✅ | 无 | 低但**无效**——不满足 I1/I2 |

**结论：选 A。** 理由：无需新增依赖、在**目标运行时实测可证明** I1/I2/I3、行为可完全由我们的代码决定、便于写出确定性测试。B 作为备选：若未来必须使用 HTTP/2 或需要与 `fetch` 语义完全一致，可再评估，但必须同时解决"每跳独立 dispatcher + 禁止跨跳复用"。

### 4.2 为什么要禁用连接复用

若复用 `https.Agent` 的 keep-alive socket，第二跳（重定向到另一域名或另一固定 IP）可能复用第一跳的 socket，出现"补丁打在了错误的连接上"。因此：

- `agent: false`（每请求独立连接）；
- 并且在连接建立后仍做 `remoteAddress` 断言（双保险）。

性能代价：单次 fetch 最多 4 跳，每跳多一次 TCP+TLS 握手（约 1 RTT / 跳，局域网或就近 CDN 通常 10–50ms）。对"只读抓取"场景可接受；如后续需要优化，只能在同一跳内重试（同一固定 IP），**不得**在同一连接上跨跳复用。

---

## 5. 推荐架构与数据流

### 5.1 模块划分（新增/改动）

```
runtime/src/net/
  address-policy.ts     ← 地址解析与"仅公网"判定（纯函数，无 I/O，易测）
  pinned-transport.ts   ← 给定 {url, address, family} 发起一次 https/http 请求，
                          内部用自定义 lookup 固定 IP，并断言 remoteAddress
  resolver.ts           ← resolveOnce(hostname): 带超时、all:true、空答案拒绝、
                          全部答案必须通过公网判定、按 DNS 返回顺序取第一条
runtime/src/fetch-tool.ts ← 保留 URL/白名单/重定向/大小/类型策略；改为
                          每跳调用 resolver.resolveOnce + pinned-transport.request
```

### 5.2 数据流（单跳）

```
URL ──validateUrl──► {hostname, port, path, scheme}
                          │
                          ▼
                 resolver.resolveOnce(hostname, {timeoutMs: 3000})
                          │  dns.lookup(all:true, verbatim:true)  ← 全流程唯一一次解析
                          ▼
                 addresses[] ──► address-policy.classify()
                          │  · 空 → FETCH_DNS_EMPTY
                          │  · 任一条非公网 → FETCH_HOST_NOT_ALLOWED（整体拒绝，不挑选）
                          ▼
                 pickFirstInDnsOrder(addresses)  → {address, family}
                          │  （Q4 定稿：保留 DNS 返回顺序，不引入 IPv4/IPv6 优先级策略）
                          │
                          ▼
        pinned-transport.request({ url, address, family, deadline })
                          │  https.request({ host: hostname, servername: hostname,
                          │                  agent: false, lookup: (…) => 只回这一个地址 })
                          ▼
                 socket 建立 ──► 断言 socket.remoteAddress == address
                          │        不等 → 立即 destroy + FETCH_PEER_MISMATCH
                          ▼
                 TLS 握手（域名校验 + SNI）──► 发送 Host: hostname
                          ▼
                 状态行 ──3xx──► 解析 Location → 回到 validateUrl（重新解析/校验/固定）
                          │
                          └─2xx──► content-type 校验 → 流式读，边读边计数 → 截断/返回
```

### 5.3 关键设计点

1. **解析与连接是同一次调用链**：`resolveOnce` 的返回值直接作为 `lookup` 的返回值，中间没有任何其他解析机会。
2. **`host` 与 `servername` 保持域名**：`https.request` 的 `host` 决定 `Host` 头与证书校验基准；`servername` 决定 SNI。**不把 URL 改写为 IP**，因此证书校验天然按域名。
3. **`lookup` 必须支持 `all: true`**：Node 20 在 `autoSelectFamily` 下会以 `all: true` 调用（实测见 §7.3）。实现必须回传**单元素数组**，这样"备选地址池"只有一个成员，Happy Eyeballs 没有第二个可试对象。
4. **失败关闭**：任何一步失败都抛 `FetchError`，不重试、不降级、不回退到全局 `fetch`。
5. **总预算**：`deadline = now + 20s` 贯穿所有跳；每跳再叠加自己的 DNS/连接/读超时，取三者更小值。

---

## 6. 关键实现示例

> 以下为**方案示意**，用于审查接口与关键判断；未写入仓库。命名与现有代码风格一致（`FetchError`、`MAX_*` 常量）。

### 6.1 地址解析与"仅公网"判定（`net/address-policy.ts`）

```ts
export type AddressFamily = 4 | 6;
export interface ParsedAddress { family: AddressFamily; value: bigint; }

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 严格解析：仅接受点分十进制 IPv4 或标准/压缩 IPv6；失败返回 null（不猜测）。 */
export function parseAddress(input: string): ParsedAddress | null { /* v4 → 32bit；v6 → 128bit，含 :: 展开 */ }

/** 仅允许全局可路由单播；默认拒绝。 */
export function classifyAddress(address: ParsedAddress): { allowed: boolean; reason?: string } {
  if (address.family === 4) return classifyV4(Number(address.value));
  return classifyV6(address.value);
}

function classifyV4(ip: number) {
  const deny: Array<[string, number]> = [
    ["0.0.0.0/8", 8], ["10.0.0.0/8", 8], ["100.64.0.0/10", 10], ["127.0.0.0/8", 8],
    ["169.254.0.0/16", 16], ["172.16.0.0/12", 12], ["192.0.0.0/24", 24],
    ["192.0.2.0/24", 24], ["192.88.99.0/24", 24], ["192.168.0.0/16", 16],
    ["198.18.0.0/15", 15], ["198.51.100.0/24", 24], ["203.0.113.0/24", 24],
    ["224.0.0.0/4", 4], ["240.0.0.0/4", 4],
  ];
  for (const [cidr, bits] of deny) if (inCidrV4(ip, cidr, bits)) return { allowed: false, reason: cidr };
  return { allowed: ip >= 0x01000000 && ip <= 0xdfffffff }; // 1.0.0.0–223.255.255.255 且不在上述段
}

function classifyV6(ip: bigint) {
  // IPv4-mapped / IPv4-compatible / NAT64 / 6to4 / Teredo：先抽取内嵌 v4 再按 v4 规则判定，
  // 或直接拒绝（推荐直接拒绝，见 §12 待决问题 Q1）。
  // 其余拒绝：::/128, ::1/128, 100::/64, 2001::/32, 2001:db8::/32, 2002::/16,
  //           fc00::/7, fe80::/10, ff00::/8；仅放行 2000::/3 中未被拒绝者。
}
```

**要点**

- **默认拒绝**：先判"是否在允许集合"，而不是"是否在私有集合"；这修复 V4。
- `::ffff:a.b.c.d`、`::ffff:7f00:1` 两种写法都归一化后判定（修复 V5 的映射绕过）。
- 明确拒绝 6to4 / Teredo / NAT64（它们能把流量引向任意 IPv4，包括内网）。
- 云元数据地址（`169.254.169.254`、`fd00:ec2::254`、`100.100.100.200` 等）本就在 `169.254/16`、`fc00::/7`、`100.64/10` 内，被默认拒绝覆盖。

### 6.2 单次解析（`net/resolver.ts`）

```ts
export interface PinnedTarget { hostname: string; address: string; family: 4 | 6; }

export async function resolveOnce(
  hostname: string,
  options: { timeoutMs: number; lookup?: typeof dnsLookup },
): Promise<PinnedTarget> {
  const lookup = options.lookup ?? dnsLookup;
  const settled = await withTimeout(
    lookup(hostname, { all: true, verbatim: true }),
    options.timeoutMs,
    new FetchError("FETCH_DNS_TIMEOUT"),
  ).catch(() => { throw new FetchError("FETCH_DNS_FAILED"); });

  if (!Array.isArray(settled) || settled.length === 0) throw new FetchError("FETCH_DNS_EMPTY");

  const parsed = settled.map((entry) => {
    const address = parseAddress(entry.address);
    if (!address) throw new FetchError("FETCH_DNS_INVALID_ADDRESS");
    const verdict = classifyAddress(address);
    // I6：任一条不合规 → 整体拒绝（不做"挑一个安全的"）
    if (!verdict.allowed) throw new FetchError("FETCH_HOST_NOT_ALLOWED");
    return { address: entry.address, family: entry.family as 4 | 6 };
  });

  // Q4 定稿：保留 DNS 返回顺序，取第一条；不引入 IPv4/IPv6 优先策略。
  const chosen = parsed[0]!;
  return { hostname, address: formatAddress(chosen.address), family: chosen.family };
}
```

> 说明：`parsed` 已保证**全部**答案都是公网地址（I6）；因此"取第一条"不会跳过危险答案——
> 只要存在一条非公网地址，`resolveOnce` 已在上面整体拒绝。

### 6.3 固定 IP 的连接（`net/pinned-transport.ts`）

```ts
export function requestPinned(input: {
  url: URL;
  target: PinnedTarget;
  deadline: number;
  headers: Record<string, string>;
}): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = input.url.protocol === "https:";
    const options: https.RequestOptions = {
      protocol: input.url.protocol,
      host: input.target.hostname,             // ← Host 头与证书校验基准仍是域名
      servername: input.target.hostname,       // ← SNI 仍是域名
      port: input.url.port || (isHttps ? 443 : 80),
      path: `${input.url.pathname}${input.url.search}`,
      method: "GET",
      headers: { ...input.headers, host: input.target.hostname },
      agent: false,                            // ← 禁连接池，杜绝跨跳复用
      lookup: (hostname, lookupOptions, callback) => {
        // 全流程唯一"解析"：只回传已校验的那一个地址
        if (hostname.toLowerCase() !== input.target.hostname.toLowerCase()) {
          callback(new Error("FETCH_LOOKUP_HOST_MISMATCH"), "" as never, 4 as never);
          return;
        }
        if (lookupOptions?.all) callback(null, [{ address: input.target.address, family: input.target.family }]);
        else callback(null, input.target.address, input.target.family);
      },
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      // I2：连接到的对端必须就是被校验的那一个
      const peer = res.socket?.remoteAddress ?? "";
      if (!sameAddress(peer, input.target.address)) {
        res.destroy();
        reject(new FetchError("FETCH_PEER_MISMATCH"));
        return;
      }
      resolve(capture(res));
    });
    req.on("error", (error) => reject(mapTransportError(error)));
    armDeadline(req, input.deadline);          // 到点 destroy + FETCH_TIMEOUT
    req.end();
  });
}
```

**为什么这样就"证明"了绑定**：

1. `lookup` 是 socket 层解析入口；它只可能返回一个地址；
2. `https.request` 不会在 `lookup` 之外再做 DNS 解析（实测 `lookupCallCountForOneRequest = 1`）；
3. 我们对 `res.socket.remoteAddress` 做了一次**事后断言**，把"应该"变成"已经"；
4. 固定到无人监听的地址会 `ECONNREFUSED`（实测），证明连接确实跟随该返回值而非另一次解析。

### 6.4 重定向循环（改造 `fetchUrl`）

```ts
let current = validateUrl(args.url, allowlist);
const deadline = Date.now() + TOTAL_BUDGET_MS;          // I7：总预算 20s
const seen = new Set<string>();

for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
  const target = await resolveOnce(current.hostname, {
    timeoutMs: Math.min(DNS_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
    lookup: resolver,                                    // 测试注入点（不再是"跳过校验"）
  });
  const response = await requestPinned({ url: current, target, deadline, headers: ACCEPT_HEADERS });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.location;
    if (!location) throw new FetchError("FETCH_REDIRECT_INVALID");
    if (hop === MAX_REDIRECTS) throw new FetchError("FETCH_REDIRECT_LIMIT");
    const next = new URL(location, current);
    if (current.protocol === "https:" && next.protocol === "http:") throw new FetchError("FETCH_SCHEME_DOWNGRADE"); // I8
    current = validateUrl(next.toString(), allowlist);
    if (seen.has(current.toString())) throw new FetchError("FETCH_REDIRECT_LOOP");
    seen.add(current.toString());
    continue;                                            // I4：下一跳重新解析/校验/固定
  }
  return await readBounded(response, maxBytes, deadline);
}
```

补充规则：`readBounded` 在读取阶段也检查 `deadline`（防"慢速滴灌"），并拒绝 `content-encoding`（见 §9 错误码 `FETCH_CONTENT_ENCODING_REJECTED`），避免依赖解压库与压缩炸弹。

---

## 7. "校验的 IP = 实际连接的 IP" 的证据链

四层证据，缺一不可：

### 7.1 代码层（结构保证）

- 唯一解析入口 `resolveOnce`（`dns.lookup` 只出现在这一处）；
- 其返回值以闭包形式进入 `lookup`，`lookup` 内只做"回放"，没有任何其他地址来源；
- `fetch-tool.ts` 不再引用全局 `fetch`（可用 lint 规则禁止：`no-restricted-globals: fetch`）。

### 7.2 运行期断言（运行时保证）

- 连接建立后比较 `res.socket.remoteAddress` 与固定地址；不一致立即 `destroy()` + `FETCH_PEER_MISMATCH`；
- 对 IPv4/IPv6/映射形式统一用 `sameAddress()` 规范化比较；
- 该断言在**每次实际抓取**都执行，不是只在测试里。

### 7.3 实测（目标运行时已复现）

一次性验证脚本（临时目录，不入库）在 **Electron 33.4.11 / Node 20.18.3** 与 Node 24.19 上结果一致：

| 观察项 | 结果 | 说明 |
|---|---|---|
| `lookup` 调用次数（单请求） | `1` | 不存在第二次解析 |
| `lookup` 参数 | `{ hostname: "example.test", all: true }` | 必须支持 `all:true` 回传数组 |
| 本地服务端看到的 SNI | `example.test` | `servername` 为原始域名 |
| 客户端 `socket.remoteAddress` | `127.0.0.1` | 即 lookup 固定值 |
| 错误域名 + 正确 CA | `ERR_TLS_CERT_ALTNAME_INVALID` | 证书校验未被削弱 |
| 固定到无人监听地址 | `ECONNREFUSED` | 连接确由 lookup 决定 |

复现方式（审查时可在本机重跑）：

```powershell
$r='D:\CODE\open-source\linos-mcp-bridge-clean'
$env:ELECTRON_RUN_AS_NODE='1'; $env:POC_DIR="$env:TEMP\ssrf-poc"
& "$r\node_modules\electron\dist\electron.exe" "$env:TEMP\ssrf-poc\pin-probe.mjs"
```

### 7.4 测试层（确定性回归）

- **Rebinding 用例**：注入 resolver，第 1 次返回公网地址、之后返回 `127.0.0.1`；断言请求只发生 1 次解析，且连接的 `remoteAddress` 为公网地址；
- **从未连接内网**：在 `127.0.0.1:PORT` 起一个"内网靶"监听，rebinding 场景下断言之**零连接**（监听器计数 == 0）；
- **对端不匹配**：构造 lookup 返回 X、实际连到 Y 的情形（测试用 transport 注入），断言 `FETCH_PEER_MISMATCH` 且响应体不被读取。

---

## 8. 安全测试用例（验收清单）

### 8.1 解析与绑定

| ID | 场景 | 输入 | 期望 |
|---|---|---|---|
| T1 | 正常公网域名 | `https://example.com/`，resolver → `93.184.216.34` | 成功；`lookup` 调用 1 次；`remoteAddress` 等于该 IP |
| T2 | DNS rebinding（二次解析内网） | resolver 第 1 次公网、第 2 次 `127.0.0.1` | 成功且**未**连内网（目标监听计数 0） |
| T3 | 空解析结果 | resolver → `[]` | `FETCH_DNS_EMPTY` |
| T4 | 混合答案 | `[93.184.216.34, 10.0.0.5]` | `FETCH_HOST_NOT_ALLOWED`（I6） |
| T5 | DNS 超时 | resolver 挂起 > 3s | `FETCH_DNS_TIMEOUT` |
| T6 | DNS 失败 | resolver reject | `FETCH_DNS_FAILED` |
| T7 | 非法地址文本 | resolver → `"not-an-ip"` | `FETCH_DNS_INVALID_ADDRESS` |

### 8.2 地址矩阵（`classifyAddress` 单元测试，全部拒绝）

IPv4：`0.0.0.0`、`10.1.2.3`、`100.64.0.1`、`127.0.0.1`、`169.254.169.254`、`172.16.0.1`、`172.31.255.255`、`192.0.0.8`、`192.0.2.5`、`192.88.99.1`、`192.168.1.1`、`198.18.0.1`、`198.51.100.7`、`203.0.113.9`、`224.0.0.1`、`240.0.0.1`、`255.255.255.255`

IPv6：`::`、`::1`、`::ffff:127.0.0.1`、`::ffff:7f00:1`、`::127.0.0.1`（v4-compatible）、`64:ff9b::7f00:1`（NAT64）、`100::1`、`2001::1`（Teredo）、`2001:db8::1`、`2002:7f00:1::1`（6to4）、`fc00::1`、`fd12:3456::1`、`fe80::1`、`ff02::1`

放行（正例）：`93.184.216.34`、`1.1.1.1`、`8.8.8.8`、`2606:4700:4700::1111`、`2a00:1450:4001::1`

云元数据专项：`169.254.169.254`、`169.254.170.2`、`fd00:ec2::254`、`100.100.100.200` → 全部拒绝

### 8.3 传输与 TLS

| ID | 场景 | 期望 |
|---|---|---|
| T8 | 证书域名不匹配 | TLS 失败（`ERR_TLS_CERT_ALTNAME_INVALID`），不返回正文 |
| T9 | 自签/不受信 CA | TLS 失败 |
| T10 | SNI 正确传递 | 服务端观测 SNI == 请求域名 |
| T11 | 对端地址与固定值不符（注入） | `FETCH_PEER_MISMATCH`，正文未读取 |
| T12 | `allow_http` 未开时访问 http | `FETCH_SCHEME_NOT_ALLOWED` |
| T13 | 连接超时 | `FETCH_TIMEOUT` |
| T14 | 总预算耗尽（慢速滴灌） | `FETCH_TIMEOUT`，连接被 destroy |

### 8.4 重定向与复用

| ID | 场景 | 期望 |
|---|---|---|
| T15 | 302 → 白名单内另一域名 | 成功；resolver 计数 2；两跳 socket 不同 |
| T16 | 302 → 非白名单域名 | `FETCH_DOMAIN_NOT_ALLOWED` |
| T17 | 302 → `https://127.0.0.1/` | `FETCH_HOST_NOT_ALLOWED` |
| T18 | 302 → 内网域名（解析到 `10.x`） | `FETCH_HOST_NOT_ALLOWED` |
| T19 | 4 次重定向 | `FETCH_REDIRECT_LIMIT` |
| T20 | 重定向环 | `FETCH_REDIRECT_LOOP` |
| T21 | `https → http` 降级 | `FETCH_SCHEME_DOWNGRADE` |
| T22 | 302 → 非默认端口（如 `:6379`） | `FETCH_PORT_NOT_ALLOWED` |
| T23 | 复用检查 | 两跳的 `socket` 实例不同（`agent:false` 生效） |

### 8.5 响应处理（沿用现有 + 新增）

| ID | 场景 | 期望 |
|---|---|---|
| T24 | 非文本 content-type | `FETCH_CONTENT_TYPE_REJECTED` |
| T25 | `content-length` 超限 | `FETCH_TOO_LARGE` |
| T26 | 无 `content-length` 但流超限 | `FETCH_TOO_LARGE`（读取中即中止） |
| T27 | `content-encoding: gzip` | `FETCH_CONTENT_ENCODING_REJECTED`（不实现解压） |
| T28 | 正文超 20 万字符 | `truncated=true`，`chars=200000` |

### 8.6 审查新增约束的用例（M1–M4）

| ID | 约束 | 场景 | 期望 |
|---|---|---|---|
| T29 | M3 | 总预算耗尽后再发生重定向 | 立即 `FETCH_TIMEOUT`，不再发起新连接 |
| T30 | M3 | 第 1 跳耗时接近总预算，第 2 跳 | 第 2 跳可用时间 = 剩余预算（不得重置为整额） |
| T31 | M3 | 慢速滴灌（每 100ms 1 字节，持续不止） | 到截止时间 `FETCH_TIMEOUT`，连接 destroy |
| T32 | M4 | 调用方在 MCP 参数里额外传 `port` / `allow_ports` | schema 拒绝（`additionalProperties:false`），端口只取白名单 |
| T33 | M1 | 答案 `[8.8.8.8, 127.0.0.1]`（审查原文场景） | `FETCH_HOST_NOT_ALLOWED`，**不得**因首条合法而放行 |
| T34 | M1 | 答案 `[]`（空） | `FETCH_DNS_EMPTY` |
| T35 | M2 | 对端 `::ffff:127.0.0.1` vs 固定 `127.0.0.1` | 视为同一地址（mapped 归一化） |
| T36 | M2 | 对端 `2001:0db8:0000:0000:0000:0000:0000:0001` vs `2001:db8::1` | 视为同一地址（文本表示归一化） |
| T37 | M2 | 对端 `127.0.0.2` vs 固定 `127.0.0.1` | 判定不等 → `FETCH_PEER_MISMATCH` |
| T38 | M3 | 响应体持续增长超过 1MB（带正确 content-type） | `FETCH_TOO_LARGE`，读取即中止（不缓冲完整大文件） |
| T39 | M4 | 白名单未配置 `allow_ports`，URL 使用 `:8443` | `FETCH_PORT_NOT_ALLOWED`；管理员配置 `allow_ports:[8443]` 后放行 |

### 8.7 回归（现有 6 个用例必须继续通过）

`fetch-tool.test.js` 的白名单匹配、工作区/Profile 回退、成功读取、拒绝未授权域名/http/IP/localhost/带凭据 URL、逐跳重定向拒绝、非文本与超限——语义保持不变，仅把"注入 `request` 函数"改为"注入 `resolver` + `transport`"。

> TLS 端到端证明（SNI/证书/对端 IP）使用**仓库外一次性探针**复现（§7.3 命令），仓库内不存放私钥素材；仓库内测试通过 `buildRequestOptions()` 纯函数断言 `servername`/`rejectUnauthorized`/`agent`/`lookup` 的构造结果，避免提交测试私钥触发密钥扫描门禁。

---

## 9. 失败处理与错误码

### 9.1 新增/调整错误码（`FetchError.code`）

| 错误码 | 含义 | 现有/新增 |
|---|---|---|
| `FETCH_DNS_EMPTY` | 解析结果为空 | 新增（修 V3） |
| `FETCH_DNS_INVALID_ADDRESS` | 解析返回非 IP 文本 | 新增 |
| `FETCH_DNS_TIMEOUT` | 解析超时（3s） | 新增 |
| `FETCH_DNS_FAILED` | 解析失败 | 保留 |
| `FETCH_HOST_NOT_ALLOWED` | 非公网/本机域名 | 保留（判定范围扩大到"仅公网"） |
| `FETCH_PEER_MISMATCH` | 实际对端 ≠ 固定地址 | 新增（**安全事件级**） |
| `FETCH_LOOKUP_HOST_MISMATCH` | lookup 收到的 host 与预期不符 | 新增（内部断言） |
| `FETCH_SCHEME_DOWNGRADE` | https→http 降级 | 新增（修 V8） |
| `FETCH_PORT_NOT_ALLOWED` | 非允许端口 | 新增（修 V7） |
| `FETCH_REDIRECT_LOOP` | 重定向环 | 新增 |
| `FETCH_CONTENT_ENCODING_REJECTED` | 压缩响应 | 新增（修 V10） |
| `FETCH_TIMEOUT` / `FETCH_TOO_LARGE` / `FETCH_CONTENT_TYPE_REJECTED` / `FETCH_REDIRECT_*` / `FETCH_DOMAIN_NOT_ALLOWED` / `FETCH_DISABLED` / `FETCH_SCHEME_NOT_ALLOWED` / `FETCH_URL_INVALID` | 现有语义不变 | 保留 |

`mcp-tools.ts` 的 `fetchHint()` 需为新增码补中文提示；`FETCH_PEER_MISMATCH` 提示应说明"连接对端与校验地址不一致，已中止"。

### 9.2 失败原则

- **一律 fail-closed**：不重试、不回退到 `fetch`、不放宽校验、不返回部分正文；
- 失败时不产生任何指向内网的连接（解析/校验在读之前完成）；
- `FETCH_PEER_MISMATCH` 记录到审计（现有 P0 审计只记工具级结果；建议把该错误码体现在 `RESULT_DURABLE.errorCode`，已是现状，无需新增字段）。

### 9.3 回滚方案

- **无数据迁移、无配置格式变更**：`fetch-allowlist.json` 结构不变（`domains` / `allow_http`）；
- 回滚 = `git revert` 该提交；不会遗留半迁移状态；
- 若仅需临时关闭"端口限制"这类**行为收紧**（非安全核心），可用白名单可选字段 `allow_ports` 放宽；但 **I1/I2/I3（绑定与 TLS）不得提供开关**——安全核心必须无条件生效；
- 灰度：实现阶段可先用内部环境变量 `LINOS_FETCH_PIN_TRANSPORT=1` 在测试机启用、默认关闭，**仅限实施期**；发版前删除该开关并默认强制。

---

## 10. 兼容性影响

### 10.1 对外行为

| 方面 | 影响 |
|---|---|
| 工具名/参数 | 无变化（`fetch`，`url` / `max_bytes`） |
| 返回字段 | 无变化（`url`、`final_url`、`status`、`content_type`、`bytes`、`chars`、`truncated`、`text`、`allowlist_source`、`redirects`） |
| 错误格式 | 仍为 `CODE：中文提示`（沿用 `fetchHint`） |
| 白名单文件 | 结构不变；行为收紧（见下） |
| `Accept` 头 | 保持 `text/*, application/json;q=0.9, */*;q=0.1`；不再发送 `accept-encoding`（不解压） |

### 10.2 行为收紧（需在 CHANGELOG / 故障排查文档中说明）

1. **非默认端口将被拒绝**（`https`→443、`http`→80）；如需其它端口，通过白名单 `allow_ports` 显式开启（默认关闭）。
2. **禁止 `https → http` 降级**，即使 `allow_http=true`。
3. **不做响应解压**：服务器返回 `content-encoding` 时拒绝；正常情况下我们不发 `accept-encoding`，服务器不应压缩。
4. **DNS 空答案由"放行"改为"拒绝"**（原本是缺陷）。
5. **公共 IPv6 现在可用且被正确判定**（旧实现里很多公网 IPv6 因字符串前缀判断被误拒或误放）。

### 10.3 性能

- 每跳新建 TCP/TLS 连接（禁用 keep-alive）：单跳约 +1 RTT；重定向最多 3 跳，最坏多 3 个 RTT。相对 10s 量级的抓取预算可忽略。
- 全局 `fetch`/undici 的初始化开销消失，单次冷启动略快。
- 无新增依赖 → 包体不变。

### 10.4 测试代码影响

- `fetch-tool.test.js` 现有 6 个用例的**断言语义保留**，但注入点从 `request: typeof fetch` 改为 `{ resolver, transport }`；`new Response(...)` 构造需替换为轻量 `PinnedResponse` 结构（或提供测试辅助 `fakeResponse()`）。
- 新增 `net/address-policy.test.js`（纯函数矩阵）、`net/resolver.test.js`、`fetch-tool.pinning.test.js`（含本地 HTTPS 服务 + 自签证书，参照本方案 §7.3 的探针写法）。

---

## 11. 实施步骤（本方案获批后执行）

| 步骤 | 内容 | 验收 |
|---|---|---|
| S1 | 新增 `net/address-policy.ts` + 地址矩阵单元测试 | §8.2 全绿 |
| S2 | 新增 `net/resolver.ts`（全局超时/空答案/全量判定/DNS 顺序选路）+ `net/pinned-transport.ts`（lookup 固定、`agent:false`、`remoteAddress` 规范化断言）+ 真实 socket 证明测试 | T1–T7、T11、T23、T33–T37 |
| S3 | 改造 `fetch-tool.ts`：去掉全局 `fetch`，接入 S2；重定向/端口/降级/编码/预算/大小 | T8–T10、T12–T22、T24–T28、T31、T32、T38、T39 |
| S4 | `fetchHint()` 文案、工具 schema 复核（`additionalProperties:false`、不新增端口参数）、全量回归 | T29、T30、原有 6 用例不变 |
| S5 | 发布门槛：runtime 全量 + 根级 + typecheck；最终代码 10 轮稳定性 | 全绿 |
| S6 | 攻击复现演练：可控 DNS 复演旧漏洞、证明新实现阻断 | 演练记录留档 |

不做的事：不引入 `undici`；不改白名单文件结构（仅新增可选 `allow_ports`）；不改工具名/返回结构；不关闭 TLS 校验；不移除重定向限制。

---

## 12. 已定稿决策（Q1–Q6，审查通过）

| ID | 问题 | 定稿决定 | 具体要求 |
|---|---|---|---|
| Q1 | IPv4 内嵌型 IPv6（NAT64 / 6to4 / Teredo） | **一律拒绝** | 不允许通过地址转换绕过检查 |
| Q2 | 非默认端口 | **默认拒绝** | HTTPS 默认 443、HTTP 默认 80；其它端口必须由管理员在 `fetch-allowlist.json` 显式授权（`allow_ports`） |
| Q3 | `https → http` 降级 | **一律禁止** | 即使 `allow_http=true` 也拒绝；`allow_http` 只影响初始 URL |
| Q4 | 多 A/AAAA 记录选路 | **保留 DNS 返回顺序**（原"IPv4 优先"被否决） | 不引入 IPv4/IPv6 优先级策略；首版只证明"校验→固定→连接→核对"链路，选路规则越少越可审计 |
| Q5 | 失败后切换 IP | **不重试** | 连接失败立即返回错误，不自动换下一个 IP |
| Q6 | `content-encoding` | **拒绝压缩** | 请求头固定 `Accept-Encoding: identity`；响应若声明非 identity 的编码即拒绝 |

**Q4 的实施含义**：`resolveOnce` 在**全部答案通过判定**之后，取 `addresses[0]`（DNS 原始顺序）。这里"取第一条"是安全的，因为 M1 已保证不存在"危险答案被跳过"的情况。

---

## 13. 实施与提交纪律（已授权）

| 阶段 | 内容 | 验收 | 提交 |
|---|---|---|---|
| S1 | 全局单播 IP 判定（`net/address-policy.ts`） | IPv4/IPv6 特殊地址矩阵全绿 | 单独提交 |
| S2 | DNS 固定 IP 连接（`net/resolver.ts` + `net/pinned-transport.ts`） | 证明"校验 IP = 实际连接 IP" | 单独提交 |
| S3 | `fetch-tool.ts` 接入：TLS/重定向/端口/全局超时/响应限制 | §8 全部用例通过 | 单独提交 |
| S4 | 现有 `fetch` 工具兼容性与回归 | 原有功能不回退（返回结构/白名单语义不变） | 单独提交 |

强制边界（不得越过）：

- 不关闭 TLS 证书验证；不把 URL 重写为 IP 来规避证书校验；
- 不允许底层再次独立解析 DNS；
- 不允许连接池跨目标复用；
- 不允许为让测试通过而放宽任何安全规则。

---

## 14. 发布门禁状态（不因本方案而改变）

| 门禁 | 状态 |
|---|---|
| P0 后台任务恢复 | ✅ 代码已提交（`e2ae906`）；**最终代码仍需 10 轮稳定性验证** |
| P0 审计持久化 | ✅ 代码已提交（`04c2d80`），126/126 runtime + 415 root + typecheck 通过 |
| **Windows 审计目录持久性** | ❌ **阻断**：`fsync(directory)` 在 Windows 返回 `EPERM`，当前仅 `FILE_SYNC_ONLY`；未解决前不得发布 |
| P1 SSRF（本文） | 🔧 已批准，按 S1–S4 实施中；须完成 §8 全部用例 |
| 内部品牌清理 / Gitleaks / CodeQL / SBOM / 干净 Windows 安装 | ❌ 未开始 |

**执行边界：S1–S4 在 `release/v0.1.1-hardening` 独立进行；不合并 `main`、不推送、不发布 v0.1.1。**
