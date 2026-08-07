---
title: "feat: 增加服务器访问认证与安全启动默认值"
type: feat
status: completed
date: 2026-08-07
origin: docs/brainstorms/2026-08-07-server-access-authentication-requirements.md
---

# feat: 增加服务器访问认证与安全启动默认值

## Overview

为蜗牛派增加单实例、单共享访问密钥的服务器认证，并同时修复当前官方生产启动继承 Next.js `0.0.0.0` 默认监听值的问题。

交付后的默认行为：

- 本地官方入口只监听回环地址，保持免认证。
- `spi --server`、等价环境配置或任何官方非回环监听自动启用认证。
- 首次服务器启动生成并只展示一次访问密钥；后续重启复用不可逆校验信息。
- 未认证页面进入解锁页，普通 API 与 SSE 返回 `401`；登录后获得跨重启有效的 7 天固定会话。
- 密钥轮换清空全部会话；现有 Automation、原生目录选择器和浏览器桥接的 loopback-only 边界保持不变。

该工作跨 CLI、启动脚本、持久化安全状态、Next.js 请求边界、Web UI、部署文档和发布验证，按 Deep / security-sensitive 计划执行。

---

## Problem Frame

当前 WebUI 没有全局访问认证，却可以读写项目、启动 Agent、运行终端并管理模型凭据。`bin/pi-web.js` 在未传 hostname 时不向 Next.js 传 `-H`，而已安装的 Next.js 16.2.9 `next start` 默认监听 `0.0.0.0`，导致“本地默认启动”可能无意暴露到局域网（see origin: `docs/brainstorms/2026-08-07-server-access-authentication-requirements.md`）。

仓库没有现成的 `proxy.ts` / `middleware.ts` 全局门禁；现有 `app/api/auth/**` 只管理模型供应商凭据，并非 WebUI 用户认证。Automation 与本机目录选择器已有独立 loopback/control-session 策略，但不能替代整个应用的访问控制。

另一个规划前置条件是框架版本：项目锁定 Next.js 16.2.9，而 Next.js 2026 年 7 月安全公告要求升级到 16.2.11；公告包含 App Router Proxy 绕过和多项 DoS/SSRF 修复。即使当前配置未使用公告中 Proxy 绕过所需的单 locale `next.config` 条件，本功能也不应建立在已知落后的安全补丁版本上。

---

## Requirements Trace

- R1–R5. 所有官方入口采用安全监听默认值；服务器模式、非回环监听和启动失败必须具有不可绕过、fail-closed 的认证语义。
- R6–R10. 首次生成高熵访问密钥，只保存不可逆校验信息；重启复用；验证限流、日志脱敏；支持轮换和遗失恢复。
- R11–R15. 提供最小匿名解锁面，保护页面/API/SSE，建立 7 天固定且跨重启有效的 HttpOnly 会话，支持退出并限制跨站/URL 泄露。
- R16–R19. HTTP 可用但强警告；文档推荐 HTTPS 反向代理；不放宽现有 loopback-only 能力；不迁移或修改现有项目/会话/模型数据。

**Origin actors:** A1（实例运维者）、A2（Web 访问者）  
**Origin flows:** F1（本地安全启动）、F2（首次服务器启动与解锁）、F3（重启与再次访问）、F4（密钥轮换与恢复）  
**Origin acceptance examples:** AE1–AE8，分别覆盖本地默认、服务器首次启动、反向代理、页面/API/SSE 门禁、跨重启会话、轮换失效、HTTP 警告与 loopback-only 不变式。

---

## Scope Boundaries

- 仅实现单实例、单共享访问密钥；不增加用户名、多用户、RBAC 或项目级权限。
- 不接入 OAuth/OIDC/LDAP/TOTP/Passkey，也不引入用户数据库。
- 不内置 TLS 证书申请或 HTTPS server；HTTPS 由 Nginx/Caddy/隧道终止。
- 不支持 URL 访问密钥、明文 CLI 密钥参数或 localStorage/sessionStorage 认证令牌。
- 不把全局认证视为 Automation、本机目录选择器、浏览器桥接等本地能力的远程授权。
- 不支持 PM2 cluster 或多个并行 Next 实例共享状态；官方 PM2 示例固定单进程 fork 模式。
- 不改造所有现有 Route Handler 的业务授权模型；本功能是实例级入口认证，不引入资源级授权。

### Deferred to Follow-Up Work

- 多用户、细粒度权限、外部身份提供商和多实例共享会话。
- 内建 HTTPS、证书自动续期、管理后台中的密钥轮换 UI。
- 面向非浏览器客户端的独立 API token 体系。

---

## Context & Research

### Relevant Code and Patterns

