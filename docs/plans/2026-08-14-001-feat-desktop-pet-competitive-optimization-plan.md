---
title: "feat: Desktop pet competitive optimization (Codex / Claude / Clawd benchmark)"
type: feat
status: active
date: 2026-08-14
origin: docs/research/desktop-pet-improvements-2026-08-13.md
architecture: docs/architecture/decisions/desktop-pet-task-observer.md
revised: 2026-08-14
---

# feat: Desktop pet competitive optimization (Codex / Claude / Clawd benchmark)

## Overview

对标 OpenAI Codex Pets、Claude Code `/buddy`、Anthropic `claude-desktop-buddy` 参考实现及开源项目 Clawd on Desk，梳理蜗牛派桌宠可借鉴的后续优化点，并按现有 observer、Electron 和隐私边界形成可执行 backlog。

本规划是 **active backlog**：调研和项目事实复核已完成。U1 Running 工作细分、U2 真实上下文占比视觉化、U7a DND、U4a 声音提示与 U4b 趣味点击反应已落地。其余单元仍待实现。已落地能力（8 态呈现、Activity tray、spritesheet 运行时、庆祝去重、Running 主循环重做、终态文案解耦、启动/重连 baseline、Running cue、主 activity 上下文环、DND 静音、needs_input/ready 短音等）见：

- `docs/research/desktop-pet-improvements-2026-08-13.md`
- `docs/architecture/decisions/desktop-pet-task-observer.md`
- `docs/operations/desktop-pet-validation.md`

本文只记录竞品对标带来的**新增优化点**，不把已有能力重复列为缺口。

### Evidence notes

竞品信息的证据强度不同，规划时不得把社区提案或宣传文案当成已发布能力：

- **高可信**：竞品官方仓库/README 和蜗牛派当前源码。
- **中可信**：引用官方发布内容的媒体报道；实现细节仍需在立项时复核。
- **低可信/仅作灵感**：第三方博客、社区 issue 和功能提案。

特别修正：

1. Codex `/pet`、`/hatch` 和自定义宠物有官方发布内容与媒体交叉印证；Codex issue #21657 是**社区交互 hooks 提案**，不是已发布 API。
2. Claude Code `/buddy` 的物种、稀有度和属性可作为身份感/收藏感参考，但公开 issue 明确描述其现状为基于账户确定、不会随使用成长；不能写成“属性随活动变化”。目前也缺少稳定官方产品文档，因此只作为低优先级灵感。
3. `anthropics/claude-desktop-buddy` 是 Anthropic 官方账号下的开源 BLE **参考实现**，其 README 明确说明 API 需 Developer Mode，且不是正式支持的产品能力；不应描述成已商业化的“官方硬件桌宠”。
4. Clawd on Desk 的功能事实主要来自其项目 README，属于项目方自述。其代码采用 AGPL-3.0，且仓库明确说明部分美术资产不在 AGPL 授权内；蜗牛派只能借鉴交互思想，不能直接复制实现或资产。

| 竞品 | 形态 | 可借鉴点 | 证据级别 |
| --- | --- | --- | --- |
| OpenAI Codex Pets | Codex App 桌面悬浮宠物（`/pet`、`/hatch`） | 被动状态监视、自定义宠物生成和分享生态 | 中（官方发布 + 媒体） |
| Claude Code `/buddy` | 终端 ASCII 彩蛋 | 确定性物种/稀有度带来的身份感；不代表已有养成成长 | 低（第三方报道 + 社区 issue） |
| Anthropic `claude-desktop-buddy` | BLE maker API 的 ESP32 参考桌宠 | 将“等待授权”变为显式、就近的批准/拒绝交互 | 高（官方仓库） |
| Clawd on Desk（调研时约 5.9k★） | 支持 Pi 等多代理的 Electron 桌宠 | 工作细分、授权气泡、Session HUD、资源环、睡眠、迷你模式、DND、PWA | 高（开源仓库自述，可查源码） |

