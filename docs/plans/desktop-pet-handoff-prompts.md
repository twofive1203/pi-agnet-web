# Desktop Pet Task Observer — 新会话交接提示词

- **Date:** 2026-08-12
- **Plan:** [`2026-08-12-001-feat-desktop-pet-task-observer-plan.md`](2026-08-12-001-feat-desktop-pet-task-observer-plan.md)
- **Requirements:** [`../brainstorms/2026-08-12-desktop-pet-task-observer-requirements.md`](../brainstorms/2026-08-12-desktop-pet-task-observer-requirements.md)
- **Architecture:** [`../architecture/decisions/desktop-pet-task-observer.md`](../architecture/decisions/desktop-pet-task-observer.md)

本文档供新 Agent 会话直接复制使用。不要替代需求/架构/计划本身；实现仍以那三份权威文档为准。

## 用法

1. 新会话先发 **§1 总控提示词**。
2. 每完成一个 Phase，用对应 **§2 Phase 提示词** 开新会话或续聊。
3. 单 unit 卡住或要严格 test-first 时，用 **§3**。
4. 收尾审查用 **§4**。
5. 不要一次要求做完 U1–U8；按计划依赖推进。

可选加强句（可追加在任意提示词末尾）：

```text
默认中文回复；代码/命令/日志保持原文。
YOLO 实现，但每 unit 边界停一下做验证，不要一口气写完 U1–U8。
若计划与代码冲突：停止扩写，先给出冲突点与最小修正建议。
```

实操顺序：

| 顺序 | 粘贴内容 |
| --- | --- |
| 第 1 次 | §1 总控提示词（默认 Phase 1 / U1 起） |
| 会话变长/上下文脏了 | §2 Phase 1 续作 |
| Phase 1 完成后 | §2 Phase 2 |
| Phase 2 完成后 | §2 Phase 3 |
| Phase 3 完成后 | §2 Phase 4 |
| 全做完或可疑时 | §4 回归 / 收尾 |

---

## 1. 总控提示词（新会话第一条）

