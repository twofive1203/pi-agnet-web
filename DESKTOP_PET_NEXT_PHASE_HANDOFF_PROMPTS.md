# 蜗牛派桌宠下一阶段——新会话交接提示词

- **Date:** 2026-08-13
- **Plan:** `DESKTOP_PET_NEXT_PHASE_IMPLEMENTATION_PLAN.md`
- **Origin:** `docs/brainstorms/2026-08-13-desktop-pet-experience-refresh-requirements.md`
- **Architecture:** `docs/architecture/decisions/desktop-pet-task-observer.md`
- **Baseline commit:** `99af428 feat(desktop-pet): refresh companion experience`

本文档供新会话直接复制。实施以计划、需求、架构和当前代码为准；提示词只负责快速建立正确上下文。

## 推荐使用顺序

1. 第一次新会话粘贴 **§1 总控提示词**，默认只完成 U1。
2. 每完成一个 Unit，可继续当前会话，也可用 **§2 对应提示词**开新会话。
3. U1–U3 完成后再开始角色资源；U4 与 U5 可在独立 worktree 并行，但项目默认不允许未授权 Subagent。
4. U7/U8 必须在有 Windows 打包和实机条件的会话中进行。
5. 完成全部工作后用 **§3 收尾审查提示词**。

---

## 1. 总控提示词（新会话第一条）

