# Codex 桌宠资源利用率与交互对标审计 — 2026-08-18

状态：Open research（P0 分层/动画通道与 P1 资源完整利用已落地；P2 发现/导入仍开放。未执行 Electron 实机逐帧播放矩阵）。

## 结论

当前实现已经正确完成 Codex 包发现、v1/v2 尺寸识别、按需加载、状态优先级、鼠标朝向和横向拖动动画，安全与内存边界也比较完整；但还不能称为“完全匹配”或“资源完全利用”。

对两套本地 v2 样本 `blue-whale-maid`、`minato` 的逐格审计结果一致：

- v2 图集共有 88 个格子（8×11）。
- 样本实际有内容的格子为 74 个；其中 1 个是非标准的额外 idle 格。
- 当前运行时真正可达的格子为 62 个。
- 因此按整张图集计算可达率为 **62/88 = 70.45%**；按样本实际有内容的格子计算为 **62/74 = 83.78%**。
- 审计当时的主要缺口是 `jumping` 5 帧和 `review` 6 帧从未被运行时选中；额外的 idle 第 7 帧也被忽略。P1 已把 `jumping` 接到一次性点击/双击、把 `review` 接到 Running `thinking`，并增加 reachability / unused-cell 校验；idle 第 7 格仍不进入运行时（协议仍是 6 帧）。
- 更影响观感的问题曾是把 192×208 单帧非等比缩放到 108×92，角色相对横向被拉宽约 **27.2%**。P0 已改为内层 `.pet-bitmap` 按 192:208 contain。

## 审计范围

### 代码

- `desktop/renderer/codex-pet-assets.ts`
- `desktop/renderer/pet-runtime-profile.ts`
- `desktop/renderer/pet-sheet.ts`
- `desktop/renderer/pet-app.tsx`
- `desktop/renderer/pet-state.ts`
- `desktop/renderer/pet.css`
- `desktop/main/pet-catalog.ts`
- `scripts/smoke-desktop-contract.ts`

### 本地样本

- `codex-ui-resouce/extracted/blue-whale-maid/`
- `codex-ui-resouce/extracted/minato/`

样本均为 v2：1536×2288、192×208 单元格、RGBA WebP。样本目录被 `.gitignore` 排除，不进入安装包。

## 资源映射与利用率

| 行 | Codex clip | 有效帧 | 当前用途 | 可达 |
| ---: | --- | ---: | --- | --- |
| 0 | `idle` | 标准 6；本地样本实际 7 | Idle；Service not running 静态帧 | 是（只用前 6） |
| 1 | `running-right` | 8 | 水平向右拖动 | 是，低频交互 |
| 2 | `running-left` | 8 | 水平向左拖动 | 是，低频交互 |
| 3 | `waving` | 4 | Ready 常驻；Idle/Running/Retrying 单击问候 | 是 |
| 4 | `jumping` | 5 | 只生成 clip/CSS；没有选择路径 | **否** |
| 5 | `failed` | 8 | Blocked；Disconnected 静态末帧 | 是 |
| 6 | `waiting` | 6 | Needs input | 是 |
| 7 | `running` | 6 | Running 与 Retrying | 是 |
| 8 | `review` | 6 | 只生成 clip/CSS；没有选择路径 | **否** |
| 9–10 | `look-0`…`look-15` | 16 | Idle 时按指针方向切换静态朝向 | 是，v2 专属 |

可达帧合计：

```text
idle 6
+ directional run 16
+ waving 4
+ failed 8
+ waiting 6
+ running 6
+ look 16
= 62
```

样本非透明像素按当前可达/不可达分类：

| 样本 | 当前可达 | `jumping` + `review` 不可达 | 额外 idle 格 |
| --- | ---: | ---: | ---: |
| blue-whale-maid | 84.63% | 13.84% | 1.53% |
| minato | 82.61% | 16.13% | 1.26% |

透明预留格不是浪费，而是 Codex 固定图集协议的一部分；真正应处理的是“有内容但不可达”的格子。

## 关键发现

### F1 — 单帧被非等比拉伸（高优先级，视觉正确性）

`PET_SPRITE_AVATAR_WIDTH/HEIGHT` 为 108×92。`spriteCellPosition()` 和 `spriteSheetBackgroundSize()` 分别使用：

```text
scaleX = 108 / 192 = 0.5625
scaleY = 92 / 208 ≈ 0.4423
```

源单帧宽高比为 192/208≈0.923，显示框宽高比为 108/92≈1.174，因此相对横向放大约 27.2%。人物脸、头发和身体会明显变宽。

建议不要只修改背景尺寸公式，因为宽于单元格的外层 viewport 可能泄露相邻格。更稳妥的结构是：

- `.pet-avatar` 保留 108×92，继续承载状态 glyph、语义动效和交互；
- 增加独立 `.pet-bitmap` 内层，按 192:208 等比 contain 为约 85×92；
- spritesheet 的 `background-position`/`animation` 只作用于内层。

这也能同时解决 F3 的动画属性冲突。

### F2 — `jumping` 与 `review` 共 11 帧不可达（高优先级，资源利用）