- `bin/pi-web.js`：当前唯一 npm `spi` 入口，解析端口/hostname/代理参数并直接启动 Next；适合收口正式启动语义。
- `package.json`：`start` 仍直接执行 `next start -p 62666`，`dev` 直接执行 `next dev`；需避免这些官方入口绕开安全默认。
- `instrumentation.ts`：Node 服务进程启动钩子，已有“先安装安全基础设施、再启动 Automation”的模式；服务器认证初始化必须放在 Automation 之前，且失败时不能像 Automation 一样吞错继续。
- `lib/browser-pairing.ts`：已有 CSPRNG、salted verifier、`timingSafeEqual`、只展示一次 secret、`0o600` 临时文件 + 原子 rename、损坏状态处理模式。认证状态可复用其风格，但损坏时必须 fail closed，不能自动重置为开放状态。
- `lib/automation-local-access.ts`：已有 HttpOnly/SameSite cookie、常量时间比较、请求来源与控制会话检查；新增全局认证必须与其叠加，而不是替代。
- `components/AppShell.tsx`：应用级操作入口集中地，适合加入“退出登录”；解锁页不应挂载整个 AppShell。
- `components/I18nProvider.tsx`、`lib/i18n/messages/*`、`app/globals.css`：解锁页需复用现有 zh/en、主题语义 Token、焦点与响应式约定。
- `hooks/useAgentSession.ts`、`components/FileViewer.tsx`、`components/ModelsConfig.tsx`：大量普通 fetch 与 EventSource 均为 same-origin；HttpOnly cookie 会自动覆盖这些调用，无需逐个注入前端 token。
- `scripts/smoke-runtime-packaging.ts` 与现有 `scripts/smoke-*.ts`：仓库偏好无测试框架的确定性 smoke；新功能需同时增加纯域测试、Proxy 路径测试和真实生产服务 E2E。
- `docs/deployment/README.md` 与 `AGENTS.md` 声明存在 `ecosystem.config.cjs`，但仓库当前实际缺少该文件；本计划恢复一个与新安全语义一致的单进程 PM2 配置，而不是继续保留失效文档。
- `docs/solutions/` 当前不存在，没有可继承的项目内认证复盘。

### External References

- Next.js 16 官方认证指南：Proxy 适合集中预过滤，但 Route Handlers 仍应视作公开端点；cookie 应设置 HttpOnly、Secure（HTTPS）、SameSite、期限与 Path。
- Next.js 16 官方 Proxy 文档：根目录 `proxy.ts` 在路由渲染前运行，可直接返回 API `401` 或页面 redirect；matcher 需要静态常量并应测试静态资源/公开路径排除。
- Next.js 2026-07 安全公告：16.2 分支应至少升级至 16.2.11，其中包含 App Router Proxy 绕过与多项 DoS/SSRF 修复。
- OWASP Authentication Cheat Sheet：凭据比较需避免时序差异，登录错误保持泛化，实施登录限流，并优先使用 TLS。
- OWASP Password Storage Cheat Sheet：访问凭据只保存 salted adaptive hash；Node 内建 scrypt 可在不增加认证框架依赖的情况下满足首版。
- OWASP Session Management Cheat Sheet：会话 ID 使用 CSPRNG，不放入 URL；cookie 使用 HttpOnly、SameSite、合理有效期和 HTTPS 下的 Secure；退出与到期需服务端失效，日志不得记录原始令牌。

---

## Key Technical Decisions

- **状态文件：** 在 Agent 数据目录新增独立 `server-access.json`，不写入 `pi-web.json`，避免设置 UI 意外读取或回写安全材料。状态包含版本、scrypt 参数/salt/verifier、凭据代次，以及有界的会话 hash/到期时间；不保存明文访问密钥或明文会话令牌。
- **访问密钥：** 首次/轮换生成 32 字节 CSPRNG base64url 值。使用 Node 内建 scrypt 生成 salted verifier，并将算法与 work factor 写入版本化状态，便于未来升级；参数以目标机器单次验证显著低于 1 秒为验收边界。
- **会话模型：** 使用 32 字节随机 opaque cookie；服务端只持久化 SHA-256 hash、绝对到期时间与 credential generation。这样可以跨重启验证、在 logout 时服务端删除单个会话、在轮换时一次清空全部会话，并避免自制 JWT/JWE。
- **会话上限：** 启动与登录时清理过期项，并对活动会话数量设置小型硬上限（建议 64）；超限时淘汰最早到期项，防止状态文件无界增长。
- **状态写入：** 同一进程内串行化登录/退出/轮换写入；同目录临时文件、flush/close、原子替换并尽力收紧到 `0o600`。损坏、缺字段或权限失败在服务器模式下均 fail closed；仅显式轮换/恢复操作可以重建损坏状态。
- **全局门禁：** 根目录 `proxy.ts` 是所有页面/API/SSE 的实例级网络门禁；服务器模式下每次受保护请求验证真实会话，而非只检查 cookie 是否存在。将 Next.js 升级到安全补丁版本，并用 route inventory + 生产 E2E 防止 matcher 漏洞。当前应用没有 Server Actions；后续若新增，仍须在 Action 内显式验证。
- **匿名面最小化：** 仅允许 `/unlock`、登录/退出 Route Handlers 和解锁页需要的静态 chunk/logo。页面匿名请求重定向到固定 `/unlock`，不把原始项目路径/query 放入 redirect URL；API/SSE 返回无业务数据的 `401`。
- **Cookie：** 固定 7 天绝对期限，不滑动续期；`HttpOnly; SameSite=Strict; Path=/`，不设置 Domain。有效 HTTPS 下设置 Secure；因首版允许 HTTP，cookie 名不使用要求 Secure 的 `__Host-` 前缀。
- **代理信任：** 默认忽略 `X-Forwarded-*`。只有显式 `PI_WEB_TRUST_PROXY=1` 且后端绑定回环地址时，才使用规范化的 `X-Forwarded-Proto` 判断外部 HTTPS/cookie Secure；不从转发头推导认证本身。
- **登录限流：** 登录 Route Handler 维护进程内、无永久锁死的短窗口限流：有效客户端桶与全局桶叠加；默认不信任转发 IP。响应统一为泛化错误，超限用 `429` + bounded `Retry-After`。重启重置限流状态是首版接受的单实例行为。
- **启动入口：** `spi` 默认 hostname 改为 `127.0.0.1`，不再把通用系统 `HOSTNAME` 当作用户授权的监听配置；新增显式 `PI_WEB_HOSTNAME`。`--server` 默认监听 `0.0.0.0`，任何显式非回环 hostname 自动设置 `PI_WEB_SERVER_MODE=1`。`npm run start` 与 `npm run dev` 复用同一 launcher 解析层，PM2 使用同一入口并固定单进程。
- **轮换：** `spi --server --rotate-access-key`（或与显式非回环模式组合）在请求可达前轮换并只打印新密钥；本地免认证模式单独使用该参数应拒绝并给出说明。
- **HTTP 策略：** 不阻止 HTTP，但服务器启动输出和解锁页都显示“仅访问控制、无传输加密”的明确警告；受信任代理声明 HTTPS 时解锁页不显示错误的明文警告。

