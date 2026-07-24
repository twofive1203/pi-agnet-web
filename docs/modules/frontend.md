# Frontend Module Map

## Components

| File | Purpose |
| --- | --- |
| `components/I18nProvider.tsx` | Client locale provider (`zh` / `en`), `t()` translator, and `useI18n` / `useT` hooks. Preference is stored in `localStorage` key `pi-locale`; first visit follows the browser language. |
| `components/AppDialogProvider.tsx` | Unified application dialog provider wrapping the app root. Renders a body portal for `alert`, `confirm`, and `prompt` dialogs with serial queue, Escape/Enter keyboard handling, overlay click cancel, danger-tone confirm styling, auto-focused prompt input, and i18n-aware title/button labels. Exposes `useAppDialog()` hook returning `{ alert, confirm, prompt }` with Promise-based API. |
| `components/AppShell.tsx` | Top-level layout, URL state, tab management, language toggle, Web Terminal bottom-dock toggling, right drawer mode switching between files, always-available SnFlow tasks, and optional Trellis tasks, Trellis-task-to-chat context block insertion, and body-portaled top-bar auxiliary panels that remain visible outside the mobile horizontal scroller. |
| `components/SessionSidebar.tsx` | Session tree sidebar, workspace/WorkTree picker actions grouped by main workspace, archive/unarchive actions, archived section, multi-select batch archive, and an integrated Explorer that starts collapsed and mounts its file tree only when expanded. |
| `components/ChatWindow.tsx` | Message list, SSE streaming, fork/navigate logic. Shows archived banner and disables input for archived sessions. Hosts Pi extension status chips, generic widget stacks around the composer, the floating todo panel, and body-portaled dialog/toast hosts for extension UI requests. |
| `components/ChatInput.tsx` | Input bar, model dropdown, thinking level, tool preset, image upload, file-reference chips, serialized Trellis task context blocks, and bounded, scrollable slash-command autocomplete for extension commands, prompts, and skills. Extension commands may show CLI-only / Partial badges from server `webSupport` metadata. |
| `components/ExtensionStatusBar.tsx` | Compact chip row for Pi extension `setStatus` keys near the chat composer. |
| `components/ExtensionWidgetStack.tsx` | Multi-line text cards for Pi extension `setWidget` content at `aboveEditor` / `belowEditor` placements; reserves the standard `todo-list` widget for the floating task panel. |
| `components/ExtensionTodoPanel.tsx` | Floating session todo panel for the standard `todo-list` widget: draggable compact capsule entry, expandable desktop panel, mobile bottom sheet, persisted/clamped position, progress bar, and parsed task rows. |
| `components/ExtensionDialogHost.tsx` | Body-portaled modal for blocking extension dialogs (`confirm`, `select`, `input`, `editor`) with keyboard navigation and Escape cancel; replaces `window.confirm` / `window.prompt`. |
| `components/ExtensionToastHost.tsx` | Body-portaled toast stack for non-blocking extension `notify` events (info/warning/error); replaces `window.alert`. |
| `components/ChatGptUsagePanel.tsx` | Optional semi-transparent top-bar ChatGPT/Codex quota panel; renders its viewport-bounded details popover through `document.body` so it is not clipped by the mobile top-bar scroller, reads and periodically revalidates cached active-account usage and reset-credit availability, reloads accounts on expand, lists saved accounts with quick activation, supports manual quota refresh and confirmed reset-credit consumption for the active account, and shows backend auto-refresh scheduler/lock maintenance state. |
| `components/GrokUsagePanel.tsx` | Optional top-bar Grok subscription usage panel (gated by `pi-web.json.grok.usagePanelEnabled`). Aligns with ChatGPT panel interaction pattern: popover via body portal, manual refresh only, cache-first load. Shows monthly used/limit/remaining/utilization/reset time, optional weekly credits, and error/not-configured states. Billing accepts OAuth from either the built-in xAI provider or the `grok-cli` extension. Controlled by Settings → Grok toggle. |
| `components/ChatGptWarmupDialog.tsx` | ChatGPT/Codex warmup management dialog opened from the saved-account management area; supports manual multi-select warmup, scheduled warmup account/time settings, and recent manual/scheduled run history. |
| `components/MessageView.tsx` | Render user, assistant, tool-call, and tool-result messages. |
| `components/BranchNavigator.tsx` | In-session branch switcher; its inline top-bar panel uses a fixed body portal so mobile toolbar overflow does not clip the branch tree. |
| `components/ChatMinimap.tsx` | Scroll minimap beside message list. |
| `components/ToolPanel.tsx` | Tool presets and preset inference helpers. |
| `components/ModelsConfig.tsx` | Modal for editing `models.json`, discovering OpenAI-compatible custom-provider models from `/models` into the staged provider model list, OAuth/API-key auth, structured Grok CLI subscription usage via the shared server-owned billing API (cache-first + manual refresh), ChatGPT Plus/Pro saved-account add/import, activation, temporary account selection for the subscription/usage panel, remarks, extra-info dialog, cached quota reset display with inline mini usage pies, manual quota refresh, inactive-account deletion, raw/CPA/SUB2API account JSON import via shared converters, manual pi.dev pricing sync via `POST /api/model-pricing` with a compact status row and sync/catalog icon buttons, automatic safe price/context-window filling, and manual candidate matching for ambiguous custom-provider model ids. |
| `components/GitPanel.tsx` | Git status dropdown panel showing branch, previewable/selectable commit graph by selected local branch, selected-commit metadata and changed files, staged/unstaged changes, untracked files, stash, and local branch switching with an explicit Switch button. |
| `components/CommitGraph.tsx` | Git commit graph renderer with lane visualization, refs, hover tooltips, and optional selected-commit callbacks for the Git panel. |
| `components/GitCommitDiffModal.tsx` | Git commit file-diff adapter that fetches one selected commit file diff, formats commit/file metadata and fallback labels, and renders the shared diff modal. |
| `components/SkillsConfig.tsx` | Modal for browsing/installing skills. |
| `components/ExtensionsConfig.tsx` | Modal with Resources (packages/extensions/tools/commands/skills/prompts/diagnostics from `/api/pi/resources`) and Settings (registered extension settings + `settings-extensions.json` edit via `/api/pi/extension-settings`). Opened from the sidebar Extensions button. |
| `components/IntercomPanel.tsx` | Top-bar Intercom panel: lists local pi-intercom peers and sends one-shot messages through `/api/intercom/*`. |
| `components/SettingsConfig.tsx` | Settings modal for interface language (`zh`/`en`), WorkTree defaults, Usage scan scope, Web Terminal enablement/shell/env settings including Unix and Windows shell choices plus raw/AI env parsing model controls, ChatGPT usage panel and backend auto-refresh settings, Grok usage panel toggle, Editor implementation/shortcut settings, native Pi subagent model settings (`AgentsConfig`), SnFlow preferences (include-archived default) plus project inspection/init/update (versioned extension/skill/agent assets; no global enable switch), and optional Trellis panel settings in `pi-web.json`, including Trellis docs guidance, prerequisite/status inspection, install/init, update, proxy controls, Trellis workflow assistant primary/fallback model controls, and Trellis subagent model policy controls. ChatGPT warmup schedule is managed from `ChatGptWarmupDialog` and preserved by settings saves. |
| `components/AgentsConfig.tsx` | Native pi-subagents model configuration section in the Settings modal. Owns its own load/save/dirty/error state, supports user-global and project scopes, loads/saves the `subagents` section of Pi `settings.json`, displays discovered agents with source badges, and provides per-agent model/thinking/fallback-model controls with inherit/clear semantics. |
| `components/SubagentPanel.tsx` | Top-bar subagent activity panel. Formats the shared `SubagentRun` projection only (does not reparse raw tool `details`): status/routing chips with the resolved model visible while a run is active, live progress row (current tool/thinking, tool/turn/token/duration stats, Needs attention / Long-running / Detached labels), expanded recent-tool trail from `SubagentRun.progress`, nested child lazy-load, and final output. Completed/failed rows are restored from persisted session messages after reload; missing live progress degrades to the pre-progress layout. |
| `components/TrellisPanel.tsx` | Read-only Trellis task drawer: top-level task list with expandable child task groups, filters, details, artifacts, hierarchy, manifest/context counts, recorded task metadata, optional check-run state, derived phase/progress, optional externally focused task selection, and a join-chat action that adds active tasks as chat context blocks without mutating Trellis files. |
| `components/WorkflowPanel.tsx` | WebUI-owned SnFlow drawer: per-project initialize empty state, optional update-available hint, create/select tasks under `.pi/snflows/tasks/` (including one-click create-from-current-chat), edit requirements/design/plan Markdown, mark ready, request an exact selected-task-bound implement/check instruction, and send it to the current chat for a visible native `subagent` tool call. It polls persisted run status, records commit metadata, completes, and archives tasks. Strictly separate from Trellis. |
| `components/WorkflowSessionWidget.tsx` | Floating session-scoped SnFlow task capsule (plan/execute/finish), shown only when the selected non-archived chat has an exact pointer binding or explicit transcript evidence for the task; opens the SnFlow drawer focused on that task. |
| `components/TrellisWorkflowVisualizer.tsx` | Large read-only Settings → Trellis modal that visualizes `.trellis/workflow.md` phases, steps, workflow-state blocks, source line ranges, parser warnings, Markdown/raw guidance text, and model-assisted Chinese reading summaries as a foundation for future workflow editing. |
| `components/TrellisSessionWidget.tsx` | Floating session-scoped Trellis progress widget shown only when the current chat session has a high-confidence associated task; includes compact child-task progress, a collapsible desktop capsule, and a mobile capsule/bottom sheet, while task-detail actions open the Trellis drawer focused on that task. |
| `components/SessionChangesFloatingPanel.tsx` | Floating chat-session file-change panel that lists tracked edit/write file changes and opens per-file diffs. |
| `components/FileDiffModal.tsx` | Session changed-file diff adapter that fetches one tracked file diff, formats session metadata and fallback labels, and renders the shared diff modal. |
| `components/DiffModal.tsx` | Shared read-only diff modal shell with close-on-Escape, overlay click close, source-specific header slot, loading/error/fallback handling, and Unified/Side-by-side mode controls defaulting to side-by-side. |
| `components/DiffView.tsx` | Shared diff renderer switch that renders unified diffs through `UnifiedDiffView` or parsed side-by-side diffs through `SideBySideDiffView`. |
| `components/SideBySideDiffView.tsx` | Theme-aware side-by-side unified diff parser/renderer with old/new line numbers, aligned modification rows, and metadata/hunk rows. |
| `components/UnifiedDiffView.tsx` | Theme-aware unified diff renderer for added, removed, hunk, header, and context lines. |
| `components/TerminalPanel.tsx` | Bottom-dock Web Terminal workspace using xterm; manages ephemeral multi-tab terminal sessions, per-pane tab strips, tab renaming, nested drag-to-split panes, pane and dock resizing, minimize/restore, app-local fullscreen, and destructive close confirmation while reusing existing terminal session APIs per tab. |
| `components/ModelPricingCatalog.tsx` | Searchable, provider-filterable read-only view of the locally cached pi.dev model pricing catalog, including context-window and token-price columns. |
| `components/UsageStatsModal.tsx` | Token/cost usage statistics modal with active/archive scan counts, parent-attributed native subagent costs, main/subagent splits, and rounded M-token conversions. |
| `components/FileExplorer.tsx` | On-demand file tree inside the sidebar; root loads are abortable and workspace changes clear old roots before applying the new response. |
| `components/FileViewer.tsx` | File content viewer/editor in a tab; routes media/document previews, orchestrates text editing state, and exposes Java implementation lookup results. |
| `components/MonacoFileEditor.tsx` | Monaco-backed source editor for text files, including language mapping, basic completions, word wrap, theme, and line-selection callbacks. |
| `components/FileIcons.tsx` | Monochrome SVG icons for files/folders. |
| `components/MarkdownBody.tsx` | Markdown, KaTeX, Mermaid, and syntax highlighting renderer. |
| `components/TabBar.tsx` | Chat and open-file tab bar. |

