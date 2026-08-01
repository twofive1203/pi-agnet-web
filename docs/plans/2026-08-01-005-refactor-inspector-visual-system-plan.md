---
title: "refactor: Iteration 4 — 统一 Inspector 与开发工具面板"
type: refactor
status: active
date: 2026-08-01
origin: docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md
iteration: 4
depends_on: docs/plans/2026-08-01-003-refactor-workbench-shell-navigation-plan.md
---

# refactor: Iteration 4 — 统一 Inspector 与开发工具面板

## Overview

本迭代在已稳定的 Inspector 外壳内，统一 Changes、Preview、Git、SnFlow、Agents 的标题、列表、状态和空态。各面板业务数据流不变，只迁移共同视觉骨架和主题表面。

**前置依赖：** Iteration 1、Iteration 2。

---

## Scope

### In scope

- Inspector Tab 内统一的 Section Header、Stat Card、List Row、Badge、Empty/Error/Loading State。
- Changes、Preview、Git、Diff、SnFlow、Agents 外壳与通用状态。
- 300px 最小宽度、移动全屏 Drawer 和长内容降级。

### Out of scope

- 不调整 Inspector 外壳宽度和主布局。
- 不修改 Changes polling、Git API、SnFlow 生命周期、Subagent detail loading 或文件编辑行为。
- 不重做 CommitGraph lane 算法、Diff parser 或 Monaco 编辑器内部主题。

---

## Requirements

- R1. 五个 Tab 的标题、边距、滚动边界和状态层级一致。
- R2. 300px 宽度下长路径、按钮组、表格和空态不撑破面板。
- R3. 领域数据色保留，通用表面与状态使用语义 Token。
- R4. Modal/Panel/TabBar 层级正确，移动全屏 Drawer 可关闭。
- R5. 所有业务请求、轮询、选择和编辑行为保持不变。

---

## Implementation Units

- [ ] U1. **统一 Inspector 内容骨架、Changes 与 Preview**

**Goal:** 先稳定最通用的 Inspector 内容原语和文件查看路径。

**Files:**
- Modify: `components/InspectorChangesPanel.tsx`
- Modify: `components/TabBar.tsx`
- Modify: `components/FileViewer.tsx`
- Modify: `components/FileExplorer.tsx`
- Modify: `app/globals.css`

**Approach:**
- 建立 Inspector section/list/stat/empty/error/loading 语义 class。
- Changes 统一统计卡、文件行、状态 Badge 和滚动容器。
- Preview 明确 Inspector Tab、文件 TabBar、文件内容三层层级。
- 保留动态 diff available、文件状态和编辑器业务逻辑。

**Test scenarios:**
- Happy path：Changes 有多文件变更并可打开 diff；Preview 有多个文件 Tab。
- Edge case：无会话、无变更、metadata-only、长 Windows 路径、二进制或不可预览文件。
- Error path：Changes 加载失败和文件加载失败保留恢复信息。
- Width：300px 与移动全宽下无页面级横向滚动。

**Verification:**
- Changes/Preview 使用相同内容密度和空态位置。
- TabBar 不与 Inspector 主 Tab 争夺主层级。

- [ ] U2. **统一 Git、CommitGraph 与 Diff 表面**

**Goal:** 让 Git 和 Diff 使用 Inspector 共同语言，同时保留领域数据表达。

**Dependencies:** U1

**Files:**
- Modify: `components/GitPanel.tsx`
- Modify: `components/CommitGraph.tsx`
- Modify: `components/GitCommitDiffModal.tsx`
- Modify: `components/FileDiffModal.tsx`
- Modify: `components/DiffModal.tsx`
- Modify: `components/SideBySideDiffView.tsx`
- Modify: `components/UnifiedDiffView.tsx`
- Modify: `app/globals.css`

**Approach:**
- 统一 Git section、branch selector、列表、选中提交和错误/空态。
- Commit lane、added/deleted 和 diff hunk 保留领域色；背景、边界、Hover、Selected 映射 Token。
- Diff Modal 统一 Header、mode switch、loading/error/fallback 与移动端布局。

**Test scenarios:**
- Happy path：有 dirty 文件、stash、分支和提交图；打开 session/git diff。
- Edge case：非 Git 工作区、空仓库、长分支名、binary/too-large/unavailable diff。
- Integration：从 Changes 和 Git 打开 Diff 时层级、Escape 和 overlay close 正确。

**Verification:**
- Git 与 Diff 的领域状态清晰，但不引入主题专属硬编码表面色。

- [ ] U3. **统一 SnFlow 与 Agents 面板外壳**

**Goal:** 完成剩余 Inspector Tab 的通用视觉迁移。

**Dependencies:** U1

**Files:**
- Modify: `components/WorkflowPanel.tsx`
- Modify: `components/WorkflowSessionWidget.tsx`
- Modify: `components/SubagentPanel.tsx`
- Modify: `components/SubagentObservation.tsx`
- Modify: `app/globals.css`

**Approach:**
- 统一 SnFlow/Agents 的 section、task/run row、status badge、empty/error/loading 和操作区。
- 保留 SnFlow phase/task 生命周期、Agents cache/abort/refresh 和观察 store 边界。
- 检查长任务标题、进度、嵌套子任务和 Agent detail 在最小宽度下的降级。

**Test scenarios:**
- SnFlow：未初始化、任务列表、运行中、完成、归档、长标题和错误状态。
- Agents：无运行、运行中、完成、失败、展开详情、递归截断和加载失败。
- Mobile：全屏 Drawer 中列表滚动和关闭入口持续可达。

**Verification:**
- 五个 Tab 均使用一致视觉骨架。
- 业务轮询、缓存和任务状态不变。

---

## Iteration Acceptance Gate

- Changes、Preview、Git、SnFlow、Agents 全部完成空态、正常态和错误态抽查。
- 300px Inspector、380px 默认宽度和移动全屏 Drawer 验证通过。
- Diff Modal、文件 Tab、Git 分支、SnFlow 任务和 Agents 详情交互保持正常。
- lint、TypeScript、主题契约 smoke、`test:session-changes` 和 `test:snflow` 通过；若 Subagent 逻辑未改，仅做其现有针对性 smoke 抽查。
- 未修改 AppShell 布局、Chat 或 Settings。

---

## Risks

| Risk | Mitigation |
| --- | --- |
| 面板文件多导致范围蔓延 | 只迁移外壳和通用状态，领域算法与数据加载保持不变 |
| Diff/Git 数据色被主题 Token 稀释 | 明确数据色与通用状态色分层 |
| 最小宽度下表格不可用 | 优先改为受控滚动、折行或信息降级，不改变数据结构 |

---

## Handoff to Next Iteration

Inspector 完成后仅在 Iteration 8 接受跨模块组合修复；设置类组件不得复用 Inspector 专属 class，应使用 Iteration 5 建立的表单与 Dialog 原语。
