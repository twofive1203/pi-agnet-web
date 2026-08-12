---
date: 2026-08-12
topic: desktop-pet-task-observer
status: revised
---

# Windows 桌宠多项目任务观察器需求

## Problem Frame

蜗牛派用户会同时把任务交给多个项目中的 Agent，然后关闭浏览器去做其他工作。任务实际运行在蜗牛派服务进程中，浏览器关闭不必然中断执行，但当前进度、完成、失败和需要人工介入等信号主要集中在 WebUI 内；用户必须重新打开页面并逐项目查看。

首版需要提供一个 **Windows 优先、独立启动**的常驻桌宠：连接同一台 Windows 机器上已经运行的蜗牛派服务，以低打扰方式呈现任务活动、未读结果和需要用户处理的事项。桌宠是只读观察器，不负责启动、停止、重启或监管蜗牛派服务，也不是完整 WebUI 的桌面替代品。

产品体验参考 Codex 桌宠，但采用蜗牛派自己的任务来源和部署边界：宠物负责环境感知，Activity tray 负责选择具体任务，详细查看与操作仍回到默认浏览器中的 WebUI。若蜗牛派服务未启动，桌宠明确显示“蜗牛派服务未启动”，提供启动命令提示和重试入口，不代替用户拉起服务。

---

## Actors

- A1. 蜗牛派用户：先独立运行蜗牛派服务，交代任务、关闭浏览器，再通过桌宠了解状态。
- A2. 桌宠客户端：Windows 常驻应用，管理窗口、托盘、服务连接、Activity tray、本地未读状态和系统通知。
- A3. 蜗牛派服务：独立运行，承载普通 Agent、Subagent、SnFlow、Automation 和项目 Quick Commands，并输出统一只读观察状态。
- A4. 任务执行单元：普通会话 activity、SnFlow run、Automation run 或 Quick Command run，是被观察而非由桌宠控制的对象。

---

## Key Flows

### F1. 浏览器关闭后继续观察

- **Trigger:** A1 已启动蜗牛派服务并提交一个或多个项目任务，然后关闭浏览器。
- **Actors:** A1, A2, A3, A4
- **Steps:** A3 继续执行任务；A2 独立常驻，通过一条服务级观察流接收有界快照；宠物显示最高优先级状态和活动数量；Activity tray 按项目列出任务阶段和运行时长。
- **Outcome:** A1 无需保持或轮询浏览器页面即可判断任务是否仍在执行。
- **Covered by:** R1, R2, R4, R8, R9

### F2. 完成、失败或需要介入

- **Trigger:** 任一任务产生未读结果、失败、系统阻塞或需要用户输入。
- **Actors:** A1, A2, A3, A4
- **Steps:** A3 产生稳定状态转换；A2 按转换身份去重；宠物切换视觉状态并按用户设置发出一次系统通知；A1 展开 Activity tray 选择任务，或点击通知。
- **Outcome:** 默认浏览器打开对应 WebUI 会话或面板；被打开的结果在该桌面客户端上标记为已读。
- **Covered by:** R3, R5, R7, R10, R11, R24–R27

### F3. 蜗牛派服务未启动或不可用

- **Trigger:** A2 启动、重连或用户手动重试连接。
- **Actors:** A1, A2, A3
- **Steps:** A2 探测固定 IPv4 回环地址；连接被拒绝时显示“蜗牛派服务未启动”，并提供复制 `spi --no-open` 启动命令、查看说明和重试连接；若端口返回未知或不兼容响应，则显示版本/端口不兼容诊断。A2 不启动或结束任何服务进程。
- **Outcome:** 用户明确知道桌宠为何无法观察，并自行决定何时启动或修复蜗牛派服务。
- **Covered by:** R14–R18, R23

### F4. 多任务活动选择

- **Trigger:** 同时有多个项目或任务产生活动。
- **Actors:** A1, A2
- **Steps:** 宠物按 Needs input、Blocked、Ready、Running 的顺序表现最高优先级状态；A1 点击宠物展开 Activity tray；Activity tray 按项目分组，并允许选择具体任务或将终态活动标为已读。
- **Outcome:** 桌宠不会把多个任务压缩成不可解释的单一动画，用户能快速定位最需要处理的活动。
- **Covered by:** R3, R6, R7, R9, R10

---

## Requirements

### 任务观察与身份

