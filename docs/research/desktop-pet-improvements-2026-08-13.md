# 桌宠（Desktop Pet）优化建议清单 — 2026-08-13

状态：Reviewed backlog（包含已实现、部分实现、待实现及延期项）。

核对依据：`desktop/renderer/pet-app.tsx`、`desktop/renderer/pet.css`、`desktop/renderer/pet-state.ts`、`desktop/renderer/pet-assets.ts`、`desktop/main/activity-store.ts`、`desktop/main/notification-controller.ts`、`desktop/main/tray-controller.ts`、`lib/task-observer-projection.ts`、`lib/task-observer-types.ts`，以及桌宠视觉与 Windows 发布验证文档。

## 背景与当前能力

桌宠展示状态共 8 种（`TaskObserverPresentationState`）：`service_not_running` / `disconnected` / `needs_input` / `blocked` / `ready` / `retrying` / `running` / `idle`。四类任务适配器（agent / snflow / automation / quick_command）投影后，由服务级 SSE 向桌宠推送有界快照；Subagent 作为普通 Agent 活动的安全子摘要呈现。

当前两只内置宠物均使用 CSS/矢量结构和 CSS keyframes。manifest v2 已支持 `renderMode: "spritesheet"` 的字段、路径、尺寸、帧范围、静态帧和打包校验，但 renderer 尚未根据 `sheet`、`firstFrame`、`frameCount` 等字段执行真正的序列帧渲染，因此不能视为完整的 spritesheet 运行时管线。

现有实现还包括：状态气泡生命周期、空闲眨眼与随机小动作、鼠标跟随、按压缩壳、ready 撒花、Activity tray 本地筛选、Subagent 展开、明确的打开/已读操作、可见设置入口、系统托盘菜单、三档尺寸和多屏位置恢复契约。

## 一、动画与表现力

### 1. 补充有语义的状态切换动作（部分实现）

状态变化时 `frame-*` class 仍会直接替换，但头部、触角、眼睛、壳和身体已有约 150ms 的 transform 过渡，因此不是完全瞬时切换。

建议补充少量有语义且可中断的转换动作，例如 ready → idle 的下沉点头、retrying → running 的重新出发。不要为任意状态组合建立复杂状态机；一次性转换必须遵守 `prefers-reduced-motion`，频繁快照也不得重复播放。

#### Running 主循环需要优先重做

当前 `.frame-running` 使用 1 秒循环的 `pet-scoot`，让整个角色持续前后、上下往复，容易形成“一拱一拱”的身体动作，观感不够自然，也与“专注执行任务”的语义不匹配。这不是状态切换过渡问题，而是 Running 常驻动作本身需要重新设计。

建议改为低幅度、非对称的“专注工作”动作：

- 避免整个角色以固定节奏持续前后顶动；
- 壳保持相对稳定，以头部前探、触角观察、尾部轻微伸缩表达工作感；
- 头、身体和壳使用错开的节奏，不同时到达位移峰值；
- 主循环放慢到约 2～3 秒，并穿插短暂停顿，避免机械重复；
- 可保留很弱的壳光泽或状态符号变化作为辅助，不依赖大幅身体位移；
- 在 small / medium / large 三档尺寸下连续观察至少 10～20 秒，专门检查是否产生顶动、抽搐或其他不合适联想；
- reduced-motion 下继续使用静态 Running 姿态。

### 2. 按完成 transition 改进庆祝触发（待实现）

`launchConfetti` 当前只在聚合状态首次进入 `ready` 时触发。多个任务先后完成、但聚合状态持续为 ready 时，后续完成不会再次庆祝。

建议基于新的 ready `transitionId` 触发，并使用本地有界 LRU 去重：

- reset、首次连接和 instance 变化只建立 baseline，不回放历史庆祝；
- SSE 重放不得重复撒花；
- 1～2 秒内的多个完成可合并为一次庆祝，避免粒子风暴；
- reduced-motion 下不创建粒子，可仅更新非动画提示。

不能直接逐次遍历 `recentTransitions` 播放，因为该数组会随完整快照重复下发。

### 3. 强化 Needs input / Blocked 的快速处理路径（部分实现）

Needs input / Blocked 已有持续气泡、非颜色符号和差异姿态；点击宠物可展开 Activity tray，任务行已有“打开任务”按钮。当前气泡仍为 `pointer-events: none` 的纯展示，处理路径需要两步。

