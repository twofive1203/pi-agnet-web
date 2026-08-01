---
title: "refactor: Iteration 5 — 建立设置原语与共享 Dialog"
type: refactor
status: completed
date: 2026-08-01
origin: docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md
iteration: 5
depends_on: docs/plans/2026-08-01-002-refactor-theme-foundation-plan.md
---

# refactor: Iteration 5 — 建立设置原语与共享 Dialog

## Overview

本迭代只建立设置类界面的最小共享原语，并迁移 `SettingsConfig` 自有 section 与共享 Dialog。MCP、Agents、Models、Extensions、Skills 的内部复杂表单留给后续迭代，避免在一次改动中覆盖全部配置能力。

**前置依赖：** Iteration 1。

**完成后解锁：** Iteration 6、Iteration 7。

---

## Scope

### In scope

- 最小 Settings 原语：Section Header、Field、Input/Select/Textarea、Toggle、Button、Notice、Empty/Error State。
- Settings Modal 外壳、侧边导航、基础 section 和移动端布局。
- App Dialog、Extension Dialog 的共享 Overlay/Panel/Header/Body/Footer。
- `UsageStatsModal` 等简单共享 Modal 的视觉对齐。

### Out of scope

- 不迁移 MCP、Agents、Models、Extensions、Skills 内部复杂表单。
- 不创建大型 UI 组件库、布局 DSL 或通用数据表格系统。
- 不改变任何配置保存路径、payload、dirty 状态或 Dialog 队列行为。

---

## Requirements

- R1. 新增设置字段不再复制整段内联样式。
- R2. 原语覆盖 normal/hover/focus/disabled/read-only/dirty/saving/success/error。
- R3. Modal 共享一致外壳并保持 Escape、overlay close、焦点和队列行为。
- R4. 移动端 Settings 导航与内容可滚动，双列字段明确转单列。
- R5. 原语保持小而明确，不承载业务状态。

---

## Implementation Units

- [x] U1. **提取最小 Settings 原语**

**Goal:** 从现有 `SettingsConfig` 重复模式中提取稳定、可复用的视觉构件。

**Files:**
- Create: `components/ui/SettingsPrimitives.tsx`
- Modify: `app/globals.css`
- Modify: `docs/modules/frontend.md`

**Approach:**
- 原语只接收显示与标准表单 props，不接管 fetch、save、dirty 或 validation 业务。
- Button/Notice 使用明确 variant，通用状态色来自 Iteration 1 Token。
- 保持原生 input/select/textarea 语义和 label 关联。
- 静态样式使用 class；动态宽度、状态值等保留 props。

**Test scenarios:**
- Manual：每个原语展示默认、hover、focus、disabled、error 和 saving 状态。
- Accessibility：Label 与控件关联，Toggle 暴露 checked/disabled，按钮类型明确。
- Theme：Light、Dark、Paper、Twilight、Dracula 下状态可辨识。

**Verification:**
- 原语没有引入业务配置类型或 API 依赖。
- 现有主题 Token 足够，不创建组件专属调色板。

- [x] U2. **迁移 Settings Modal 与自有 section**

**Goal:** 验证原语可覆盖 Settings 外壳和普通配置场景。

**Dependencies:** U1

**Files:**
- Modify: `components/SettingsConfig.tsx`
- Modify: `app/globals.css`
- Modify: `lib/i18n/messages/settings.ts`

**Approach:**
- 迁移 Modal header/body/footer、section nav、Field、Toggle、Input、Notice 和 action buttons。
- 优先覆盖 language、worktree、usage、terminal、ChatGPT、Grok、editor、workflow 等 Settings 自有 section。
- MCP/Agents/Extensions 仍以嵌入边界存在，本迭代不进入其内部批量迁移。
- 保留 `pi-web.json` 保存、默认值、AI env parsing、SnFlow setup 等行为。

**Test scenarios:**
- Happy path：逐个切换 Settings section、修改字段、保存和关闭。
- Edge case：长路径、环境变量表、窄屏双列、未选择 cwd、模型列表加载失败。
- Error path：parse error、保存失败、SnFlow setup 错误和 dirty 状态显示正确。
- Mobile：section nav 横向滚动，内容单列且 footer 可达。

**Verification:**
- Settings 自有 section 不再重复定义基础输入/开关/按钮样式。
- 保存 payload 与 dirty 逻辑不变。

- [x] U3. **统一共享 Dialog 与简单 Modal**

**Goal:** 收口全局阻塞式 Dialog 的视觉和键盘基础。

**Dependencies:** U1

**Files:**
- Modify: `components/AppDialogProvider.tsx`
- Modify: `components/ExtensionDialogHost.tsx`
- Modify: `components/UsageStatsModal.tsx`
- Modify: `components/ModelPricingCatalog.tsx`
- Modify: `app/globals.css`

**Approach:**
- 统一 Overlay、Panel、Header、Body、Footer、关闭按钮、danger confirm 和移动全屏规则。
- 保留 App Dialog 串行队列、prompt autofocus、Enter/Escape 和 overlay cancel。
- 保留 Extension Dialog select/input/editor 的响应桥接。
- 不在本迭代处理每个业务 Popover。

**Test scenarios:**
- Dialog：alert、confirm、danger confirm、prompt、select、input、editor。
- Keyboard：初始焦点、Tab 范围、Enter、Escape、关闭后焦点恢复。
- Integration：Settings 上方再打开 Dialog，z-index 与滚动行为正确。
- Mobile：390px 下全屏或受控面板布局可关闭。

**Verification:**
- 阻塞式 Dialog 使用单一视觉规范。
- 队列、响应和取消语义不变。

---

## Iteration Acceptance Gate

- Settings 原语 API 足以覆盖普通设置场景，但未包含业务逻辑。
- Settings 自有 section 完成迁移并保持保存/dirty 行为。
- App Dialog、Extension Dialog 与简单 Modal 完成正常/危险/错误/移动场景验证。
- lint、TypeScript 和主题契约 smoke 通过。
- MCP、Agents、Models、Extensions、Skills 内部未被顺带大规模迁移。

---

## Risks

| Risk | Mitigation |
| --- | --- |
| 原语过早泛化 | 只从真实重复模式提取，不支持尚未出现的布局 |
| Settings 迁移范围过大 | 按 section 分批替换，但保持同一迭代验收边界 |
| Dialog 可访问性被视觉改动破坏 | 先保留现有交互逻辑，再替换结构和 class |

---

## Handoff to Next Iteration

Iteration 6 和 Iteration 7 必须复用本迭代原语。若复杂面板发现缺口，只允许增加通用 variant 或小型原语，并同步回本计划的契约说明，禁止在各面板复制新样式体系。