---

## Open Questions

### Resolved During Planning

- 等价环境变量：使用 `PI_WEB_SERVER_MODE=1`、`PI_WEB_HOSTNAME=<host>`、`PI_WEB_TRUST_PROXY=1`；保留 `PORT`，停止把系统 `HOSTNAME` 当作隐式监听授权。
- 密钥轮换入口：`--rotate-access-key`，必须与服务器认证模式同时生效；不提供明文 `--access-key` 参数。
- 持久化会话：使用服务端 opaque session registry，而不是仅删除 cookie 的 stateless token，从而满足 logout/rotation 的服务端失效语义。
- Proxy 覆盖：升级至已修复版本后，以根 `proxy.ts` 作为实例门禁，并通过动态 route inventory 与真实服务 E2E 验证所有入口；不在上百个现有 Route Handler 中复制相同检查。
- HTTPS 识别：默认只信任请求自身协议；显式 trusted-proxy 模式才读取 forwarded proto，且要求后端回环绑定。
- 限流状态：首版进程内、有界、可重启恢复，不写入安全状态文件，避免高频攻击造成磁盘写放大。

### Deferred to Implementation

- scrypt 的最终 N/r/p 与 `maxmem`：在 Node 22 目标环境基准后选择 OWASP 推荐组合中低于 1 秒的一档，并把参数固化进状态与测试。
- Windows 上现有文件原子替换/权限收紧的最终系统调用细节：保持 fail closed，并在烟测和 Windows 手工验证中确认行为。
- Next.js 生产输出中静态 chunk 的最小 allowlist：先以解锁页实际依赖为准，不能为了缩小匿名面而导致 hydration/CSS 失败。

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
flowchart TD
  A[官方 launcher] --> B{启动意图}
  B -->|默认/回环| C[127.0.0.1 + auth off]
  B -->|--server / 非回环 / env| D[auth on]
  D --> E[instrumentation 初始化 server-access.json]
  E -->|首次/轮换| F[终端只展示一次访问密钥]
  E --> G[Next.js Proxy]
  G -->|公开解锁资源| H[/unlock + auth routes]
  G -->|无有效会话的页面| I[redirect /unlock]
  G -->|无有效会话的 API/SSE| J[401 no-store]
  G -->|有效 opaque session| K[现有页面/API/SSE]
  H --> L[scrypt 验证 + 限流]
  L -->|成功| M[持久化 session hash + Set-Cookie]
  M --> K
  K --> N[logout 删除 session hash]
  E --> O[rotation 清空全部 session hash]