蜗牛派桌宠与 Clawd on Desk 在 Electron 常驻桌宠和本地代理观察方面相近，但蜗牛派坚持 **attach-only、服务端权威投影、最小隐私 payload**。对标时不能直接照搬 Clawd 的 hooks、进程探测、远程授权或服务所有权模型。

---

## Competitive Gap Map

「✅ 已有」「➕ 本规划新增」「△ 已有基础但需增强」「⏸ 延期/不进入近期范围」

| 能力 | 竞品参考 | 蜗牛派现状 | 归属 |
| --- | --- | --- | --- |
| 8 态呈现 + Activity tray + 筛选 | Codex / Clawd | 已实现 | ✅ |
| 子代理感知 | Clawd | `children`、`activeSubagents` 已采集并可展开 | △ U1 增强主视觉 |
| 细粒度工作提示（思考/编辑/命令/子代理） | Clawd 12 态 | 主视觉仅 Running；Agent 行已有原始工具名/子代理计数 | ➕ U1 |
| 资源展示 | Clawd Orbit rings | Agent 行保留上下文、TPS、费用/Token 文本；主视觉旁仅对主 Agent `context.percent` 画静态环 | ✅ U2 |
| needs_input 桌面直接响应 | Claude Desktop Buddy / Clawd | 仅状态提示 + 单击打开最高优先级任务 | ➕ U5（先做可行性与安全设计） |
| 自定义宠物包 / Codex Pet 包导入 | Codex `/hatch` / Clawd | 仅内置 manifest 与 spritesheet；无用户导入 | ➕ U6（独立安全设计） |
| 渐进式睡眠 | Clawd | idle 随机小动作；无按 idle 时长分级 | ➕ U3 |
| 趣味点击反应 | Clawd | 无；现有单击承担 tray/needs_input 直达 | ➕ U4 |
| 声音提示 | Clawd | needs_input/ready 短音已落地（U4a，主默认关、事件开关、冷却、DND 静音）；趣味交互已落地（U4b，idle 双击 poke / 四连击 flail，非关注状态不触发） | △ U4（U4a、U4b 均已交付） |
| 迷你模式 | Clawd | 无 | ➕ U7 |
| Do Not Disturb | Clawd | 无应用级 DND | ➕ U7（U4 声音的前置策略） |
| 启动/重连 baseline | Clawd | 已实现：重新 attach 后建立 baseline，不回放历史通知 | ✅（补实机证据，不重复立项） |
| 进程存活检测 | Clawd | 服务端 observer 是权威来源；桌宠不拥有或探测 Agent 进程 | ⏸ 不照搬 |
| i18n | Clawd 多语言 | Electron 桌宠中文写死，未接入独立 catalog | ➕ U7 |
| 养成 / 稀有度彩蛋 | Claude `/buddy` | 无；原规划排除养成 | ⏸ |
| 移动端只读伴侣 | Clawd PWA | 无 | ⏸ |

---

## Decision Rules

所有工作单元先遵守以下规则：

1. **不伪造指标**：只有真实分母的数据才能画进度环。Token、费用和 TPS 没有配额/目标时只能显示数值或趋势，不能画“剩余比例”。
2. **不扩大 observer 隐私面**：Prompt、审批正文、工具参数、路径、命令、输出和 raw error 继续禁止进入桌宠。
3. **不改变 attach-only**：桌宠不启动、停止、探测或接管 `spi`/Agent 进程。
4. **聚合状态与工作细分分层**：8 态 `TaskObserverPresentationState` 仍决定注意力优先级；工作细分只能作为 Running 的 renderer 修饰，不新增全局状态。
5. **竞品代码与资产仅作参考**：不复制 Clawd AGPL 实现或非开源美术；导入的第三方宠物必须有来源/许可提示。
6. **先解决选择语义**：任何主视觉、资源摘要或快捷操作都必须明确由哪一条 activity 驱动，不能把多个项目/会话的数据静默合并。

