---
title: "refactor: Iteration 8 — 完成 UI 质量与视觉回归收口"
type: refactor
status: active
date: 2026-08-01
origin: docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md
iteration: 8
depends_on:
  - docs/plans/2026-08-01-003-refactor-workbench-shell-navigation-plan.md
  - docs/plans/2026-08-01-004-refactor-chat-visual-system-plan.md
  - docs/plans/2026-08-01-005-refactor-inspector-visual-system-plan.md
  - docs/plans/2026-08-01-006-refactor-settings-primitives-plan.md
  - docs/plans/2026-08-01-007-refactor-mcp-agents-settings-plan.md
  - docs/plans/2026-08-01-008-refactor-resource-config-surfaces-plan.md
---

# refactor: Iteration 8 — 完成 UI 质量与视觉回归收口

## Overview

本迭代是跨模块质量门，不承接新的大规模视觉迁移。它将前七个迭代放入固定主题、视口、键盘、动效和 Portal 组合中验证，只修复阻塞性组合问题，并固化可重复的视觉验收文档。

**前置依赖：** Iteration 2–7 全部完成并各自通过验收门。

---

## Scope

### In scope

- 固定视口与断点边界验证。
- 键盘、焦点、触控可达性与状态非颜色表达。
- 文本/状态/Focus ring 对比度与 reduced-motion。
- Sidebar、Inspector、Composer、Modal、Popover、Terminal 的组合层级。
- 主题契约 smoke 扩展、人工视觉矩阵和维护文档。
- 仅修复验证中发现的阻塞性或高优先级问题。

### Out of scope

- 不重新设计已验收模块，不批量清理剩余历史内联样式。
- 不新增主题、不引入 UI 框架或截图测试依赖。
- 不处理纯偏好型微调；非阻塞建议进入后续独立计划。

---

## Requirements

- R1. 四个固定视口和四个断点边界下关键流程可完成。
- R2. 仅键盘可访问顶部栏、Sidebar、Composer、Inspector 和 Modal。
- R3. 关键状态不只依赖颜色或 hover。
- R4. reduced-motion 下无非必要动画，功能和焦点恢复不受影响。
- R5. 主题契约、视觉清单和前端文档可指导后续维护。

---

## Implementation Units

- [ ] U1. **执行跨视口与组合层级验证**

**Goal:** 发现单模块验收无法覆盖的布局、Portal 和滚动组合问题。

**Files:**
- Modify as needed: `app/globals.css`
- Modify as needed: `components/AppShell.tsx`
- Modify as needed: `components/ChatInput.tsx`
- Modify as needed: `components/AppDialogProvider.tsx`
- Modify as needed: `components/ExtensionDialogHost.tsx`

**Approach:**
- 固定视口：1440×900、1024×768、768×1024、390×844。
- 断点边界：960、959、641、640px。
- 固定流程：选择工作区 → 新建会话 → 输入 → 流式工具 → 查看 Changes/Diff → 打开 Settings → 切换主题。
- 组合检查：Sidebar + Inspector + Terminal、Composer Popover + Modal、Todo Sheet + Toast、顶部 Usage Popover + Drawer。
- 只做必要修复，发现模块级大缺口则退回对应迭代计划，而不是在本迭代吞并。

**Test scenarios:**
- Layout：所有组合无页面级横向滚动、不可关闭浮层或关键操作遮挡。
- Zoom：125%/150% 下内容仍可滚动和操作。
- Content：超长中英文、路径、模型名和任务标题不破坏布局。
- Safe area：移动 Composer、Drawer、Toast、Todo 和 Terminal 不重叠。

**Verification:**
- 每个固定流程在四个视口可完整执行。
- 阻塞性组合问题已修复或明确回退到责任迭代。

- [ ] U2. **完成键盘、焦点、对比度与动效检查**

**Goal:** 统一跨模块可访问性和交互反馈质量。

**Dependencies:** U1

**Files:**
- Modify as needed: `app/globals.css`
- Modify as needed: `components/ThemePicker.tsx`
- Modify as needed: `components/AppShell.tsx`
- Modify as needed: `components/ChatInput.tsx`
- Modify as needed: `components/AppDialogProvider.tsx`
- Modify as needed: `components/ExtensionDialogHost.tsx`

