---
title: "refactor: WebUI i18n 覆盖补齐（zh/en）"
type: refactor
status: completed
date: 2026-08-07
origin: session audit 2026-08-07
related:
  - docs/modules/frontend.md
  - PERFORMANCE_AND_POLISH_ROADMAP.md
  - lib/i18n/
---

# refactor: WebUI i18n 覆盖补齐（zh/en）

## Overview

当前 WebUI 已有完整的轻量 i18n 骨架（`lib/i18n/*` + `I18nProvider`，仅 `zh`/`en`），主壳、Sidebar、Chat 主体、Git、Workflow、Browser、Automation 父面板等已接线。但仍存在明显缺口：

1. **有词条未接线**：`panels.extensions` / `skills` / `usage` / `subagents` 等 catalog 已写，组件仍硬编码英文。
2. **整面板未接入**：Skills / Extensions / Usage / Subagents / ToolPanel / Warmup / Pricing 等。
3. **半接入混杂**：ModelsConfig、ChatGPT/Grok 用量、FileViewer、Chat 运行态文案中英混杂或 locale 三元硬编码。
4. **词条质量**：en 独有 key、MCP 字段 label 直接显示配置键名。
5. **locale 附属能力**：日期数字格式未跟随 app locale；API 错误字符串无语言通道。

本计划目标：在**不扩第三语言、不改业务契约、不大拆架构**的前提下，按 surface 小批量把用户可见文案迁入 `lib/i18n/messages/*`，并优先消耗已有未用词条。

**非目标：** 引入 `next-intl` / `react-i18next`；服务端全量 i18n 框架；翻译 QA 外包流程。

---

## Current State (audit snapshot)

| 指标 | 值 |
| --- | --- |
| 支持语言 | `zh`（默认倾向）、`en` |
| 词条规模 | ~1370 leaf keys |
| `t("literal")` 引用 | ~891 |
| 组件已接 `useI18n`/`useT` | ~38 / 67 |
| 组件完全未接 | ~29 |
| zh/en key 不对齐 | en 多 2：`settings.assistFallbackHint`、`settings.followMainFallbackHint` |
| 文档已登记债 | `docs/modules/frontend.md` Coverage status；Roadmap P2 i18n |

### 已覆盖较好

- AppShell 主壳 / 语言切换 / Settings 语言段
- Sidebar 会话与项目选择
- Chat 输入与消息主体（仍有运行态残留）
- Git、Terminal（部分）、DiffModal、Workflow
- Browser 绑定、McpConfig / AgentsConfig 主路径
- Automation 父面板（子组件经 `labels` 注入）
- SessionChanges 浮层、共享 AppDialog

### 主要缺口地图

```
P0 接线（catalog 已有）
  SkillsConfig / ExtensionsConfig / UsageStatsModal
  SubagentPanel / ToolPanel / InspectorChangesPanel
  ChatGPT/Grok fixLock 中文硬编码
  Chat phaseLabel / "继续"

P0 迁入（catalog 不足或半接入）
  ModelsConfig 大表单与 OAuth/quota copy
  ChatGptUsagePanel / GrokUsagePanel 英文残留
  FileViewer 预览/保存/同步文案
  ChatWindow 打字机与运行态

P1 面板补齐
  ChatGptWarmupDialog / ModelPricingCatalog
  ExtensionDialogHost / FileDiffModal / GitCommitDiffModal
  MarkdownBody Mermaid / Monaco 帮助
  TerminalPanel 残留 aria/错误

P2 一致性
  toLocaleString(appLocale)
  词条质量（MCP 字段中文名、en-only key）
  API 错误码 → 前端 t() 映射（可选试点）

P3 工程卫生
  类型化 key / 未用词条清理 / 去掉 locale 三元
  layout title 与 app.title 单轨
```

---

## Principles

1. **先接线、后扩词条**：已有 `panels.*` / `settings.*` / `automation.*` key 优先直接 `t()`，避免重复造 key。
2. **按 surface 小批量提交**：一面板或一运行态一条 PR/提交，便于回归。
3. **禁止 locale 三元散落**：`locale === "zh" ? "中文" : "English"` 一律迁入 messages。
4. **子组件两种合法模式**（二选一，同一文件不混用）：
   - 直接 `useI18n()` / `useT()`；
   - 父组件注入 `labels`（Automation 子组件已采用），但 **default fallback 也应尽量走 t，或文档约定父级必传**。
