# Implementation Plan: 移动端顶部功能面板适配

## Ordered Checklist

1. 在 `components/AppShell.tsx` 中将共享顶部面板迁移为 body portal，保留现有 active state、定位和 outside-click 安全选择器。
2. 在 `components/BranchNavigator.tsx` 中对 inline 分支面板应用同一 portal 模式。
3. 在 `components/ChatGptUsagePanel.tsx` 中记录触发器矩形，将额度详情改为 viewport-fixed portal，并补齐移动端可靠的关闭交互。
4. 在 `app/globals.css` 中增加顶部浮层的手机端视口约束、安全边距、动态高度和内部滚动规则。
5. 搜索并检查所有 `.app-top-aux-panel` 与顶部栏弹层调用点，确保没有遗漏同类裁剪风险。
6. 更新 `docs/modules/frontend.md`；若形成新的项目级约束，同步 `.trellis/spec/frontend/component-guidelines.md`。

## Manual Validation

- 375px 和 430px 宽度下依次打开 Branches、System、Subagents、Git 和 GPT 额度。
- 顶部栏分别处于最左和横向滚动到最右时重复打开各面板。
- 验证面板完整可见、内部可滚动、页面无横向溢出，并可通过外部点击和 Escape 关闭。
- 验证点击面板内部按钮、列表和 Git 控件不会被 outside-click 误判。
- 在桌面宽度验证面板锚点、尺寸、互斥关系和内容交互无回归。
- 验证手机横竖屏切换或 resize 后面板不会留在错误位置。

## Commands

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

## Risky Files / Rollback Points

- `components/AppShell.tsx`：共享面板 portal 与 outside-click 交互。
- `components/ChatGptUsagePanel.tsx`：独立 open state、异步刷新和详情面板交互。
- `components/BranchNavigator.tsx`：迁移 inline 面板时避免与 AppShell 的受控 open state 冲突。
- `app/globals.css`：手机断点必须避免影响桌面样式。

规划获用户批准前不执行实现。