---

## Proposed Work Units

### U1 — Running 工作细分提示（P1，先做 renderer modifier）

**用户价值**：用户可区分“模型思考”“文件编辑”“命令执行”“子代理协作”，无需打开 Activity tray 才知道当前在做什么。

**现有数据与限制**：

- 仅普通 Agent 的 `progress.kind=counters` 可能包含 `currentToolName`、`activeSubagents`、`completedSubagents`。
- `currentToolName` 是当前活动工具 Map 中遇到的第一个非 Subagent 原始名称；多个工具并行时不代表完整工作阶段，工具结束后也会消失。
- SnFlow、Automation、Quick Command 不保证提供工具名，必须继续回退普通 Running。
- 主宠物展示聚合状态；当前 renderer 的 primary activity 取排序后第一个项目的第一条活动。同优先级跨项目时可能受项目名排序影响，因此不能未经定义就拿它驱动资源/工作细分。

**建议范围**：

1. 新增纯函数 `resolveRunningCue(activity)`，输出有限枚举：`thinking | editing | command | subagent_one | subagent_many | generic`。
2. 使用本地 allowlist 将已知工具名归类；未知、缺失、多个冲突或非 Agent 来源回退 `generic`，不向 manifest/CSS 注入原始工具名。
3. 明确驱动 activity：按 presentation 优先级、是否 active、`updatedAt` 倒序选择；选择器写成纯函数并复用于 caption/bubble，避免项目名字典序意外决定主动画。
4. 首期只增加 CSS class、glyph 或小型 overlay modifier，保留现有 Running 主循环；不修改 8 态契约和 manifest v2。
5. spritesheet 宠物首期复用 Running 帧并叠加非资产提示。若未来需要每种 cue 的独立序列帧，应另行演进 manifest schema，不能声称 manifest v2 已支持子状态。
6. 对工具高频切换做最短驻留/防抖，但 needs_input、blocked、ready 等高优先级状态必须立即打断。

**验收要点**：工具分类、未知回退、并行工具、1/2+ Subagent、非 Agent 回退、主 activity 选择、防抖取消、reduced-motion 静态提示。

### [x] U2 — 上下文占比与资源摘要视觉化（P1，增量增强）

**用户价值**：在当前 Agent 接近上下文窗口上限时提供一眼可见的风险提示，并保留 TPS、费用/Token 的紧凑只读摘要。

**事实修正**：`sessionResources` 已经在 Activity tray 的 Agent 行中以文本展示，并非“完全未渲染”。当前数据也不是 Clawd 所展示的订阅 quota window，不能据此宣称“还剩多少订阅额度”。

**建议范围**：

1. 仅 `context.percent` 具备真实分母，可渲染为静态环/条；同时保留可读数字和 `aria-label`。
2. `billing.totalTokens`、`billing.costUsd`、`performance.avgTps` 继续作为数值摘要，不画无依据的百分比环。
3. Activity tray 每条 Agent 行可显示自身指标；宠物旁的紧凑摘要只能显示明确选中的主 Agent activity，不跨会话求和，也不借用其他活动的数据。
4. 当前主 activity 为非 Agent、资源缺失或 snapshot stale 时隐藏紧凑环，不显示 0%。
5. 提供关闭开关；reduced-motion 下保持静态，颜色以外还需有数字/形状提示。

**验收要点**：0/临界/100%、`percent=null`、缺失数据、stale snapshot、非 Agent 主活动、多 Agent 不串值、键盘/读屏和小中大尺寸。

**Completed:** 2026-08-14 — 复用 U1 `selectPrimaryActivity`；仅主 Agent `context.percent` 画静态环；settled/ready 主 activity 可展示自身百分比；非 Agent / null / 无效 / stale / 关闭开关时隐藏，不伪造 0%；Activity tray 文本摘要保留；`showContextMeter` 默认开启并在 v1 settings 内迁移。