`profileFromCodexMetadata()` 会创建两组 clip，`buildSpriteSheetStyleTextFromProfile()` 也会生成对应 CSS，但：

- `SNAIL_STATE_TO_CODEX_CLIP` 没有映射到 `jumping` 或 `review`；
- `resolveActivePetClip()` 的装饰覆盖只支持 directional run、wave、look；
- 仓库搜索没有其他选择入口。

推荐映射：

1. **`jumping` 用作一次性点击/双击反应**，不要重新作为 Ready 无限循环。这样既符合 Codex 用户观察到的“触碰短跳”，也避免 Minato 等动作型资源持续原地攻击。
2. **`review` 用作 Running cue 的 `thinking`/检查姿态**。现有 `resolveRunningCue()` 已有有限枚举和防抖，不需要扩大 observer wire；未知/编辑/命令/Subagent 仍可回退 `running` + glyph。

完成后，标准 v2 的 73 个协议帧都可以具有明确可达路径；本地额外 idle 格仍应按 F4 处理，而不是擅自改变协议。

### F3 — spritesheet 播放与外层趣味/过渡动画争抢 `animation`（高优先级，交互正确性）

动态样式的 selector 类似：

```css
.pet-avatar.pet-sprite-<token>[data-clip="idle"].is-animated { animation: ... }
```

而 `reaction-poke`、`reaction-flail`、`transition-retry-go` 也在同一个 `.pet-avatar` 上写 `animation`。前者 specificity 更高，因此 spritesheet 角色通常会继续播放背景帧动画，而外层 transform keyframes 不生效。CSS 蜗牛有独立 anatomy 子节点，所以不完全暴露这个问题。

F1 建议的“外层 avatar + 内层 bitmap”可把两个动画通道彻底分离：

- 内层：只控制 `background-position` 帧动画；
- 外层：只控制 transform/transition/按压/趣味反应。

新增 smoke 应直接验证最终样式层级或浏览器 computed style，不能只检查 class/CSS marker 存在。

### F4 — 两套本地 v2 样本都有一个非标准 idle 第 7 帧（中优先级，资源质量）

官方 `hatch-pet` animation rows 当前定义 idle 使用 0–5 共 6 帧，后续格必须透明。本地两套样本的 row 0、col 6 均非透明，但当前 profile 正确地只使用 0–5。

这说明“尺寸正确”不足以判断包完全符合协议。当前 catalog 只检查文件大小、路径和期望像素尺寸，renderer 只做 decode/尺寸检查，没有验证未使用格透明。

建议：

- 保持运行时 idle=6，不因个别样本改变固定兼容表；
- 在导入/检查工具中增加“有效格非空 + 保留格全透明”诊断；
- 对不合规包给出警告或拒绝策略，避免用户误以为所有画面都会播放。

### F5 — 选择器中未选中的 Codex 包没有真实缩略图（中优先级，资源发现）

catalog 扫描只下发 metadata，位图只在选中后通过 `getPetAsset()` 按需加载。这是正确的内存策略，但副作用是未选角色在 Picker 中只显示 `◈`；用户无法在选择前看到角色本身。

建议保留“只加载选中全图集”，另加轻量缩略图通道：

- main 从 idle 首帧生成/缓存小尺寸 PNG/WebP；或
- 选项进入可视区/hover 时按需请求只读缩略图；
- 不把所有 2–3 MiB atlas 一次性送入 renderer。

### F6 — v2 兼容需要明确证据边界（中优先级，维护风险）

OpenAI 当前官方 `hatch-pet` skill 和 Pets Web 上传文档仍以 1536×1872 的 8×9/v1 图集为公开合同；8×11/v2 与 16 个 look 方向主要来自当前 App/社区资源和第三方兼容生态。项目支持 v2 是有价值的增强，但不应把它描述为官方 skill 的稳定公开 schema。

建议：

- v1 继续作为官方基线；
- v2 保持 additive capability 与独立 fixture；
- 任何 v2 行数、look 索引或 manifest 版本变化都由样本/实机回归验证，而不是只依赖社区说明。

## 已做得比较好的部分

- v1/v2 atlas 尺寸、单元格尺寸和版本分开处理。
- Snail/Codex key 使用 `snail:<id>` / `codex:<id>` 命名空间，无同名劫持。
- catalog 只传 metadata，2–3 MiB 位图仅选中时读取，避免批量 base64。
- realpath containment、大小上限、类型/路径门禁、删除/变化检测与 CSS fallback 完整。
- v2 的 16 向 look、左右拖动 clip、reduced-motion 静态帧都已经有纯函数与自动 smoke。
- Ready 已从错误的 `jumping` 无限循环修正为 `waving`；这个决策应保留。
- 8 态优先级、Activity tray、多项目聚合、上下文环、快速会话、DND/声音等生产力能力已经不弱于 Codex Pets。

## Codex 当前交互对标

OpenAI 当前官方 Pets 文档确认：