```markdown
# 任务：继续蜗牛派 Windows 桌宠下一阶段优化，从 U1 开始

## 工作方式
你是本仓库的实现 Agent。直接实施既有计划，不重新 brainstorm，不创建 SnFlow 任务，不扩大产品范围。
未经我明确批准，不创建 Subagent；主 Agent 自己阅读、修改和验证。
默认中文回复，代码、命令、日志保持原文。

## 必读（按顺序完整阅读）
1. `AGENTS.md`
2. `DESKTOP_PET_NEXT_PHASE_IMPLEMENTATION_PLAN.md`
3. `DESKTOP_PET_NEXT_PHASE_HANDOFF_PROMPTS.md`
4. `docs/brainstorms/2026-08-13-desktop-pet-experience-refresh-requirements.md`
5. `docs/architecture/decisions/desktop-pet-task-observer.md`
6. `docs/operations/desktop-pet-validation.md`
7. `docs/standards/code-style.md`
8. 相关代码：
   - `desktop/main/window-manager.ts`
   - `desktop/main/main.ts`
   - `desktop/main/settings-store.ts`
   - `desktop/main/activity-store.ts`
   - `desktop/main/notification-controller.ts`
   - `desktop/main/ipc-contract.ts`
   - `desktop/preload/pet-preload.ts`
   - `desktop/renderer/pet-state.ts`
   - `desktop/renderer/pet-app.tsx`
   - `desktop/renderer/index.html`
   - `desktop/renderer/pet.css`
   - `scripts/smoke-desktop-contract.ts`
   - `scripts/smoke-desktop-package.mjs`
   - `scripts/build-desktop-pet.mjs`
   - `forge.config.ts`

## 基线与工作区安全
- 体验重塑基线提交：`99af428 feat(desktop-pet): refresh companion experience`
- 开始前执行 `git status --short` 和 `git log -1 --oneline`。
- 当前工作区可能存在其他用户的未提交修改；不得 `git reset --hard`、`git clean`、批量 restore 或覆盖无关文件。
- 修改前先确认目标文件是否已有未提交内容；提交时只精确暂存本 Unit 文件。
- 不得为了让测试通过而回退或提交无关的 observer/automation 修改。

## 产品硬边界（违反即错误）
- 桌宠是 attach-only、只读观察器；不得启动/停止/重启/监管 `spi`，不得保存服务 PID。
- 退出、崩溃、升级或卸载桌宠不得影响服务和运行任务。
- renderer 不得获得 Node、observer token、access key、cwd、任意 filesystem 或任意 URL 打开能力。
- deep link 只能由 main 对服务端 allowlisted 相对路径二次验证后打开。
- 观察负载不得新增 Prompt/firstMessage、模型全文、工具参数、路径、命令、输出、env、密钥和原始错误。
- 已读、筛选、展开和气泡都属于桌面本地展示状态，不写回服务端任务。
- 不伪造普通 LLM 任务百分比。
- 不内嵌完整 WebUI，不增加 Prompt/审批/停止任务等写操作。
- 不做任意自定义宠物文件导入、皮肤商店、养成或云同步。
- 桌宠与 npm `spi` 包必须继续完全分离。

## 实施顺序
计划单元：
- U1：窗口激活意图与不抢焦点
- U2：多屏/DPI/尺寸/位置恢复
- U3：视觉状态验收台与可访问性
- U4：内置角色资源契约
- U5：Activity tray 多任务定位
- U6：气泡/通知/恢复设置
- U7：真实 Forge 产物
- U8：Windows 发布矩阵

依赖关系以计划中的 Mermaid 图为准。
**本次会话只做 U1。** U1 完成、测试通过、计划勾选后停止，不进入 U2。

## U1 目标
区分：
1. 被动状态更新——绝不 show/focus；
2. 非激活显示——只在设计明确需要时使用；
3. 用户显式激活——托盘点击、second-instance、用户“显示桌宠”可以显示并聚焦。

重点检查：
- `desktop/main/window-manager.ts` 的 `PetWindowHandle` 与 `applyWindowManagerState`
- `desktop/main/main.ts` 的 snapshot、connection、notification、tray、second-instance 路径
- 已隐藏桌宠在 snapshot/reconnect/Ready/Blocked 时必须保持隐藏
- 被动变化不得切换 Windows 虚拟桌面或抢当前应用焦点

## 实施纪律
- 先在 `scripts/smoke-desktop-contract.ts` 增加可失败的 host/调用序列覆盖，再改实现。
- 最小修改；不要同时做尺寸、spritesheet 或 Activity tray 筛选。
- 纯状态与 Electron 接线分离；不把 Electron 实例塞入纯模块。
- 改 IPC/settings/shared type 前先搜索全部消费者。
- 同步更新 `docs/operations/desktop-pet-validation.md` 的对应实机项。
- 完成后在根目录计划中将 U1 改为 `[x]`，补一行简短完成注记与实机残留项。

## 验证
至少实际执行：
```bash
npm run test:desktop-contract
npm run test:desktop-observer
npm run lint
node_modules/.bin/tsc --noEmit
```

若没有真实 Windows 虚拟桌面条件，只能报告自动验证通过，并明确：
“已完成自动与静态检查，Windows 虚拟桌面/焦点实机验证未执行。”
禁止把 smoke 结果写成实机验证通过。

## 输出
- 修改摘要
- 变更文件
- 验证命令和结果
- 是否执行 Windows 实机焦点验证
- 残余风险
- 下一单元 U2 的前置是否满足
- 不要自动 commit，除非我明确要求

现在开始 U1。
```

---

## 2. 分 Unit / 分阶段提示词

### U2：多屏、DPI、尺寸和位置恢复

```markdown
继续 `DESKTOP_PET_NEXT_PHASE_IMPLEMENTATION_PLAN.md`，本次只做 U2。

前置：U1 已在计划中完成且 `npm run test:desktop-contract` 通过。若未完成，先停止并说明缺口。

必读：AGENTS.md、根目录计划、根目录交接提示词、体验重塑需求、desktop validation，以及 U2 Files 中的全部文件。
先检查 git status，保护其他用户未提交修改；不 reset/clean，不使用未授权 Subagent。

目标：
- settings 增加兼容迁移的小/中/大 `petScale`
- 提供“恢复默认位置”
- 用同一布局规格计算 collapsed/tray/pet stack/click target/anchor
- 处理 display added/removed/metrics changed，把离屏窗口拉回最近 workArea
- renderer 与 BrowserWindow 同步缩放，重启保持

先写设置迁移和几何纯函数 smoke，再接 main/screen/IPC/renderer。
不要做 spritesheet、筛选、气泡策略或 Forge 发布。

验证：desktop-contract、desktop-observer、lint、tsc；有 Windows 条件时补 100/150/200% 和主副屏实测并更新 validation 文档。
完成后勾 U2、汇报残留实机风险，停止。
```