### U3 — 渐进式 idle / 睡眠表现（P2，含资源成本）

**用户价值**：让长时间空闲更有生命感，同时不把“应用 idle”误报成“用户离开电脑”。

**范围澄清**：首期依据“宠物进入 idle 状态后的本地时长”，不称为系统离开检测。renderer 只能可靠感知自身窗口交互；若要根据全局系统空闲时间唤醒/入睡，需要 Electron main 的 `powerMonitor` 方案和单独评审。

**建议范围**：

1. 基于进入 idle 的时间分为 awake idle → sleepy → sleeping；任意宠物窗口交互恢复 awake idle。
2. 状态离开 idle、窗口隐藏、reduced-motion 或 renderer destroy 时清理 timer；重新显示窗口时从 awake idle 恢复，避免后台计时后突然深睡。
3. CSS 宠物可使用 modifier；spritesheet 宠物需要可接受的静态/复用帧回退。正式多阶段美术应计入成本，不能标为纯逻辑低成本。
4. 睡眠是装饰状态，不进入 observer wire 状态、不触发通知、不覆盖 needs_input/blocked/ready。

**验收要点**：阈值边界、timer 取消、隐藏/恢复、状态抢占、交互唤醒、spritesheet 回退、reduced-motion。

**Completed:** 2026-08-14 — 新增 renderer-local 装饰睡眠阶段：`pet-state.ts` 纯函数 `resolveIdleSleepStage` / `nextIdleSleepBoundaryMs` / `shouldRunProgressiveSleep` / `reduceIdleSleepState`（阈值 `PET_SLEEPY_AFTER_MS=45_000`、`PET_SLEEPING_AFTER_MS=120_000` 与 `PET_IDLE_POINTER_WAKE_THROTTLE_MS` 集中定义）；`pet-app.tsx` 以单一本地 timer 推进 awake→sleepy→sleeping，同态 snapshot/资源刷新/revision 不重置 idle 起点，离开 idle、hidden、reduced-motion、press/drag 立即回 awake 并取消 timer；pointerdown/hover（sleepy/sleeping 才主动唤醒、节流）/键盘/开 tray/开设置/开始拖动唤醒且不触发打开任务、mark read；`pet.css` 提供低幅度半闭眼/闭眼 + 缓慢呼吸 + z/Z glyph overlay（spritesheet 复用 idle 帧、不加 manifest v2 子状态）；未引入 powerMonitor/系统级监听、不持久化、睡眠阶段不写 observer/tray/settings/服务端。

### U4 — 声音提示与趣味交互（P2，拆分交付）

**用户价值**：声音用于功能提醒，趣味动作增强情感反馈；二者应分别控制，避免为了趣味功能引入打扰。

**现状修正**：needs_input / blocked 当前是**单击**直达最高优先级任务，并有 Enter/Space 键盘路径，不是“双击直达”。普通状态单击仍切换 Activity tray。

**建议范围**：

- **U4a 声音**：完成和 needs_input 短音；独立总开关、事件开关、冷却和音量上限。WebUI 与桌宠同时运行时应避免明显重复提示。DND 启用后必须静音。
- **U4b 趣味动作**：只在非 needs_input/blocked 状态启用 poke/flail；先设计 click-sequence resolver，再决定双击/连点是否消费普通单击，不能让 tray 连续开合或延迟紧急直达。
- reduced-motion 下用短暂静态表情或不播放；声音不能成为唯一状态线索。

**依赖**：U4a 在没有 U7 DND 时可先以独立静音开关交付，但完整验收必须覆盖 DND；U4b 依赖现有拖动阈值、pointer capture 和键盘路径回归。

#### [x] U4a — 声音提示