可评估增加更直接的“去处理”入口，但需遵守以下约束：

- `pet-caption` 当前位于 `pet-button` 内，不能直接嵌套另一个 button；需要调整 DOM 或将整个宠物点击行为按状态上下文化；
- 仍通过现有 `openActivity(activityId)` 和 main 进程 deep-link allowlist 打开任务；
- 必须提供键盘等价操作，不能只依赖鼠标；
- 不在桌宠内展示 Prompt、审批正文或其他隐私字段。

### 4. 完成实际拖动与放下反馈（部分实现）

当前按下时已经会缩头、闭眼并放大壳，不只是视觉缩放。但超过拖动阈值后会移除 `is-pressed`，实际拖动过程中恢复普通姿态，放下也没有一次性探头动作。

建议让 `is-dragging` 同步驱动缩壳姿态，并在 pointerup 后播放短暂探头动作。拖动反馈不得影响窗口移动流畅度，也不得在 reduced-motion 下播放弹性位移动画。

### 5. 打通 spritesheet 运行时渲染（待实现）

现有 manifest validator 和打包检查已具备基础，但 renderer 仍只设置 CSS frame class。启用正式序列帧皮肤前还需要：

- 根据 sheet 宽高、行列和 state frame range 计算背景位置；
- 根据 `durationMs` 和 `frameCount` 驱动 steps 动画；
- reduced-motion 使用 `staticFrameIndex`；
- 图片加载、解码或资源缺失时回退 CSS 蜗牛；
- 增加真实渲染和坏资源回退测试，而不只是 manifest 校验。

正式美术和运行时渲染应作为独立工作单元，不应描述为“只需提供一套图片”。

## 二、状态语义与交互

### 6. 解耦“关注状态”和“任务结果”（建议优先）

`deriveActivityPresentation` 当前会将已读的失败、成功或取消终态回落为 idle。这适合让聚合宠物停止提醒，但 Activity tray 中的终态任务也会使用 presentation 文案，导致已读失败任务可能显示“空闲”，用户难以确认最终结果。

建议保留两个表达维度：

- `presentation`：决定宠物姿态、未读徽标和是否需要关注；
- 终态结果文案：根据 `executionState` / `outcome` 持续显示“已完成”“失败”“已取消”“已中断”等。

优先修复任务列表语义，不建议先增加“壳上裂纹并于次日清除”。后者会引入新的时间、持久化和活动保留规则，且不应污染全局 8 状态领域契约。

### 7. 宠物右键菜单作为可选增强（低优先）

宠物本体目前没有右键菜单，但系统托盘已经提供显示桌宠、取消鼠标穿透、重试连接、打开 WebUI、复制启动命令和退出；Activity tray 也已有可见设置入口。

若增加宠物右键菜单，应只作为系统托盘菜单的便捷镜像，避免形成两套行为不一致的菜单。重连、退出、穿透等操作涉及 main/IPC 或原生菜单，不属于纯 renderer 改动。鼠标穿透开启时仍只能依靠系统托盘恢复。

### 8. 双击直达最高优先级任务（可评估）

当前没有双击直达逻辑，可复用排序后的 primary activity。但现有 pointerup 会立即执行单击开关托盘，不能简单追加 `dblclick`，否则第一次点击已经改变界面。

实现前需明确单击延迟、拖动阈值、双击失败回退和键盘等价操作。只有 needs_input / blocked 等明确需要介入的状态适合直达；其他状态继续打开 Activity tray 更可预测。

## 三、性能与工程

### 9. Elapsed timer 已完成按需门控（无需再改）

当前 elapsed interval 只在 Activity tray 展开、设置面板关闭且存在未结束活动时启动；托盘收起或没有运行活动时会清除。因此“每秒全局刷新”已不是现状，应从待办中移除。

后续若需要进一步节能，应把重点放在窗口隐藏或 `document.visibilityState !== "visible"` 时暂停眨眼、idle acts 等装饰性 JS timer，而不是 elapsed timer。

### 10. 移除眨眼重启中的强制 reflow（低优先）

`scheduleIdleBlink` 通过清空眼睛 animation，并读取 `avatar.offsetWidth` 触发同步布局后重新启动。问题事实成立，但触发频率低、节点规模很小，不应高估性能收益。

可改用 Web Animations API，或在两个等价 class / animation name 间切换。修改后需确认不会让频繁状态更新重新排布 blink cadence。

### 11. 统一眨眼与 idle act 调度（建议修正描述）

