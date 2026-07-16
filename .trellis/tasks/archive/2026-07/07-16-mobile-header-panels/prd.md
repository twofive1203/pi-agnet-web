# 移动端顶部功能面板适配

## Goal

修复手机 Web 端对话页顶部横向功能入口点击后面板不可见的问题，使 Git 管理、系统提示词、子 Agent 管理、ChatGPT/Codex 账号额度等顶部功能在窄屏设备上可正常打开、查看和关闭，同时保持桌面端现有行为。

## Confirmed Facts

- 问题发生在手机端对话框顶部的横向功能区。
- 已明确受影响的入口包括 Git 管理、系统提示词、子 Agent 管理和 GPT 账号额度显示；同类 Branches 顶部浮层一并纳入统一修复。
- 项目此前做过通用移动端适配，但当前这些顶部弹层仍存在可见性问题。
- `app/globals.css` 在手机断点将 `.app-top-bar` 设为横向滚动容器，并设置 `overflow-y: hidden` 与 `-webkit-overflow-scrolling: touch`。
- System、Subagents、Git 共用的 `.app-top-aux-panel` 仍渲染在该滚动容器内部；Branches 也在 `BranchNavigator` 内使用相同模式。它们没有像已修复的聊天输入工具菜单一样 portal 到 `document.body`。
- `ChatGptUsagePanel` 的额度详情更明确地使用 `position: absolute; width: 380px`，并直接挂在顶部滚动容器内；375px 手机视口下既可能横向越界，也会被顶部栏的 overflow 裁剪。
- Git、Subagents 和系统提示词内容区已经具备移动端最大高度或内部滚动处理，主要缺口位于弹层的挂载与定位层，而非数据加载或面板内容逻辑。
- 现有 `ChatInput` 已提供项目内可复用的正确模式：触发时读取 `getBoundingClientRect()`，通过 `createPortal` 渲染 fixed 弹层，并用移动端 CSS 约束视口。
- 本阶段先排查代码和根因，不直接实施修改。

## Requirements

- 定位每个受影响入口对应的组件、弹层定位方式和移动端样式。
- 统一覆盖 Branches、System、Subagents、Git 和 GPT 额度等同类顶部浮层。
- 判断问题是裁剪、层级、固定定位、宽度溢出还是状态交互导致，并识别是否存在共同根因。
- 给出优先复用现有组件、避免复制移动端组件树的适配方案。
- 修改范围聚焦前端布局与交互，不改变后端接口或持久化格式。
- 桌面端布局和功能不得回归。

## Acceptance Criteria

- [x] 在典型手机宽度（至少覆盖 375px）下，Branches、Git 管理、系统提示词、子 Agent 管理和 GPT 账号额度入口点击后均能看到对应内容。
- [x] 各面板内容不会被顶部栏或视口边界完全裁掉，并可通过现有关闭方式关闭。
- [x] 面板宽度和高度受视口约束，超长内容可在面板内部滚动，不产生横向页面溢出。
- [x] 桌面端顶部功能入口和面板行为保持不变。
- [x] 实施后通过 `npm run lint` 与 `node_modules/.bin/tsc --noEmit`，或清楚记录无关的既有失败。

## Out of Scope

- 后端 API、账号额度计算、Git 操作或子 Agent 执行逻辑变更。
- 与本问题无关的全站移动端视觉重构。

## Validation Notes

- `npm run lint` 通过。
- `node_modules/.bin/tsc --noEmit` 通过。
- `git diff --check` 通过，仅报告仓库既有行尾转换提示。
- 使用 Chrome DevTools Protocol 在 375px、430px 和 1200px 视口验证五类面板均挂载到 `document.body`、使用 fixed 定位、保持在视口内，并支持内部点击、Escape 和 GPT 外部点击关闭。
- Trellis 独立检查未发现阻塞问题。
