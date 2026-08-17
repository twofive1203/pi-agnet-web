---
title: "feat: Desktop pet needs_input response channel (design + phased gate)"
type: feat
status: deferred
date: 2026-08-14
origin: docs/plans/2026-08-14-001-feat-desktop-pet-competitive-optimization-plan.md
architecture: docs/architecture/decisions/desktop-pet-needs-input-response.md
requirements: docs/brainstorms/2026-08-14-desktop-pet-needs-input-response-requirements.md
---

# feat: Desktop pet needs_input response channel

## Status

**deferred**。ADR `docs/architecture/decisions/desktop-pet-needs-input-response.md` 判定为 **No-go（当前协议下）**：extension UI request payload 没有非敏感的结构化安全摘要来源，`title/message/options/prefill` 是扩展作者任意字符串且常内嵌命令/路径/Prompt。因此当前不实现任何桌面批准/拒绝/输入/全局热键/新写 API；桌宠继续“提示 + 打开 WebUI”。

本计划只记录**有条件的分阶段路径**：Phase 0 是当前唯一允许的、不触碰运行时代码的协议验证与纯领域模型工作；Phase 1–2 以“安全摘要来源出现并通过独立安全评审”为硬门禁。

## Scope

- **In scope（本计划允许）:** Phase 0 的纯领域模型与协议可行性验证（无 TypeScript/route/IPC/preload/renderer 改动）。
- **Out of scope（本计划禁止，直至重新评审）:** 桌面批准/拒绝/输入/editor、全局热键、任何新写 API、扩展 observer payload、可运行授权原型、声称已通过安全评审。

## Phases

### Phase 0 — 协议验证与纯领域模型（唯一当前允许）

**目标:** 用事实确认“是否存在安全摘要来源”，并沉淀可复用的领域模型，避免未来在错误假设上实现。

**工作项:**

1. 建立纯领域类型（不接线）：`DesktopControlCapability`（不可猜测、短期、单次、绑定 `instanceId/sessionId/activityId/requestId`）、`DesktopControlSummary`（服务端派生、非敏感、结构化）、`DesktopControlResponse`（有限枚举：`confirm:approve` / `confirm:reject` / `fallback`）。
2. 用 fixture 验证“从当前 extension_ui_request 派生安全摘要”在所有真实扩展样本（`permission-gate`、`confirm-destructive`、`question`、`questionnaire`、`timed-confirm`）上**不可行**（title/message 含敏感内容），把结论固化为测试，防止未来回退。
3. 若未来上游 Pi 增加结构化摘要字段，用同一 fixture 定义“安全摘要必须满足的判据”（非敏感、有界、服务端可验证、不透明渲染）。
4. 沉淀 threat fixture：过期、cancel、settled、destroy、并发多端、DND、stale 快照等生命周期矩阵。

**验收:** 纯函数与 fixture 可被 `npm run test:*` 风格 smoke 直接 import；不产生任何运行时接线；文档记录“无安全摘要来源”的负结论。

**门禁:** 无（不触碰运行时，纯设计/验证）。

### Phase 1 — confirm-only + 安全摘要 + 无全局热键（硬门禁后）

**前置条件（必须全部满足，缺一即 No-go）:**

1. 上游 Pi 或 WebUI 侧存在**可验证非敏感的结构化摘要来源**（例如 extension_ui_request 新增 `safeLabel`/`category`/`risk` 并由服务端校验），且通过独立安全评审。
2. ADR 状态从 Proposed 提升为 Accepted（针对 confirm-only 子集）。

**范围（仅当前置满足）:**

- 独立 loopback control API（不复用 observer snapshot），门控强度对齐 `/api/desktop-observer/**`。
- 服务端 capability 注册表：绑定 instance/session/activity/request，单次消费、原子失效。
- Electron main 持有 capability，renderer 只收到有界安全描述 + 有限动作词汇（对已分类 confirm 的 approve/reject）。
- 过期/cancel/settled/destroy/并发响应/WebUI 回退/DND 语义按 ADR §6–8。
- 审计仅记录结构化非敏感字段（ADR §9）。
- 明确**排除** select/input/editor，排除全局热键。

**验收:** capability 生命周期、竞态、过期、DND 静默、回退、审计无敏感字段、renderer 不接收 capability 明文/正文。

### Phase 2 — 实机与攻击面验证

- Windows 实机：capability 过期、服务重启 instance 变化、多端并发、DND、隐藏窗口、通知/托盘。
- 攻击面回归：renderer compromise 模拟（capability 不落 renderer）、跨会话串响应、id 重放、server mode + access key、CSRF。
- 记录未验证风险，不声明“已通过安全评审”。

### 后续（仅重新评审后）

- select/input/editor 桌面表单：需单独评估隐私、表单、焦点、IME、IPC 成本，本计划默认**不进入**。

## Validation

Phase 0 仅做静态链接与 Markdown 检查；不运行无关构建。未来若进入 Phase 1，最低门禁为 `npm run lint`、`node_modules/.bin/tsc --noEmit` 加新增 control API/capability 的专项 smoke，并必须通过独立安全评审。

## Open Decisions

见 ADR “Open Decisions”：上游安全摘要字段、Phase 0 是否授权、审计保留期。