**Completed:** 2026-08-14 — 新增纯策略模块 `desktop/main/sound-policy.ts`（参考 notification-controller 结构）：仅 `needs_input`→`attention`、`ready`→`completion` 可发声，blocked/running/retrying/连接状态不发声；初始连接、reset、instanceId 变化与重连 baseline 播种有界独立 `soundedTransitionIds` LRU 且不播放；设置门控（`sound.masterEnabled` 默认关闭 + 独立 `needsInput`/`completion` 开关，master 关闭时保留事件开关）、DND 门控（`surface: "sound"`）与每类 10 秒冷却统一消费被抑制的 transition（关闭 DND / 开启设置 / 冷却结束均不补播）；SSE replay 与相同 transition 去重。settings v1 不变，旧文件缺 `sound`/`soundedTransitionIds` 时按默认迁移并过 normalize/serialize/forbidden-key。main 经窄 IPC `pet:sound-cue` 只推有限枚举（renderer 不可发送、不可传路径/URL/音频参数），preload 只暴露只读 `onSoundCue` 并校验枚举。renderer `pet-sound.ts` 用本地 Web Audio 合成（固定频率/时长、音量上限 0.06、单次≤300ms、无文件/网络/队列，AudioContext 缺失/suspended/播放异常静默失败，destroy 释放 context）；不新增 CSP `media-src`、不引入第三方播放依赖。设置面板提供总开关+两个事件开关+“声音已被勿扰模式静音”提示，托盘提供 checked 状态的“声音提示”总开关。不改 `acknowledgedTransitionIds`/未读状态/服务端 transition，不修改 WebUI `useAudio`。策略与 IPC 已自动验证；Windows 实际音频播放仍需实机验证。

**验收要点**：单击直达优先、拖动不计点击、双击/四连击判定、冷却、DND、WebUI 重复声音、系统无音频设备、reduced-motion。

#### [x] U4b — 趣味点击反应

**Completed:** 2026-08-14 — 新增 renderer-local 趣味反馈 poke（双击）与 flail（四连击）。纯函数集中在 `pet-state.ts`：`reducePetClickSequence`（点击序列 reducer，首击立即单点、后续点击不再开合 tray、flail 覆盖并取消未播放的 poke）、`resolvePetReaction(clickCount, elapsedMs)`、`shouldAllowPetReaction(presentation, reducedMotion)`，时间常量 `PET_DOUBLE_CLICK_INTERVAL_MS=320`、`PET_QUAD_CLICK_WINDOW_MS=900`、`PET_POKE_ANIMATION_MS=380`、`PET_FLAIL_ANIMATION_MS=750`。`pet-app.tsx` 仅 idle 允许反应；needs_input/blocked 保持现有单击直达，其余状态单击切换 tray；拖动过阈值、pointercancel、lostpointercapture、窗口隐藏、状态抢占与 renderer destroy 均调用 `cancelClickSequence()` 清理 sequence/timer/class；宠物聚焦时 `P` 触发 poke、`Shift+P` 触发 flail，并在 aria-label/title 说明快捷方式（趣味动作不成为任何业务状态唯一表达）。`pet.css` 新增低幅度、可中断 `reaction-poke`/`reaction-flail` wrapper transform（spritesheet 复用现有帧，不改 manifest v2，不遮挡 U1 工作提示/U2 context meter/未读 badge/状态 caption）。reduced-motion 下不播放位移动画（JS 门控 + 全局 reduced-motion 规则双保险）；DND 不阻止用户主动触发；不新增声音、不改 U4a 声音偏好/冷却/sounded LRU；不写 observer wire、8 态契约、settings schema。纯逻辑已自动验证；Windows 实际手势/动画仍需实机视觉验证。

### U5 — needs_input 桌面响应通道（先做 feasibility/security，禁止直接实现）

**用户价值**：减少 Agent 安静等待阻塞输入时的上下文切换。

**当前阻塞点**：

