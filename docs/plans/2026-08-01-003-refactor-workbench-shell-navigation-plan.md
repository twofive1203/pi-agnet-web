---
title: "refactor: Iteration 2 — 优化工作台骨架与左侧导航"
type: refactor
status: active
date: 2026-08-01
origin: docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md
iteration: 2
depends_on: docs/plans/2026-08-01-002-refactor-theme-foundation-plan.md
---

# refactor: Iteration 2 — 优化工作台骨架与左侧导航

## Overview

本迭代只处理应用主框架、顶部上下文栏、Observe Bar、Sidebar 和 Explorer。目标是在不触碰聊天内容和 Inspector 内部业务面板的前提下，稳定三档布局和左侧高频导航路径。

**前置依赖：** Iteration 1 完成。

**完成后解锁：** Iteration 4；为 Iteration 3 和 Iteration 8 提供稳定容器。

---

## Scope

### In scope

- AppShell 三栏卡片骨架、顶部上下文栏、Observe Bar、Inspector 外壳。
- Sidebar Workspace Card、新建会话、Sessions/Archive、搜索、会话列表、Explorer。
- 宽桌面、窄桌面、移动端的布局边界与 z-index。
- 本次触及的新工作台硬编码文案 i18n。

### Out of scope

- 不重做消息、Composer、Inspector Tab 内容、Settings 和 Terminal 内部 UI。
- 不改变 Sidebar/Inspector 的业务状态、本地持久化键或会话生命周期。
- 不在本迭代完成全站无障碍审计；只处理当前范围内的键盘与触控可达性。

---

## Requirements

- R1. 1440px 下 Sidebar、Chat、Inspector 可同时打开，Chat 保持最小可用宽度。
- R2. `960/959`、`641/640` 断点切换无双占位、横向页面滚动或不可见关闭入口。
- R3. 左栏只有一个最高优先级主操作，工作区、会话、Explorer 层级清晰。
- R4. Hover-only 操作同时具备 focus 和触控可发现路径。
- R5. 不破坏右栏宽度、Explorer 高度和当前工作区状态的持久化。

---

## Implementation Units

- [x] U1. **收口 AppShell 静态样式与上下文栏信息层级**

**Goal:** 将主框架静态视觉迁移到语义 class，保留真正动态的尺寸和 Portal 坐标。

**Files:**
- Modify: `components/AppShell.tsx`
- Modify: `app/globals.css`
- Modify: `lib/i18n/messages/common.ts`

**Approach:**
- 迁移顶部按钮、统计 Chip、空态、Observe Bar 和 Inspector 外壳的静态内联样式。
- 建立 breadcrumb、关键动作、低优先级统计的收缩与溢出顺序。
- 收口 active、dirty、running、disabled 和 empty 状态。
- 统一工作台 z-index 层级，覆盖 Sidebar/Inspector Drawer、Portal、Terminal dock 和遮罩。

**Test scenarios:**
- Happy path：普通会话、活动 Agent、Git dirty、Todo active 时顶部状态层级清楚。
- Edge case：长工作区名、长会话名、Usage panel 同时显示时关键按钮仍可达。
- Integration：Branch/System/Subagent Portal、Terminal 和 Inspector 不互相遮挡。

**Verification:**
- 静态 hover 不再通过事件直接修改元素 style。
- 新增工作台文案接入 i18n。

- [x] U2. **统一三档响应式布局和 resize 行为**

**Goal:** 让 CSS 与 TypeScript 对布局边界形成清晰一致的契约。

**Dependencies:** U1

**Files:**
- Modify: `components/AppShell.tsx`
- Modify: `app/globals.css`
- Modify: `docs/modules/frontend.md`
- Test: `scripts/smoke-ui-theme-contract.ts`

**Approach:**
- 固定宽桌面 `≥960px`、窄桌面 `641–959px`、移动端 `≤640px` 三档行为。
- 明确现有 `860px` 规则只负责卡片外观或删除，禁止成为第四种布局状态。
- 宽桌面保留 inline resize；窄桌面使用 overlay drawer；移动端保持全宽 drawer。
- 保持 resize keyboard step、viewport clamp 与本地宽度存储。

**Test scenarios:**
- Boundary：960、959、641、640px 下 Sidebar/Inspector 开关组合正确。
- Edge case：右栏存储宽度超出当前视口时自动 clamp。
- Accessibility：separator 可 Tab 聚焦、方向键调整且 focus-visible 清楚。

**Verification:**
- 无页面级横向滚动。
- 断点说明与 `docs/modules/frontend.md` 一致。

- [x] U3. **优化 Workspace、Session 与 Explorer 导航层级**

**Goal:** 完成左侧导航高频路径的视觉收口与可发现性补齐。

**Dependencies:** U1

**Files:**
- Modify: `components/SessionSidebar.tsx`
- Modify: `components/sidebar/WorkspacePicker.tsx`
- Modify: `components/sidebar/SessionList.tsx`
- Modify: `components/sidebar/ArchivedSessionSection.tsx`
- Modify: `components/sidebar/SidebarExplorerPane.tsx`
- Modify: `components/sidebar/WorktreeBadge.tsx`
- Modify: `app/globals.css`
- Modify: `lib/i18n/messages/sidebar.ts`

**Approach:**
- 校准 Workspace Card、新建会话、导航 Pill、搜索和列表的垂直节奏。
- 统一 selected、running、idle、archived、rename、multi-select 与 hover action 状态。
- 将 Context Menu、Worktree 确认层和 danger/warning 通知切换到语义 Token。
- 保持现有 memoization、业务编排和 Explorer resize 数据流。

**Test scenarios:**
- Manual：无工作区、普通工作区、WorkTree、空列表、加载/错误、长列表、批量归档、重命名。
- Manual：Explorer 展开/收起/resize，移动端与会话列表共享剩余高度。
- Accessibility：鼠标、键盘与 390px 触控场景均能发现归档、菜单和清除搜索。

**Verification:**
- 主操作视觉优先级唯一。
- 状态不只依赖颜色表达。

---

## Iteration Acceptance Gate

- AppShell 与 Sidebar 范围完成 Light、Dark、Paper、Twilight、Dracula 抽查。
- 1440×900、1024×768、768×1024、390×844 及四个边界宽度验证通过。
- Sidebar/Inspector resize、Drawer、Portal 和 Terminal 组合无明显层级错误。
- lint、TypeScript 和主题契约 smoke 通过。
- Chat、Inspector 内容和 Settings 未被顺带迁移。

**Implementation verification:** `npm run lint`、`node_modules/.bin/tsc --noEmit`、`npm run test:ui-theme` 与 `git diff --check` 已通过。当前会话没有绑定浏览器标签页，代表主题与固定视口的人工视觉矩阵仍需在浏览器中执行。

---

## Risks

| Risk | Mitigation |
| --- | --- |
| AppShell 视觉与状态逻辑交织 | 只迁移静态样式和标签，不重写状态机或 callback |
| CSS 与 TS 断点再次漂移 | 在文档和 smoke 中记录边界契约 |
| 左栏调整影响会话性能 | 保留现有 memoized 子组件和数据 hook 边界 |

---

## Handoff to Next Iteration

Iteration 3 使用稳定后的中心容器，不再调整 AppShell 布局；Iteration 4 可依赖已稳定的 Inspector 外壳，只迁移各 Tab 内部内容。