```

### 启动决策矩阵

| `--server` / env | hostname | 监听结果 | 全局认证 |
| --- | --- | --- | --- |
| 否 | 未指定 | `127.0.0.1` | 关闭 |
| 否 | 回环地址/localhost | 指定回环地址 | 关闭 |
| 否 | `0.0.0.0`、`::`、LAN/DNS | 指定地址 | 自动开启 |
| 是 | 未指定 | `0.0.0.0` | 开启 |
| 是 | 任意地址（含回环） | 指定地址 | 开启 |

---

## Implementation Units

### Phase 1 — 安全基础与状态域

- [x] U1. **升级 Next.js 安全补丁基线**

**Goal:** 在引入 Proxy 认证前将 Next.js 16.2 从 16.2.9 升级到至少 16.2.11，并保持 lint 插件版本一致，消除已公告的 Proxy 绕过与相邻高风险漏洞基线。

**Requirements:** R5, R12；支持 AE4 的门禁可信度。

**Dependencies:** None

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `bun.lock`
- Test: `scripts/smoke-runtime-packaging.ts`

**Approach:**
- 同步升级 `next` 与 `eslint-config-next` 的 16.2 安全补丁版本，不跨到 16.3 preview/canary。
- 在 runtime smoke 中断言 Next 版本不低于认证功能要求的安全基线，防止后续 lockfile 回退。
- 保持 `scripts/build-next.js` 的 webpack release build 约定不变。

**Patterns to follow:**
- `package.json` 的精确版本锁定。
- `scripts/smoke-runtime-packaging.ts` 的发布不变量断言。

**Test scenarios:**
- Happy path：安装后的 Next 版本满足 16.2.11+ 且 `next start --help` 仍支持预期 port/hostname 参数。
- Regression：runtime smoke 在 package/installed version 回退到 16.2.9 时明确失败。
- Integration：现有 lint、类型检查、runtime smoke 和 release build 在补丁升级后保持通过。

**Verification:**
- 依赖树只发生预期的 Next 16.2 补丁升级；现有构建和运行时不变量不变。

---

- [x] U2. **实现访问密钥与持久会话安全域**

**Goal:** 提供与 Next/UI 解耦的版本化认证状态、密钥生成/验证、session 生命周期、轮换、限流和安全写入能力。

**Requirements:** R5–R10, R13–R15, R19；F2–F4；AE5、AE6。

**Dependencies:** U1

**Files:**
- Create: `lib/server-access-auth.ts`
- Create: `scripts/smoke-server-access-auth.ts`
- Modify: `docs/modules/library.md`

**Approach:**
- 解析 `PI_CODING_AGENT_DIR` 并将状态固定在 `server-access.json`；严格验证 schema version、算法参数、hash 编码、代次、会话上限和到期时间。
- 首次初始化返回一次性明文 key 给启动层，持久化仅保留 scrypt verifier；正常读取永不返回可恢复明文。
- 会话使用随机 opaque token，状态仅保存 token hash；创建、验证、退出、过期清理与 credential rotation 走单一模块。
- 所有持久化变更采用串行队列和原子写；损坏状态抛出稳定错误，不自动开放、不静默生成新密钥。
- 限流单独保存在有界进程内 store，测试可注入时间；不将原始 IP、访问密钥或 session token 写日志。

**Execution note:** 先用临时 Agent 目录补齐失败测试，再实现持久化和生命周期；该域是后续所有入口的安全根。

**Patterns to follow:**
- `lib/browser-pairing.ts` 的 CSPRNG、salt/verifier、常量时间比较、原子写和只展示一次 secret。
- `lib/automation-local-access.ts` 的 cookie/安全错误风格与测试可控时钟。
- `lib/automation-paths.ts` 的本地 Agent 数据目录解析方式。

**Test scenarios:**
- Covers F2 / AE2. 空目录初始化生成高熵 key，文件中不存在该明文，第二次初始化不再返回 key。
- Happy path：正确 key 通过 scrypt 验证；错误、空值、超长输入均返回同一类失败且不泄漏 verifier 信息。
- Covers F3 / AE5. 创建 7 天 session 后重新加载模块/状态仍可验证，超过绝对期限立即失效且不滑动续期。
- Covers F4 / AE6. logout 删除指定 session；轮换后旧 key、全部旧 session 都失效，新 key 可登录。
- Edge case：活动 session 达上限时只保留有界集合并按规则淘汰；过期项在启动/登录时清理。
- Error path：malformed JSON、未知 schema、缺 verifier、权限/rename 失败均 fail closed，原文件不被自动清空。
- Security：候选 hash 长度不一致不会抛错；比较路径使用安全比较；日志/错误对象不含 key/token。
- Rate limit：客户端桶与全局桶分别触发 `429`，窗口后恢复，无永久锁死；成功登录不绕过全局限制。
- Platform：临时文件与最终文件权限在支持 POSIX mode 的平台为 owner-only，Windows 路径可原子替换或明确失败。

**Verification:**
- 认证域可在纯 Node smoke 中独立证明首次生成、重启、logout、rotation、损坏状态和限流行为，不依赖 Next.js。

### Phase 2 — 启动语义与全局门禁

- [x] U3. **统一 CLI、npm、dev 与 PM2 启动语义**

**Goal:** 让所有官方入口默认回环监听，并把 server/non-loopback/rotation/trusted-proxy 意图可靠传入 Next 运行时。

**Requirements:** R1–R5, R7, R10, R16–R17；F1–F4；AE1–AE3、AE7。

**Dependencies:** U2

**Files:**
- Create: `bin/runtime-options.js`
- Create: `ecosystem.config.cjs`
- Modify: `bin/pi-web.js`
- Modify: `package.json`
- Modify: `instrumentation.ts`
- Modify: `scripts/smoke-runtime-packaging.ts`
- Test: `scripts/smoke-runtime-packaging.ts`
- Test: `scripts/smoke-server-access-auth.ts`

**Approach:**
- 将纯参数/hostname 分类提取到可测试的 CommonJS 模块，兼容已发布 `npx` 环境；识别 localhost、IPv4/IPv6 loopback、wildcard 与非回环 DNS 名称。
- `spi` 默认显式传 `-H 127.0.0.1`；`--server` 无 hostname 时传 `0.0.0.0`；非回环 hostname 自动注入服务器模式。
- 增加 `--rotate-access-key`、`--no-open` 与清晰 help；服务器模式默认不自动打开远程机器浏览器，普通 `spi` 保持现有自动打开体验。
- `npm run start` 与 `npm run dev` 通过同一 launcher（dev 跳过 `.next` 检查），避免直接 Next CLI 绕过；保留 `PORT`，用 `PI_WEB_HOSTNAME` 替代通用 `HOSTNAME`。
- `instrumentation.ts` 在 Automation scheduler 前初始化/轮换认证状态。服务器模式失败必须向上抛出终止启动；本地模式不创建认证文件。
- 新 PM2 配置固定单实例、`--server --no-open` 与回环 backend，供 HTTPS 反向代理使用；直接 LAN 监听作为文档化替代参数。

**Patterns to follow:**
- `bin/pi-web.js` 当前不使用 `shell: true`、直接解析 Next CLI 路径、代理环境透传和信号转发的约束。
- `instrumentation.ts` 的 Node-runtime register 入口，但认证失败策略与可降级 Automation 明确分开。

**Test scenarios:**
- Covers F1 / AE1. 无参数得到 `127.0.0.1`、认证关闭、普通模式允许自动开浏览器。
- Covers F2 / AE2. `--server` 得到 `0.0.0.0` + auth env；`-H 0.0.0.0` 即使无 `--server` 也自动 auth。
- Covers AE3. `--server -H 127.0.0.1` 保持回环监听但认证开启，适合反向代理。
- Edge case：`localhost`、`127.0.0.2`、`::1` 归类本地；`::`、LAN IP、DNS hostname 归类服务器。
- Error path：本地模式单独传 rotation 被拒绝；认证初始化失败使进程退出而非继续 Ready。
- Compatibility：port、HTTP/SOCKS/no-proxy、NODE_OPTIONS、signal forwarding 与 `--no-open` 行为保持。
- Packaging：发布包包含新的 runtime options 与 PM2 配置，launcher 仍不使用 shell。

**Verification:**
- 所有文档化入口都经过同一模式决策；无法通过 `--hostname`、npm script 或 PM2 示例获得未认证非回环服务。

---

- [x] U4. **增加认证 Route Handlers 与 Next.js Proxy 全局门禁**

**Goal:** 在服务器模式下统一保护页面、普通 API、SSE 和文件深链，并建立解锁/退出 cookie 生命周期。

**Requirements:** R5, R8, R10–R18；F2–F4；AE2–AE8。

**Dependencies:** U2, U3

**Files:**
- Create: `proxy.ts`
- Create: `app/api/server-auth/login/route.ts`
- Create: `app/api/server-auth/logout/route.ts`
- Create: `lib/server-access-policy.ts`
- Create: `scripts/smoke-server-access-proxy.ts`
- Modify: `docs/modules/api.md`
- Modify: `docs/modules/library.md`
- Test: `scripts/smoke-server-access-proxy.ts`

**Approach:**
- 将模式判断、公开路径分类、页面/API 响应策略、same-origin 检查、有效 HTTPS 判定和 cookie options 放在纯 policy 模块，供 Proxy 与 Route Handlers 共用。
- Proxy 在 auth off 时零状态访问地放行；auth on 时读取并验证服务端 session state。状态缺失/损坏返回 `503` fail closed，绝不当作本地模式。
- 页面无 session 时固定 redirect `/unlock`；`/api/**`（包括 SSE、range/file preview、OAuth EventSource）返回 JSON 或纯文本 `401`，不 redirect HTML。
- 匿名 allowlist 只含 `/unlock`、登录/退出 API 和实际解锁静态依赖；不得公开 `/api/home`、`/api/models`、session/file/git/workflow 等探测面。
- 登录仅接受 POST JSON，限制 body/key 长度，执行 origin/referer 一致性与限流，成功创建 server-side session 并设置 7 天 cookie；失败使用泛化错误。
- logout 接受 POST，删除当前 server session hash 和 cookie；无效/过期 cookie 也能幂等清理。
- 未认证与 auth 响应使用 `Cache-Control: no-store`；认证页面/API 不改变现有业务状态码与 body。

**Execution note:** 从 Proxy matcher 与 API/SSE `401` 的失败测试开始；安全门禁不能仅靠 UI 验证。

**Patterns to follow:**
- `lib/automation-api.ts` / `lib/automation-local-access.ts` 的稳定安全错误、same-origin 和 cookie 响应方式。
- Next.js 16 官方 `proxy.ts`、`NextRequest`、`NextResponse` 与 `next/experimental/testing/server` 测试工具。

**Test scenarios:**
- Covers AE4. 无 cookie 请求 `/`、`/file?...`、legacy file route均进入 `/unlock`，redirect 不回显原始绝对路径/query。
- Covers AE4. 无 cookie 请求每个可实例化的 `app/api/**/route.ts` 路径都命中 Proxy 并返回 `401`；代表性 Agent SSE 与 file watch SSE 也不建立 stream。
- Happy path：正确 key 登录返回 cookie；携带 cookie 的普通页面/API/SSE 继续得到下游原始响应。
- Error path：错误 key、超长 body、错误 content type、跨站 Origin、达到限流阈值分别得到稳定 `4xx`，且无 key/verifier/session 泄漏。
- Session：logout 后同一 cookie 立即失效；到期/未知/篡改 token 为 `401`；rotation 后旧 cookie 为 `401`。
- Fail closed：auth mode 开启但状态缺失/损坏时，业务页面和 API 均不可达，仅恢复指引可见于服务日志。
- Public surface：解锁页、所需 CSS/JS/logo可加载；其他 public/Next 优化入口没有项目数据泄漏。
- Covers AE8. 已通过全局认证的远程请求仍被 Automation 与 native picker 原有 local-only gate 拒绝。
- Proxy regression：`unstable_doesProxyMatch` 与 route inventory 证明动态 API、RSC/data 请求和 metadata 页面不会绕过 matcher。

**Verification:**
- 在合成请求测试中，匿名用户无法触达任何业务 Route Handler；认证用户不需要修改现有 fetch/EventSource 调用即可继续工作。

### Phase 3 — 解锁体验与应用操作

- [x] U5. **实现双语解锁页、HTTP 警告与退出入口**

**Goal:** 提供独立、可访问、与现有主题一致的 Web 解锁体验，并允许已登录用户主动退出。

**Requirements:** R9, R11, R13–R17；A1、A2；F2–F4；AE2、AE5–AE7。

**Dependencies:** U4

**Files:**
- Create: `app/unlock/page.tsx`
- Create: `components/ServerUnlockForm.tsx`
- Create: `lib/i18n/messages/access.ts`
- Modify: `lib/i18n/messages/index.ts`
- Modify: `components/AppShell.tsx`
- Modify: `app/globals.css`
- Modify: `docs/modules/frontend.md`
- Test: `scripts/check-i18n-keys.ts`
- Test: `scripts/smoke-server-access-proxy.ts`

**Approach:**
- 解锁页只挂载 `I18nProvider` 和轻量表单，不加载 AppShell、session sidebar 或项目 fetch；复用 logo、语义 Token、现有 focus/响应式/减弱动画规则。
- password input 支持粘贴与密码管理器，不回显 key；提交中禁用重复发送；错误、限流剩余时间和 HTTP 风险均使用 zh/en catalog。
- 成功后使用 replace 导航到 `/`，不在 URL/localStorage 中保存 key 或 session。
- 页面根据可信的 effective protocol 展示 HTTP 强警告；trusted proxy 声明 HTTPS 时使用 Secure cookie 并不误报。
- 在 AppShell overflow/application actions 增加“退出登录”；local auth-off 模式可隐藏该项，server mode 下 POST logout 后 replace 到 `/unlock`。

**Patterns to follow:**
- `components/I18nProvider.tsx`、`lib/i18n/messages/index.ts` 的双语 catalog 与 fallback。
- `components/ui/SettingsPrimitives.tsx`、`.pi-modal-*` 和 `app/globals.css` 的语义表单、焦点、移动端与 reduced-motion 约定；解锁页可使用专用类但不能硬编码 palette。
- `components/AppShell.tsx` 的 application overflow action 组织方式。

**Test scenarios:**
- Covers F2 / AE2. 首次打开服务器 URL 显示解锁表单，正确 key 进入应用，错误 key 显示泛化错误且保留可重试状态。
- Covers AE7. HTTP 直连显示中英文风险警告；可信 HTTPS proxy 语义下不显示明文传输警告且 cookie 为 Secure。
- i18n：zh/en key 完全对齐；浏览器语言/已存 locale 驱动标题、label、错误、按钮和警告。
- Accessibility：表单 label 关联、错误状态可读、初始焦点合理、Enter 提交、disabled/loading 明确、移动端无横向溢出。
- Logout：server mode 显示退出操作，点击后返回解锁页；local auth-off 不增加无意义操作。
- Privacy：DOM、URL、localStorage/sessionStorage、console 中均不出现访问密钥或 session token。

**Verification:**
- 解锁页在 CSS/JS 最小匿名 allowlist 下完整工作；AppShell 只在成功认证后加载并发起业务请求。

### Phase 4 — 生产级回归、文档与交付

- [x] U6. **增加真实生产服务认证回归矩阵**

**Goal:** 用构建后的真实 Next 服务证明启动、Proxy、cookie、SSE、重启与轮换端到端语义，而不只依赖纯函数测试。

**Requirements:** R1–R19；F1–F4；AE1–AE8。

**Dependencies:** U1–U5

**Files:**
- Create: `scripts/e2e-server-access-auth.mjs`
- Modify: `package.json`
- Modify: `scripts/smoke-runtime-packaging.ts`
- Modify: `docs/standards/code-style.md`
- Test: `scripts/e2e-server-access-auth.mjs`

**Approach:**
- 增加快速 `test:server-auth`（纯域 + Proxy + launcher smoke）和 build 后运行的 `test:server-auth:e2e`。
- E2E 使用临时 Agent 数据目录和随机空闲端口，启动发布 launcher，捕获一次性 key，不读取明文状态，使用真实 HTTP client 管理 cookie。
- 每个子进程设置硬超时并确保 teardown；日志断言只匹配标记，不把 key 回显到测试失败输出。
- 将该安全 E2E 纳入 release/publish 验证顺序：安全 smoke 在 build 前，真实 E2E 在 build 后。

**Test scenarios:**
- Covers AE1. 默认 launcher 参数为回环且无 auth 文件；通过 launcher parser 与真实 socket 验证非回环不可达。
- Covers AE2 / AE4. 服务器模式首次输出一次 key；匿名页面 redirect、API/SSE `401`；正确登录后 `/api/home` 可达。
- Covers AE5. 停止并用相同 Agent 目录重启：stdout 不再含 key，原 cookie 在 7 天内继续有效。
- Covers AE6. 以 rotation 重启：输出新 key，旧 cookie 与旧 key 失效，新 key 可登录。
- Covers AE7. HTTP 解锁 HTML 含风险提示；cookie 没有错误地设置 Secure 而导致 HTTP 无法使用。
- Covers AE3. trusted-proxy + loopback backend + `X-Forwarded-Proto: https` 时 cookie 带 Secure；未开启 trust 时伪造头不改变 cookie 属性。
- Covers AE8. 认证 cookie 不绕过 Automation/native picker local-only 拒绝。
- Failure：损坏状态文件后进程不进入可用 Ready 或所有业务请求为 fail-closed，且日志给出轮换恢复指引。

**Verification:**
- 真实 `.next` 生产服务完整通过 AE1–AE8；测试结束无残留 child process、临时状态或占用端口。

---

- [x] U7. **更新部署、安全边界与恢复文档**

**Goal:** 让本地、Nginx/Caddy、PM2、容器和故障恢复用户都能按同一安全模型操作，不再误以为默认 `localhost` URL 等于回环监听。

**Requirements:** R1–R4, R7, R9–R10, R16–R19；A1；AE1–AE3、AE5–AE8。

**Dependencies:** U3–U6

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/deployment/README.md`
- Modify: `docs/operations/troubleshooting.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/modules/api.md`
- Modify: `docs/modules/frontend.md`
- Modify: `docs/modules/library.md`
- Modify: `docs/plans/README.md`
- Modify: `AGENTS.md`
- Modify: `package.json`
- Modify: `ecosystem.config.cjs`
- Test expectation: none — 该单元为文档/运维契约；命令和文件存在性由 U3/U6 runtime smoke 覆盖。