`idle-act-sleepy` 不一定表现为“边睡边眨眼”，因为更具体的 CSS animation 通常会覆盖通用 blink；真正风险是 blink timer 在 sleepy/look 期间清空和恢复眼睛 animation，导致当前小动作被中断或重新开始。

建议在 idle act 播放期间暂停 blink 重启，动作结束后重新安排随机眨眼。最好把 idle 生命周期整理为可测试的纯调度策略，并在状态变化、按压、拖动、reduced-motion、窗口隐藏和 destroy 时统一取消 timer。

## 四、产品与扩展性

### 12. 用户自定义皮肤目录（延期，需单独安全设计）

当前 manifest 只允许两个 builtin id，并由 renderer 静态导入；renderer 没有文件系统能力。开放 `~/.pi/agent/pets/` 不能只复用 `isSafePetAssetPath`，至少还需要：

- main 进程目录枚举和真实路径 containment；
- manifest、文件数量、单文件与总包体上限；
- 图片格式、尺寸、解码失败和符号链接处理；
- CSP 与受控资源协议，禁止 renderer 获取任意 `file://` 能力；
- preload/IPC 安全视图、损坏回退、升级兼容和卸载行为；
- 自定义资源不能声明 URL、命令、脚本、工具或执行能力。

批准的体验重塑范围明确要求先完成内置角色，自定义导入应另立需求与安全评审。

### 13. 统一通知与宠物动效的 transition 策略（部分实现）

系统通知与宠物姿态已经由同一快照/transition 驱动，但各自拥有独立生命周期。可共享“是否为新 transition、是否为 baseline、是否已处理”的策略思想，同时保留独立偏好和表现形式。

Windows 勿扰/Focus Assist 通常由操作系统决定是否展示 toast，当前 Electron 通知层没有可靠的勿扰状态输入。桌宠气泡本来仍会显示，因此不应把“系统勿扰时降级为气泡”描述为现有代码可直接判断的分支。若需要应用级安静时段，应另增明确设置。

### 14. 状态历史与成就（延期）

快照中的 `recentTransitions` 最多保留 20 条，完整快照会重放，首次连接、reset 和 instance 变化还会建立 baseline。它不能可靠统计“今日完成 N 个任务”。

若未来确实需要统计，必须建立独立、去重、可清理的本地事件账本，并定义断连遗漏、跨日、服务重启、隐私、保留周期和数据清除规则。当前批准范围明确排除了成就和养成系统，因此该项不进入近期优先级。

## 五、验证、测试与可访问性补充

### 15. 视觉与 Windows 实机验证门禁（P0 已完成）

P0 已于 2026-08-14 由产品所有者明确关闭：修复后的 0.1.1 安装版已确认可见，以下未执行项作为已知残余风险接受，不虚记为 Pass，后续仍可按验证矩阵补充证据：

- `docs/operations/desktop-pet-visual-review.md` 中八状态 × 两角色 × 三尺寸以及 tray/settings/reduced-motion 组合仍未人工执行；
- Windows 10/11、100%～200% DPI、多屏双向拖动、虚拟桌面、任务栏位置和前台焦点仍未实测；
- 通知权限、通知点击、clean install、update-over-install、uninstall、SmartScreen 与签名仍有未完成项。

这些项目不再阻塞 P0，但后续仍应按照 `docs/operations/desktop-pet-validation.md` 和 `DESKTOP_PET_NEXT_PHASE_IMPLEMENTATION_PLAN.md` 的 U8 补充人工证据，不能用 contract smoke 代替。

### 16. 增加动效生命周期行为测试

现有 desktop contract smoke 对部分动效主要验证源码和 CSS marker 存在。建议补充可确定执行的行为测试：

- 同一 transition 不重复撒花；
- reset、SSE 重放和 instance 变化不回放庆祝；
- reduced-motion 不创建粒子或循环动作；
- idle act 期间 blink 不重启动作；
- 状态变化、拖动、隐藏窗口和 destroy 后 timer 被正确取消；
- spritesheet 加载失败可靠回退 CSS。

### 17. 所有新交互继续满足可访问性边界

气泡按钮、双击、右键菜单和拖放动画若实现，必须同时满足：

- 提供键盘等价操作和可见焦点；
- 避免嵌套交互控件和焦点陷阱；
- 状态不能只依赖颜色、动画或声音；
- reduced-motion 下保留静态、可理解的状态；
- Needs input / Blocked 可以更醒目，但不得持续高频闪烁、抢焦点或主动显示已隐藏窗口。