- R1. 桌宠必须在一个 Activity tray 中聚合当前服务实例上的多项目活动，并按项目分组；折叠态至少显示活动任务数和需关注任务数。
- R2. Windows 首版必须覆盖普通 Agent activity 及其 Subagent、SnFlow implement/check run、Automation run 和项目 Quick Command run。Subagent 作为父任务详情展示，不作为普通顶层任务重复计数；Web Terminal 不属于首版观察来源。
- R3. 桌面呈现必须使用四类用户状态：`Running`、`Needs input`、`Ready`、`Blocked`。多任务视觉优先级必须为 `Needs input > Blocked > Ready > Running > Idle`；服务断开作为更高优先级的连接状态单独覆盖。
- R4. 服务端领域模型必须将执行状态、终态结果和关注原因分离。至少能表达排队、运行、重试、已结束，以及成功、失败、取消、中断、不确定，不能把所有需要关注情况压成一个不可恢复的任务终态。
- R5. 每个任务实体和每次执行 activity 必须具有不同的稳定身份，并为有意义的状态变化生成稳定 `transitionId`。普通会话重复发送新 Prompt 时必须产生新的 activity identity；同一状态重放不能产生新转换。
- R6. `Ready` 表示任务已结束且该结果在当前桌面客户端仍未查看。已读状态由桌面客户端本地维护，不写回任务执行状态，也不影响其他浏览器或桌面安装。
- R7. SnFlow 与其宿主普通会话必须去重；同一次 SnFlow 执行不能显示为两个顶层 activity。相关宿主阶段和 native Subagent 进度附着到 SnFlow activity。
- R8. 进度只呈现可证实信息，例如当前阶段、当前工具名称、Subagent 数量、工具/turn 计数、真实步骤数和运行时长。普通 LLM 任务不得推测百分比；没有真实分母时使用不确定进度。

### 桌面体验

- R9. 首版以 Windows 10/11 为发布和验收平台，提供透明无边框桌宠窗口、Activity tray、系统托盘、置顶开关、鼠标穿透开关和可选开机启动；macOS/Linux 不阻塞首版发布。
- R10. 点击桌宠默认展开或收起 Activity tray；点击具体任务或系统通知才通过默认浏览器打开对应 WebUI。首版不在 Electron 内嵌完整 WebUI。
- R11. 桌宠至少要有 Idle、Running、Retrying、Needs input、Ready、Blocked、Service not running 和 Disconnected 视觉状态；状态不能只靠颜色区分。系统减少动画偏好开启时必须使用静态帧或低动态表达。
- R12. 首版至少提供一组默认宠物资源，并支持多个内置宠物的本地选择、位置持久化和静态 fallback。自定义宠物导入、AI 生成、皮肤商店和云同步不属于首版硬要求。
- R13. 用户关闭桌宠窗口时默认隐藏到托盘而不是退出；只有托盘“退出”才结束桌宠进程。托盘必须始终提供取消鼠标穿透、显示桌宠、打开 WebUI 和重试连接的恢复入口。

### 服务连接边界

- R14. 桌宠是独立进程，只连接已经运行的蜗牛派服务。运行 `spi`、打开 WebUI 和启动桌宠彼此都不得隐式拉起另一个进程。
- R15. 桌宠只能自动连接配置端口上的 `127.0.0.1` 本地模式兼容实例。远程服务器、多实例聚合、`localhost` DNS 解析、局域网地址和服务器模式认证接入不属于首版。
- R16. 连接被拒绝时，桌宠必须明确显示“蜗牛派服务未启动”，提供复制 `spi --no-open`（或安装说明中的等价命令）、查看启动说明和手动重试；不得自动执行命令、弹出 Shell 或启动后台服务。
- R17. 退出或崩溃桌宠不得停止、重启或影响蜗牛派服务及其活动任务。桌宠不保存服务 PID，不发送进程信号，也不根据端口推断进程所有权。
- R18. 若端口被未知服务占用、协议版本不兼容或本地实例处于 server mode，桌宠必须显示可操作诊断并保持只读重试；不得结束、覆盖或接管该进程。

### 安全、隐私与观察协议

- R19. 任务观察接口必须为只读、直接回环限定并使用短期观察会话；不得复用公共 `/api/health` 暴露任务详情。根级 server access 认证不能放宽观察接口的本地模式门禁。
- R20. 桌面观察负载不得包含 Prompt、第一条用户消息、模型输出全文、工具参数、文件内容、文件变更内容、cwd、会话文件路径、输出文件、async 目录、Quick Command 命令、环境变量值、密钥或原始 provider 错误。项目只暴露不含路径的安全显示名和稳定 project key；所有字符串和数组必须有硬上限。
- R21. 普通会话标题优先使用用户显式命名；没有显式命名时使用通用本地化标签，不能使用 `firstMessage` 兜底。错误只发送稳定 reason code 和安全 fallback，不发送未经审查的异常全文。
- R22. 服务端必须提供相对、同源、allowlist 化的 WebUI deep link；桌面主进程再次验证后才能通过默认浏览器打开。renderer 不得获得观察 token、cwd、任意 URL 打开能力或进程控制能力。
- R23. 桌宠与服务断开时必须保留最后快照但标记为 stale/unknown，不能把消失的任务误报为成功。服务 `instanceId` 变化视为 reset；恢复后以完整快照重新建立基线。持续连接被拒绝时切换为 Service not running，而不是无限显示加载中。

