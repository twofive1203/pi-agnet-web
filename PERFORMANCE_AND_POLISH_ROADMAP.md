# Performance & Functional Polish Roadmap

> Status: active working backlog for the stable product phase  
> Scope: measurable performance improvements first, then focused UX polish; no feature expansion by default  
> Last updated: 2026-08-06

功能面已趋于稳定（会话/分支、SSE、Subagent、SnFlow、Automation、MCP、Browser 等）。下一阶段优先降低真实热路径成本并打磨高频交互，不为“架构更漂亮”进行大规模重写。

本文已按当前代码重新核对。旧版路线图中部分 Subagent 优化已经落地，不再作为待开发项目重复安排。

---

## 1. Current Baseline

以下能力已经存在，后续应验证和巩固，而不是重新实现：

| Area | Current implementation |
| --- | --- |
| Token stream | `lib/agent-event-throttler.ts` 将累计 `message_update` 限制到约 20 次/秒，并在生命周期事件前保持顺序屏障 |
| Hidden tab | `hooks/useAgentSession.ts` 在页面隐藏时按 500 ms 合并累计消息快照，恢复可见或遇到生命周期事件时立即 flush |
| Historical chat renders | streaming bubble 与已提交历史分离；历史消息对象在 token streaming 期间保持稳定，`MessageView` 已 memo |
| Streaming Markdown | `MarkdownBody` streaming/折叠大代码块走轻量 `<pre><code>`，settled 展开后才 Prism；内容相等 memo；≥80 行或 ≥4000 字符默认折叠 |
| Settings-class code split | `AppShell` 对 Models/Settings/Usage/Terminal/Workflow/Automation 使用 `next/dynamic`（`loading: null`，打开控件 hover/focus prefetch）；Automation 关闭时 unread 由 `useAutomationUnread` 维护 |
| Message identity | `ChatWindow` 优先 `entryIds`，无 entry id 的 optimistic 行使用 WeakMap 本地稳定 key，单层 keyed owner |
| Subagent progress | `lib/subagent-progress-throttler.ts` 按 300 ms 合并普通进度，terminal/error/attention 立即送达 |
| Subagent payload | `lib/subagent-event-projection.ts` 删除普通进度中的完整输出并限制终态预览大小 |
| Subagent detail | `lib/parse-subagent-children.ts` 与详情 API 按需读取、限制深度/大小并按 fingerprint 缓存 |
| Subagent browser isolation | `lib/subagent-store.ts` + `components/SubagentObservation.tsx` 将 badge counts 与完整 runs 分开订阅，面板关闭时不让进度更新重渲染 AppShell |
| Subagent diagnostics | server/browser opt-in 聚合指标已存在；`npm run test:subagent-observability` 覆盖节流、顺序、边界和 store 通知 |
| Session browse | `lib/session-index.ts` 提供可重建磁盘索引；侧栏按 cwd 对 active/archived 分页 |
| Sidebar | lazy project history、受控 `activeCwd`、memoized list items |
| Session changes | `lib/session-file-changes.ts` 使用异步 sidecar projection 和 per-session write queue |
| Auto-scroll internals | 已能识别用户是否离开底部并暂停 sticky scroll，但还缺少明确的 paused/unread UI |
| Agent failure | 已有持久失败卡、重试信息和 one-click continue，不应整体重做 |

### Remaining Subagent limitation

当前 WebUI 会屏蔽 `subagent-fleet-status` / `subagent-async` TUI widget，但已安装的 `pi-subagents` 仍没有安全的 WebUI session 级开关来保证内部 TUI fleet timer 完全不启动。

这不是普通前端待办。只有在现有 observability 再次证明 TUI 内部工作仍造成明显 CPU/API 延迟时，才进行用户全局 `fleetView: false` + `asyncWidget: false` attribution 实验或推动上游 capability 支持。不要在没有数据时改全局默认。

---

## 2. Priority Ladder

## P0 — Low-risk, measurable hot-path wins

### P0.1 Lightweight Markdown while streaming

**Where:** `components/MarkdownBody.tsx`, `components/MessageView.tsx`

**Confirmed code path:**

- 当前 streaming bubble 每次累计文本变化都会重新运行完整 `ReactMarkdown`。
- fenced code 在 streaming 阶段仍进入 Prism `SyntaxHighlighter`。
- `memo(MarkdownBody)` 单独无法解决累计文本持续变化的问题。
- Mermaid 已正确延迟到 streaming 结束后预览，保留该边界。

**Recommended slice:**

1. streaming 阶段继续保留 Markdown 基础结构，但代码块使用轻量 `<pre><code>`，不执行 Prism。
2. `message_end` 后切换为完整语法高亮。
3. 给 settled `MarkdownBody` 增加内容相等的 memo 防线。
4. 对超大代码块增加默认折叠或按展开高亮；先确定字符/行数阈值并保留 copy。
5. 不在第一步替换整套 Markdown renderer 或 highlighter。