## 修订后的建议优先级

### P0：发布与体验验证（已完成）

P0 已于 2026-08-14 完成：Agent 自动门禁、preview、0.1.1 安装产物、哈希、启动修复和本机更新安装验证均已完成；产品所有者确认安装版可见并明确接受尚未执行的完整视觉矩阵及 Windows 环境矩阵风险。关闭记录见 `docs/operations/desktop-pet-p0-validation-2026-08-13.md`。

### P1：语义与核心交互（已完成）

P1 已于 2026-08-14 完成：Running 常驻动作重做为低幅度、非对称的“专注工作”循环（头前探、触角观察、尾轻伸、壳仅弱光泽，主循环约 2.6s，不再整角色前后顶动）；终态 outcome 文案与未读 presentation 解耦（已读失败任务在 Activity tray 仍明确显示“失败/已取消/已中断”，不再回落为“空闲”）；拖动全程保持缩壳姿态并在放下时播放一次性探头动作（reduced-motion 与 cancel 不播放）；Needs input / Blocked 单击直达最高优先级任务并同步键盘 Enter/Space 路径（仍走 `openActivity` + main deep-link allowlist，不展示隐私字段）；新增庆祝去重（transitionId 基线/重放/reduced-motion 门控）与 timer 清理的契约/行为测试。实现见 `desktop/renderer/pet.css`、`desktop/renderer/pet-state.ts`、`desktop/renderer/pet-app.tsx` 与 `scripts/smoke-desktop-contract.ts`。

2. ~~重新设计 Running 常驻动作，消除持续前后顶动和“一拱一拱”的不自然观感。~~ 完成。
3. ~~解耦终态 outcome 文案与未读 presentation，确保失败任务已读后仍明确显示失败。~~ 完成。
4. ~~完成实际拖动缩壳与放下反馈。~~ 完成。
5. ~~评估 Needs input / Blocked 的安全快速跳转，并同步键盘路径。~~ 完成。
6. ~~为庆祝去重、气泡和 timer 生命周期增加行为测试。~~ 完成。

### P2：表现力与小型工程优化（已完成，第 10 项除外）

P2 已于 2026-08-14 完成 7/8/9 项：庆祝触发改为 transitionId 去重 + 1.5s 合并窗口，窗口内多任务完成合并为一次撒花（reset/SSE 重放/reduced-motion 仍不回放）；新增 ready→idle 下沉点头、retrying→running 重新出发两个一次性语义转换动作（可中断、尊重 reduced-motion、同态快照不重播）；blink/idle act 调度统一为可测试纯策略（`shouldRunIdleLife`/`nextBlinkDelayMs`/`nextActDelayMs`），idle act 播放期间暂停 blink 重启、窗口隐藏时暂停并销毁装饰性 timer、可见时恢复。实现见 `desktop/renderer/pet-state.ts`、`desktop/renderer/pet-app.tsx`、`desktop/renderer/pet.css` 与 `scripts/smoke-desktop-contract.ts`。

7. ~~基于 transitionId 合并多任务完成庆祝。~~ 完成。
8. ~~增加少量语义状态转换动作。~~ 完成。
9. ~~统一 blink / idle act 调度，并在窗口隐藏时暂停装饰性 timer。~~ 完成。
10. 视实际性能证据决定是否移除 blink 强制 reflow。 → 无性能证据，暂不修改（维持现状）。

### P3：正式资源能力

11. 打通 spritesheet 运行时渲染、坏资源回退和正式内置美术。

### Deferred：单独立项

12. 用户自定义皮肤目录。
13. 状态历史、成就或其他养成能力。
14. 宠物本体右键菜单和双击直达，除非用户验证表明现有 Activity tray / 系统托盘路径明显不足。

## 实现边界说明

不能再将上述建议统一描述为“局限在 renderer、不触碰 SSE 协议与领域契约”：

- 终态语义可能涉及共享投影与 Activity view；
- 右键退出、穿透和重连涉及 main/IPC；
- 用户皮肤涉及文件系统、CSP、preload 和打包边界；
- 通知策略涉及 main 进程；
- 历史统计需要新的持久化模型。

优先选择不扩展 observer wire payload 的方案；如果确需改变事件种类、状态契约或共享字段，必须同步更新 ADR、模块文档、消费者和验证用例。
