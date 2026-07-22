# SnFlow 改造方案：项目级扩展集成 + 设置页状态面板

> 目标：让 SnFlow 对齐 Trellis 的集成模式——以 pi 项目级扩展的方式集成到目标项目（注册 extension / skill / agent），引入版本管理与更新检测，并在设置页提供类 Trellis 的状态检查面板（初始化状态、当前版本、是否需要更新）。

## 一、现状与差距

| 维度 | Trellis（参照） | SnFlow（现状） | 目标 |
|---|---|---|---|
| 设置页 | Inspection 面板：环境/CLI/项目版本逐行状态 + init/update 按钮（`SettingsConfig.tsx:1364-1670`） | 仅 2 个偏好开关（`SettingsConfig.tsx:1338-1363`） | 增加状态面板 + init/update 按钮 |
| pi 扩展 | `.pi/extensions/trellis/index.ts`（工具/快捷键/事件钩子） | 无扩展，靠 `lib/rpc-manager.ts:517-524` 硬编码注入 guidance | 初始化时写入 `.pi/extensions/snflow/` |
| skill | 9 个 `trellis-*` skill | 仅本仓库预置的静态 `.pi/skills/workflow-dev/` | 初始化时写入 skill 到目标项目 |
| agent | 3 个 `.pi/agents/trellis-*.md` | 无 | 初始化时写入 `snflow-implement` / `snflow-check` 等 agent |
| 版本管理 | `.trellis/.version` + `trellis --version`，支持 upgrade | 无版本概念，init 仅创建两个空目录（`lib/workflow-setup.ts:64-70`） | `.pi/snflows/.version` + 内置资产版本对比 |

## 二、总体设计

### 2.1 资产模板化（新增 `assets/snflow/`）

SnFlow 与 Trellis 的关键区别是**没有外部 npm 包**，资产随 pi-agent-web 应用发布。因此把要写入目标项目的文件收敛为应用内置模板目录：

```
assets/snflow/
├── manifest.json                 # { "version": "1.0.0", "files": [...] }
├── extensions/snflow/index.ts    # pi 项目级扩展（见 2.3）
├── skills/snflow-dev/SKILL.md    # 由现有 .pi/skills/workflow-dev/ 迁移改名
├── agents/snflow-implement.md
├── agents/snflow-check.md
└── scripts/snflow-task.ts        # 由 scripts/workflow-task.ts 迁移（或扩展内联调用）
```

- `manifest.json` 中的 `version` 是**单一版本源**（SemVer），随资产变更手动递增。
- 打包注意：Next.js 下需确保模板目录进入运行时产物（`outputFileTracingIncludes` 或构建期内联为字符串常量，推荐后者，彻底规避路径问题）。

### 2.2 初始化 / 更新逻辑（改造 `lib/workflow-setup.ts`）

`initializeWorkflowProject(cwd)` 从"只建目录"升级为完整安装：

1. 创建 `.pi/snflows/tasks/`、`.pi/snflows/archived/`（保留现有幂等行为）。
2. 按 manifest 将模板复制到目标项目：
   - `.pi/extensions/snflow/index.ts`
   - `.pi/skills/snflow-dev/SKILL.md`
   - `.pi/agents/snflow-implement.md`、`.pi/agents/snflow-check.md`
3. 写入 `.pi/snflows/.version`（内容为 manifest 版本号）。

新增 `updateWorkflowProject(cwd)`：

- 覆盖式重写受管文件（以 manifest 的 `files` 列表为白名单，只动 SnFlow 自己的文件，不碰用户的其他 `.pi` 内容）。
- 更新 `.pi/snflows/.version`。
- 任务数据（`tasks/`、`archived/`）绝不触碰。

`WorkflowSetupStatus` 扩展为（对齐 `TrellisSetupStatus` 的形态）：

```ts
export interface WorkflowSetupStatus {
  cwd: string;
  initialized: boolean;            // tasks 目录存在（保持现语义，向后兼容）
  hasSnflowsDir: boolean;
  hasTasksDir: boolean;
  hasArchivedDir: boolean;
  pathLabel: string;
  // —— 新增 ——
  bundledVersion: string;          // 应用内置资产版本（manifest）
  projectVersion?: string;         // .pi/snflows/.version，缺失=旧版初始化
  hasExtension: boolean;           // .pi/extensions/snflow/ 存在
  hasSkill: boolean;
  hasAgents: boolean;
  updateAvailable: boolean;        // projectVersion < bundledVersion 或组件缺失
  recommendedAction: "initialize" | "update" | "ready";
}
```

版本对比用简单的 SemVer 比较（可直接复用 `trellis-manager.ts:64` 的 `versionAtLeast` 思路，抽到公共工具）。**兼容旧项目**：已有 `.pi/snflows/tasks/` 但无 `.version` 的项目视为"已初始化 + 需要更新"，update 会补齐扩展/skill/agent 和版本文件。

