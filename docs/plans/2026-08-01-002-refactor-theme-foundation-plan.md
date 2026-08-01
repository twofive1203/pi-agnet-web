---
title: "refactor: Iteration 1 — 建立主题基础与语义 Token"
type: refactor
status: completed
date: 2026-08-01
origin: docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md
iteration: 1
---

# refactor: Iteration 1 — 建立主题基础与语义 Token

## Overview

本迭代只建立后续视觉优化所需的主题基础，不批量迁移工作台、聊天、Inspector 或设置组件。交付结果是一套稳定、向后兼容的语义 Token，以及能发现主题注册漂移的 smoke 检查。

**前置依赖：** 无。

**完成后解锁：** Iteration 2–7。

---

## Scope

### In scope

- 统一主题注册表、首屏初始化、ThemePicker 与 CSS 皮肤名单。
- 补齐表面、文本、边界、状态、圆角、阴影、焦点与动效 Token。
- 明确旧 Token 与新语义 Token 的兼容映射和淘汰顺序。
- 建立主题契约 smoke 入口。
- 仅迁移 ThemePicker 自身和少量基础规则验证新契约。

### Out of scope

- 不批量修改 `AppShell`、Sidebar、Chat、Inspector 或 Settings。
- 不删除仍被历史组件使用的旧变量。
- 不新增主题，不引入 UI 框架，不建立浏览器截图平台。

---

## Requirements

- R1. `lib/theme.ts` 继续作为主题名单和 resolved mode 的唯一事实源。
- R2. 现有 11 个主题偏好全部拥有完整的关键语义角色。
- R3. 旧组件在本迭代后保持当前视觉，不因 Token 调整失色。
- R4. `system`、非法本地值、具体 skin 和 reduced-motion 行为保持正确。
- R5. 自动检查能发现主题注册、首屏脚本、Picker 或关键 Token 漂移。

---

## Implementation Units

- [x] U1. **定义语义 Token 与兼容映射**

**Goal:** 在不破坏历史组件的前提下，建立后续迭代统一使用的主题角色。

**Files:**
- Modify: `app/globals.css`
- Modify: `docs/modules/frontend.md`

**Approach:**
- 将 Token 分为 surface、border、text、accent、status、shape、elevation、motion 八类。
- 对 `--bg-panel/--bg-card`、`--border/--line` 等重复角色确定主名称，旧名称保留为兼容别名。
- 为 success/warning/danger/info 提供 foreground、soft background 和 border 组合。
- Theme skin 只定义调色板与必要材质差异，不继续增加业务组件选择器。

**Test scenarios:**
- Happy path：默认浅色、默认深色和 curated skins 均解析出全部关键 Token。
- Edge case：旧变量继续能通过兼容别名得到有效颜色。
- Manual：Light、Dark、Paper、Twilight、Dracula 下基础页面未出现透明、纯黑或不可读区域。

**Verification:**
- 新 Token 有明确角色，不按具体业务组件命名。
- 本迭代不删除仍有调用者的旧 Token。

- [x] U2. **收口主题注册、首屏初始化与 ThemePicker**

**Goal:** 防止主题枚举、首屏脚本、Picker 选项和 CSS skin 名单相互漂移。

**Dependencies:** U1

**Files:**
- Modify: `lib/theme.ts`
- Modify: `app/layout.tsx`
- Modify: `hooks/useTheme.ts`
- Modify: `components/ThemePicker.tsx`
- Modify: `app/globals.css`

**Approach:**
- 继续由 `THEME_PREFERENCES`/`THEME_META` 派生首屏 skin 与 mode。
- 为 ThemePicker 的预览色建立与主题元数据一致的维护方式，避免独立名单遗漏。
- 保持 `localStorage["pi-theme"]`、`data-theme-preference`、`data-theme-skin` 与 `.dark` 兼容行为。
- 保持 View Transition、系统主题监听和 `prefers-reduced-motion` 行为。

**Test scenarios:**
- Happy path：逐个选择 11 个主题后，Picker 选中态、skin 属性、`.dark` 和 `color-scheme` 一致。
- Edge case：非法本地值回落到 `system`；从具体 skin 切回 Light/Dark 时旧 skin 属性被清理。
- Accessibility：方向键、Home、End、Escape 与焦点返回行为保持可用。
- Motion：reduced-motion 下主题立即切换且无 View Transition 动画。

**Verification:**
- 首屏无明显主题闪烁。
- Monaco/Markdown 仍通过 resolved `isDark` 得到二值兼容结果。

- [x] U3. **新增主题契约 smoke**

**Goal:** 用低成本自动检查覆盖可静态判断的主题漂移。

**Dependencies:** U1, U2

**Files:**
- Create/Test: `scripts/smoke-ui-theme-contract.ts`
- Modify: `package.json`
- Modify: `docs/standards/code-style.md`

**Approach:**
- 检查主题注册表、Picker、首屏初始化和 CSS skin 覆盖关系。
- 检查关键语义 Token 与兼容别名存在性。
- 检查 reduced-motion 和主题存储键等稳定契约。
- 增加单一 npm script 入口，后续迭代复用并扩展。

**Test scenarios:**
- Happy path：当前 11 个主题和关键 Token 全部通过。
- Error path：模拟缺失主题元数据、CSS skin 或关键 Token 时，输出明确缺失项。
- Compatibility：旧 Token 兼容别名在迁移期仍被契约接受。

**Verification:**
- Smoke 失败信息能直接定位主题、Token 或同步面。
- 文档说明何时扩展 smoke，避免把视觉主观判断塞入静态测试。

---

## Iteration Acceptance Gate

- 11 个主题注册、首屏脚本、Picker 与 CSS 契约一致。
- 新语义 Token 可供后续组件使用，旧组件保持兼容。
- 主题契约 smoke、lint 和 TypeScript 检查可通过。
- 完成 Light、Dark、Paper、Twilight、Dracula 的基础人工抽查。
- 未开始迁移工作台、聊天、Inspector 或 Settings。

---

## Risks

| Risk | Mitigation |
| --- | --- |
| 新旧 Token 同时存在导致含义不清 | 在 `docs/modules/frontend.md` 标明主名称与兼容别名 |
| 全局颜色调整造成大面积视觉变化 | 本迭代优先补 Token，不主动改变历史变量的最终颜色 |
| 静态 smoke 误当作视觉测试 | 明确 smoke 只验证契约，实际观感留给代表主题人工抽查 |

---

## Handoff to Next Iteration

Iteration 2 只能依赖本迭代已经确认的语义 Token；如工作台迁移发现 Token 缺口，先补充通用角色及契约，再继续组件样式，不在 `AppShell` 中新增专属调色板。