**Acceptance signals:**

- code-heavy token stream 的 browser main-thread time 明显下降。
- settled message 仍完整支持 GFM、math、table、file links、code 和 Mermaid。
- streaming 结束时没有明显布局跳动或丢失滚动位置。

---

### P0.2 Lazy-load settings-class surfaces

**Where:** `components/AppShell.tsx`

当前 AppShell 仍静态导入 Models、Settings、Usage、Terminal、Workflow、Automation 等大型界面。

**Recommended slice:**

1. 使用 `next/dynamic` 延迟加载 `ModelsConfig`、`SettingsConfig`、`UsageStatsModal`、`TerminalPanel`、`WorkflowPanel`。
2. 每个 surface 提供局部 loading state，不阻塞 chat shell。
3. `ChatInput` 属于首屏关键路径，不做延迟加载。
4. Automation 当前关闭时仍保持挂载以维持 unread polling；先将轻量 unread/polling owner 与重型 drawer UI 分离，再动态加载 drawer，不能简单条件卸载导致 badge 失真。
5. 通过生产构建 chunk/network 记录确认组件确实在打开时才加载。

**Acceptance signals:**

- 主 chat route 的 initial JS parse/compile 降低。
- 未打开的 Settings/Models/Terminal/Workflow 不出现在首屏业务 chunk 中。
- 第一次打开面板有短暂局部 loading，后续打开正常复用 chunk。
- Automation unread badge 行为不回退。

---

### P0.3 Stable message identity

**Where:** `components/ChatWindow.tsx`

当前消息和外层 ref wrapper 仍使用 `key={idx}`。纯 append 时通常不会造成严重性能问题，但 session switch、branch navigation、context replacement 时可能复用错误的组件本地状态，例如 Thinking 展开或 copied 状态。

**Recommended slice:**

1. persisted message 优先使用 `entryIds[idx]`。
2. optimistic user、steer、follow-up 等尚无 entry id 的消息必须拥有生命周期内稳定的本地 key。
3. 不使用易碰撞的 content hash；同文案消息必须仍能区分。
4. 内外两层只保留一个 keyed owner，避免重复且不一致的 key。
5. `toolResultsMap` 的 prop churn 作为同一小 PR 的 profiling 项；只有确认 committed message append 导致大量历史 assistant rerender 时，才改为 per-message tool result projection。

**Acceptance signals:**

- session/branch 切换不会把旧消息的本地展开/复制状态带到新消息。
- streaming 不重新 mount 历史消息。
- optimistic message 持久化后不会出现重复 DOM 或明显闪烁。

---

## P1 — Benchmark-gated work

以下问题可能真实，但实施成本较高或不在首屏高频路径。必须先建立可重复基线，再决定是否进入开发。

### P1.1 Long-chat rendering strategy

当前 `ChatWindow.tsx` 仍渲染完整 `messages` 数组。长会话会让 Markdown、tool cards 和 DOM 持续增长，但完整 virtualization 会同时影响：

- variable-height messages；
- Thinking/tool expansion；
- auto-scroll 和 user-message anchor；
- `ChatMinimap` 的 DOM refs/测量；
- branch switch；
- transcript search；
- streaming tail。

**Delivery gate:**

1. 建立 100/200/500 turn 固定 fixture，记录首次打开、DOM node 数、滚动响应、streaming main-thread time 和 branch switch。
2. 先试 `content-visibility: auto` + 合理的 intrinsic size。
3. 同时默认折叠超大 tool output。
4. 只有前两步仍不达标，才引入真正 message windowing。
5. 如果落地 virtualization，同一设计必须覆盖 minimap、scroll anchoring 和自定义 transcript search；不能只替换 `.map()`。

**Decision rule:** 没有可复现的长会话卡顿或 before/after trace，不进入完整 virtualization。

---

### P1.2 Usage stats incremental index

**Where:** `lib/usage-stats.ts`

当前 Usage 查询会列出全部 active/archived parent sessions，并解析 parent JSONL 与 companion subagent session files。随着历史增长，耗时近似线性增加，但 Usage modal 属于低频操作。

**Delivery gate:**

1. 记录 session 数量、JSONL 总大小、parent/subagent 文件数、cold/warm 查询耗时。
2. 当典型数据集明显超过可接受交互时间时，再实现索引。
3. 索引 fingerprint 必须覆盖 parent 和全部 companion subagent files，不能只缓存 parent `path + mtimeMs + size`。
4. 日期范围查询必须保持 `usage.cost.total` 的权威历史值，不重新定价。
5. corruption/miss 必须安全 rebuild，并与未缓存扫描结果在 fixture 上逐项对比。

