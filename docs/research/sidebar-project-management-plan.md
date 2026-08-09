# 左侧项目管理（Session Sidebar）续优需求规划

> 状态：已实施并归档为历史规划；正文中的未勾选项描述实施前状态，不是当前 backlog。
>
> 交付：`fbe6e8e` 完成后端懒加载主路径，`2fbe0f4` 完成分页消费、树/数据层拆分和会话索引等收口。
>
> 当前权威说明：[`docs/architecture/overview.md`](../architecture/overview.md)、[`docs/modules/frontend.md`](../modules/frontend.md)、[`docs/modules/api.md`](../modules/api.md)。剩余性能与体验建议统一进入 [`docs/plans/README.md`](../plans/README.md)。
>
> 范围：WebUI 左侧栏「项目管理 / 会话浏览 / WorkTree / Explorer」
> 相关代码：
>
> - `components/SessionSidebar.tsx`
> - `lib/session-reader.ts` / `lib/session-reader-constants.ts`
> - `app/api/sessions/route.ts`、`app/api/sessions/[id]/route.ts`、`app/api/sessions/archived/route.ts`
> - `components/FileExplorer.tsx`
> - `docs/architecture/overview.md`、`docs/modules/frontend.md`、`docs/modules/api.md`
> - `scripts/smoke-lazy-session-load.ts`

---

## 1. 目标

在**不回退到全量扫会话**的前提下，把左侧项目管理从「半截懒加载」补成完整、可扩展、可维护的浏览体验：

1. 用户能稳定浏览某一项目的**全部历史会话**（不仅是最近 10 条）。
2. 项目切换、刷新、URL 恢复、fork 树展示在懒加载窗口下仍然正确。
3. 侧边栏代码可拆分、可测，后续改分页/搜索不再碰 2700 行单体。
4. 会话量大时启动与切换仍然快；Usage 等全量消费者保持现有语义不动。

非目标（本轮不做）：

- 不改 Pi 会话 JSONL 存储格式。
- 不把 Usage / 全局统计改为懒加载（它们继续走 `listAllSessions()`）。
- 不做跨项目的统一「全局会话时间线」。
- 不重做整站设计系统；样式收敛以侧边栏内部为限。

---

## 2. 实施前快照（历史）

### 2.1 当时已完成（后端懒加载主路径）

| 能力 | 实现 |
| --- | --- |
| 项目发现 | `GET /api/sessions?view=projects` → `listProjectSummaries()`：目录 + header 级扫描，按真实 `cwd` 分桶 |
| 单项目最近会话 | `GET /api/sessions?cwd=&limit=10` → `listRecentSessionsForCwd()`：mtime 排序，最多完整 parse 10 条 |
| 单会话定位 | `GET /api/sessions/[id]`：文件名扫描，不走全库 parse；用于 URL 恢复与「当前选中不在 recent 窗口」补丁 |
| 归档可见性 | 各 list 模式附带 `archivedCwds` / `archivedCounts` |
| 竞态防护（前端部分） | `AbortController` + `projectSessionsCwd` 绑定，切项目先清空再加载 |
| 回归冒烟 | `scripts/smoke-lazy-session-load.ts` |

### 2.2 当时未完成（现已关闭或转入统一 backlog）

| 缺口 | 说明 |
| --- | --- |
| 无「加载更早」 | API 已返回 `total`，UI 不展示、不提供分页/游标加载 |
| fork 树在窗口截断下易断 | `buildSessionTree` 只在已加载集合内找父节点；父在窗口外时子会话变 root |
| Archived 仍全量 | active 已 limit，archived 按 cwd 一次拉全 |
| 巨型组件 | `SessionSidebar.tsx` ≈ 2700 行，状态/effect/UI/业务耦合 |
| 扫描成本仍偏高 | 项目多/会话多时 summaries 与 git metadata 仍偏贵；缺进程内缓存 |
| i18n / 空状态 | 部分文案仍硬编码英文（如 `Loading...`、`No sessions found`） |
| 计数语义混用 | `sessionCount`（候选文件数）与 `projectSessionTotal` / archive-all 展示可能不一致 |

