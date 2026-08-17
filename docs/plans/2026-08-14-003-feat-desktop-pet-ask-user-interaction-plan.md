---
title: "feat: Desktop pet structured ask_user interaction (U5a MVP)"
type: feat
status: active
date: 2026-08-14
origin: docs/brainstorms/2026-08-14-desktop-pet-ask-user-interaction-requirements.md
architecture: docs/architecture/decisions/desktop-pet-ask-user-interaction.md
parent: docs/plans/2026-08-14-001-feat-desktop-pet-competitive-optimization-plan.md
revised: 2026-08-14
---

# feat: Desktop pet structured ask_user interaction (U5a MVP)

## Overview

为「桌宠结构化 ask_user 交互 MVP」独立立项。范围严格限定为**可信 bundled `pi-ask-user` 的单选（`allowMultiple=false`、`allowFreeform=false`、`allowComment=false`、`options.length>0`）+ 取消**，通过**可验证结构化 provenance** 与**独立 loopback 控制 API + 单次 capability** 实现，WebUI 与桌宠 first-response-wins。通用 U5（任意 confirm/select/input/editor）维持 No-go。

本计划**只交付 requirements / ADR / 本计划**，不编写运行时代码。Phase 1–2 以 provenance 落地 + 独立安全评审为硬门禁。

> 命名说明：本计划沿用仓库 `YYYY-MM-DD-NNN-` 编号，取 `2026-08-14-003`。前序 `2026-08-14-002` 是通用 U5 的 deferred 计划。

## Non-Goals（禁止夹带）

- 多选、freeform、comment、无选项自由输入、编辑器形态。
- 任意 extension confirm/select/input/editor 桌面应答、权限审批、危险命令授权、auto-approve。
- 修改 public observer snapshot（`TaskObserverSnapshot`）字段或 8 态契约。
- 修改 `ctx.ui.custom()` RPC 降级语义、全局热键。

## Provenance 定案（Phase 0 前置结论）

- **机制**：patch-package 对 `pi-ask-user@0.13.1` 打补丁，令 `askViaDialogs` 的单选 `ctx.ui.select` 第三参 `opts` 携带结构化 provenance；WebUI `ExtensionWebUiBridge.select/…` 透传到 `extension_ui_request`。并行向上游 `github.com/edlsh/pi-ask-user` 提非阻塞 PR。
- **字段**（严格 schema，服务端校验）：`{ source:"pi-ask-user", kind:"ask_user_select", question, context?, options:[{title,description?}], allowMultiple:false, allowFreeform:false, allowComment:false }`。
- **回退**：若团队拒绝 postinstall 补丁，转 vendor（仓库自有路径加载，同 schema）。
- 详见 ADR「Provenance Mechanism Decision」。

---

## Phase 0 — provenance 与状态机纯领域验证（无运行时代码）

**目标**：在不写生产运行时代码的前提下，先证明 provenance 可行与 capability/first-response-wins 状态机正确。

### 0.1 provenance 形态验证

1. 用纯类型/领域模块描述 `AskUserProvenance` 与 `desktopAnswerable(request)` 判定函数（严格 schema + bundled allowlist 常量）。
2. 枚举 ask_user 各形态（单选/多选/freeform/comment/无选项）与普通 select，验证只有"单选+三 flag 全 false+非空 options"通过。
3. 明确 provenance 仅作为"可信 bundled 包的结构化分类信号"，不是对抗恶意扩展的安全边界（记录于 ADR 威胁模型）。

### 0.2 capability 状态机验证

1. 纯状态机：`PENDING → CONSUMED | EXPIRED | ABORTED | SETTLED | DESTROYED | SUPERSEDED`，消费为原子 compare-and-delete，二次消费 no-op。
2. 用注入时钟模拟：timeout、abort（AbortSignal）、settled、`rejectAll()`、新对话框取消、instance 变化、WebUI 先答 → 桌宠后答（及反向）的全部迁移。
3. 验证 capability 绑定四元组 `instanceId+sessionId+activityId(promptEpoch)+requestId` 不匹配即拒绝。

### 0.3 边界与竞态核对

1. 确认控制 API 与 observer API 边界：observer 只读、不带正文/能力；控制 API 独立 loopback + 短时 token + capability。
2. 确认 WebUI `respond()` 首命中语义与桌宠 consume 的收敛（共享同一 `ExtensionWebUiBridge.respond()`）。
3. 确认 renderer 只收描述符 + 有限动作，capability/observer token/access key 留在 main。

**验收**：纯领域 smoke 通过；无 `app/api`/`desktop`/`lib` 生产运行时改动（除纯类型/常量模块）；ADR 状态仍为 Proposed（未声称已过安全评审）。

---

## Phase 1 — 服务端私有 request broker + 单次 capability（评审后实现）

**硬门禁**：独立安全评审通过后开始。

### 1.1 provenance 落地

1. `patches/pi-ask-user+0.13.1.patch`（postinstall 应用，版本锁）。
2. `lib/extension-web-ui.ts`：`select`/`createDialogPromise` 透传并校验 `provenance`；新增 `lib/ask-user-provenance.ts`（schema 校验 + `desktopAnswerable` + bundled allowlist）。

### 1.2 私有控制 API

1. `app/api/desktop-control/**`（loopback-only，复用 `lib/desktop-observer-access.ts` 同源门控思路但独立 token）。
   - `POST /session`：mint 短时控制 token（独立 TTL）。
   - `GET /events`：SSE 推送桌面可应答描述符（`requestId`、`question`、`context`、`options[{title,description}]`、`expiresAt`）+ capability 引用（仅 main）。
   - `POST /[requestId]/respond`：校验 capability + live pending，写回 `ExtensionWebUiBridge.respond()`，失效注册表，合成结算事件。