- observer 只暴露 `attention=needs_input` 和安全 phase；`BLOCKING_EXTENSION_UI_METHODS` 仅用于服务端识别阻塞请求，**方法名、request id、Prompt、选项和响应能力都没有进入桌宠 payload**。
- `select`、`confirm`、`input`、`editor` 不是统一的“批准/拒绝”模型；只显示方法名无法让用户做出安全、知情的决定，也无法构造正确响应。
- 当前 preload/API 是只读观察与安全 deep link，不存在桌宠写回 Agent 的授权通道。

**第一阶段只产出独立 requirements/design/plan，至少回答**：

1. 哪些请求类型允许桌面处理；建议先评估低风险 `confirm`，`input/editor/select` 默认仍打开 WebUI。
2. 用户做出知情决定所需的最小安全摘要是什么；不得仅凭“confirm”或工具名盲批。
3. request identity、过期、竞态、终端/WebUI 已响应后的幂等和撤销语义。
4. loopback、短期 capability、IPC/API、CSRF/same-origin 和审计边界。
5. 全局热键的前台归属、可见请求绑定、防误触和高风险操作禁用规则。
6. DND 时只能隐藏桌面气泡并回退 WebUI 原生流程，不能自动批准或拒绝。

**禁止项**：不允许通用 auto-approve；不允许把 Prompt/工具参数直接塞进现有 public observer snapshot；不允许复用 `ctx.ui.confirm` 名义绕过实际 extension response 生命周期。

### U6 — 自定义宠物包与 Codex Pet 导入（P2 独立立项）

**用户价值**：提升个性化、分享和社区传播能力。

**建议分层**：

1. **Codex Pet atlas ZIP 导入**：只支持明确版本和位图 atlas/manifest 子集，转换为蜗牛派托管格式。
2. **蜗牛派自定义包**：先支持无脚本的 raster/spritesheet；SVG/GIF/APNG/WebP 等格式按风险和解码成本逐项开放，不与 Codex atlas 导入混为一谈。
3. AI 生成属于上游创作流程，首期只做安全导入，不在桌宠内直接接入付费生成服务。

**安全与合规门禁**：

- ZIP entry path traversal、zip bomb、文件数/单文件/解压总量、嵌套压缩包和符号链接处理；
- realpath containment、原子导入、损坏回滚、升级/卸载；
- manifest schema、维度、帧数、解码、资源协议与 CSP；
- 禁止 URL、脚本、命令、工具、HTML 和任意 Electron capability；
- 若开放 SVG，必须采用成熟 sanitizer + CSP 隔离并单独测试；不能只写“sanitize”即视为完成；
- 导入界面展示来源/许可声明，禁止捆绑复制 Clawd 未授权美术或其他来源不明资产。

**Delivery note (slice 1, 目录放置式):** 已完成无脚本 raster/spritesheet 自定义包的首个切片：用户将 `<pet-id>/manifest.json` + PNG/WebP 精灵图放入 `~/.pi/agent/desktop-pets/`（或 `SNAIL_PET_CUSTOM_PETS_DIR` / `PI_CODING_AGENT_DIR` 覆盖），main 在启动/刷新时扫描校验（`desktop/main/custom-pets.ts`，共享 manifest 契约 + 尺寸/帧数/单行连续/能力字段门禁，内置 id 冲突拒绝，最多 16 只），位图转为 data URL 经窄 IPC 推送（`pet:get-custom-pets` / `pet:custom-pets-changed` / `pet:open-custom-pets-dir` / `pet:rescan-custom-pets`）；renderer 逐条二次门禁（`validateCustomPetAsset`）后注册运行时 manifest/贴图、动态渲染设置面板宠物选项并显示目录路径。CSS 模式自定义包、ZIP/Codex atlas 导入、SVG/GIF/APNG 与 AI 生成仍按本计划后续分层，不在本切片内。

### U7 — 桌面健壮性、DND、迷你模式与 i18n（拆分交付）

该单元不能作为一个大批次一次实现，应拆成独立小项：

#### [x] U7a — DND（优先于完整声音体验）