**Approach:**
- CLI 示例覆盖默认本地、`--server`、反向代理回环 backend、显式 LAN、rotation、trusted proxy 和 data-dir 持久化。
- 明确 HTTP 只能提供访问控制而非传输加密，公网推荐 Caddy/Nginx HTTPS；forwarded headers 仅在显式 trust 且回环 backend 时可信。
- 数据表新增 `server-access.json`，说明只含 verifier/session hash、首次 key 不可恢复、遗失需轮换、备份/权限注意事项。
- 故障排查覆盖：key 未打印/遗失、状态损坏、cookie 在 HTTP/HTTPS 下不生效、反向代理循环 redirect、429、rotation 后全员退出、容器未持久化 Agent 目录。
- 架构文档登记“Proxy 为实例门禁、local-only 仍叠加”的不变量；模块文档登记新 routes/component/lib；AGENTS 快速入口和测试命令同步。
- PM2 配置与文档只声明单进程支持；不得继续描述不存在或不安全的默认配置。

**Verification:**
- 新用户可只根据文档完成安全本地启动、HTTPS 反向代理服务器部署与密钥轮换；所有示例与 launcher 实际帮助一致。

---

## Phased Delivery

1. **Phase 1（U1–U2）**：先建立安全补丁基线和可独立验证的认证状态域，不改变现有网络行为。
2. **Phase 2（U3–U4）**：统一官方启动入口并接入全局门禁；此阶段必须作为一个可发布整体完成，避免“server flag 已出现但 API 未全保护”的中间版本。
3. **Phase 3（U5）**：补齐解锁/退出 UI 与 i18n，在不改变安全域的前提下完善体验。
4. **Phase 4（U6–U7）**：以生产 E2E 封口，再更新发布、运维和恢复文档。

