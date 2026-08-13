---
date: 2026-08-13
topic: desktop-pet-experience-refresh
status: approved
---

# 蜗牛派桌宠体验重塑需求

## Problem Frame

蜗牛派桌宠已经具备可靠的本地任务观察底座：可聚合普通 Agent、Subagent、SnFlow、Automation 与 Quick Command，区分 Running、Needs input、Ready、Blocked，并遵守只读、隐私与本地连接边界。但当前用户可见体验仍接近工程原型：宠物是简单 CSS 几何图形，两个内置宠物没有可感知差异，状态动作弱，设置能力没有完整可见入口，Activity tray 也没有充分展示服务端已经提供的阶段、可信进度和 Subagent 信息。

下一阶段应优先完成“体验重塑”，把桌宠从状态指示器原型升级为低打扰、可识别、有蜗牛派品牌感的任务伙伴，同时收口 Windows 多屏、DPI、裁切和抢焦点等常驻桌面体验风险。产品不转向养成游戏，也不把桌宠扩展成第二套完整 WebUI。

---

## Actors

- A1. 多项目任务用户：在浏览器之外工作，希望不切换上下文即可判断任务状态并快速回到需要处理的任务。
- A2. 桌宠客户端：以低打扰方式表达最高优先级状态、承载活动列表和本地偏好。
- A3. 蜗牛派服务：继续提供隐私有界、只读的统一任务观察快照。

---

## Key Flows

- F1. 环境感知
  - **Trigger:** A1 在其他应用中工作，蜗牛派任务开始、等待输入、完成或失败。
  - **Actors:** A1, A2, A3
  - **Steps:** A3 推送状态；A2 通过角色动作、非颜色提示和简短状态气泡表达最高优先级活动；A1 无需展开面板即可判断是否需要介入。
  - **Outcome:** 桌宠提供可理解但不打断工作的环境提示。
  - **Covered by:** R1, R2, R3, R8

- F2. 快速定位任务
  - **Trigger:** A1 点击桌宠或活动提示。
  - **Actors:** A1, A2
  - **Steps:** A2 展开与桌宠相连的 Activity tray；按项目和关注优先级展示任务；行内显示来源、阶段、可信进度、时长和 Subagent 摘要；A1 选择任务后回到 WebUI。
  - **Outcome:** 用户能在数秒内定位最需要关注的任务。
  - **Covered by:** R4, R5, R6

- F3. 个性化与恢复
  - **Trigger:** A1 希望更换角色、动画/通知偏好，或桌宠遮挡内容。
  - **Actors:** A1, A2
  - **Steps:** A1 从 Activity tray 设置区选择内置宠物和常驻偏好；A2 即时预览并持久化；鼠标穿透后仍可从系统托盘恢复。
  - **Outcome:** 常用设置可发现、可恢复，不依赖手改配置。
  - **Covered by:** R7, R8, R9

---

## Requirements

**角色与状态表达**

- R1. 折叠态必须以透明角色为主体，不再以深色方形卡片作为宠物本体；窗口控制应在需要时出现而不是持续抢占视觉中心。
- R2. 内置蜗牛至少对 Idle、Running、Retrying、Needs input、Ready、Blocked、Service not running、Disconnected 提供动作、姿态或表情差异；状态不能只依赖颜色。
- R3. 折叠态应显示简短、隐私安全的当前状态提示；存在活动时可展示通用标题、状态或阶段，但不得引入 Prompt、cwd、工具参数、原始错误等现有禁止字段。
- R4. 动画必须遵守系统 reduced-motion；空闲动作保持低频，Needs input/Blocked 可更醒目，但不得持续高强度闪烁或抢焦点。

**Activity tray**

- R5. Activity tray 必须强化信息层级：项目、任务标题、状态、来源、可信阶段/进度、运行时长和未读状态可快速扫描；未结束活动的运行时长应在列表可见时自动刷新，无需用户点击，也不得为此增加服务端轮询。
- R6. 当观察快照包含真实 ratio/counters 或 Subagent 摘要时，Activity tray 应展示这些信息；没有真实分母时不得伪造百分比。
- R7. Activity tray 的关闭动作应只收起活动列表；“隐藏桌宠到系统托盘”保留为宠物自身控制和系统托盘动作，避免两个关闭语义混淆。

**设置与桌面可靠性**

- R8. Activity tray 内必须提供可发现的本地设置入口，至少覆盖访问密钥、内置宠物选择、置顶、鼠标穿透、开机启动和通知策略，并复用现有本地设置边界；访问密钥输入不得长期占用活动列表的固定高度。
- R9. 内置宠物选择必须产生可感知的视觉差异并即时预览；选择、窗口位置与偏好重启后保持。
- R10. 桌宠在 Windows 多屏、100%–200% DPI、屏幕边缘与任务栏附近不得被永久裁切，并且必须能在不同分辨率/缩放的屏幕之间双向拖动，不得卡在单个显示器边缘；状态更新不得主动切换虚拟桌面或抢走当前应用焦点。
- R11. 体验重塑不得放宽现有只读、loopback、deep-link allowlist、renderer 隔离和退出不影响任务等安全边界。