### 2.3 实施前数据流

```text
Browser                         Server
  │                               │
  ├─ GET ?view=projects ─────────▶ listProjectSummaries()
  │◀─ projects + archived* ───────┤
  │                               │
  ├─ GET ?cwd=&limit=10 ─────────▶ listRecentSessionsForCwd()
  │◀─ sessions + total + archived*┤
  │                               │
  ├─ (URL/选中不在窗口) ──────────▶ GET /api/sessions/[id]
  │◀─ info 补丁进列表 ────────────┤
  │                               │
  └─ (展开 Archived) ────────────▶ GET /api/sessions/archived?cwd=
     ◀─ 该 cwd 全部归档 ──────────┘
```

浏览排序语义：sidebar recent 使用 **文件 mtime**（再文件名时间戳、路径）；与历史 `SessionManager.listAll()` 的 last-message `modified` 不同。后续改动必须写进 docs。

---

## 3. 用户故事与验收标准

### US-1：浏览某一项目的更早会话

**作为** 开发者  
**我希望** 在左侧看到「当前显示数 / 总数」，并能加载更早会话  
**以便** 找回不在最近 10 条里的历史会话，而不必依赖碰巧的 URL。

验收：

- [ ] 当 `total > loaded` 时，会话列表底部显示计数与「加载更早」入口。
- [ ] 点击后追加更早会话，不丢失当前选中、不闪回顶部无意义重置。
- [ ] 重复点击直到 `loaded >= total`，入口消失或变为不可用。
- [ ] 切换项目后分页状态重置；不会把 A 项目页数据拼进 B 项目。
- [ ] 不触发全量 `listAllSessions()`。

### US-2：懒加载窗口下 fork 关系仍可读

**作为** 用户  
**我希望** 子会话在列表中仍能看出其父/fork 关系  
**以便** 不会因为父会话暂时未加载而误以为是独立 root。

验收：

- [ ] 若 child 在已加载集合、parent 仅在更早文件中：要么自动补 parent 摘要节点，要么显示明确的「父会话未加载」占位并可点加载。
- [ ] 「加载更早」后树重组应尽量稳定（同一会话 id 不无故改变深度语义，或仅一次性校正）。
- [ ] 删除父会话后的既有 reparent/展示行为不被破坏。

### US-3：URL / 深链恢复旧会话

**作为** 用户  
**我希望** 打开带旧 `sessionId` 的链接时仍能进入正确项目与会话  
**即使** 它不在 recent 窗口。

验收：

- [ ] 保持现有 `GET /api/sessions/[id]` 恢复路径。
- [ ] 恢复后的会话出现在列表中（补丁或加载包含它的一页）。
- [ ] 会话所属 cwd 自动选中；归档会话走归档展示/只读语义。

### US-4：归档区也可控加载

**作为** 用户  
**我希望** 展开 Archived 时不要一次卡死在超大归档列表上。

验收：

- [ ] Archived 支持 limit + 加载更多（或等价游标）。
- [ ] 默认首次只加载一页；计数仍显示总数（若可得）。

### US-5：结构可维护

**作为** 维护者  
**我希望** 侧边栏数据加载与 UI 分层  
**以便** 改分页不必通读整文件。

验收：

- [ ] 数据加载进入独立 hook（或等价模块）。
- [ ] CWD picker / session tree / worktree actions / explorer section 至少逻辑边界清晰（物理拆分优先）。
- [ ] 纯函数（树构建、picker 分组）可单测。

---

## 4. 方案设计

### 4.1 API：单项目会话分页（推荐游标，兼容 limit）

在现有：

```http
GET /api/sessions?cwd=<path>&limit=10
```

上扩展，保持无新参时行为不变。

推荐查询参数：

| 参数 | 含义 | 默认 |
| --- | --- | --- |
| `cwd` | 项目路径 | 必填（该模式） |
| `limit` | 本页条数 | `10`（`RECENT_SESSIONS_LIMIT`） |
| `before` | 游标：只返回严格早于该 mtime（或 mtime+path）的候选 | 无 = 最新一页 |
| `offset` | 可选兼容；若实现游标可标记为次选 | `0` |