5. **技术标识可保留英文**：model id、provider id、HTTP method、配置字段 path（如 `outputGuard.maxBytes`）可保留；**用户句子、按钮、空态、错误、aria-label** 必须双语。
6. **不改 API 契约与业务行为**：只换展示字符串；`handleSend("继续")` 这类会进入会话内容的字符串需单独评估（见 U3）。
7. **验证最低标准**：每批 `npm run lint` + `node_modules/.bin/tsc --noEmit`；触及 automation/mcp 时跑对应 smoke。

---

## Scope

### In scope

- 用户可见 UI 文案（label、button、empty、error、tooltip、aria-label、confirm）。
- `lib/i18n/messages/{common,app,sidebar,chat,git,panels,workflow,settings,automation}.ts` 增补与对齐。
- 组件接入 `useI18n`/`useT` 或补全 `labels` 注入。
- 日期/数字格式可选跟随 app locale（P2）。
- API 错误展示试点（错误码或稳定 `error` token → 前端映射，不强制服务端双语）。

### Out of scope

- 第三语言、RTL、ICU 复数完整引擎。
- 替换 i18n 运行时库。
- 服务端响应体全量本地化。
- 扩展/技能包自身的上游英文 description（第三方内容）。
- 纯开发者日志、`console.*`、内部 debug dump。
- 视觉/布局重构（除非文案变长导致明显截断且本批必须修）。

---

## Requirements

- R1. 切换 `zh`/`en` 后，P0 面板与主路径运行态文案立即切换，无整页英文孤岛、无「中文 UI + 英文按钮」或「英文 UI + 中文修锁」混杂。
- R2. zh/en leaf key 集合一致；禁止再出现 en-only / zh-only 用户文案 key。
- R3. 新增用户文案必须进 `lib/i18n/messages/*`，禁止新的 locale 三元硬编码。
- R4. 不改变保存、RPC、session JSONL、Automation labels 业务语义；仅替换展示。
- R5. `t(key)` 缺失时仍 fallback 到 en 再 key（现有行为），但本计划交付的 key 必须双语齐全。
- R6. 文档：完成后更新 `docs/modules/frontend.md` 的 Coverage status，并勾选 Roadmap 相关项。

---

## Implementation Units

### Wave A — 零成本接线（catalog 已有）

- [x] **U1. Resource 配置面：Skills / Extensions**

**Goal:** 消耗 `panels.skills.*` / `panels.extensions.*`（及不足时少量补 key），去掉整页英文硬编码。

**Files:**
- Modify: `components/SkillsConfig.tsx`
- Modify: `components/ExtensionsConfig.tsx`
- Modify: `lib/i18n/messages/panels.ts`（仅补缺口）
- Modify: `docs/modules/frontend.md`（Coverage 注记可延后到 Wave 结束）

**Approach:**
- 组件内 `useI18n()`；标题、tab、空态、loading、filter、scope、close/refresh 全部 `t()`。
- 先 grep 现有 key 列表再映射，避免同义重复 key。
- 保留 skills.sh、package id、command name 等技术标识原文。

**Test scenarios:**
- Happy：中/英切换下打开 Skills / Extensions，主文案随语言变化。
- Empty：无技能 / 无包 / 无诊断。
- Error：加载失败文案双语。
- Edge：长包名、filter 无匹配。

**Verification:**
- lint + tsc
- 静态确认无整页级英文 JSX 句子残留（允许技术专有名词）

---

- [x] **U2. Inspector / Tools / Usage / Subagents 接线**

**Goal:** 消除 Inspector 中英混杂；Usage/Subagents/Tool 预设进入 i18n。

**Files:**
- Modify: `components/InspectorChangesPanel.tsx`
- Modify: `components/UsageStatsModal.tsx`
- Modify: `components/SubagentPanel.tsx`
- Modify: `components/ToolPanel.tsx`
- Modify: `lib/i18n/messages/panels.ts`
- Modify: `lib/i18n/messages/chat.ts`（Tool 预设若归 chat 更合适则放 chat）