---

## System-Wide Impact

- **Interaction graph:** launcher 决定 env/hostname → instrumentation 初始化安全状态 → Proxy 验证 cookie → auth Route Handler 创建/删除持久 session → AppShell/所有现有 fetch/EventSource 在同源 cookie 下继续工作。
- **Error propagation:** 本地 auth-off 不触碰状态；服务器初始化错误必须阻断 Ready；运行期状态损坏由 Proxy 返回 `503`；凭据错误为泛化 `401`；限流为 `429`；下游业务错误保持原样。
- **State lifecycle risks:** 首次生成、并发登录/logout、过期清理、Windows 原子替换、rotation 与 process restart 都会触碰同一安全状态；通过单进程序列化、原子文件与 E2E 控制。
- **API surface parity:** 根页面、`/file`、legacy redirect、全部 `app/api/**`、SSE/EventSource、range/media preview 都必须命中同一门禁；Chrome loopback WebSocket bridge不经过该 HTTP cookie，保持原有 pairing。
- **Integration coverage:** 纯域测试证明密码学/状态；Proxy 测试证明路径分类；真实 build E2E 证明 Next runtime、Set-Cookie、restart 和 rotation，三层缺一不可。
- **Unchanged invariants:** AgentSession wrapper/fork/session JSONL、changed-file sidecar、Automation control session/approval、native picker remote-address gate、browser pairing、模型供应商 `app/api/auth/**` 均不改语义；服务器模式只在它们之前增加实例认证。
- **Performance:** authenticated 请求会读取一个小型有界状态文件并 hash session token。首版优先强一致 logout/rotation，不做可能延迟失效的长期缓存；E2E/手工验证需观察 SSE 与高频文件请求的开销，如有必要仅做基于可靠文件 revision 的短生命周期解析缓存。
- **Operations:** 默认 hostname 变化会让曾经依赖隐式 LAN 暴露的用户无法远程访问；这是有意的 breaking security correction，发布说明必须给出 `--server` 迁移路径。

