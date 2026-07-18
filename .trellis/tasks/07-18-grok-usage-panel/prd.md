# Grok structured usage panel

## Goal

用蜗牛派服务端直连 xAI Grok CLI billing API，提供结构化 Grok 用量数据；在对话框顶栏右上角增加可选 Grok 用量面板（交互对齐 ChatGPT 面板），并替换 Models → Grok CLI → Subscription 里依赖 `/grok-cli-usage` 扩展命令桥的文本用量视图。

## Background

- 当前 Grok 用量仅存在于 Models 页：`POST /api/auth/usage/grok-cli` → `runExtensionCommand("grok-cli-usage")`，强依赖 `pi-grok-cli` 扩展命令与 workspace cwd，返回纯文本 notices。
- `pi-grok-cli@0.5.0` 内部已有可复用的结构化 billing 契约：
  - `GET {baseUrl}/billing`
  - `GET {baseUrl}/billing?format=credits`
  - Header: `Authorization: Bearer <token>` + `x-xai-token-auth: xai-grok-cli`
  - Monthly: `used / monthlyLimit / billingPeriodEnd`
  - Weekly (optional): `creditUsagePercent / billingPeriodEnd`
- ChatGPT 顶栏面板参考：`components/ChatGptUsagePanel.tsx` + Settings `chatgpt.usagePanelEnabled`。
- 本任务不复制 Grok OAuth / streaming / tools，只复制 billing 查询与展示所需契约。

## Confirmed Decisions

1. **数据源方案 A**：服务端直连 xAI billing，返回结构化用量；不再通过扩展命令桥查询用量。
2. **刷新策略**：仅手动刷新；不做后台 scheduler / 定时自动刷新。
3. **Models 页旧视图**：直接替换命令桥文本展示；不再保留 `/grok-cli-usage` 文本双轨。
4. **缓存策略 A**：持久化 last-known 成功结果；面板/Models 打开时先显示缓存，手动刷新才请求 billing。

## Requirements

### Structured usage API

- 提供服务端 Grok 用量查询能力，从 Pi `AuthStorage` / `ModelRegistry` 读取已登录 `grok-cli` access token（兼容 env bypass 若项目已有同类路径，但优先 OAuth 存储）。
- 直连 xAI Grok CLI billing endpoint，解析 monthly / optional weekly 为结构化字段。
- 响应不得返回 access token、refresh token 或原始 credential 对象。
- 未登录 / token 无效 / billing 失败时返回可操作的 browser-safe 错误，不抛出原始内部堆栈。
- 支持读取 last-known 缓存，以及手动刷新写入缓存（仅成功结果落盘）。

### Top-bar Grok usage panel

- 在对话框顶栏右上角增加 Grok 用量面板，交互与视觉对齐现有 ChatGPT 面板（触发按钮 + 固定定位 popover + 手动刷新）。
- Settings / `pi-web.json` 增加开关（默认关闭，与 ChatGPT 面板一致），开启后显示面板。
- 面板展示至少包括：
  - Monthly used / limit / remaining / utilization
  - Monthly reset 时间
  - Weekly utilization / reset（有数据时）
  - 上次查询时间、加载中、错误态
  - 打开时先展示 last-known 缓存（若有）
- 不提供自动后台刷新、多账号切换、reset-credit 消耗。

### Models Subscription replacement

- Models → Grok CLI → Subscription 的用量区改为同一结构化数据源与结构化展示。
- 移除对 `POST /api/auth/usage/grok-cli` / `runExtensionCommand` / 文本 notices 渲染的依赖（若该 runner/route 无其他消费者则一并删除或收敛）。
- 不再要求为查询用量选择 workspace cwd。
- 打开详情时先读缓存；手动刷新更新。

### Documentation

- 更新 `docs/modules/api.md`、`docs/modules/frontend.md`、`docs/integrations/README.md`（及如有配置项文档的 `AGENTS.md` / deployment 配置索引）说明：
  - 新的结构化 usage 来源与 endpoint
  - 顶栏面板与 Settings 开关
  - last-known 缓存位置与刷新语义
  - 与 `pi-grok-cli` 的边界：OAuth/模型仍依赖扩展；用量查询不再依赖扩展命令

## Out Of Scope

- Grok 多账号管理 / 账号切换
- 后端自动刷新 scheduler / 定时轮询
- 复制或维护 Grok OAuth、streaming、Imagine、vision、Cursor 工具
- 安装 / 更新 / 卸载 `pi-grok-cli` 的 UI
- 解析或继续展示 `/grok-cli-usage` 原始 notify 文本

## Open Questions

None remaining for MVP.

## Acceptance Criteria

- [ ] 已登录 `grok-cli` 时，服务端结构化 usage API 可返回 monthly（及可用时 weekly）用量、reset 时间与 queriedAt。
- [ ] 成功查询会写入 last-known 缓存；后续读取可先返回缓存而不打 billing。
- [ ] Settings 可开关顶栏 Grok 用量面板；开启后顶栏显示面板，关闭后不显示。
- [ ] 顶栏面板支持手动刷新，展示 used/limit/remaining/utilization/reset 与错误态；无自动后台刷新。
- [ ] Models → Grok CLI → Subscription 使用同一结构化展示，不再调用扩展命令桥或渲染 notices 文本。
- [ ] 旧 `auth/usage` 命令桥路径对 Grok 的依赖被移除；无其他消费者时清理相关代码。
- [ ] API 响应不包含 credential/token；失败信息 browser-safe。
- [ ] 文档已更新 usage 来源、面板开关、缓存与 `pi-grok-cli` 边界。
- [ ] `npm run lint` 与 `node_modules/.bin/tsc --noEmit` 通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Complex task: also produce `design.md` and `implement.md` before `task.py start`.