**Approach:**
- Inspector：空态/loading 改用 `panels.sessionChanges.*`；Files/Added/Removed 新增或复用 key，去掉硬编码中文句子。
- Usage：对接 `panels.usage.*`，补 Main cost / Subagent / scanned 等缺失 key。
- Subagents：对接 `panels.subagents.*`，补 activity/waiting/truncated 等。
- ToolPanel：All / Read-only / Off / footnote 进 messages。

**Test scenarios:**
- 无会话 / 无变更 / 有 diff 文件。
- Usage 无数据范围、含归档开关。
- Subagent 空列表、running、failed。
- Tool 三档切换，脚注「下一轮生效」双语。

**Verification:**
- lint + tsc
- 中文 UI 下 Inspector 不再出现裸英文 Files/Added/Removed；英文 UI 下不再出现硬编码中文空态

---

- [x] **U3. Chat 运行态与续写文案**

**Goal:** 主聊天路径上的 phase / 空态 / 续写不再中英固定。

**Files:**
- Modify: `components/ChatWindow.tsx`（`phaseLabel`、`TYPEWRITER_PHRASES`）
- Modify: `hooks/useAgentSession.ts`（`handleSend("继续")`）
- Modify: `components/ChatInput.tsx`（upload error 等）
- Modify: `components/MessageView.tsx`（usage 短标签、空 output 若需）
- Modify: `lib/i18n/messages/chat.ts`

**Approach:**
- `phaseLabel`：`chat.phase.runningTool` / `waitingModel` / `thinking`，带 `{name}` / `{count}` 插值。
- 打字机：按 locale 使用两套 phrases 数组（messages 内用编号 key 或嵌套 list 策略；若 MessageTree 仅支持 string，用 `chat.typewriter.p01`… 或前端按 locale 常量表 + messages 文件导出辅助常量——优先仍走 `t()`）。
- **「继续」决策（需实现时二选一，默认 D1）：**
  - **D1（推荐）**：发送内容本地化为 `chat.continuePrompt`（中「继续」/英 “Continue”），接受 transcript 随 UI 语言变化。
  - **D2**：保持发送固定 token（如 `继续` 或中性 `/continue`），仅按钮 label i18n——需确认 agent/prompt 侧不依赖固定中文。
- 上传失败：`chat.uploadFailed` + server message 拼接。

**Test scenarios:**
- waiting_model / running_tools(1) / running_tools(n) 文案。
- 空会话打字机中英各一套。
- 点续写：D1 下英文 UI 发送 Continue。
- 上传失败提示双语。

**Verification:**
- lint + tsc
- 手动切换语言观察 phase 条与空态

---

- [x] **U4. ChatGPT / Grok 用量面板残留**

**Goal:** 去掉「故障处理：修复刷新锁」中文硬编码与大段英文 status 句。

**Files:**
- Modify: `components/ChatGptUsagePanel.tsx`
- Modify: `components/GrokUsagePanel.tsx`
- Modify: `lib/i18n/messages/panels.ts`（`panels.chatgpt.*` / `panels.grok.*` 补齐）

**Approach:**
- `fixLock` 按钮与 confirm 已有 key 的改为 `t()`。
- Unknown usage / No quota cache / Reset limit / Earliest expires / Used·Limit·Remaining 全部词条化。
- 相对时间（justNow/minutesAgo）优先复用已有 key。

**Test scenarios:**
- 无账号、无缓存、刷新失败、修锁确认框中英。
- 额度倒计时与过期日期展示。

**Verification:**
- lint + tsc
- 英文 UI 不再出现「故障处理：修复刷新锁」

---

### Wave B — 高价值半接入面板

- [x] **U5. ModelsConfig 文案分批迁入**（主表单/发现/OAuth 导入/额度核心 chrome；仍可能有次要英文残留）

**Goal:** Settings → Models 用户句子与表单 chrome 双语；消灭 locale 三元。

**Files:**
- Modify: `components/ModelsConfig.tsx`（可分多 commit：providers / models editor / oauth import / quota）
- Modify: `lib/i18n/messages/settings.ts`（`settings.models.*`）

