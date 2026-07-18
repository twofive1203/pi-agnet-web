# Support pi Grok provider extension

## Goal

在蜗牛派 Models 页的 Grok CLI `Subscription` 区域展示 `pi-grok-cli` 扩展提供的账号用量，让已登录用户不必切回 Pi TUI 手动执行 `/grok-cli-usage`，即可查看月度 allowance、已用和剩余 credits、重置时间及可选周用量。

## Confirmed Facts

- `pi-grok-cli` 0.5.0 要求 Pi 0.80.0+；项目当前使用的 Pi CLI 是 0.80.7。
- 扩展通过 `pi.registerProvider()` 动态注册 `grok-cli` provider、OAuth 和模型，不是 `models.json` API Key provider。
- 扩展还注册 Grok usage、Imagine、vision 命令，以及 `image_gen` 和部分模型专用的 Cursor 兼容工具。
- Web 会话已经加载 Pi packages，并以 RPC 模式绑定扩展；默认 `all` 工具预设会动态包含扩展工具。
- `/api/commands` 和 `/api/pi/resources` 会创建临时 SDK 会话，因此能发现扩展命令、工具及加载诊断。
- 用户已执行 `pi install npm:pi-grok-cli` 并卸载 `pi-xai-oauth`。
- 用户已在蜗牛派 Providers 页面完成 `grok-cli` OAuth，模型列表和实际会话调用均正常；provider 接入链路不是当前缺口。
- Models 页的通用 OAuth 详情标题为 `Subscription`，但结构化额度视图目前只对 `openai-codex` 启用，Grok CLI 登录后只显示连接状态。
- `pi-grok-cli` 没有公开结构化 usage API；它公开 `/grok-cli-usage` 扩展命令，命令通过 `ctx.ui.notify()` 输出月度 credits、剩余 credits、重置时间和可选周用量。
- 直接复制扩展的 `/billing` 请求、OAuth header 和 payload parser 会形成脆弱的双重实现；应通过 Pi 扩展命令和 Web UI bridge 获取扩展自己的结果。

## Requirements

- Grok CLI 已登录时，`Subscription` 区域能主动刷新并显示 `/grok-cli-usage` 返回的当前用量。
- 用量查询必须通过已安装扩展的注册命令执行，不复制或导入 `pi-grok-cli` 的内部 billing/OAuth 实现。
- 执行命令时使用当前工作目录生效的 Pi package 配置和现有认证存储。
- 展示加载中、成功、未安装、未登录、扩展命令缺失及查询失败状态；错误不影响其他 OAuth providers。
- 不把 OAuth token、callback URL 或原始凭据发送到浏览器。
- 保持现有 Grok OAuth、模型选择、会话、slash command 和工具行为不变。

## Acceptance Criteria

- [x] 已安装并登录 `pi-grok-cli` 时，Grok CLI `Subscription` 区域可查询并显示月度用量、剩余额度和 reset 时间。
- [x] 扩展返回 weekly usage 时一并显示；未返回时不伪造周额度。
- [x] 刷新操作调用扩展注册的 `grok-cli-usage` 命令，并保留扩展返回的 warning/error 语义。
- [x] 未安装扩展、命令不可用、凭据过期或网络失败时显示可操作错误，不泄露 token。
- [x] 查询所创建的临时 SDK 会话总能释放，不污染聊天 session registry 或 JSONL。
- [x] 其他 OAuth provider 详情页及现有 Grok 登录/模型功能无回归。
- [x] lint 与 TypeScript type-check 通过；命令执行与结果归一化有针对性验证。
- [x] 集成文档说明用量来源是扩展命令，并注明 `pi-grok-cli` 最低 Pi 版本和安装方式。

## Out Of Scope

- 复制或维护 xAI billing、OAuth、模型目录、streaming 协议和 Cursor 兼容工具实现。
- 添加 Pi package 安装、更新或卸载 UI。
- 为 Grok 添加多账号管理、自动后台刷新或顶部常驻用量面板。

## Open Questions

None. The user confirmed that the first version should display the extension command's original text output with a refresh action, without parsing it into progress bars.