**Approach:**
- 仅键盘遍历顶部栏、Sidebar、Composer、Inspector Tabs、Settings、Dialog。
- 检查 focus-visible、初始焦点、焦点返回、Escape、方向键和 Tab 顺序。
- 检查 selected、dirty、running、warning、danger、disabled 不只依赖颜色。
- 对主文本、次文本、状态文字、Focus ring 优先从 Token 调整，不做局部主题补丁。
- 所有非必要动画遵守 `prefers-reduced-motion`。

**Test scenarios:**
- Keyboard：不使用鼠标完成固定流程的主要导航和关闭操作。
- Focus：Dialog/Popover 打开关闭后焦点位置合理，无焦点陷入隐藏面板。
- Contrast：Light、Dark、Paper、Twilight、Dracula 的文本、Selected、Notice、Focus 可辨识。
- Motion：reduced-motion 下 Theme、Drawer、Popover、Notice 状态切换仍正确。

**Verification:**
- 不存在只能 hover 才能发现的关键操作。
- 不存在只靠红/绿区分的关键状态。

- [ ] U3. **扩展主题契约并编写视觉验证文档**

**Goal:** 固化自动契约与人工回归矩阵。

**Dependencies:** U1, U2

**Files:**
- Modify/Test: `scripts/smoke-ui-theme-contract.ts`
- Modify: `package.json`
- Create: `docs/operations/ui-visual-validation.md`
- Modify: `docs/modules/frontend.md`
- Modify: `docs/standards/code-style.md`

**Approach:**
- 扩展 smoke 覆盖关键 Token、主题同步、首屏初始化、reduced-motion 和稳定 class 契约。
- 文档固定主题矩阵、视口矩阵、状态数据、用户流程和截图命名规则。
- 代表主题：Light、Dark、Paper、Twilight、Dracula；其余主题执行契约 smoke 和关键路径抽查。
- 记录静态 class、动态 inline style、领域色和通用状态色的使用边界。

**Test scenarios:**
- Happy path：当前主题和关键契约全部通过。
- Error path：删除主题元数据、关键 Token 或首屏映射时明确失败。
- Manual：空态、活动会话、流式工具、Inspector、Settings、Modal、移动 Drawer 截图清单完整。

**Verification:**
- 新主题或新 UI 模块有明确接入与验收入口。
- 文档与实际主题、断点和共享原语一致。

- [ ] U4. **整理剩余问题与后续边界**

**Goal:** 防止最终收口演变为无边界“顺手优化”。

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md`
- Modify: `docs/operations/ui-visual-validation.md`

**Approach:**
- 更新总路线图中各迭代完成状态。
- 阻塞问题必须在本迭代修复；非阻塞微调、截图自动化和全仓内联样式清理列为后续独立工作。
- 不在本迭代创建新的大范围实现单元。

**Test scenarios:**
- Test expectation: none — 纯状态与后续边界整理。

**Verification:**
- 路线图状态真实，遗留项有清晰归属且不伪装成已完成。

---

## Iteration Acceptance Gate

- 四个固定视口、四个断点边界、五个代表主题完成关键流程验证。
- 键盘、焦点、触控、对比度、reduced-motion 和 Portal 组合无阻塞问题。
- 主题契约 smoke、lint、TypeScript 及触及模块的领域 smoke 通过。
- `docs/operations/ui-visual-validation.md`、`docs/modules/frontend.md`、`docs/standards/code-style.md` 与实现一致。
- 总路线图已更新迭代状态，非阻塞遗留项已拆出。

---

## Risks

| Risk | Mitigation |
| --- | --- |
| 最终迭代吸收前期遗漏导致再次膨胀 | 大缺口退回责任迭代，本迭代只修复组合阻塞 |
| 人工验证不稳定 | 固定视口、主题、流程、数据状态和截图命名 |
| 对比度修复产生主题特例 | 优先调整语义 Token，禁止组件级 skin 补丁 |
| 文档与实现再次漂移 | 将更新文档作为验收门，而非收尾可选项 |

---

## Completion Outcome

完成本迭代后，前端视觉优化总计划具备可维护的主题基础、稳定的高频 UI、统一的复杂配置表面，以及可重复的质量验证入口。后续视觉需求应按独立小计划推进，不再回到一次覆盖全站的大规模改造方式。