### U3：视觉状态验收台与可访问性

```markdown
继续根目录桌宠计划，本次只做 U3。
前置：U1、U2 完成。

目标：建立开发态视觉状态 preview/fixture，覆盖八状态、两角色、三尺寸、tray、settings、reduced-motion；补键盘焦点和长标题检查。

约束：
- preview 只接受静态安全 view fixture
- 不连接真实 observer，不读取 session/cwd，不持有 token
- production preload/IPC/package 不暴露调试入口
- 不新增服务端协议字段

实现计划中的 `scripts/preview-desktop-pet-states.mjs` 和 `docs/operations/desktop-pet-visual-review.md`；先查现有 build/package ignore，确保 fixture 不扩大生产攻击面。

验证：desktop:build、desktop-contract、desktop-package、lint、tsc；输出 preview 使用方法和未执行的人工视觉组合。
完成后勾 U3，停止。
```

### U4：版本化内置角色资源契约

```markdown
继续根目录桌宠计划，本次只做 U4。
前置：U3 完成。

目标：建立安全的内置 pet manifest v2 和可选 spritesheet 资源加载，任何失败都回退当前 CSS 蜗牛。

必须：
- 内置 id allowlist
- 包内相对路径，无 `../`、file://、http(s)://
- 状态完整性、尺寸、帧数/时序和文件大小上限
- reduced-motion 静态帧
- build/package 验证资源存在
- 角色仅改变外观，绝不声明命令、URL、技能或写操作

如果没有批准的正式美术，只落 contract、validator 和 CSS fallback，不临时生成低质量资源冒充完成；在计划完成注记中明确“资源契约完成，正式 spritesheet 待美术”。

验证：desktop:build、desktop-contract、desktop-package、lint、tsc；完成后勾 U4，停止。
```

### U5：Activity tray 多任务定位

```markdown
继续根目录桌宠计划，本次只做 U5。
前置：U1 完成；U4 不要求完成。

目标：
- renderer 本地筛选：全部/需关注/运行中/已完成
- Subagent 安全摘要展开
- 明确区分“打开任务”和“标记已读”
- 键盘与空结果/选择重置完整

硬边界：只使用现有 DesktopActivityView；不新增 transcript/output/cwd/tool args，不改服务端任务状态，不新增 per-session SSE。

先给筛选/选择/已读纯 helper 写 smoke；再改 renderer。检查 `assertRendererViewSafe` 仍通过。
验证：desktop-contract、desktop-observer、lint、tsc；完成后勾 U5，停止。
```

### U6：气泡生命周期、通知与恢复

```markdown
继续根目录桌宠计划，本次只做 U6。
前置：U2、U3、U5 完成。

按 transition/revision 实现纯气泡状态策略：
- Needs input / Blocked：保持到状态改变或查看
- Ready：保持到已读
- Running / Retrying：有意义转换后短暂显示
- Idle：默认隐藏
- replay/reset/elapsed 不重复触发

同时本地化通知文案，并接“恢复默认位置/尺寸”；通知权限失败不能影响 Activity tray。
使用注入时间/reducer 测试，禁止真实 sleep 和高频 timer 推动服务 revision。

验证：desktop-contract、desktop-observer、lint、tsc；有 Windows 条件时验证通知拒绝和点击回跳。
完成后勾 U6，停止。
```

### U7：真实 Forge 产物