响应建议：

```json
{
  "sessions": [/* SessionInfo[] */],
  "cwd": "...",
  "limit": 10,
  "total": 128,
  "loadedHint": 10,
  "nextBefore": "2026-07-01T12:00:00.000Z",
  "hasMore": true,
  "archivedCwds": [],
  "archivedCounts": {}
}
```

实现要点（`listRecentSessionsForCwd`）：

1. 继续：候选 mtime 排序 → header cwd 过滤 → 仅对命中页 full parse。
2. `total` = header 匹配的候选数（与是否 full parse 成功的关系需在 docs 写清；建议 total 表示「匹配的会话文件数」，`sessions.length` 为成功解析数）。
3. **Parent 闭包（US-2）**：对本页 sessions，若 `parentSessionId` 指向同 cwd 且不在本页/已加载集合，则额外 header/轻量 parse 补齐 parent（可设上限，例如每页最多补 N 个祖先，防止极端链）。
4. 不改变 default `GET /api/sessions`（全量）语义。

Archived 对称扩展：

```http
GET /api/sessions/archived?cwd=&limit=20&before=
```

### 4.2 前端数据层

新建（名称可微调）：

- `hooks/useSessionBrowser.ts`
  - `projectSummaries` / `loadProjectSummaries`
  - `sessions` / `sessionsCwd` / `total` / `hasMore` / `loadFirstPage` / `loadMore`
  - `archived*` 分页状态
  - 统一 `AbortController`、cwd 绑定、refreshKey 响应
  - 选中会话 outside-window 补丁合并（去重 by id）

`SessionSidebar` 只负责布局与事件绑定。

分页状态机（单 cwd）：

```text
idle → loadingFirst → ready
ready → loadingMore → ready
任意加载中 + cwdChange → abort → clear → loadingFirst
```

合并规则：

- first page：替换（但保留「当前选中且同 cwd」的临时补丁项，若新页未包含则继续置顶或按 mtime 插入）。
- more page：append + id 去重；补丁 parent 节点按树规则挂载。
- 乐观归档/删除：先本地移除 id，再后台 refresh first page 或局部修正 `total`。

### 4.3 UI

会话列表底部（active）：

- 文案：`已显示 {loaded} / {total}`（i18n）
- 按钮：`加载更早` / `Loading…`
- `hasMore === false` 时隐藏按钮，可保留计数

Archived 区：同样模式。

可选增强（本规划 P2）：

- 项目内会话过滤（name / firstMessage 本地滤已加载集；远端搜索另议）
- 虚拟列表（单页很大时）

### 4.4 组件拆分

建议落地结构（可分 PR）：

```text
components/
  SessionSidebar.tsx              # 壳：组装
  sidebar/
    CwdPicker.tsx
    SessionTree.tsx
    SessionItem.tsx               # 若从原文件抽出
    ArchivedList.tsx
    WorktreeMenus.tsx
    ExplorerSection.tsx
lib/
  sidebar-session-tree.ts         # buildSessionTree + parent placeholder
  sidebar-cwd-picker.ts           # build/group/filter rows
hooks/
  useSessionBrowser.ts
  useExplorerHeight.ts            # 可选：高度 localStorage/resize
```

拆分原则：

- 先抽纯函数与 hook，再搬 JSX，降低一次性 diff 风险。
- 不改变对外 `SessionSidebar` props 契约（`AppShell` 无感）。

### 4.5 后端性能（P2，可与分页并行或随后）

| 项 | 建议 |
| --- | --- |
| summaries 缓存 | 进程内 TTL（如 2–5s）或按 sessions 目录 mtime 失效 |
| git metadata | 仅当前选中 + picker 可见前 N；或 summaries 延迟填充 |
| Windows 碰撞 | 可选 sidecar 索引 `cwd → encoded dirs`，避免每次全目录 header 探活 |
| 刷新策略 | 会话变更后优先 invalidate 当前 cwd 页；summaries 可防抖合并 |

