---
date: 2026-08-18
topic: codex-pet-resource-compatibility
status: approved
---

# Codex 桌宠资源兼容需求

## Problem Frame

蜗牛派桌宠已经具备安全的自定义资源加载能力，但当前资源契约是项目自研格式：`manifest.json + PNG/WebP spritesheet`、8 个业务展示状态、默认 108×92 单元格、单图不超过 256 KB。制作一套完整资源需要自行设计角色、逐状态出图、拼图和质检，成本较高。

Codex 已形成可复用的桌宠资源与 `hatch-pet` 生成工作流。当前抽样资源使用 `pet.json + spritesheet.webp`；下载的两个 v2 包均为 1536×2288、8×11、192×208 单元格，包含 9 行标准动作与 2 行 16 向注视姿态。若蜗牛派原生兼容该格式，用户可直接使用 Codex 资源，后续角色设计也可复用 Codex 的生成工作流，而无需继续维护一条独立美术产线。

用户已选择：**双格式并存**。现有蜗牛派资源格式继续兼容，新增 Codex v1/v2 原生资源 profile；不通过强制离线转码替代原资源。

---

## Actors

- A1. 桌宠用户：希望复用本地 Codex 资源或下载的 Codex 资源包。
- A2. 资源制作者：使用 Codex `hatch-pet` 工作流生成 `pet.json + spritesheet.webp`。
- A3. 蜗牛派桌宠主进程：发现、校验并按需读取本地资源，保持文件系统与 IPC 安全边界。
- A4. 蜗牛派桌宠 renderer：将两种资源规范归一为统一动画 clip，并按业务状态呈现。

---

## Key Flows

- F1. 自动发现 Codex 资源
  - **Trigger:** A1 启动桌宠或点击刷新资源。
  - **Steps:** A3 扫描蜗牛派自定义资源目录和本机 Codex pets 目录；识别蜗牛派 `manifest.json` 与 Codex `pet.json`；只向 renderer 暴露安全目录项和诊断。
  - **Outcome:** 两种资源在同一角色选择器中可见，且来源可区分。

- F2. 原生播放 Codex 资源
  - **Trigger:** A1 选择一个 Codex v1/v2 角色。
  - **Steps:** A3 按选择项读取一个资源文件；A4 校验解码尺寸，按 Codex 固定 atlas profile 解析标准动作；将蜗牛派 8 个展示状态映射到 Codex 动作。
  - **Outcome:** 不重编码原文件即可正确显示和播放。

- F3. 复用 Codex 生成工作流
  - **Trigger:** A2 使用 Codex `hatch-pet` 生成或更新资源。
  - **Steps:** 生成结果写入 Codex pets 目录；A1 在蜗牛派桌宠刷新资源。
  - **Outcome:** 生成产物无需再制作蜗牛派专用 manifest 或 spritesheet。

---

## Requirements

- R1. 保留现有蜗牛派自定义资源格式与内置资源，不要求用户迁移已有资源。
- R2. 原生识别 Codex v1（8×9、1536×1872，`spriteVersionNumber` 缺省或为 1）和 v2（8×11、1536×2288，`spriteVersionNumber: 2`）资源。
- R3. Codex 资源至少支持 `id`、`displayName`、`description`、`spritesheetPath`、`spriteVersionNumber`，并容忍抽样资源中的安全展示元数据（如 `kind`）；未知字段不得进入运行时能力面。
- R4. 统一资源层必须将蜗牛派业务状态映射到 Codex 标准动作，同时继续使用蜗牛派现有文字、glyph、气泡、通知和优先级语义，不能让美术格式反向改变任务领域状态。
- R5. Codex v2 的 16 向注视应作为增强能力；v1、reduced-motion、损坏资源或无指针方向时必须有稳定回退。
- R6. 不把所有大型 Codex atlas 一次性 base64 推送给 renderer；资源目录只传元数据，位图按当前选择项加载并在切换时释放。
- R7. 两种格式的资源路径都必须经过根目录 containment、文件类型、文件大小、数量和解码尺寸校验；renderer 不获得任意文件路径或 `file://` 能力。
- R8. 资源选择持久化必须使用可区分格式/来源的稳定 key，避免同名蜗牛派与 Codex 资源冲突，并兼容现有 `selectedPetId` 设置。
- R9. 加载失败、资源被删除或 atlas 解码不匹配时必须回退到内置 CSS 蜗牛，不得白屏或使桌宠崩溃。
- R10. Codex 资源的本地加载能力不等同于再分发许可；项目不得仅凭 `pet.json` 将第三方角色资源打包发布。