### 通知、活动托盘与可运维性

- R24. 成功、失败、需要输入和阻塞通知必须按稳定 transition identity 去重。服务重连、SSE reset、快照刷新和服务重启后重读持久任务不得产生重复通知。
- R25. 桌面首次启动、服务实例变化或 reset 后收到的第一份快照只建立通知基线，默认不追溯补发离线期间通知。后续可确认的状态转换才允许通知。
- R26. 系统通知策略必须至少支持“从不、仅桌宠/应用在后台时、始终”三档完成通知，以及独立的 Needs input/Blocked 开关。Activity tray 始终可查看活动，不依赖系统通知权限。
- R27. Activity tray 必须支持选择具体任务、展示未读 Ready/Blocked/Needs input、将单项或全部终态活动标为已读。已读只影响桌面呈现和通知，不改变服务端任务记录。
- R28. 一条服务级 SSE 必须承载完整有界快照；不得为每个会话建立 SSE 或高频轮询。运行时长由客户端根据时间戳计算，服务端不能只因时间流逝持续提高 revision。

---

## Acceptance Examples

- AE1. **Covers R1, R2, R8.** Given 项目 A 有普通 Agent 正在执行 bash，项目 B 有 Automation 正在运行，项目 C 有 Quick Command 正在测试，when 浏览器全部关闭，then Activity tray 显示三个项目和三个顶层 activity，展示可信阶段与时长，不显示猜测百分比。
- AE2. **Covers R3, R6, R24, R25.** Given 一个 activity 从 Running 进入 succeeded，when 桌面已完成初始基线，then 宠物进入 Ready、Activity tray 出现未读结果且系统通知一次；when SSE 重连并重放相同终态，then 不重复通知。
- AE3. **Covers R5.** Given 同一普通 session 的第一轮 Prompt 已完成并已读，when 用户在该 session 发送第二轮 Prompt，then 服务生成新的 activity identity，桌宠显示新的 Running，第二轮完成可以独立产生 Ready。
- AE4. **Covers R7.** Given SnFlow implement 由当前聊天中的 native Subagent 执行，when 服务生成观察快照，then 只显示一个 SnFlow implement 顶层 activity，并在详情中展示宿主会话和 Subagent 计数。
- AE5. **Covers R9, R13.** Given 用户点击桌宠窗口关闭按钮，when 桌宠仍在运行，then 窗口隐藏、托盘图标保留且观察不中断；即使开启鼠标穿透也可从托盘恢复。
- AE6. **Covers R10, R22.** Given 一个 Automation run 需要关注，when 用户点击通知，then 默认浏览器打开本机 WebUI 并定位到该 run；renderer 提供的任意外部 URL 请求被主进程拒绝。
- AE7. **Covers R14, R16.** Given 62666 没有服务监听，when 桌宠启动，then 显示“蜗牛派服务未启动”和 `spi --no-open` 启动提示；桌宠不创建任何服务子进程。用户独立启动 `spi` 并点击重试后，桌宠连接成功。
- AE8. **Covers R19–R21.** Given 未持有观察会话的请求访问观察快照，when 请求到达服务，then 返回拒绝；合法快照也不包含 cwd、firstMessage、Prompt、原始错误、会话路径、Quick Command 命令或工具参数。
- AE9. **Covers R23–R25.** Given 服务在三个任务运行中途断开并以新 instanceId 启动，when 桌宠重连，then 旧任务显示未知/可能中断，第一份新快照仅建立基线，不能生成三条成功通知。
- AE10. **Covers R17.** Given 蜗牛派服务仍有活动任务，when 用户从托盘退出桌宠，then 桌宠立即退出且服务和任务继续运行；桌宠不显示“会中断任务”的误导警告。
- AE11. **Covers R3, R27.** Given 同时存在 Needs input、Blocked、Ready 和 Running 活动，when 用户查看宠物，then 宠物优先表现 Needs input；展开 Activity tray 后四类任务都可见，标记 Ready 已读后不会改变服务端 succeeded 结果。
- AE12. **Covers R11, R12.** Given Windows 减少动画已开启，when 用户切换内置宠物，then 位置与选择被保存，状态使用对应静态帧表达且不丢失文字/图形状态提示。
- AE13. **Covers R18.** Given 62666 返回未知网页、旧 observer 协议或 server-mode 实例，when 桌宠探测，then 显示对应不兼容诊断并允许重试，不结束或覆盖端口所有者。

---

## Success Criteria