## Hooks

| File | Purpose |
| --- | --- |
| `hooks/useAgentSession.ts` | Central chat/session hook: data loading, SSE, streaming state, commands, tools, cwd-scoped model metadata with bounded browser request/result deduplication, thinking levels, and subagent run/routing metadata. Session and branch-context loads rebuild persisted `SubagentRun` rows through `lib/subagent-runs.ts`; live `tool_execution_update.partialResult.details.progress` and supplemental `controlEvents` remain the source for non-persisted progress/activity state. Explicit tool-call model/thinking overrides seed the row before the first update. Flush-to-AppShell dedupe includes visible progress and routing fields. The hook also owns browser-mediated Pi extension UI state (`setStatus`/`setWidget` maps, blocking dialog request, notify toasts) with `extension_ui_response` replies. Standard `todo-list` widget updates are projected by `ChatWindow` into the floating `ExtensionTodoPanel`; other widgets stay near the composer. `tool_execution_end` remains the live authority for final top-level status/result/routing while the last progress snapshot is retained until a reload. |
| `hooks/useTheme.ts` | Dark/light theme toggle with view-transition animation. |
| `hooks/useDragDrop.ts` | Drag-and-drop image attachment handler. |
| `hooks/useAudio.ts` | Sound toggle and completion chime playback. |
| `hooks/useAutoScroll.ts` | Persisted chat auto-stick-to-bottom preference used by the message list and input toggle. |

