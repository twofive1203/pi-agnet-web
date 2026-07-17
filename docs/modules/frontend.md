# Frontend Module Map

## Components

| File | Purpose |
| --- | --- |
| `components/AppShell.tsx` | Top-level layout, URL state, tab management, Web Terminal bottom-dock toggling, right drawer mode switching between files and optional Trellis tasks, Trellis-task-to-chat context block insertion, and body-portaled top-bar auxiliary panels that remain visible outside the mobile horizontal scroller. |
| `components/SessionSidebar.tsx` | Session tree sidebar, workspace/WorkTree picker actions grouped by main workspace, archive/unarchive actions, archived section, multi-select batch archive, and integrated file explorer. |
| `components/ChatWindow.tsx` | Message list, SSE streaming, fork/navigate logic. Shows archived banner and disables input for archived sessions. |
| `components/ChatInput.tsx` | Input bar, model dropdown, thinking level, tool preset, image upload, file-reference chips, serialized Trellis task context blocks, and bounded, scrollable slash-command autocomplete for extension commands, prompts, and skills. |
| `components/ChatGptUsagePanel.tsx` | Optional semi-transparent top-bar ChatGPT/Codex quota panel; renders its viewport-bounded details popover through `document.body` so it is not clipped by the mobile top-bar scroller, reads and periodically revalidates cached active-account usage and reset-credit availability, reloads accounts on expand, lists saved accounts with quick activation, supports manual quota refresh and confirmed reset-credit consumption for the active account, and shows backend auto-refresh scheduler/lock maintenance state. |
| `components/ChatGptWarmupDialog.tsx` | ChatGPT/Codex warmup management dialog opened from the saved-account management area; supports manual multi-select warmup, scheduled warmup account/time settings, and recent manual/scheduled run history. |
| `components/MessageView.tsx` | Render user, assistant, tool-call, and tool-result messages. |
| `components/BranchNavigator.tsx` | In-session branch switcher; its inline top-bar panel uses a fixed body portal so mobile toolbar overflow does not clip the branch tree. |
| `components/ChatMinimap.tsx` | Scroll minimap beside message list. |
| `components/ToolPanel.tsx` | Tool presets and preset inference helpers. |
| `components/ModelsConfig.tsx` | Modal for editing `models.json`, discovering OpenAI-compatible custom-provider models from `/models` into the staged provider model list, OAuth/API-key auth, and ChatGPT Plus/Pro saved-account add/import, activation, temporary account selection for the subscription/usage panel, remarks, extra-info dialog, cached quota reset display with inline mini usage pies, manual quota refresh, inactive-account deletion, and raw/CPA/SUB2API account JSON import via shared converters. |
| `components/GitPanel.tsx` | Git status dropdown panel showing branch, previewable/selectable commit graph by selected local branch, selected-commit metadata and changed files, staged/unstaged changes, untracked files, stash, and local branch switching with an explicit Switch button. |
| `components/CommitGraph.tsx` | Git commit graph renderer with lane visualization, refs, hover tooltips, and optional selected-commit callbacks for the Git panel. |
| `components/GitCommitDiffModal.tsx` | Git commit file-diff adapter that fetches one selected commit file diff, formats commit/file metadata and fallback labels, and renders the shared diff modal. |
| `components/SkillsConfig.tsx` | Modal for browsing/installing skills. |
| `components/SettingsConfig.tsx` | Settings modal for WorkTree defaults, Usage scan scope, Web Terminal enablement/shell/env settings including Unix and Windows shell choices plus raw/AI env parsing model controls, ChatGPT usage panel and backend auto-refresh settings, Editor implementation/shortcut settings, native Pi subagent model settings (`AgentsConfig`), and optional Trellis panel settings in `pi-web.json`, including Trellis docs guidance, prerequisite/status inspection, install/init, update, proxy controls, Trellis workflow assistant primary/fallback model controls, and Trellis subagent model policy controls. ChatGPT warmup schedule is managed from `ChatGptWarmupDialog` and preserved by settings saves. |
| `components/AgentsConfig.tsx` | Native pi-subagents model configuration section in the Settings modal. Owns its own load/save/dirty/error state, supports user-global and project scopes, loads/saves the `subagents` section of Pi `settings.json`, displays discovered agents with source badges, and provides per-agent model/thinking/fallback-model controls with inherit/clear semantics. |
| `components/SubagentPanel.tsx` | Top-bar subagent activity panel, including nested subagent inspection and compact model/thinking metadata chips when subagent routing or result metadata is available. |
| `components/TrellisPanel.tsx` | Read-only Trellis task drawer: top-level task list with expandable child task groups, filters, details, artifacts, hierarchy, manifest/context counts, recorded task metadata, optional check-run state, derived phase/progress, optional externally focused task selection, and a join-chat action that adds active tasks as chat context blocks without mutating Trellis files. |
| `components/TrellisWorkflowVisualizer.tsx` | Large read-only Settings → Trellis modal that visualizes `.trellis/workflow.md` phases, steps, workflow-state blocks, source line ranges, parser warnings, Markdown/raw guidance text, and model-assisted Chinese reading summaries as a foundation for future workflow editing. |
| `components/TrellisSessionWidget.tsx` | Floating session-scoped Trellis progress widget shown only when the current chat session has a high-confidence associated task; includes compact child-task progress, a collapsible desktop capsule, and a mobile capsule/bottom sheet, while task-detail actions open the Trellis drawer focused on that task. |
| `components/SessionChangesFloatingPanel.tsx` | Floating chat-session file-change panel that lists tracked edit/write file changes and opens per-file diffs. |
| `components/FileDiffModal.tsx` | Session changed-file diff adapter that fetches one tracked file diff, formats session metadata and fallback labels, and renders the shared diff modal. |
| `components/DiffModal.tsx` | Shared read-only diff modal shell with close-on-Escape, overlay click close, source-specific header slot, loading/error/fallback handling, and Unified/Side-by-side mode controls defaulting to side-by-side. |
| `components/DiffView.tsx` | Shared diff renderer switch that renders unified diffs through `UnifiedDiffView` or parsed side-by-side diffs through `SideBySideDiffView`. |
| `components/SideBySideDiffView.tsx` | Theme-aware side-by-side unified diff parser/renderer with old/new line numbers, aligned modification rows, and metadata/hunk rows. |
| `components/UnifiedDiffView.tsx` | Theme-aware unified diff renderer for added, removed, hunk, header, and context lines. |
| `components/TerminalPanel.tsx` | Bottom-dock Web Terminal workspace using xterm; manages ephemeral multi-tab terminal sessions, per-pane tab strips, tab renaming, nested drag-to-split panes, pane and dock resizing, minimize/restore, app-local fullscreen, and destructive close confirmation while reusing existing terminal session APIs per tab. |
| `components/UsageStatsModal.tsx` | Token/cost usage statistics modal with active/archive scan counts and rounded M-token conversions. |
| `components/FileExplorer.tsx` | File tree inside the sidebar. |
| `components/FileViewer.tsx` | File content viewer/editor in a tab; routes media/document previews, orchestrates text editing state, and exposes Java implementation lookup results. |
| `components/MonacoFileEditor.tsx` | Monaco-backed source editor for text files, including language mapping, basic completions, word wrap, theme, and line-selection callbacks. |
| `components/FileIcons.tsx` | Monochrome SVG icons for files/folders. |
| `components/MarkdownBody.tsx` | Markdown, KaTeX, Mermaid, and syntax highlighting renderer. |
| `components/TabBar.tsx` | Chat and open-file tab bar. |

## Hooks

| File | Purpose |
| --- | --- |
| `hooks/useAgentSession.ts` | Central chat/session hook: data loading, SSE, streaming state, commands, tools, models, thinking levels, subagent run/routing metadata, and simple browser-mediated Pi extension UI requests. |
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