---

### P1.3 Re-measure Subagent contention

现有 Subagent 轻量优化已经落地。下一步不是继续重构，而是用相同 workload 复测：

- Next.js event-loop delay / CPU；
- SSE count 和 bytes；
- browser event handler / panel render；
- child 运行时 Worktree API latency；
- Grok cache/live refresh latency。

只有仍能稳定复现“操作在 child 结束后才恢复”，才继续：

1. TUI fleet global-config attribution experiment；
2. 定位仍在 event handler/request path 上的大块同步工作；
3. 与上游协商 WebUI capability；
4. 最后才评估 process isolation。

---

### P1.4 Targeted synchronous I/O cleanup

项目中存在同步文件 API，但不能按 grep 数量进行全库迁移。优先级只针对：

- request hot paths 上的大目录扫描；
- Agent event handler 中的大文件读取/写入；
- 会持续阻塞 Next.js event loop 的 JSONL parsing；
- trace 已证明的高延迟路径。

启动配置、小型原子文件、worker 内部或低频管理操作不因“使用 Sync API”自动列为问题。异步化也必须保持顺序、原子写和 lifecycle invariants。

---

## P2 — Functional detail polish

| Area | Current assessment | Suggested action |
| --- | --- | --- |
| Auto-scroll | 内部 sticky pause 已存在但不可见 | 增加“paused while reading”状态和 new-message chip，点击回到底部 |
| Tool cards | 大输出会增加 DOM/阅读负担 | 按大小默认折叠；只在实际需要时做长输出内部 virtualization |
| Error recovery | failure card、retry、continue 已存在 | 只补齐 SSE reconnect/空完成/普通失败之间仍不一致的 copy 和 action，不整体重写 |
| Session switch | stale request ids 已存在 | 如实际切换有空白感，再增加 skeleton/previous-content transition |
| Transcript search | 普通 DOM 下浏览器查找仍可用 | 完整 virtualization 落地时再实现应用内 search |
| Settings feedback | 各配置域已有独立 save/dirty/conflict 边界 | 统一视觉和 copy，不合并成一个跨域保存事务 |
| i18n | Models/Settings 和部分 quota/runtime copy 仍混合硬编码 | 持续迁入 `lib/i18n/messages/*`，按 surface 小批量提交 |
| a11y | shared dialog 已有 focus trap/restore | 按 `docs/operations/ui-visual-validation.md` 做具体缺陷 sweep |
| Command palette | 属于功能扩展而非性能核心 | 有明确快捷键发现性需求后再做 |
| Changes filter | 仅在单会话变更文件很多时价值明显 | 收集真实使用反馈后决定 path/unread filter |

---

## P3 — Deferred architecture / maintainability

### Do not schedule without a trigger

1. **Out-of-process AgentSession host**  
   只有轻量优化和 TUI attribution 后，Next.js event loop 仍持续饱和，才进入 ADR/原型。它会影响 session registry、start locks、SSE、fork、shutdown、dev reload 和部署。

2. **Full `useAgentSession` store split**  
   当前 Subagent 高频状态已经移出 React chat state。文件职责过多是维护性问题，但“拆成多个 context/store”不会自动降低 Markdown streaming 成本。优先渐进抽离 extension UI、scroll controller、session loading 或 model metadata，不做一次性重写。

3. **Settings-facing performance diagnostics**  
   当前环境变量 + bounded aggregate logs 足够开发诊断。只有建立正式用户支持/导出流程后才产品化。

4. **Physical large-module splits**  
   `ModelsConfig`、`ChatInput` 等文件可在后续行为改动中按清晰职责渐进拆分。只有形成 dynamic boundary、状态隔离或明确维护收益时，才作为独立任务。

---

## 3. Explicit Non-Goals

- 不进行 UI framework rewrite 或 SSE protocol redesign。
- 不在没有指标时调整 throttle 常量。
- 不为“优雅”重写稳定的 Automation / SnFlow core。
- 不做 microfrontend 或 multi-package monorepo 拆分。
- 不从 Git 推导 session changed-files；sidecar 仍是 source of truth。
- 不递归计费 parent companion 目录之外的 orphaned subagent trees。
- 不将所有同步文件 API 机械替换为异步 API。
- 不把大文件拆分本身宣称为运行时性能优化。

---

## 4. Suggested Delivery Sequence

```text
Slice 1  Streaming Markdown: lightweight code path, settled full highlighting
Slice 2  Dynamic import Models / Settings / Usage / Terminal / Workflow
Slice 3  Stable persisted/local message keys
Slice 4  Large tool-output collapse + auto-scroll paused/new-message chip
Measure  100/200/500-turn transcript + Usage cold/warm + Subagent contention regression
Later    content-visibility or virtualization, Usage index, targeted sync-I/O cleanup
Defer    process isolation, full useAgentSession store split, product diagnostics
```