- 用户可以在 Windows 上独立运行蜗牛派服务，交代多个项目任务后关闭浏览器，并从桌宠和 Activity tray 中识别 Running、Needs input、Ready 与 Blocked。
- 蜗牛派未运行时，桌宠能准确说明原因和启动方法，而不是静默失败或自行管理服务进程。
- 观察状态与服务端真实生命周期一致；同一会话的多轮 activity、SnFlow 宿主去重和服务重启都不会制造重复或虚假通知。
- 桌宠兼具低打扰环境提示和可操作的活动列表，而不是只提供动画或缩小版日志面板。
- 桌面只建立一条服务级观察连接，不读取任务存储目录，不接收 cwd、Prompt、输出、命令或工具参数。
- 退出、崩溃或卸载桌宠不会停止蜗牛派服务或正在执行的任务。

---

## Scope Boundaries

- 首版只发布和验收 Windows 10/11；macOS/Linux 兼容性留待后续。
- 首版不启动、停止、重启、安装或监管蜗牛派服务；服务托管属于低优先级后续能力，必须另立需求与架构决策。
- 不接入远程蜗牛派、服务器模式访问密钥、多台机器或多个服务实例聚合。
- 不把桌宠扩展为完整 Electron 工作台，不内嵌 Chat、Settings、Terminal 或编辑器。
- 不从桌宠发送 Prompt、停止任务、批准 Automation、响应扩展对话框或执行其他任务写操作；“标为已读”仅是桌面本地展示状态。
- 不观察人工 Web Terminal。Quick Command 作为有稳定 run 生命周期的一次性项目任务纳入首版。
- 不承诺服务崩溃、电脑休眠、关机或重启后恢复普通 Agent 或 Quick Command 执行。
- 首版不追溯补发桌宠离线期间的普通会话通知；恢复时只展示当前可确认状态。
- 不建设皮肤商店、角色养成、云同步、在线脚本化动作系统或自动更新。
- 不以 AI 估算补齐普通任务百分比。
- 自定义宠物上传和 AI 生成属于后续增强；首版只要求版本化内置资源。

---

## Key Decisions

- **桌宠与蜗牛派独立启动：** 桌宠只观察已运行的本地服务，避免首版引入 Next/pi/native module 打包、进程树所有权和崩溃监管复杂度。
- **Windows-first Electron：** 与现有 TypeScript/React 技术栈一致，并覆盖透明窗口、托盘、Windows 通知和登录启动。
- **宠物 + Activity tray：** 宠物表达最高优先级状态，Activity tray 选择具体任务，避免把多任务压缩为一段不可解释动画。
- **四类用户状态 + 分离领域状态：** 桌面使用 Running/Needs input/Ready/Blocked；服务内部保留执行状态、终态和关注原因。
- **任务实体与 activity 分离：** 普通 session 可连续产生多轮 activity，通知和时长按 activity 计算。
- **浏览器打开 WebUI：** 桌宠保持只读、轻量，避免首版演变成第二套完整客户端。
- **服务端统一投影：** 桌宠不解析 JSONL、不读取 `.pi`/Automation/Quick Command 存储，也不理解各来源内部状态机。
- **快照优先：** 一条 SSE 推送完整有界快照；reset 后重新建立基线，首版不引入复杂增量协议。
- **最小观察数据：** project key、显示名、状态、计数、时间戳和相对 deep link 足够；cwd 与任务文本不进入桌面协议。

---

## Dependencies / Assumptions

- 用户通过 `spi --no-open`、`npm run start -- --no-open` 或现有部署方式独立保持蜗牛派服务运行。
- 关闭浏览器本身不会终止服务端 AgentSession；关闭服务进程会中断普通 Agent 和 Quick Command，桌宠不负责恢复。
- 现有 `/?session=<id>` deep link 继续有效；SnFlow、Automation 和 Quick Command 需要新增一次性消费的面板 deep link。
- 当前项目已有 Quick Command 进程级 registry 和稳定 run 状态，可作为 observer source adapter，但服务重启后不恢复历史非终态运行。
- 本机同一用户进程可以读取 `~/.pi/agent`；观察会话用于减少浏览器跨站、误暴露和 renderer 泄露，不作为同账户恶意本地进程之间的强隔离。

---

## Outstanding Questions

### Deferred to Implementation

- [Affects R12][Visual] 首发内置宠物数量和美术帧集可在不改变状态 manifest 的前提下确定。
- [Affects R16][UX] 启动说明最终展示全局安装命令、`npx` 命令或两者，可根据已安装环境探测结果选择，但桌宠不得执行它们。
- [Affects R26][Windows] 安装器类型、代码签名证书和通知 AppUserModelID 在 Windows 打包验证阶段确定；广泛分发前必须签名。

---

## Next Steps

-> 依据本修订需求更新架构决策和实施计划，首版只实现 observer、桌宠、Activity tray、通知和“服务未启动”提示。
