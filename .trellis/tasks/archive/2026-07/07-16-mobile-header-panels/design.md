# Design: 移动端顶部功能面板适配

## Root Cause

手机断点将 `.app-top-bar` 设为横向滚动容器：

```css
overflow-x: auto;
overflow-y: hidden;
-webkit-overflow-scrolling: touch;
```

顶部弹层仍作为该容器的后代渲染。System、Subagents、Git 和 Branches 虽使用 `position: fixed`，但没有脱离滚动容器 DOM；在移动浏览器尤其是 WebKit 的滚动/裁剪上下文中不可靠。ChatGPT 额度详情问题更直接：它使用绝对定位和固定 `380px` 宽度，因此会被 36px 高的顶部滚动容器裁剪，并在 375px 视口越界。

这与此前聊天输入工具选择器的移动端缺陷属于同一类问题；项目现有规范要求滚动工具栏的浮层通过 portal 挂载到 `document.body`。

## Proposed Approach

1. 为顶部浮层复用统一的“触发器矩形 + fixed + portal”模式。
2. AppShell 的 System、Subagents、Git 共用面板继续保留单一 active state，但将面板 portal 到 `document.body`。
3. 让 `BranchNavigator` 的 inline 面板也通过 portal 脱离顶部栏。
4. `ChatGptUsagePanel` 在打开时读取按钮矩形，将详情面板 portal 到 `document.body`；桌面端保持靠右锚定，手机端使用左右安全间距和视口宽度约束。
5. 增加语义 CSS class，在 `max-width: 640px` 下统一限制宽高、内部滚动和安全边距；不复制组件树。
6. 保留 `.app-top-aux-panel` class，使 AppShell 现有 outside-pointer/focus 判定在 portal 后仍把弹层视为安全区域。

## Boundaries

- 主要文件：`components/AppShell.tsx`、`components/BranchNavigator.tsx`、`components/ChatGptUsagePanel.tsx`、`app/globals.css`。
- 不修改 Git、额度、系统提示词或子 Agent 的数据请求和业务逻辑。
- 不改变 API、配置或持久化格式。

## Interaction and Accessibility

- System、Subagents、Git、Branches 继续保持同组互斥，并支持现有外部点击、失焦和 Escape 关闭。
- GPT 额度面板应补齐一致的外部点击与 Escape 关闭；点击面板内部不得误关闭。
- 保留触发按钮的 `aria-expanded`；如补充面板语义，使用稳定 id 与 `aria-controls`。

## Compatibility

- 桌面端保留当前锚点、宽度和视觉样式。
- 手机端面板不依赖顶部栏的滚动位置，宽度不超过可视视口，最大高度使用动态视口单位并在内部滚动。
- 旋转屏幕或视口尺寸变化时，应重新计算位置或关闭短生命周期浮层，避免使用陈旧坐标。

## Risks and Rollback

- Portal 改变 DOM 层级，outside-click 判定必须继续覆盖 portal 节点。
- GPT 面板拥有独立 open state，实施时需要避免和共享顶部面板产生遮挡或意外互相关闭。
- 回滚只需恢复原内联渲染和相关 CSS，无数据迁移。