---

## Acceptance Examples

- AE1. **Covers R1–R4.** Given 桌宠空闲且 Activity tray 收起，when 用户查看桌面，then 看到透明蜗牛角色和低干扰空闲动作，而不是深色方形应用卡片；开启 reduced-motion 后角色使用静态姿态。
- AE2. **Covers R2, R3.** Given 一个任务进入 Needs input，when 状态到达桌宠，then 蜗牛使用问询姿态和文字/图形提示表达待输入，不显示 Prompt 或请求正文。
- AE3. **Covers R5, R6.** Given 一个 Agent 正在使用工具且有两个 Subagent，when 用户展开 Activity tray，then 任务行展示安全工具/阶段、真实计数或 Subagent 摘要；若进度为 indeterminate，则不显示猜测百分比；保持列表展开时运行时长自动递增且不发起额外服务请求。
- AE4. **Covers R7.** Given Activity tray 已展开，when 用户点击 tray 的收起按钮，then 只收起 tray，桌宠继续显示；点击宠物自身隐藏按钮才隐藏到系统托盘。
- AE5. **Covers R8, R9.** Given 用户从设置区选择 Classic Snail 并关闭再启动桌宠，then 角色保持 Classic 外观；选择过程中可即时看到视觉差异；需要访问密钥时可在同一设置区填写或清除，而活动列表不被密钥表单持续占高。
- AE6. **Covers R10.** Given 桌宠位于副屏右下角且显示缩放为 150%，when 展开/收起 tray、状态更新，或从低分辨率屏拖向高分辨率屏，then 宠物保持可见、可跨过屏幕边界且当前前台应用不被抢焦点。
- AE7. **Covers R11.** Given renderer 尝试打开绝对 URL 或执行服务命令，when 请求到达主进程，then 仍被现有安全边界拒绝。

---

## Success Criteria

- 用户第一眼感知到的是“蜗牛派角色”，而不是一个带蜗牛图标的小工具卡片。
- 用户无需展开面板即可区分运行、等待输入、完成、失败和连接异常。
- 展开 Activity tray 后，用户能用已有安全数据快速判断任务在做什么、运行多久、是否包含 Subagent。
- 桌宠设置可发现且可恢复，常见常驻桌面问题不会迫使用户手改文件或重启系统。
- 体验升级不改变桌宠只读观察器的产品边界和隐私协议。

---

## Scope Boundaries

- 本轮不在桌宠内发送 Prompt、批准请求、停止任务或执行 Quick Command。
- 本轮不内嵌完整 WebUI、终端、编辑器或任务日志。
- 本轮不建设养成、喂食、货币、成就、皮肤商店或云同步。
- 自定义宠物导入、AI 生成宠物和开放动画脚本属于后续能力；先把内置角色和资源契约做好。
- 不伪造 AI 任务完成百分比。
- 不改变桌宠与 `spi` 独立启动、退出互不影响的边界。

---

## Key Decisions

- **先体验重塑，再做自定义生态：** 当前最大问题是内置体验不可感知；先证明角色、状态和任务信息的组合价值。
- **生产力底座优先于养成玩法：** 桌宠的核心价值是低打扰任务感知，趣味性服务于可读性和品牌记忆。
- **复用现有观察协议：** phase、progress、children 已经安全投影到 renderer，优先释放已有数据价值，不扩张敏感协议。
- **设置留在轻量 tray：** 不新增完整设置窗口，保持桌宠轻量并减少第二套客户端心智。
- **稳定性与视觉同批验收：** 多屏、DPI、裁切和抢焦点直接决定常驻桌面体验，不能作为纯美术工作之后的收尾。

---

## Dependencies / Assumptions

- 现有 `PetPrefsPatch` 和桌面设置持久化可承载首轮可见设置，无需新增服务端配置。
- 当前观察负载已经包含安全的 phase、progress、children，可直接用于 Activity tray 展示。
- 首轮可使用内置 CSS/矢量角色完成体验验证；正式高帧率 spritesheet 与 AI 生成流程可在后续资源管线中替换。
- Windows 安装器、签名和真实多屏/DPI 矩阵仍需按 `docs/operations/desktop-pet-validation.md` 人工验收。

---

## Outstanding Questions

### Deferred to Implementation

- [Affects R1, R2][Visual] 首轮内置角色采用 CSS/矢量还是版本化 spritesheet，以实际包体、清晰度和维护成本验证为准。
- [Affects R10][Windows] Electron 在不同 DPI/虚拟桌面上的 `show`/`showInactive` 行为需在真实 Windows 环境验证后确定最终策略。

---

## Next Steps

-> 开始实现第一条完整体验切片：透明角色与状态动作、Activity tray 信息层级、可见设置入口和对应桌面契约测试。