**Approach:**
- **Batch B1：** provider 表单 label、fetch models、validation errors。
- **Batch B2：** model 行编辑（reasoning、context、headers）。
- **Batch B3：** OAuth/CPA/SUB2API 说明（替换 `locale === "zh" ? …`）、转换按钮。
- **Batch B4：** quota/balance/reset credits 展示句。
- 错误优先：UI 包装层 `t()`；若必须展示 `Error.message`，对已知中文 converter 错误做映射或改为错误码（见 U10 可选）。

**Test scenarios:**
- 添加 provider、fetch models 空列表、缺 base URL/api key。
- Codex 粘贴 JSON 校验/转换/导入成功失败。
- 额度刷新与 reset credit 确认。

**Verification:**
- lint + tsc
- 搜索 `locale === "zh"` 在 ModelsConfig 中清零
- 无新增用户可见硬编码中文 JSX 句（注释除外）

---

- [x] **U6. FileViewer / Standalone 残留**

**Goal:** 预览失败、磁盘冲突、word wrap、live sync 等双语。

**Files:**
- Modify: `components/FileViewer.tsx`
- Modify: `components/StandaloneFileViewer.tsx`（已部分接线，做 diff 复查）
- Modify: `lib/i18n/messages/panels.ts`（`panels.fileViewer.*`）

**Approach:**
- 映射已有 `save`/`discardChanges`/`copyPath`；补 image/audio/docx/html preview、conflict banner、symbol cursor hint。

**Test scenarios:**
- 图片/音频加载失败；docx 超限；未保存冲突 reload/save。
- 独立页返回工作台、复制路径。

**Verification:**
- lint + tsc

---

- [x] **U7. Warmup / Pricing / Extension dialog / Diff 错误态**

**Goal:** 次高频面板与弹层不再整页英文。

**Files:**
- Modify: `components/ChatGptWarmupDialog.tsx`
- Modify: `components/ModelPricingCatalog.tsx`
- Modify: `components/ExtensionDialogHost.tsx`
- Modify: `components/FileDiffModal.tsx`
- Modify: `components/GitCommitDiffModal.tsx`
- Modify: `components/MarkdownBody.tsx`（Mermaid chrome）
- Modify: `lib/i18n/messages/panels.ts`（新建 `warmup` / `pricing` / 扩 `extensionUi` / `diff` 子树）

**Approach:**
- Warmup：标题、schedule、history、校验错误。
- Pricing：catalog 标题、search、empty、cache read/write 列。
- ExtensionDialog：对接 `panels.extensionUi.*`，补 select/input 标题。
- Diff：binary/too large/unavailable reason 双语（可与 sessionChanges.metadataOnly 对齐语气）。

**Test scenarios:**
- Warmup 无账号、非法 HH:mm、保存失败。
- Pricing 无同步数据、provider 过滤。
- Extension confirm/select 取消按钮。
- 二进制 diff / 超大 diff 提示。

**Verification:**
- lint + tsc

---

### Wave C — 一致性与债清理

- [x] **U8. 词条对齐与质量**

**Goal:** zh/en key 集合一致；减少「key 名当文案」。

**Files:**
- Modify: `lib/i18n/messages/settings.ts`
- Optional: `lib/i18n/messages/*.ts` 扫描脚本（可放 `scripts/check-i18n-keys.ts`，不强制进 CI）

**Approach:**
- 补 `settings.assistFallbackHint` / `followMainFallbackHint` 中文。
- MCP 字段：保留技术名作 secondary，或 `label + hint` 模式（中文短名 + 英文 path），不破坏已绑定 key 路径。
- 增加可选检查：flatten zh/en keys diff；打印 onlyZh/onlyEn。

**Test scenarios:**
- 脚本或手工确认 onlyZh=onlyEn=0。
- Settings 中 Agents fallback hint 中英都有完整句子。

**Verification:**
- 检查脚本 exit 0（若添加）
- lint + tsc

---

- [x] **U9. App locale 驱动的日期/数字格式**

**Goal:** UI 语言与 `toLocaleString` 一致。