- 一键抑制 Electron 通知、needs_input 气泡弹出和声音，但 Activity tray 状态继续更新。
- 不自动改变任务状态，不自动批准/拒绝；恢复后不补播历史声音/通知。
- 明确手动 DND 与未来安静时段的区别，首期只做手动开关。

**Completed:** 2026-08-14 — 新增纯策略模块 `desktop/main/dnd-policy.ts`（同一门控同时服务系统通知、状态气泡与未来 U4a 声音）；`dndEnabled` 进入 settings-store defaults/normalize/update/serialize（缺省 false，旧 v1 文件迁移为 false，schema 版本不变）并经现有窄 preload `setPrefs` 与设置面板/托盘菜单（checked 状态）双向开关；DND 期间任务态通知与气泡被静默消费（notified/dismissed LRU 前移），关闭 DND、renderer 重建或相同 snapshot 重放均不补播；连接诊断（service_not_running/disconnected/reconnecting）始终可见；不写 acknowledgedTransitionIds、不改 8 态呈现与 Activity tray 未读；与 reduced-motion 相互独立。U4a 声音仅预留门控，未实现音频。

#### U7b — Electron 桌宠 i18n

- Electron renderer 与 Next WebUI 是独立 bundle，不能直接假设可复用 `I18nProvider` 或 `localStorage["pi-locale"]`。
- 优先抽取可在两端复用的纯 catalog/translator，或建立 desktop 独立 zh/en catalog；locale 存入 desktop settings 并做 schema 迁移。
- 覆盖 renderer、main 原生托盘/通知、连接诊断、设置和辅助文本；不能只替换 `DEFAULT_FRAMES`。

#### U7c — 迷你模式

- 拖到屏幕边缘吸附、hover peek、托盘/右键恢复；先支持右边缘，再评估多边缘。
- 与多屏负坐标、DPI、任务栏 workArea、click-through、tray 展开和位置恢复共同设计。
- 必须保证任何情况下可从系统托盘退出迷你模式。

#### U7d — 启动/重连回归证据

- 现有 attach/reconnect baseline 已能在服务仍运行时恢复当前快照并抑制历史通知，不再作为新功能重复开发。
- 增加实机场景：桌宠重启时 Agent 正在运行、服务重启 instanceId 变化、snapshot stale → reset；不得引入 PID/信号或进程所有权。

---

## Priorities and Dependencies

| 顺序 | 单元 | 决策 |
| --- | --- | --- |
| **P1** | U1 Running 工作细分提示 | 先以 renderer modifier + 明确主 activity 选择落地；不改 wire/8 态/manifest v2 |
| **P1** | U2 上下文占比视觉化 | 仅 context percent 可画比例；费用/Token/TPS 保持数值 |
| **P2** | U7a DND、U7b i18n | DND 是完整声音体验前置；i18n 是独立 Electron 基础能力 |
| **P2** | U3 渐进式睡眠、U4 声音/趣味交互 | 需计入 spritesheet 美术、手势冲突和重复通知成本 |
| **P2 独立设计** | U5 桌面响应、U6 自定义宠物包 | 先 requirements/design/security review，不能夹带进 renderer PR |
| **P3** | U7c 迷你模式 | 涉及窗口、多屏、click-through 和恢复路径，实机成本较高 |
| **验证项** | U7d 启动/重连 | 已有能力，只补自动/Windows 实机证据 |
| **Deferred** | 养成彩蛋、移动端 PWA、系统级离开检测 | 不进入近期实现 |

依赖关系：

```text
主 activity 选择器 ──> U1 主视觉 / U2 宠物旁资源摘要
U7a DND ───────────> U4a 完整声音验收
窗口几何与恢复设计 ─> U7c 迷你模式
U5 security design ─> 任意桌面响应实现
U6 package design ──> 任意第三方资源导入
```

---

## Implementation Boundaries