---

## Alternative Approaches Considered

- **仅在 Nginx/Caddy 配 Basic Auth：** 实现最少，但无法保护直接运行 `spi`/PM2 的用户，也无法统一首次生成、会话、logout 和 rotation；不满足安全默认。
- **HTTP Basic Auth 内建：** 可保护所有请求，但浏览器退出/轮换体验差，凭据会在每次请求重复发送，难以实现 7 天服务器会话语义。
- **使用 Auth.js/外部认证库：** 对多用户/OIDC 合理，但首版没有用户数据库或外部 IdP；会引入超出单共享 key 目标的 schema、callback 和运维复杂度。
- **只使用 stateless signed cookie：** 跨重启简单，但单次 logout 无法服务端撤销被复制的 cookie，除非引入 denylist；有界 server-side opaque session registry更贴合明确需求。
- **每个 Route Handler 手工调用认证：** 防御接近数据，但当前 API 路由数量大、易漏且未来新增路由仍靠人工。选择 patched Next Proxy 作为实例级统一边界，并用 route inventory/真实 E2E 加固；未来 Server Actions 仍需局部检查。
- **自建 Node 反向代理包住 Next：** 可以在框架外拦截所有 HTTP，但会增加端口转发、流式/SSE、range、header 与生命周期复杂度，并让 npm/PM2 部署更难维护。