**Files:**
- Add or Modify: `lib/i18n/format.ts`（`dateTime(locale)` / `number(locale)` 薄封装）
- Modify: 调用点按需替换——`ChatGptUsagePanel`、`GrokUsagePanel`、`UsageStatsModal`、`AutomationRunList`、`MessageView`、`BrowserBindingPanel`、`WorkflowPanel`、`ModelPricingCatalog`、`sidebar-utils` 等

**Approach:**
- `locale === "zh" ? "zh-CN" : "en-US"` 映射。
- 不强制改排序 collator，除非用户可感知顺序差异。

**Test scenarios:**
- 同一时间戳在 zh/en 下日期格式不同且稳定。
- 数字千分位分隔符符合语言习惯。

**Verification:**
- lint + tsc

---

- [x] **U10. API 错误展示试点（可选）**

**Goal:** 减少「中文 UI + 英文 API error」或反向混杂；不引入服务端 i18n 框架。

**Files:**
- Modify（试点）: `lib/oauth-account-converters.ts`、`app/api/terminal/env/assist/route.ts`、`lib/grok-usage.ts` 等改为稳定 `code` + 英文 `error`（或保留 error 作 dev detail）
- Modify: 对应前端 catch 处 `t("errors." + code)` fallback 原文
- Modify: `lib/i18n/messages/common.ts` 或新建 `errors.ts`

**Approach:**
- 只试点 1–2 条高频用户路径（OAuth 导入、Grok 未登录、terminal env assist）。
- 约定：API `error` 保持英文机器句；`code` 为稳定常量；UI 优先 `code`。
- 不做全 API 扫尾。

**Test scenarios:**
- 触发 Grok 未登录 / 非法 CPA JSON，中英文 UI 各显示本地化句。
- 未知 code fallback 到 server error 字符串。

**Verification:**
- 相关 smoke（若有）+ lint + tsc

---

- [x] **U11. 文档与收尾**

**Goal:** 状态可被后续 agent 发现。

**Files:**
- Modify: `docs/modules/frontend.md`（Internationalization Coverage status）
- Modify: `PERFORMANCE_AND_POLISH_ROADMAP.md`（i18n 项进度）
- Optional: `AGENTS.md` 仅当阅读顺序需增加 i18n 专项入口时

**Approach:**
- 写明：P0/P1 已完成范围、P2 残留（API 全量、类型化 key）。
- 列出 messages 文件职责表（若有新增 `errors.ts`）。

**Verification:**
- 文档与代码行为一致

---

## Execution Order

```text
U1 → U2 → U3 → U4     Wave A（快赢，建议连续完成）
  ↓
U5 (B1→B4) → U6 → U7  Wave B（可与 A 后并行评审，但单写者串行）
  ↓
U8 → U9 → U10? → U11  Wave C
```

依赖关系：
- U5 不依赖 U1–U4，但建议 A 完成后再动 Models，避免 messages 冲突。
- U9 可在任意 Wave 后做，调用点越多越适合统一 `format.ts` 后批量换。
- U10 可选；不阻塞 U11 文档收尾（文档标注「API 试点未做」即可）。

---

## Risk & Decisions

| ID | 风险/决策 | 默认 |
| --- | --- | --- |
| D1 | 「继续」是否本地化发送内容 | 本地化发送（chat.continuePrompt） |
| D2 | Automation 子组件 fallback 英文 | 保持 labels 注入；父级必传；不在本计划重写成 useT 也可 |
| D3 | MCP 字段显示技术 path | 可保留 path；补中文短 label 而非删除 path |
| D4 | API 全量错误码 | 不做；仅 U10 试点 |
| D5 | 类型化 MessageKey | P3，不纳入本计划必达 |
| R1 | ModelsConfig 文件过大易冲突 | 严格分 B1–B4 提交 |
| R2 | 文案变长导致窄屏截断 | 本计划不改布局；若按钮溢出记入 UI 债而非扩 scope |
| R3 | 第三方 skill/extension 描述英文 | 保持原文，只翻译 WebUI chrome |

---

## Validation Matrix