### 4.6 计数与文案语义

统一并文档化：

| 字段 | 含义 |
| --- | --- |
| `ProjectSummary.sessionCount` | 该 cwd 下匹配的 active 会话文件候选数 |
| 列表 `total` | 同上（active 浏览） |
| `archivedCounts[cwd]` | 归档文件数 |
| Archive All 确认文案 | 使用 `total(active) + archivedCounts` 的明确来源，避免混用未定义字段 |

硬编码英文改为 i18n key（`sidebar.loading`、`sidebar.noSessions`、`sidebar.loadOlder`、`sidebar.shownOfTotal` 等）。

---

## 5. 历史分阶段实施计划

### Phase 0 — 文档与契约冻结（0.5d）

- [x] 本规划文档落盘
- [ ] 更新 `docs/modules/api.md` / `docs/modules/frontend.md` / `docs/architecture/overview.md` 中分页与排序语义（实施 PR 内完成）
- [ ] 确认游标字段（`before` vs `offset`）最终选择；默认推荐 `before`

### Phase 1 — API 分页 + parent 闭包（1d）

- [ ] `listRecentSessionsForCwd` 支持 `before`/`hasMore`/`nextBefore`
- [ ] route 透传参数与响应字段
- [ ] parent 闭包补齐（含上限与测试）
- [ ] 扩展 `scripts/smoke-lazy-session-load.ts`（多页、游标单调、parent 补齐、cwd 过滤）
- [ ] archived list 对称 limit/游标（可同 PR 或紧随）

### Phase 2 — 前端 Load more 闭环（1d）

- [ ] `useSessionBrowser`（或等价）承接加载状态
- [ ] 底部计数 + 加载更早
- [ ] cwd 切换重置、abort、选中补丁合并
- [ ] i18n 文案
- [ ] 手动验收：大项目切换、快切 cwd、URL 恢复、加载多页后选中/归档

### Phase 3 — 结构拆分（1–2d，可与 Phase 2 分 PR）

- [ ] 纯函数抽到 `lib/sidebar-*.ts` + 单测
- [ ] hook 抽离
- [ ] UI 子组件拆分，`SessionSidebar` 变薄
- [ ] `npm run lint` + `tsc --noEmit` 全绿

### Phase 4 — 性能与体验打磨（0.5–1d，可选）

- [ ] summaries/git 缓存或延迟
- [ ] 归档/删除乐观更新
- [ ] 项目内已加载会话本地搜索
- [ ] 空状态与 loading 骨架一致性

---

## 6. 风险与不变量

必须遵守的项目不变量：

1. **一个 session id 对应全局单一 wrapper 生命周期**（本功能不直接改 RPC，但删除/归档仍要走现有 destroy 路径）。
2. **fork（新 JSONL + parentSession）与 in-session branch（navigate_tree）不可混淆**；侧边栏树只表达 fork/`parentSession`。
3. **`parentSession` 仅展示元数据**；聊天内容仍以 JSONL entries 为准。
4. **WorkTree 删除/归档** 继续清理对应 cwd 会话；listing 继续 prune 已删 `*.worktrees/*` 残留。
5. **默认 `GET /api/sessions` 全量语义** 供 Usage 等使用，不得擅自改成懒加载。
6. **不覆盖用户无关改动**；拆分 PR 保持行为优先、纯搬迁可审。

主要风险：

| 风险 | 缓解 |
| --- | --- |
| 游标用 mtime 碰到同一秒多个文件 | 游标使用 `(mtimeMs, path)` 或 `(mtimeIso, id)` 复合比较 |
| parent 闭包放大 parse 量 | 每页祖先补齐上限；只 header + 最小 SessionInfo |
| 拆组件导致回归 | 先 hook/纯函数，再 JSX；保持 props 契约；手工清单验收 |
| Windows 编码碰撞 | 继续 header cwd 过滤，禁止用目录名当唯一项目键 |
| total 与可见条数不一致（坏文件） | UI 使用「已加载成功数 / total 候选数」，docs 写明 |