---

## Acceptance Examples

- AE1. **Covers R1, R2.** 同一资源目录中同时存在一个蜗牛派 manifest 包和一个 Codex v2 包时，刷新后两者都出现在选择器中并可分别选择。
- AE2. **Covers R2, R4.** 选择 Codex v2 资源后，任务进入 Running、Needs input、Ready、Blocked 时分别播放工作、等待、庆祝、失败语义的动画，蜗牛派状态文字和 glyph 保持不变。
- AE3. **Covers R5.** Codex v2 角色空闲且用户在角色附近移动指针时，可按 deadzone 量化到 16 个注视方向；开启 reduced-motion 后保持静态、可理解的姿态。
- AE4. **Covers R6.** 安装多个 2–3 MB Codex 资源时，启动扫描只返回目录元数据；仅选择项的位图进入 renderer，切换后旧 object URL 被释放。
- AE5. **Covers R7, R9.** `spritesheetPath` 越界、文件超限、版本与尺寸不匹配、图片解码失败或资源在选择后被删除时，该资源被拒绝或回退，桌宠仍显示内置 CSS 蜗牛。
- AE6. **Covers R8.** 已保存的现有蜗牛派自定义角色在升级后仍能恢复；同 id 的 Codex 角色不会覆盖它。
- AE7. **Covers R10.** 本地导入的 ZIP 没有作者/许可证元数据时，系统可以将其作为用户本地资源使用，但不会把它加入安装包或官方内置资源。

---

## Scope Boundaries

- 首轮不建设在线宠物商店、远程下载、评分、云同步或自动更新。
- 首轮不移除 `skills/desktop-pet-assets`、现有蜗牛派 manifest 或已有自定义资源目录。
- 首轮不把 Codex atlas 裁剪、缩小或重新编码为蜗牛派 4×8 图集。
- `.codex-pet.zip` 一键导入可作为后续独立切片；首轮以解压目录和 `${CODEX_HOME:-~/.codex}/pets` 自动发现为主。
- 不把下载样例资源提交进仓库；尤其是第三方/知名角色素材，未确认许可前不得随桌宠发布。

---

## Key Decisions

- **双 profile，而不是替换格式：** 保护现有用户资源，降低迁移风险。
- **原生播放，而不是离线转换：** 保留 Codex 动作质量、v2 注视方向和官方生成工作流直通能力。
- **领域状态与美术动作分离：** Codex 动作只是表现层，蜗牛派 8 状态继续是业务事实来源。
- **目录扫描与位图加载分离：** Codex atlas 明显大于当前资源，必须按需加载，避免启动时的 base64/IPC/内存放大。
- **同时支持 v1/v2：** 公开资源存在版本差异，兼容两版比假设所有资源都已升级更稳妥。

---

## Dependencies / Assumptions

- Codex 标准单元格为 192×208，v1 为 8×9，v2 为 8×11；前 9 行标准动作顺序固定为 idle、running-right、running-left、waving、jumping、failed、waiting、running、review；v2 最后两行为 16 个顺时针注视方向。
- `pet.json` 不提供蜗牛派业务状态映射，因此映射由项目内置 Codex profile 定义。
- 两个本地样例包均可作为人工兼容验证输入，但不是可提交的测试夹具或可再分发素材。

---

## Next Steps

进入技术实施计划：先建立双格式目录与运行时 profile，再完成按需位图加载、业务状态映射和 v2 注视增强。