### If only three things ship

1. **Streaming Markdown lightweight path**
2. **Lazy settings-class panels**
3. **Stable message identity**

---

## 5. Validation Checklist

Minimum for code changes:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

Add targeted checks:

| Area | Extra validation |
| --- | --- |
| Stream/throttle | `npm run test:agent-stream` |
| Subagent path | `npm run test:subagent-observability` + opt-in before/after metrics |
| Session changes | `npm run test:session-changes` |
| Session stats | `npm run test:session-stats` |
| Chat render | fixed 100/200/500-turn fixture: open, scroll, stream, branch/session switch |
| Markdown | code-heavy streaming + settled GFM/math/table/file-link/Mermaid regression |
| Code split | production build chunk inspection + network panel confirms load-on-open |
| Usage index | compare cached and uncached totals across active/archived/subagent fixtures |
| UI/a11y | relevant checks from `docs/operations/ui-visual-validation.md` |

Do not claim runtime performance wins without before/after evidence: metrics、trace、bundle/chunk output，或可重复的手工 timing。

---

## 6. Backlog Tracker

### P0 — Ready to implement

- [x] Streaming code blocks bypass Prism
- [x] Settled Markdown memo boundary
- [x] Lazy/collapsed very large code blocks
- [x] Dynamic import Models / Settings / Usage
- [x] Dynamic import Terminal / Workflow
- [x] Split Automation unread owner before lazy drawer
- [x] Persisted `entryId` message keys
- [x] Stable local keys for optimistic messages

### P1 — Measure first

- [ ] Add fixed 100/200/500-turn transcript fixture
- [ ] Measure `content-visibility` strategy
- [ ] Decide whether full message windowing is justified
- [ ] Measure Usage cold/warm scan by parent/subagent files
- [ ] Decide whether Usage summary disk index is justified
- [ ] Re-run Subagent contention workload with existing metrics
- [ ] Identify sync I/O only from trace-backed hot paths

### P2 — Polish

- [ ] Auto-scroll paused / new-message chip
- [ ] Large tool-output collapse defaults
- [ ] Close remaining error/reconnect UX gaps
- [ ] Incremental Models/Settings i18n sweep
- [ ] Targeted a11y pass
- [ ] Session switch skeleton if measurements/user feedback justify it

### Completed baseline — keep covered

- [x] Agent message-update throttling and lifecycle barriers
- [x] Hidden-tab message coalescing
- [x] Subagent opt-in server/browser metrics
- [x] Subagent 300 ms progress throttling with urgent/terminal bypass
- [x] Bounded Subagent summary payloads
- [x] On-demand bounded nested detail loading
- [x] Subagent external store with counts/runs subscription split
- [x] Persistent agent failure card and one-click continue
- [x] Session browse disk index and pagination
- [x] Streaming Markdown lightweight code path + settled memo + large-block collapse
- [x] Dynamic import Models / Settings / Usage / Terminal / Workflow / Automation
- [x] Automation unread owner split (`useAutomationUnread`)
- [x] Stable persisted/local message keys

### Deferred

- [ ] Out-of-process AgentSession host exploration
- [ ] Full `useAgentSession` state-domain rewrite
- [ ] Settings-facing performance diagnostics
- [ ] Command palette / shortcut discoverability
- [ ] Full transcript search before virtualization requires it

---

## 7. Working Rules

1. **Measure first** for long transcript、Usage、Subagent contention 和 sync-I/O work。
2. **Smallest viable diff** — performance PR 不混入无关重构。
3. **Preserve invariants** from `AGENTS.md` / `docs/architecture/overview.md`。
4. **Docs follow code** — 行为、route、shared module 变化时同步更新 `docs/modules/*`。
5. **Do not duplicate completed work** — 开始任务前先核对 Current Baseline 和实际代码。
6. **Default out of SnFlow** unless the user explicitly opts into a new SnFlow task。

---

## 8. Related Documents

| Doc | Why |
| --- | --- |
| `docs/architecture/overview.md` | Runtime invariants、SSE/JSONL/session lifecycle |
| `docs/modules/frontend.md` | UI/hook ownership and current render boundaries |
| `docs/modules/library.md` | Shared library ownership, indexes, throttlers, observability |
| `docs/operations/troubleshooting.md` | Subagent diagnostics flags and TUI fleet attribution experiment |
| `docs/operations/ui-visual-validation.md` | Visual/a11y/manual browser validation |
| `docs/research/README.md` | Longer investigations and future research archive |

当某个高成本项目通过 measurement gate 并形成稳定技术决策时，再新增 ADR 到 `docs/architecture/decisions/`。本文件只保留可执行优先级和状态，不复制完整设计。