2. `lib/ask-user-capability.ts`：mint（≥256-bit）、哈希存证、原子消费、失效（timeout/abort/settled/destroy/新对话框/instance 变化/WebUI 已响应）。
3. `lib/rpc-manager.ts`：在 `extension_ui_request`/`extension_ui_response` 边界接线 broker（mint/失效/结算回写），并合成 `extension_ui_settled` 事件给 WebUI SSE 关闭陈旧模态。

### 1.3 审计与隐私

1. 只记结构化非敏感字段（capability 哈希、四元组 id、时间戳、outcome、失效原因）；正文不落盘、不入日志/审计/通知。
2. 不扩展 `TaskObserverSnapshot`；`needs_input` 派生逻辑不变。

**验收**：`npm run lint`、`node_modules/.bin/tsc --noEmit`；新增 `test:desktop-control`（capability 生命周期/竞态/绑定）；`test:desktop-observer-api` 回归不破坏。

---

## Phase 2 — Electron 单选 UI + WebUI first-response-wins（评审后实现）

### 2.1 main 订阅与 capability 持有

1. `desktop/main/ask-user-control-client.ts`：订阅 `/api/desktop-control/events`，capability 仅存 main 内存。
2. `needs_input`（observer）→ 查控制 pending：可应答且开启且非 DND → 推送描述符；否则现状（bubble + openActivity）。

### 2.2 窄 IPC + renderer UI

1. `desktop/main/ipc-contract.ts` 增窄通道：`askUser:present`（main→renderer 描述符，无 capability）、`askUser:respond`（renderer→main 有限动作：选项 index / cancel）。
2. `desktop/preload/pet-preload.ts` 增只读/只发枚举方法，不暴露 token/capability/id。
3. `desktop/renderer/` 增单选面板：question + 选项 title（+ description 次要）、context 默认折叠、明确取消；关闭/过期/销毁/DND/隐藏时清空 DOM 与状态引用。

### 2.3 first-response-wins

1. 桌宠 consume 成功后服务端合成 `extension_ui_settled`；WebUI `useExtensionUi` 处理该事件关闭陈旧模态。
2. WebUI 先答 → capability 注册表失效 → 桌宠 consume 返回 stale → 关闭本地 UI 并回退。

**验收**：`npm run test:desktop-contract`、`test:desktop-connection`、`test:desktop-deep-links`；新增 renderer 内容展示/清理、竞态 smoke；`desktop:preview` 视觉矩阵。

---

## Phase 3 — 安全、竞态、Windows 实机验证

1. 威胁模型 T1–T10 逐项验证（普通 select 不误判、capability 重放/过期/跨会话拒绝、DND 不静默决策、双答收敛）。
2. renderer 内存清理与 CSP/沙箱回归；确认正文不进入 settings/日志/审计/系统通知。
3. 设置默认关闭与旧文件迁移（`settings-store` normalize），不误伤 `bundledExtensions["pi-ask-user"]`。
4. Windows 实机：桌宠应答、取消、超时、DND、托盘回退、WebUI 并发、窗口隐藏/重建、reduced-motion。

**验收**：`npm run test:task-observer`、`test:desktop-observer-api`、`test:desktop-contract`、`test:desktop-package` 全绿；按 `docs/operations/desktop-pet-validation.md` 完成 Windows 实机矩阵；ADR 状态由 Proposed 更新为 Accepted（在独立安全评审通过后）。

---

## Dependencies and Ordering

```text
Phase 0（纯领域，本计划当前允许项）
   └─> 独立安全评审（硬门禁）
        └─> Phase 1（provenance + 控制 API + capability）
             └─> Phase 2（Electron UI + first-response-wins）
                  └─> Phase 3（安全/竞态/Windows 实机）
```

- Phase 0 是当前唯一**无需评审即可执行**的产出（本计划交付）。
- Phase 1–2 均以「provenance 落地 + 独立安全评审通过」为硬门禁。
- 上游 PR 合并后：移除 patch、提升 pinned 版本、回归 Phase 0 判定与 Phase 1 校验。

## Validation

最低门禁（实现阶段）：

```bash
npm run lint
node_modules/.bin/tsc --noEmit
npm run test:desktop-contract
npm run test:desktop-observer-api
npm run test:task-observer
npm run test:desktop-connection
npm run test:desktop-deep-links
npm run test:desktop-package
```

按改动范围补充 `test:desktop-control`（capability 生命周期/竞态/绑定）与 `test:bundled-extensions`（patch 后 bundle 加载回归）。

contract smoke 不替代 Windows 通知、焦点、DND、多屏、renderer 内存清理实机验证。

## Success Criteria

- 普通 extension `select` 绝不误判为 ask_user，桌宠不为其弹出可应答 UI。
- ask_user 单选在开启且非 DND 时桌宠可就地选择/取消，Agent 继续执行。
- capability 单次消费，双端 first-response-wins，重复/过期/跨会话/绑定不匹配均拒绝。
- 全程正文与 capability 不进入 observer snapshot、settings、日志、审计正文、系统通知。
- 默认关闭，旧设置迁移为关闭，不误伤工具开关；DND 不弹出、不自动批准/拒绝。
- 通用 U5 仍为 No-go（父计划 `2026-08-14-001` 明确标注），U5a 单独立项。