---

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Proxy matcher/框架漏洞导致绕过 | Low after patch | Critical | U1 升级 16.2.11+；全 API inventory；真实生产 E2E；auth 状态异常 fail closed。 |
| HTTP 上 key/cookie 被窃听 | Medium | Critical | CLI + 解锁页强警告；推荐 HTTPS proxy；Secure cookie 在可信 HTTPS 下强制；文档不宣称 HTTP 安全。 |
| forwarded headers 被伪造 | Medium | High | 默认完全不信任；仅显式 trust + 回环 backend；不让 forwarded headers决定是否需要认证。 |
| 状态文件损坏或部分写 | Low | High | 串行原子写、严格 schema、启动阻断、显式 rotation 恢复、临时目录故障测试。 |
| logout/rotation 后旧 session 短暂可用 | Low | High | 每请求读取当前有界状态或可靠 revision；不采用无法即时撤销的长缓存/stateless-only cookie。 |
| 登录限流被利用造成自我 DoS | Medium | Medium | 无永久 lock；客户端 + 全局短窗口；有界 Retry-After；高熵 key 使阈值无需激进。 |
| PM2 多进程并发写状态 | Medium if misconfigured | High | 官方配置单实例 fork；启动检查/文档拒绝 cluster；多实例明确超出范围。 |
| Next 补丁升级引发构建/运行回归 | Low | Medium | 锁定同 minor 安全补丁；lint/tsc/runtime/build/现有 smokes + 新 E2E。 |
| 状态文件读取影响高频 SSE/API | Low | Medium | 状态严格有界；先测量；只允许不会延迟 logout/rotation 的 revision cache。 |
| 用户丢失首次 key | Medium | Medium | 明确只展示一次；提供 rotation；故障文档给出恢复流程，不保存可恢复明文。 |

---

## Documentation / Operational Notes

- 发布说明需突出：默认 hostname 从 Next 隐式 `0.0.0.0` 改为 `127.0.0.1`；远程访问必须改用 `--server` 或等价 env。
- HTTPS 反向代理示例必须让 Next backend 绑定回环，并显式启用 server mode；不能把“代理来自 loopback”误判为本地免认证。
- 容器/PM2 必须持久化 `PI_CODING_AGENT_DIR`；否则 key 与 7 天 session 无法跨重启。
- 首次 key 可能进入 PM2/systemd 日志。文档应要求限制日志访问，并建议首次启动后立即安全保存；正常重启不重复打印。
- rotation 属于高风险运维操作：必须清晰打印“全部会话已失效”，但不能打印旧 key 或 session 标识。
- 发布验证至少包括 `npm run lint`、`node_modules/.bin/tsc --noEmit`、`npm run test:server-auth`、现有受影响 smoke、`npm run build`、`npm run test:server-auth:e2e`；release build 仍只能使用 `npm run build`。

---

## Sources & References

- **Origin document:** [`docs/brainstorms/2026-08-07-server-access-authentication-requirements.md`](../brainstorms/2026-08-07-server-access-authentication-requirements.md)
- Related code: `bin/pi-web.js`, `instrumentation.ts`, `lib/browser-pairing.ts`, `lib/automation-local-access.ts`, `app/api/**`, `components/AppShell.tsx`
- [Next.js Authentication Guide](https://nextjs.org/docs/app/guides/authentication)
- [Next.js Proxy file convention](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Next.js July 2026 Security Release](https://nextjs.org/blog/july-2026-security-release)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
