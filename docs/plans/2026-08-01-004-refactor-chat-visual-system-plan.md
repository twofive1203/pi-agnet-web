---
title: "refactor: Iteration 3 — 统一聊天消息与 Composer 视觉"
type: refactor
status: active
date: 2026-08-01
origin: docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md
iteration: 3
depends_on: docs/plans/2026-08-01-002-refactor-theme-foundation-plan.md
---

# refactor: Iteration 3 — 统一聊天消息与 Composer 视觉

## Overview

本迭代聚焦最常用的阅读和输入路径：消息、Thinking、工具调用、流式状态、空态和 Composer。只在稳定的主题 Token 上优化视觉，不调整 Agent SSE、消息生命周期、输入业务能力或 AppShell 布局。

**前置依赖：** Iteration 1；建议在 Iteration 2 后实施以减少容器样式冲突。

---

## Scope

### In scope

- User/Assistant/Thinking/Tool Call/Tool Result/Error/Streaming 的视觉层级。
- Composer 主输入、附件、模型、Thinking、Tools、发送/停止和下拉菜单。
- 空会话与无会话 Empty State。
- Extension status/widget/todo 与聊天主视觉的融合。
- 当前范围内的 hover、focus、touch 和 reduced-motion。

### Out of scope

- 不修改 `hooks/useAgentSession.ts` 的 SSE、stream coalescing 或生命周期。
- 不改 Tool schema、Slash command、模型选择和附件上传行为。
- 不重做 Markdown/Mermaid/KaTeX 渲染能力，只调整容器和主题表面。
- 不调整 AppShell、Sidebar、Inspector 或 Settings。

---

## Requirements

- R1. 用户、Assistant、Thinking 和工具块层级清楚，不产生重复卡片嵌套感。
- R2. 流式更新只影响 live row，不破坏历史消息稳定渲染。
- R3. Composer 所有控件在桌面、移动端和键盘下可达。
- R4. 通用状态色使用语义 Token，领域数据色保留独立表达。
- R5. Theme 切换时 Markdown、代码块、工具卡和 Composer 同步更新。

---

## Implementation Units

- [ ] U1. **统一消息与工具调用层级**

**Goal:** 建立稳定的消息、元信息、工具和操作行视觉规则。

**Files:**
- Modify: `components/MessageView.tsx`
- Modify: `components/MarkdownBody.tsx`
- Modify: `components/ChatWindow.tsx`
- Modify: `app/globals.css`
- Modify: `lib/i18n/messages/chat.ts`

**Approach:**
- 使用现有 `message-view-*` 根 class 迁移静态样式。
- 明确 User/Assistant 的表面差异，以及 Thinking/Tool 嵌套层级。
- 将 Copy/Edit/Fork、TPS、usage、error/warning 的通用颜色映射到 Token。
- 保留 TPS 分档、diff、语法高亮等领域数据色。
- 触屏下消息操作不依赖 hover 才出现。

**Test scenarios:**
- Happy path：用户文本/图片、Assistant Markdown、Thinking、成功工具、usage 同时存在。
- Edge case：长代码块、长路径、Mermaid、KaTeX、连续工具和空工具结果不溢出。
- Error path：工具失败、中断和重试状态层级一致。
- Performance：流式尾消息更新时历史消息不闪动或重新动画。

**Verification:**
- 消息操作不再通过 mouse event 直接改颜色。
- Assistant 内容与嵌套工具卡没有双重重边框。

- [ ] U2. **统一 Composer 与下拉控件**

**Goal:** 让输入区在各种模型、工具和流式状态下保持清晰且紧凑。

**Dependencies:** U1

**Files:**
- Modify: `components/ChatInput.tsx`
- Modify: `components/ToolPanel.tsx`
- Modify: `components/BrowserBindingTrigger.tsx`
- Modify: `components/BrowserBindingPanel.tsx`
- Modify: `app/globals.css`

**Approach:**
- 统一主输入卡、focus ring、附件/模型/Thinking/Tools 控件和发送/停止按钮。
- 统一 model/thinking/tool/slash 下拉的表面、选中、禁用、滚动和视口约束。
- 保留 Portal 定位、动态高度、文件引用、图片和 steer/followup 行为。
- 移动端控件条允许受控横向滚动，关键发送/停止操作持续可见。

**Test scenarios:**
- Happy path：普通输入、图片/文件引用、模型/Thinking/Tools 切换和发送。
- Streaming：Steer、Follow-up、Stop 和自动滚动/声音控件状态正确。
- Edge case：窄屏、长模型名、Slash 大列表和浏览器绑定 Popover 不超出视口。
- Accessibility：Tab、方向键、Escape、Enter 和 focus-visible 路径完整。

**Verification:**
- 静态视觉样式主要由 class/Token 控制。
- 输入业务与 Portal 定位行为保持不变。

- [ ] U3. **收口 Empty State 与 Extension 周边组件**

**Goal:** 避免 AppShell 空态、ChatWindow 新会话空态和 Extension UI 使用不同视觉语言。

**Dependencies:** U1, U2

**Files:**
- Modify: `components/ChatWindow.tsx`
- Modify: `components/ExtensionStatusBar.tsx`
- Modify: `components/ExtensionWidgetStack.tsx`
- Modify: `components/ExtensionTodoPanel.tsx`
- Modify: `components/ExtensionToastHost.tsx`
- Modify: `app/globals.css`

**Approach:**
- 统一产品标识、说明文本、主操作和版本信息层级。
- 让 status/widget/todo/toast 复用相同卡片、状态和阴影 Token。
- 保留 Todo 拖动、移动底部 Sheet、Toast 生命周期和 extension bridge 行为。

**Test scenarios:**
- Manual：无工作区、已选工作区无会话、新建空会话三种空态。
- Integration：Extension status/widget/todo/toast 与 Composer 同时出现时不挤压关键输入区域。
- Mobile：Todo bottom sheet、Toast 与 Composer safe area 不重叠。

**Verification:**
- 空态主按钮和说明层级一致。
- Extension UI 不再像独立主题组件。

---

## Iteration Acceptance Gate

- 代表主题下完成完整消息、工具、流式和 Composer 场景抽查。
- 820px 内容宽度、390px 移动宽度和 125%/150% 缩放无关键溢出。
- 消息 memoization、流式显示、输入、下拉、附件和停止行为不变。
- lint、TypeScript、主题契约 smoke 和现有 `test:agent-stream` 通过。
- 未调整 Inspector、Settings 或会话生命周期代码。

---

## Risks

| Risk | Mitigation |
| --- | --- |
| MessageView 样式与流式性能耦合 | 不改变 props identity、memo 比较和消息映射结构 |
| ChatInput 体量大，视觉迁移易误伤功能 | 按主输入、下拉、扩展区三块小范围迁移并逐块验证 |
| 移动端控件过多 | 保留受控横向滚动并固定发送/停止优先级 |

---

## Handoff to Next Iteration

后续迭代不得再次修改消息层级或 Composer 基础样式；跨模块焦点、对比度和组合问题统一留给 Iteration 8 收口。