- Desktop：Pets 设置选择角色，`/pet` 或 Wake Pet 唤醒/收起；位置持久化；Running / Needs input / Ready / Blocked 四态；多聊天按 Needs input > Blocked > Ready > Running；Activity tray 选聊天；点宠物回到 ChatGPT；点 activity 打开聊天。
- macOS Computer Use：画中画窗口可附着到醒着的宠物，移动宠物时窗口跟随。
- Custom pet：Settings 内一键启动 bundled `hatch-pet` skill，生成后 Refresh/选择。
- Web：支持上传、编辑、下载、刷新、删除 1536×1872 PNG/WebP 宠物，但没有 desktop overlay/tray。
- CLI：`/pets`/`/pet` 选择图形终端宠物，跟随当前 CLI session，不提供多聊天 tray。
- reduced motion：使用静态帧。

值得借鉴、且与当前项目最匹配的方向：

1. **先补资源播放完整性**：等比渲染、jumping 一次性反应、review 工作细分、reachability 测试。
2. **把角色选择做成真正的视觉选择**：安全缩略图，而不是只有名称和 `◈`。
3. **打通“创作 → 校验 → 预览 → 安装”**：复用项目已有 `desktop-pet-assets` 检查能力，提供受控 ZIP/文件导入、来源/许可说明和一键刷新；不必首期在桌宠内接付费图像生成。
4. **评估 Browser/Computer Use 小窗跟随**：项目已有 Browser Binding，可研究只读、可关闭的绑定状态/预览附着，但这属于独立高成本特性，不应夹在资源修复中。
5. **跨表面只复用身份，不复制完整桌宠**：以后可在 WebUI/CLI 展示所选角色或当前状态，但 Windows Electron 仍是多项目常驻观察器的主表面。

不建议照搬：

- 不开放 `pet.json` 任意 click/URL/command/action；OpenAI 对此也只有社区 issue 提案，并非已发布合同。
- 不把 Prompt、命令、路径或审批正文放入 observer snapshot。
- 不一次性加载所有完整 atlas 来做 Picker 预览。
- 不把 `jumping` 重新作为 Ready 常驻循环。
- 不复制第三方角色或 AGPL/非开源美术；本地可加载不代表可再分发。

## 建议优先级

### P0 — 视觉/播放正确性（已完成 2026-08-18）

1. 外层 `.pet-avatar` 保持 108×92；内层 `.pet-bitmap` 按 192:208 contain（约 85×92）。
2. 图集 `animation` 只写在 `.pet-bitmap`；`reaction-poke` / `reaction-flail` / `transition-retry-go` 留在外层。CSS 蜗牛的 wrapper 循环加 `:not(.pet-sprite)`，避免 `frame-idle` 抢占图集角色。
3. smoke 用解析后的 CSS cascade + `spriteVisualSize` 覆盖小/中/大尺寸等比，不只检查 class/marker。Electron 实机逐帧仍未跑。

### P1 — 资源完整利用（已完成 2026-08-18）

1. `jumping` 接一次性点击/双击反应（`playCodexJump`；Ready 仍循环 `waving`）。
2. `review` 接 Running `thinking`/检查 cue，并保留防抖与高优先级抢占。
3. 增加 clip reachability 测试：每个标准 clip 必须被业务态或显式交互引用；例外必须有注释。
4. 增加 unused-cell transparency 校验，报告额外 idle 第 7 格（`auditCodexAtlasCells` + `desktop-custom-pet.mjs review`；保留格泄漏为警告，不阻止本地加载）。

### P2 — 资源发现与生态

1. Picker 安全缩略图。
2. ZIP/文件导入、预览、校验、来源/许可声明、删除/刷新。
3. 记录 v1 官方基线与 v2 additive fixture 的兼容矩阵。

### P3 — 独立产品研究

- Browser/Computer Use 预览附着。
- WebUI/CLI 的同角色身份投影。
- 社区分享/下载生态。

## 验证记录

已执行：

```text
npm run test:desktop-contract
smoke-desktop-contract: ok
```

另用 Pillow 对两套本地 atlas 做了尺寸、alpha、逐格非透明像素和可达帧统计。

未执行：

- Electron 中两套样本的小/中/大尺寸逐帧视觉播放；
- Windows DPI、多屏、拖动、鼠标朝向和 reduced-motion 实机矩阵；
- 安装包内真实 custom pet 加载。

因此结论属于静态代码 + 资源像素 + 自动 contract smoke 审计，不能替代实机视觉验收。

## Sources

- [OpenAI Codex Pets 官方文档](https://developers.openai.com/codex/pets)
- [OpenAI `hatch-pet` skill](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md)
- [OpenAI `hatch-pet` animation rows](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/references/animation-rows.md)
- [OpenAI Developer Community — Show us your custom Codex Pet](https://community.openai.com/t/show-us-your-custom-codex-pet/1387591)
- [Codex issue #20863 — configurable animation sequences/activity events（社区提案，非已发布能力）](https://github.com/openai/codex/issues/20863)
- [Codex issue #21657 — pet interaction hooks/APIs（社区提案，非已发布能力）](https://github.com/openai/codex/issues/21657)