| 批次 | 命令 | 手工 |
| --- | --- | --- |
| 每 Unit | `npm run lint`；`node_modules/.bin/tsc --noEmit` | 切换 zh/en 打开对表面板 |
| 触及 MCP | `npm run test:mcp` | — |
| 触及 Automation labels | `npm run test:automation`（若改 labels 契约） | 打开任务/run 详情 |
| Wave A 结束 | 同上 | Skills/Extensions/Usage/Subagents/Inspector/Tool/Chat phase/用量修锁 |
| Wave B 结束 | 同上 | Models 主路径、FileViewer、Warmup、Pricing |
| 计划关闭 | 文档已更新 | Coverage status 与代码一致 |

---

## Success Criteria

1. P0 列表中的组件不再出现「整页英文」或「中英混杂指标/空态」。
2. `ModelsConfig` 无 `locale === "zh" ? '…' : '…'` 用户文案三元。
3. zh/en leaf key 差集为 0（用户文案 key）。
4. Chat 运行态 phase 与续写策略（D1/D2）按文档生效。
5. `docs/modules/frontend.md` 反映新 Coverage；Roadmap i18n 项可勾选「主路径完成」或注明残留 P2。
6. 未引入新 i18n 库；未改变 session/API 数据契约（U10 试点除外且需兼容旧客户端）。

---

## Out-of-plan Follow-ups (P3)

- `t()` key 类型导出（从 messages 推断联合类型）。
- 清理长期未引用词条 / 防止 catalog 腐烂。
- `app/layout.tsx` title 与 `app.title` 单源。
- SSR/首屏 locale 闪烁进一步抑制。
- API 错误码全覆盖与 Accept-Language。
- 扩展第三方内容的展示语言策略。

---

## Appendix A — 优先文件清单（实施核对用）

### Wave A
- `components/SkillsConfig.tsx`
- `components/ExtensionsConfig.tsx`
- `components/UsageStatsModal.tsx`
- `components/SubagentPanel.tsx`
- `components/ToolPanel.tsx`
- `components/InspectorChangesPanel.tsx`
- `components/ChatWindow.tsx`
- `components/ChatInput.tsx`
- `components/MessageView.tsx`
- `hooks/useAgentSession.ts`
- `components/ChatGptUsagePanel.tsx`
- `components/GrokUsagePanel.tsx`
- `lib/i18n/messages/panels.ts`
- `lib/i18n/messages/chat.ts`

### Wave B
- `components/ModelsConfig.tsx`
- `components/FileViewer.tsx`
- `components/ChatGptWarmupDialog.tsx`
- `components/ModelPricingCatalog.tsx`
- `components/ExtensionDialogHost.tsx`
- `components/FileDiffModal.tsx`
- `components/GitCommitDiffModal.tsx`
- `components/MarkdownBody.tsx`
- `lib/i18n/messages/settings.ts`
- `lib/i18n/messages/panels.ts`

### Wave C
- `lib/i18n/format.ts`（新建）
- `lib/i18n/messages/settings.ts`
- `scripts/check-i18n-keys.ts`（可选）
- `docs/modules/frontend.md`
- `PERFORMANCE_AND_POLISH_ROADMAP.md`

### 明确暂不动（除非联带）
- `components/FileIcons.tsx`、纯 SVG/结构组件
- `components/DiffView.tsx` / `UnifiedDiffView` / `SideBySideDiffView`（无用户句子则跳过）
- 第三方 skill 描述正文
- 全量 `app/api/**` 错误字符串（仅 U10 试点）

---

## Appendix B — 审计摘录（2026-08-07）

- 组件未接 i18n：29 个（含 Skills/Extensions/Usage/Subagents/Tool/Inspector/Warmup/Pricing 等）。
- 已接但仍硬编码：ModelsConfig、ChatGpt/Grok Usage、FileViewer、ChatWindow phase、ChatInput upload、Terminal 部分、AppShell token tooltip。
- 词条未接线前缀：`panels.extensions|skills|usage|subagents|chatgpt|grok|fileViewer|extensionUi` 等。
- en-only keys：`settings.assistFallbackHint`、`settings.followMainFallbackHint`。
- 固定中文交互：`useAgentSession` `handleSend("继续")`；ChatGPT/Grok「故障处理：修复刷新锁」。
- 项目自评：`docs/modules/frontend.md` — large settings/models panels still mixed；Roadmap P2 i18n sweep。