---

## 7. 测试计划

### 自动化

- 扩展 `scripts/smoke-lazy-session-load.ts`：
  - 12+ 会话只有第一页 10 条；第二页游标返回剩余且无重叠
  - `hasMore` / `nextBefore` 边界（空项目、恰 10 条、11 条）
  - 同目录多 cwd 碰撞仍只返回请求 cwd
  - parent 在窗口外时响应含 parent 或占位所需最小信息
  - archived 分页（若本阶段实施）
- 纯函数单测：`buildSessionTree`（缺父、成环守卫、排序）、`buildCwdPickerRows` / filter
- `npm run lint`
- `node_modules/.bin/tsc --noEmit`

### 手动

1. 冷启动：项目多、单项目会话 > 10，首屏可交互时间可接受。
2. 快切 3 个项目：列表不串、无报错、abort 正常。
3. 加载更早 2–3 页后选中、重命名、归档、删除。
4. 打开不在第一页的 session URL。
5. fork 子会话在父未加载/已加载两种情况下的展示。
6. WorkTree 创建与删除 fallback。
7. Explorer 展开/拖高/折叠后高度记忆。
8. 仅归档会话的项目仍出现在 picker。

---

## 8. 文档同步清单（实施时）

| 文档 | 更新内容 |
| --- | --- |
| `docs/modules/api.md` | sessions 查询参数 `before`/`hasMore`、archived 分页 |
| `docs/modules/frontend.md` | SessionSidebar 懒加载+分页、拆分后的组件/hook 入口 |
| `docs/modules/library.md` | `listRecentSessionsForCwd` 游标与 parent 闭包 |
| `docs/architecture/overview.md` | 数据流图补 load-more；mtime 排序语义 |
| `AGENTS.md` | 仅当顶层导航/入口变更时再改（细则仍放 docs） |

实施完成后：可将本文归档到 `docs/research/` 或 `docs/architecture/decisions/`，根目录文件改为指向归档路径，避免双源。

---

## 9. 历史排期与优先级

| 优先级 | 项 | Phase |
| --- | --- | --- |
| P0 | Active 会话 Load more（API + UI） | 1–2 |
| P0 | 分页下 fork/parent 正确性 | 1–2 |
| P1 | `useSessionBrowser` + 组件拆分 | 2–3 |
| P1 | Archived 分页 | 1 或 2 |
| P2 | summaries/git 缓存与刷新策略 | 4 |
| P2 | i18n/空状态/乐观更新/本地搜索 | 2–4 |
| P3 | 虚拟列表、全局索引 sidecar | 后续 |

**推荐首 PR：** Phase 1（API + smoke）  
**第二 PR：** Phase 2（前端闭环）  
**第三 PR：** Phase 3（拆分，行为无变更）

---

## 10. 已决事项

最终实现采用复合 `before` 游标、受限 parent 闭包和默认 10 条活动会话页；本文已归档到 `docs/research/`。以下列表保留原始决策上下文：

1. 分页游标用 `before` 复合游标还是 `offset`？（**默认 `before`**，更稳）
2. parent 缺失时自动补节点还是 UI 占位？（**默认自动补一层 parent 摘要，深链超出上限再占位**）
3. 单页默认条数是否保持 10？（**默认 10**，与 `RECENT_SESSIONS_LIMIT` 一致）
4. 根目录本文件是否在首个实施 PR 后移到 `docs/research/sidebar-project-management-plan.md`？（**建议是**）

---

## 11. 当前代码锚点

- 前端数据层：`hooks/useSessionBrowser.ts`
- 侧栏组合：`components/SessionSidebar.tsx` 与 `components/sidebar/*`
- 树构建：`lib/sidebar-session-tree.ts`
- 项目排序与 picker：`components/sidebar/sidebar-utils.ts`
- 后端：`lib/session-reader.ts`、`lib/session-index.ts`、`app/api/sessions/route.ts`
- 常量：`RECENT_SESSIONS_LIMIT = 10`（`lib/session-reader-constants.ts`）