```markdown
# 任务：实现蜗牛派 Windows 桌宠任务观察器（Desktop Pet Task Observer）

## 角色
你是本仓库的实现 Agent。按既有需求/架构/计划交付，不重新 brainstorm，不扩大范围。

## 必读（按顺序完整阅读后再改代码）
1. `AGENTS.md`（项目入口与不变量）
2. `docs/brainstorms/2026-08-12-desktop-pet-task-observer-requirements.md`
3. `docs/architecture/decisions/desktop-pet-task-observer.md`
4. `docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md`
5. 交接提示词（本文上下文）：`docs/plans/desktop-pet-handoff-prompts.md`
6. 相关既有代码（按计划 “Current Code Context”）：
   - `lib/rpc-manager.ts`
   - `lib/agent-lifecycle.ts` / `lib/chat-prompt-lifecycle.ts`
   - `lib/subagent-progress.ts` / `lib/subagent-event-projection.ts`
   - `lib/workflow-chat-lifecycle.ts` / `lib/workflow-store.ts`
   - `lib/automation-store.ts` / `lib/automation-service.ts` / `lib/automation-run-registry.ts`
   - `lib/quick-command-runner.ts` / `lib/quick-command-types.ts`
   - `lib/automation-connection-context.ts` / `lib/automation-local-access.ts`
   - `lib/process-runtime.ts` / `app/api/health/route.ts`
   - `components/AppShell.tsx`、`WorkflowPanel.tsx`、`hooks/useAutomations.ts`
7. 编码规范：`docs/standards/code-style.md`
8. 模块文档：改 API/前端/lib 时同步更新 `docs/modules/{api,frontend,library}.md` 与必要 architecture 文档

## 产品硬边界（违反即错误）
- v1 = **attach-only 只读观察器**，不是完整桌面 WebUI，也不是服务进程管理器
- 桌宠 **不得** spawn/stop/restart/signal/supervise 蜗牛派服务，不得保存服务 PID
- 只能连 `127.0.0.1:<port>` 本地模式；拒绝远程、server-mode、多实例聚合
- 观察负载 **禁止** 含：cwd、Prompt/firstMessage、模型全文、工具参数、文件内容/路径、会话路径、Quick Command 命令/输出/env、密钥、原始 provider 错误
- 普通会话标题：用户显式命名优先；否则通用本地化标签；**禁止 firstMessage 兜底**
- 已读/未读仅桌面本地；不写回服务端任务状态
- 一条服务级有界快照 SSE；不为每会话建 SSE；elapsed 不单独抬 revision
- 通知按稳定 `transitionId` 去重；首次连接/reset/instanceId 变化的第一份快照只建基线，不追溯通知
- SnFlow 与宿主普通会话去重：一次 SnFlow 只有一个顶层 activity
- Subagent 嵌套展示，不顶层重复计数；Web Terminal 不观察
- 点击宠物 = 开关 Activity tray；点任务/通知 = 默认浏览器打开 WebUI deep link
- Electron renderer：`nodeIntegration:false`、`contextIsolation:true`、sandbox；token/cwd/任意 URL 不得进 renderer
- 桌宠安装包与 npm `spi` 分离；包内不打 Next/pi/native/node-pty/sidecar
- Windows 10/11 首版；macOS/Linux、服务自启动、皮肤商店等全部延后

## 交付节奏（严格按计划）
计划单元：U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8
阶段：
- Phase 1 = U1–U4（服务端 observer 底座）
- Phase 2 = U5–U6（deep link + 连接态机）
- Phase 3 = U7（桌宠 UI/通知/托盘）
- Phase 4 = U8（打包与发布验证）

**本次会话默认只做 Phase 1，从 U1 开始。**
未完成当前 unit 的验证前，不要进入下一 unit。
不要跳去做 Electron 窗口/美术/安装包，除非当前会话明确指定 Phase 3/4。

## 实现原则
- 最小必要修改；复用现有 loopback/token/lifecycle/projection 模式
- 先读再改；先 domain/纯函数与 smoke，再接线
- 计划写明 test-first 的 unit（尤其 U1、U4 access、U6 态机）必须先写/先跑 smoke
- 改 event/JSONL/RPC/config/共享常量前先搜全消费者
- 保持项目不变量：每 session 一个 wrapper；Automation 独立；observer 订阅者不是 chat SSE listener，不延长 settled 生命周期（除计划对 idle teardown 的明确修复）
- U2 必须修：idle teardown 只能在真正 settled 且无 active tools/Subagents/blocking UI 后开始；静默长工具不能因浏览器关闭被 10 分钟干掉

## 目标目录（以计划为准）
- `lib/task-observer-*.ts`、`lib/desktop-observer-access.ts`、`lib/desktop-deep-link.ts`
- `app/api/desktop-observer/**`
- `desktop/**`（Phase 3+）
- `scripts/smoke-task-observer.ts` 等计划中的 smoke
- `forge.config.ts`（Phase 4）

## 每个 Unit 完成定义
1. 代码按计划 Files 落地
2. 计划中的 Test scenarios 有对应 smoke/测试并实际执行
3. 相关 docs 已更新
4. 计划文件里把该 Unit 勾成 `[x]`，必要时在 unit 下补简短完成注记
5. 跑：
   ```bash
   npm run lint
   node_modules/.bin/tsc --noEmit
   ```
   以及本 unit 新增/相关 smoke
6. 输出：改动摘要、验证命令与结果、残留风险、下一 unit 是什么
7. 无法运行验证时必须写明“已完成静态检查，未执行运行验证”，禁止谎称已测通

## 明确不要做
- 不要重新写需求/另起架构替代 ADR（除非发现计划与代码严重冲突，先停下说明）
- 不要实现服务自动拉起、远程连接、内嵌 WebUI、任务写操作
- 不要把观察数据塞进 `/api/health`
- 不要用 `next build` 做日常开发验证；发布构建只用 `npm run build`
- 未经要求不要 commit/push/PR

## 开工动作
1. 确认工作区无半成品桌宠代码；若有，先盘点再续作
2. 从 **U1** 开始：`lib/task-observer-types.ts`、`lib/task-observer-projection.ts`、`scripts/smoke-task-observer.ts`
3. U1 验证通过后再做 U2

现在开始 Phase 1 / U1。
```

---

## 2. Phase 提示词

### Phase 1 续作 / 专注 U1–U4

```markdown
继续桌宠计划 Phase 1（U1–U4 only）。
权威文档：
- docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
- docs/architecture/decisions/desktop-pet-task-observer.md
- docs/brainstorms/2026-08-12-desktop-pet-task-observer-requirements.md
- docs/plans/desktop-pet-handoff-prompts.md

先盘点 U1–U4 哪些已完成、哪些未完成；从未完成的最小 unit 继续。
验收出口：CLI/fixture 能经一条本地安全 SSE 观察到 Agent/SnFlow/Automation/Quick Command；隐私字段为零；loopback/token/server-mode 门禁生效；`/api/health` 仍无任务元数据。
不要做 desktop/ Electron UI（U7）和打包（U8）。
每完成一个 unit：勾计划、跑 lint/tsc/相关 smoke、汇报残留风险。
```

### Phase 2（U5–U6）

```markdown
开始桌宠计划 Phase 2：U5 + U6。
前置假设：Phase 1（U1–U4）已完成且 smoke 通过；若没有，先补齐再继续。

权威文档：
- docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
- docs/architecture/decisions/desktop-pet-task-observer.md
- docs/brainstorms/2026-08-12-desktop-pet-task-observer-requirements.md
- docs/plans/desktop-pet-handoff-prompts.md

U5：`lib/desktop-deep-link.ts` + AppShell/Workflow/Automation/QuickCommand 一次性 query intent；相对 allowlist deep link；缺失目标有 unavailable fallback。
U6：`desktop/main/observer-client.ts`、`connection-state.ts`、`settings-store.ts`；态机 probing/connected/reconnecting/service-not-running/incompatible；拒绝端口显示“蜗牛派服务未启动”+ 可复制 `spi --no-open`；禁止任何 child_process/PID/signal。
主进程 fetch SSE（token 不进 renderer）。
只做 Phase 2；不做宠物动画/托盘完整产品（那是 U7）。
验证后勾计划并更新 docs。
```

### Phase 3（U7）

```markdown
开始桌宠计划 Phase 3：U7 Windows pet + Activity tray + notifications。
前置：U1–U6 完成。

权威文档：
- docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
- docs/architecture/decisions/desktop-pet-task-observer.md
- docs/brainstorms/2026-08-12-desktop-pet-task-observer-requirements.md
- docs/plans/desktop-pet-handoff-prompts.md

实现 `desktop/` 主进程/preload/renderer/assets；透明宠物、Activity tray、托盘、本地已读 LRU、通知策略、内置宠物 manifest、reduced motion、close-to-tray、click-through 恢复。
安全：preload 窄桥；main 校验 deep link 后才 `shell.openExternal`；renderer 无 token/Node/任意导航。
退出桌宠不得影响 `spi`/任务；Service not running 可复制命令但不可执行。
先纯状态（activity/read/notification）再接线窗口。
完成后跑 desktop contract smoke + lint/tsc，勾 U7，更新模块文档。
不做签名安装包完整发布矩阵（U8）。
```

### Phase 4（U8）

```markdown
开始桌宠计划 Phase 4：U8 pet-only Windows packaging + release validation。
前置：U7 可用。

权威文档：
- docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
- docs/architecture/decisions/desktop-pet-task-observer.md
- docs/brainstorms/2026-08-12-desktop-pet-task-observer-requirements.md
- docs/plans/desktop-pet-handoff-prompts.md

配置 Electron Forge 仅桌宠包；断言包内无 Next/pi/Automation worker/node-pty/sidecar；与 npm `spi` 发布分离。
补 `scripts/smoke-desktop-package.mjs`、`docs/operations/desktop-pet-validation.md`、deployment/troubleshooting/README 中独立启动说明。
尽量跑 AE1–AE13 与计划验证命令；不能跑的手动项写入 validation 文档并标明未执行。
完成后勾 U8；若全部完成，将计划 status 改为 completed，并更新 `docs/plans/README.md`。
```

---

## 3. 单 Unit 精细提示词

### U1

```markdown
只做计划 U1：observer identity/state/privacy contract。
创建：
- lib/task-observer-types.ts
- lib/task-observer-projection.ts
- scripts/smoke-task-observer.ts
修改 package.json 增加对应 test script（若项目惯例需要）。

必须覆盖：taskKey/activityId/transitionId；execution/outcome/attention 三轴；桌面优先级（含 Service not running/Disconnected 覆盖）；本地 ack；不确定进度；256KiB/行数预算；禁止字段无法序列化；时间流逝不抬 revision。
Test-first。不做 rpc-manager、不做 API、不做 Electron。
权威计划：docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
```

### U2

```markdown
只做计划 U2：普通 Agent prompt activity 可观察。
改 lib/rpc-manager.ts（及必要 lifecycle/subagent 复用），扩展 smoke-task-observer。
要点：promptEpoch；retry 仍属同一 activity；blocking extension_ui → Needs input（无文案/选项）；agent_settled 终态；idle teardown 仅 genuine settled；observer 访问不改变 chat SSE 计数/所有权；静默 tool + 零 browser listener 不被误杀。
先 characterize 现有事件边界再改。更新 overview/library 文档。
权威计划：docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
```

### U3

```markdown
只做计划 U3：SnFlow/Automation/Quick Command adapters + SnFlow host 去重。
新建 lib/task-observer-{snflow,automation,quick-command}.ts，接现有 store/registry；Quick Command 只暴露安全 summary/listener。
畸形 source 隔离；observer 失败不得让 source mutation 失败。
扩展 smoke。不做 hub HTTP。
权威计划：docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
```

### U4

```markdown
只做计划 U4：TaskObserverHub + /api/desktop-observer/* + desktop-observer-access。
复用/抽取 automation loopback 模式；拒绝非回环/server-mode/跨源；短时 hashed token；snapshot + SSE full snapshot；progress ≤500ms 合并；terminal/attention/retry 立即 flush；health 保持无任务元数据。
Access/Proxy 测试优先。扩展 server-auth/runtime 相关 smoke。更新 api/library/overview 文档。
权威计划：docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
```

### U5

```markdown
只做计划 U5：one-time WebUI deep links。
创建 lib/desktop-deep-link.ts；改 AppShell / WorkflowPanel / AutomationPanel / QuickCommand 相关路径。
相对 allowlist link；query intent 一次性消费；缺失目标 unavailable fallback；关闭面板后不被 rerender 强行重开。
补 scripts/smoke-desktop-deep-links.ts 与 frontend/library 文档。
权威计划：docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
```

### U6

```markdown
只做计划 U6：desktop connection client + service-not-running UX。
创建 desktop/main/observer-client.ts、connection-state.ts、settings-store.ts 与 scripts/smoke-desktop-connection.ts。
纯态机 test-first：probing/connected/reconnecting/service-not-running/incompatible。
只连 127.0.0.1；可复制 spi --no-open；禁止 child_process/PID/signal；token 仅 main。
权威计划：docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
```

### U7

```markdown
只做计划 U7：Windows pet + Activity tray + notifications。
实现 desktop/main|preload|renderer|assets 与 forge 初配、scripts/smoke-desktop-contract.ts。
先 activity/read/notification 纯状态，再窗口/托盘接线。
安全与 close-to-tray、reduced motion、本地 mark-read、通知去重按计划 Test scenarios 覆盖。
不做 U8 完整发布矩阵。
权威计划：docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
```

### U8

```markdown
只做计划 U8：pet-only Windows packaging + release validation。
硬化 forge.config、smoke-desktop-package、operations/desktop-pet-validation 与 deployment/README 说明。
断言包内无服务运行时；卸载不影响 ~/.pi/agent 与 spi。
完成后更新计划 status 与 docs/plans/README.md。
权威计划：docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
```

---

## 4. 回归 / 收尾提示词

```markdown
桌宠功能按计划应已实现到 [填写：U4 或 U7 或 U8]。
请只做审查与补缺，不扩 scope：
1. 对照 requirements AE1–AE13 与计划 Success Metrics 逐条核对
2. 搜是否泄漏 cwd/firstMessage/prompt/command/output/env/path/raw error
3. 搜 desktop 是否出现 child_process/spawn/kill/pid 服务管理代码
4. 跑：
   npm run lint
   node_modules/.bin/tsc --noEmit
   以及计划 Validation Commands 中相关 suites / desktop smokes
5. 列出缺口、风险、建议补丁；先报告再经确认后修复

权威文档：
- docs/brainstorms/2026-08-12-desktop-pet-task-observer-requirements.md
- docs/architecture/decisions/desktop-pet-task-observer.md
- docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md
- docs/plans/desktop-pet-handoff-prompts.md
```

---

## 维护说明

- 若计划 unit 拆分、退出条件或硬边界变化，先改计划/ADR/需求，再同步本文提示词。
- 本文不是执行状态源；unit 完成勾选仍写在 `2026-08-12-001-feat-desktop-pet-task-observer-plan.md`，总状态看 `docs/plans/README.md`。