## Styles

Global CSS lives in `app/globals.css`. Components may reference these CSS variables directly:

```text
--bg --bg-panel --bg-hover --bg-selected --bg-subtle --border
--text --text-muted --text-dim --accent --accent-hover
--user-bg --assistant-bg --tool-bg --font-mono
```

They are also mapped to Tailwind `--color-*` utility aliases. The theme toggles by adding/removing `dark` on `document.documentElement`.

## Internationalization (i18n)

- **Supported locales**: `zh` (default when browser is Chinese), `en`.
- **Provider**: `components/I18nProvider.tsx` wraps the app in `app/page.tsx`.
- **Catalogs**: `lib/i18n/messages/*` nested dictionaries; lookup via dotted keys such as `sidebar.archiveAllSessions`.
- **API**: `const { locale, setLocale, t } = useI18n()`; `t("key", { name })` interpolates `{name}` placeholders.
- **Persistence**: `localStorage["pi-locale"]`; boot script in `app/layout.tsx` sets `document.documentElement.lang` early to reduce flash.
- **Switcher**: top-bar `EN`/`中` button in `AppShell`, and Settings → Language section.
- **Coverage status**: shell/chat/sidebar/git/terminal/diff and shared chrome strings are wired. Large settings/models/trellis panels still contain mixed hard-coded Chinese/English copy and should continue migrating onto `settings.*` / `trellis.*` / `panels.*` keys.