- 优先不扩展 observer wire payload、不改变事件种类、状态契约或共享字段；若确需，必须同步更新 ADR、`docs/modules/*`、所有消费者和验证用例。
- U1/U2 首期只消费现有安全字段；任何原始工具名只用于本地 allowlist 匹配，不能成为 CSS class、资源路径或持久化 key。
- U5、U6 触及授权、文件系统、CSP、preload、IPC 和打包边界，必须单独立项并安全评审。
- U7 不得借“健壮性”引入服务 PID、进程信号、自动启动或所有权推断。
- 所有交互提供键盘等价操作、可见焦点和非颜色提示；reduced-motion 下保持静态可理解。
- 新设置必须经过 `settings-store` normalize/migration/forbidden-key 检查，不能把 token、Prompt、cwd 或审批内容写入 Electron settings。

---

## Validation

最低门禁：

```bash
npm run lint
node_modules/.bin/tsc --noEmit
npm run test:desktop-contract
npm run test:desktop-package
```

按改动范围补充：

- observer/projection：`npm run test:task-observer`、`npm run test:desktop-observer-api`；
- main/preload/连接：`npm run test:desktop-connection`、`npm run test:desktop-deep-links`；
- i18n：`npm run test:i18n` + desktop catalog parity；
- 资源包：坏包/zip bomb/path traversal/符号链接/CSP/解码/包体 smoke；
- 视觉：`npm run desktop:preview`，并按 `docs/operations/desktop-pet-validation.md` 做 Windows 实机验证。

行为测试至少覆盖：

- U1：工具分类、主 activity 选择、未知/并行工具回退、Subagent 数量、防抖抢占；
- U2：真实 context 分母、null/stale/非 Agent、多会话隔离；
- U3：idle 阈值、隐藏/恢复、timer 清理、状态抢占；
- U4：单击直达 vs 趣味点击、拖动、声音冷却/DND/重复提示；
- U7：DND 不补播、locale 迁移、迷你模式多屏恢复、启动 baseline。

contract smoke 不替代 Windows 通知、音频、DPI、多屏、任务栏和焦点实机验证。

---

## Success Criteria

每个单元立项时至少定义一个可验证结果，避免只凭“更像竞品”验收：

- U1：用户能通过无文本详情的主视觉区分 generic / editing / command / subagent，且未知工具不误分类。
- U2：接近上下文上限时可在不展开详情的情况下读到真实百分比，不出现伪造 quota。
- U3/U4：不会增加误触、重复通知或后台 timer；关闭/reduced-motion/DND 行为可预测。
- U5：任何桌面响应都必须是知情、绑定到单一未过期请求且可安全回退 WebUI。
- U6：恶意或损坏包只能被拒绝/隔离，不能扩大 renderer 或文件系统权限。
- U7：新设置和窗口模式均可从托盘恢复，升级后旧设置有确定迁移结果。

---

## Sources

### Primary / project sources

- [Clawd on Desk — GitHub](https://github.com/rullerzhou-afk/clawd-on-desk)
- [Anthropic claude-desktop-buddy — GitHub](https://github.com/anthropics/claude-desktop-buddy)
- [Codex desktop pet interaction hooks proposal — GitHub Issue #21657](https://github.com/openai/codex/issues/21657)
- [Claude Code `/buddy` growth proposal clarifying current static behavior — GitHub Issue #41684](https://github.com/anthropics/claude-code/issues/41684)

### Secondary / release reporting

- [OpenAI introduces AI-generated pets for its Codex app — Engadget](https://www.engadget.com/2162796/openai-introduces-ai-generated-pets-for-its-codex-app)
- [OpenAI Developers: `/hatch` custom Codex pets](https://x.com/OpenAIDevs/status/2050621561443701108)
- [What Is Claude Code's Buddy Feature? — MindStudio](https://www.mindstudio.ai/blog/what-is-claude-code-buddy-feature)（第三方说明，仅作低可信灵感）