```markdown
继续根目录桌宠计划，本次只做 U7。
前置：U4、U6 完成；需要 Windows 打包环境。

先运行当前 Forge package/make 做 characterization，记录实际失败，不先猜修复。
然后：
- 增加稳定 package/make 脚本，构建前生成 main/preload/renderer
- 配置正式 icons/AppUserModelID/Squirrel metadata
- 扩展 artifact scan 到真实 asar/资源树
- 验证通知点击和 pet-only 包体

禁止把证书、密码或 secret 写入仓库；未签名产物只能标工程 QA。
禁止把 Next、pi SDK、node-pty、Automation worker、spi sidecar 带入安装包。

验证：desktop:build、desktop-observer、desktop-package、Forge package/make、DESKTOP_PACKAGE_OUT artifact scan、lint、tsc。
完成后勾 U7，列出签名/SmartScreen 阻塞，停止。
```

### U8：Windows 发布矩阵

```markdown
继续根目录桌宠计划，本次只做 U8 发布验收和发现问题的最小修复。
前置：U1–U7 完成，已有可安装产物。

严格执行 `docs/operations/desktop-pet-validation.md`：
- Windows 10/11 clean install
- 100/150/200% DPI
- 主副屏、拔掉副屏、任务栏位置
- 虚拟桌面不抢焦点
- 通知允许/拒绝/点击
- service down/up/restart
- click-through recovery、close-to-tray、Quit pet
- update-over-install、uninstall、`~/.pi/agent` 保留
- reduced-motion、浅/深主题

每项写 Pass/Fail/Blocked 和证据；不得把自动 smoke 当实机结果。
失败只做与发布门禁相关的最小修复，并回补自动测试；不新增产品功能。

全部阻塞项通过后才把根目录计划 status 改为 completed，并更新相关 README/validation。
不要自动发布、上传或签名，除非我明确授权。
```

---

## 3. 收尾审查提示词

```markdown
审查 `DESKTOP_PET_NEXT_PHASE_IMPLEMENTATION_PLAN.md` 的完成情况，不新增功能。

先读：
- AGENTS.md
- 根目录计划和交接提示词
- 体验重塑需求与桌宠 ADR
- desktop validation
- git diff / git status

逐项检查 U1–U8：
1. 计划 Files 和行为是否真实落地
2. Test scenarios 是否有对应自动或人工证据
3. Windows 实机项是否被诚实标记
4. attach-only、privacy、loopback、renderer 隔离、deep-link allowlist、退出隔离是否退化
5. npm spi 与桌宠包是否仍分离
6. 是否误提交用户原有修改、生成物、证书、secret 或安装包
7. docs/modules、deployment、troubleshooting、validation 是否与代码一致

执行：
```bash
npm run desktop:build
npm run test:desktop-observer
npm run test:desktop-package
npm run lint
node_modules/.bin/tsc --noEmit
```
如有真实 Forge 产物，设置 DESKTOP_PACKAGE_OUT 再跑 package smoke。

输出按严重度列发现（文件+依据），然后给：
- 自动验证结果
- Windows 实机矩阵结果
- 残留发布阻塞
- 是否可以将计划标记 completed

不要自动 commit/push/release。
```

---

## 4. 提交提示词（单 Unit 验证完成后使用）

```markdown
只提交刚完成的桌宠 Unit。

要求：
- 先读 `git status`、`git diff`、最近提交
- 当前工作区可能有其他用户未提交修改，按文件精确暂存，禁止 `git add .` / `git add -A`
- 不提交证书、secret、安装包、out/dist、日志或视觉临时产物
- 如果目标文件混有其他工作，先停下说明，不要整文件误提交
- 提交前确认该 Unit 的测试已实际通过
- 使用仓库 conventional commit 风格，例如：
  - `fix(desktop-pet): prevent passive window activation`
  - `feat(desktop-pet): add resilient scale and placement`
  - `feat(desktop-pet): add safe builtin animation assets`
- 提交后报告 hash、subject 和仍未提交的文件；不要 push
```

---

## 5. 会话结束交接模板

每个新会话结束时，让 Agent 输出以下内容，便于下一会话续接：

```markdown
## 桌宠会话交接
- 当前分支：
- 最新相关提交：
- 完成 Unit：
- 修改文件：
- 自动验证：
- Windows 实机验证：
- 未完成/Blocked：
- 工作区其他未提交修改：
- 下一 Unit：
- 下一会话第一步：
```