### 2.3 pi 项目级扩展（`assets/snflow/extensions/snflow/index.ts`）

参照 `.pi/extensions/trellis/index.ts` 的结构，但保持轻量（KISS，第一版只做 guidance 迁移）：

```ts
export default function snflowExtension(pi) {
  pi.on("before_agent_start", (event) => {
    // 读取 .pi/snflows/ 任务状态，构建面包屑注入 systemPrompt
    // 逻辑即现有 lib/workflow-guidance.ts 的 buildWorkflowSystemGuidance
  });
}
```

要点：

- **guidance 注入职责从 `rpc-manager.ts` 迁到扩展**。扩展是自包含的（不能 import WebUI 的 lib），需把 `workflow-guidance.ts` 的核心逻辑复制/生成进扩展文件——这正是资产需要版本化的原因。
- `rpc-manager.ts:517-524` 的注入逻辑保留一个过渡开关：检测到项目已安装 snflow 扩展（`hasExtension`）时**跳过** WebUI 侧注入，避免双重注入；未安装扩展的旧项目仍走旧路径，保证平滑过渡。
- 第二版可选增强：注册 `snflow_task` 工具（替代 CLI 脚本调用）、快捷键等，本方案不展开。

### 2.4 API 路由

| 路由 | 变更 |
|---|---|
| `app/api/workflows/setup/status/route.ts` | 返回扩展后的 `WorkflowSetupStatus`（含版本与 recommendedAction） |
| `app/api/workflows/setup/init/route.ts` | 调用升级后的完整初始化 |
| `app/api/workflows/setup/update/route.ts` | **新增**，调用 `updateWorkflowProject` |

响应统一为类 `TrellisCommandResponse` 形态：`{ success, output, status, error? }`，便于前端复用现有渲染逻辑。

### 2.5 设置页（`components/SettingsConfig.tsx` SnFlow 分区）

参照 Trellis Inspection 面板（:1605-1663）改造 SnFlow 分区，在现有两个开关下方新增：

**状态检查面板**（复用 `StatusRow` 组件）：

- 项目是否已初始化（`.pi/snflows` 路径展示）
- 项目 SnFlow 版本 vs 内置版本（如 `1.0.0 → 1.1.0` 提示可更新）
- pi 扩展已注册（`.pi/extensions/snflow/`）
- skill 已注册（`.pi/skills/snflow-dev/`）
- agent 已注册（`.pi/agents/snflow-*`）

**操作区**：

- `Initialize SnFlow` 按钮（`recommendedAction === "initialize"` 时高亮可用）
- `Update SnFlow` 按钮（`updateAvailable` 时可用，否则置灰显示 "Up to date"）
- 操作输出/错误提示区

SnFlow 无环境先决条件（无 Node/Python/CLI 依赖），不需要 Trellis 的 prerequisites 检查行。`WorkflowPanel.tsx:667` 的面板内初始化按钮保留，改为调用同一套 init API，并在面板上补一条"检测到新版本，请到设置页更新"的轻提示（可选）。

i18n：在中英文案中补充 `settings.workflowStatus*` 系列 key。

## 三、实施步骤

1. **资产抽取**：新建 `assets/snflow/`，迁移 `workflow-dev` skill、`workflow-task.ts` 脚本，编写 `snflow` 扩展（guidance 逻辑自 `workflow-guidance.ts` 落地为自包含代码）、两个 agent 定义、`manifest.json`（version 1.0.0）。
2. **setup 层**：改造 `lib/workflow-setup.ts`（状态检测扩展、完整 init、新增 update、版本对比），确保模板在构建产物中可读。
3. **API 层**：更新 status/init 路由，新增 update 路由。
4. **注入迁移**：`rpc-manager.ts` 增加 `hasExtension` 门控，已装扩展的项目跳过 WebUI 侧注入。
5. **UI 层**：SettingsConfig SnFlow 分区加状态面板与操作按钮；WorkflowPanel 初始化按钮对齐新 API；补 i18n 文案。
6. **验证**：在空白测试项目上走一遍 init → 确认扩展/skill/agent/版本文件落盘、guidance 由扩展注入且无双重注入；手动降低 `.version` 验证 update 流程；旧项目（仅有 tasks 目录）验证兼容升级路径。

## 四、边界与原则

- **只管自己的文件**：init/update 仅写 manifest 白名单内的路径，绝不触碰用户任务数据与其他 `.pi` 内容。
- **幂等**：init/update 可重复执行，结果一致。
- **向后兼容**：无 `.version` 的旧初始化项目正常工作，提示更新即可；未安装扩展前 guidance 注入走旧路径。
- **KISS**：第一版扩展只承接 guidance 注入；工具注册、快捷键等留待后续版本。
