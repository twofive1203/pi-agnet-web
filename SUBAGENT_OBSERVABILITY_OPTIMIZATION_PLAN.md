# Subagent Observability Optimization Plan

## 1. Problem Statement

When the main conversation executes work through a subagent, especially when SnFlow dispatches `snflow-implement`, the session enters a long-running wait state. During that period, unrelated WebUI operations may become slow or appear blocked:

- Creating a Git Worktree may remain pending until the subagent finishes.
- Refreshing Grok usage can take significantly longer than usual.
- Other interactions recover after the child agent or main turn completes.

Code inspection did not identify a shared business lock between AgentSession, Worktree, and Grok routes. Runtime sampling instead showed that the Next.js parent process can sustain approximately one full CPU core while a subagent is active. The current working hypothesis is cumulative load from the subagent observability pipeline:

```text
Subagent process
  -> pi-subagents progress events
  -> AgentSession tool_execution_update
  -> server-side projection
  -> SSE serialization
  -> useAgentSession state processing
  -> periodic AppShell state propagation
  -> top-bar SubagentPanel rendering
```

The nested-child observation feature may add synchronous event-file projection, TUI fleet timers, repeated snapshots, and browser rendering work to this path.

## 2. Goals

The optimized implementation should ensure that, while a subagent is running:

- Worktree creation remains responsive.
- Grok usage refresh is not delayed by local observation work.
- The main conversation still shows useful subagent status.
- The top-bar observation row retains current tool, state, elapsed time, tool count, and token count.
- Nested-child details and full output load only when requested.
- Subagent completion releases timers, polling, pending requests, and retained snapshots.

## 3. Non-Goals

The first optimization pass will not:

- Remove the Subagent panel.
- Remove nested-subagent observability.
- Change subagent execution semantics.
- Change SnFlow lifecycle rules.
- Move AgentSession into a separate process immediately.
- Optimize external xAI/Grok network latency unrelated to local contention.

## 4. Target Architecture

Separate WebUI summary observation from TUI fleet rendering and nested detail inspection:

```text
Subagent process
  |
  | high-frequency raw events
  v
AgentSession host
  |
  | throttled Web observation snapshots
  v
SSE
  |
  | bounded UI state updates
  v
Subagent summary store
  |-- Top-bar badge: running/error counts only
  |-- Subagent panel: summary rows while open
  `-- Detail view: output and nested children on demand
```

The three observation surfaces should be independent:

```text
TUI fleet       -> CLI/TUI only
WebUI summary   -> lightweight top-bar status
Nested details  -> on-demand inspection
```

Hiding a TUI widget in the WebUI bridge must not leave its internal refresh timers or scans running.

## 5. Phase 1: Performance Instrumentation

Add opt-in diagnostics before changing behavior so the bottleneck can be measured rather than inferred.

### 5.1 Server Metrics

Measure:

- `tool_execution_update` events per second.
- Time spent in `projectSubagentEvent()`.
- Time spent in session file-change projection.
- Time spent in nested event projection.
- Time spent in fleet/status refresh operations.
- SSE payload count and serialized byte size.
- Event-loop delay while subagents are active.
- AgentSession event handler duration.

### 5.2 Browser Metrics

Measure:

- SSE events received per second.
- `handleAgentEvent()` processing duration.
- `serializeSubagentRunsForFlush()` duration.
- Number of AppShell renders caused by subagent updates.
- SubagentPanel render duration.
- Delay between a Worktree/Grok click and the browser starting the request.

### 5.3 Instrumentation Rules

- Diagnostics must be disabled by default.
- Logging must use bounded aggregation rather than one log line per event.
- Metrics should distinguish summary events, detail events, and terminal events.
- Instrumentation must not retain full subagent outputs.

## 6. Phase 2: Disable TUI Fleet Work in WebUI Mode

The current WebUI extension context supports dialogs and widgets, which can cause pi-subagents to treat it as a full TUI environment. The WebUI bridge then suppresses TUI widget keys, but suppression happens after internal fleet/status work may already have started.

Introduce an explicit capability or runtime mode, for example:

```ts
uiMode: "web" | "tui"
```

or narrower capabilities:

```ts
supportsTuiFleet: false
supportsWebSubagentSummary: true
```

In WebUI mode:

- Do not construct `SubagentFleetStatus`.
- Do not start the TUI fleet inspector.
- Do not start the legacy async widget.
- Do not start timers used only to refresh TUI presentation.
- Preserve `confirm`, `select`, `input`, `editor`, and notification bridging.
- Preserve subagent execution and terminal result delivery.
- Preserve lightweight WebUI progress snapshots.

### Validation Experiment

Before implementing a new capability contract, test the existing pi-subagents `fleetView: false` setting. If CPU and interaction latency improve substantially during the same SnFlow workload, treat TUI fleet work as a confirmed contributor.

## 7. Phase 3: Throttle Server-Side Progress Events

The WebUI does not require every raw progress event. Add per-tool-call snapshot coalescing.

### Event Policy

| Event | Delivery |
| --- | --- |
| `tool_execution_start` | Immediate |
| `tool_execution_end` | Immediate |
| Failed/timeout state | Immediate |
| `needs_attention` | Immediate |
| `active_long_running` | Immediate |
| Ordinary progress | At most once every 300-500 ms |

For each top-level subagent tool call:

1. Store the latest progress snapshot in memory.
2. If the throttle interval has not elapsed, replace the pending snapshot.
3. Deliver the newest snapshot when the timer expires.
4. Flush immediately before a terminal event.
5. Clear timers when the tool, session, or SSE listener is destroyed.

Initial defaults:

```text
Normal progress interval: 300 ms
High-load fallback:       500 ms
Terminal/error events:    immediate
```

## 8. Phase 4: Split Summary and Detail Data

The high-frequency path should carry only the data needed by the top-bar row.

### 8.1 Summary Payload

```ts
{
  id,
  agent,
  status,
  currentTool,
  currentToolArgs,
  toolCount,
  turnCount,
  tokens,
  durationMs,
  activityState,
  error,
  routing
}
```

### 8.2 Excluded from High-Frequency Updates

Do not include the following in ordinary summary events:

- Full `partialOutput` snapshots.
- Full child transcripts.
- Recursive nested children.
- Complete result message arrays.
- Unbounded recent tool history.
- Full historical control-event arrays.

### 8.3 Detail Payload

Detailed output should be fetched or streamed only for an expanded run. Detail responses should be bounded by:

- Maximum output characters.
- Maximum recent tool count.
- Maximum tool argument preview length.
- Maximum child count and nesting depth.

## 9. Phase 5: Make Nested Observation On-Demand

The existing SubagentPanel already lazy-loads children after expansion. Extend this boundary so nested event projection is also demand-driven.

Default rows should show only:

```text
snflow-implement | Running | bash | 4 tools | 38k tokens | 2m
```

When the user expands a row:

1. Request nested children.
2. Read a bounded session/transcript projection.
3. Display recent tools and output.
4. Permit recursive expansion within configured limits.

### Limits

- Maximum nesting depth: 3.
- Maximum children per level: 16.
- Maximum output size per detail response.
- Maximum recent tools displayed: bounded and configurable.
- Active detail refresh interval: no faster than 1 second.
- Abort stale requests when the panel closes or session changes.
- Cache children by session file and modification fingerprint.

### Nested Registry Behavior

Avoid synchronously scanning and merging nested event files for every ordinary progress event. Prefer:

```text
Nested event arrives
  -> mark route dirty
  -> project on explicit detail request or low-frequency reconciliation
```

Terminal nested events may still trigger an immediate lightweight summary update.

## 10. Phase 6: Reduce Browser-Level Rendering

Current subagent state is periodically propagated into AppShell. This can cause top-level rerenders even when the Subagent panel is closed.

Introduce a dedicated subagent observation store:

```text
SubagentStore
  |-- TopBarBadge subscribes to running/error counts
  |-- SubagentPanel subscribes to summary rows while open
  `-- RunDetail subscribes to one selected run
```

Browser optimization rules:

- Do not store the full runs array in AppShell.
- Keep the top-bar badge subscription limited to counts and severity.
- Subscribe to summary rows only while the panel is open.
- Memoize rows by stable summary fields.
- Avoid replacing row objects when observable fields are unchanged.
- Increase browser flush interval from 150 ms to approximately 300 ms unless measurements justify a lower value.
- Keep terminal events immediate.

## 11. Phase 7: Protect Unrelated APIs

### 11.1 Short-Term Protection

- Keep Worktree Git execution asynchronous.
- Add explicit Worktree operation timeouts and actionable errors.
- Keep Grok cache reads local and fast.
- Keep Grok live fetch timeouts independent of AgentSession.
- Remove synchronous nested projection from ordinary API request paths.
- Prevent AgentSession event handlers from performing large synchronous filesystem work.

### 11.2 Medium-Term Isolation

If the previous phases do not sufficiently reduce contention, move AgentSession hosting out of the Next.js process:

```text
Next.js server
  |
  | IPC/message channel
  v
AgentSession host process
  |-- Main conversation sessions
  |-- Subagent event processing
  `-- Observation snapshot generation
```

This provides a hard isolation boundary: an overloaded AgentSession host cannot block Worktree, Grok, Settings, or other Next.js APIs.

This is intentionally deferred because it changes lifecycle, deployment, shutdown, hot reload, and session registry behavior.

## 12. Implementation Sequence

1. Add opt-in server and browser performance metrics.
2. Run a repeatable SnFlow workload and capture a baseline.
3. Disable TUI fleet/status work in WebUI mode.
4. Add server-side progress throttling and terminal flush behavior.
5. Measure again using the same workload.
6. Split summary and detail payloads.
7. Move nested projection to on-demand or low-frequency reconciliation.
8. Introduce the dedicated browser subagent store.
9. Reassess whether AgentSession process isolation is still necessary.

The recommended first delivery includes only steps 1-4. It has the smallest behavioral surface and should validate the primary hypothesis quickly.

## 13. Verification Scenarios

### 13.1 Baseline Scenario

Run the same `snflow-implement` task before and after each optimization phase while collecting:

- Next.js CPU and memory.
- Child process CPU and memory.
- Event-loop delay.
- SSE event count and bytes.
- Browser main-thread activity.
- Worktree API latency.
- Grok cache and live refresh latency.

### 13.2 Functional Scenarios

1. A single foreground subagent reports current tool, tokens, and elapsed time.
2. A subagent completes successfully and the final state is delivered immediately.
3. A subagent fails and the error state is delivered immediately.
4. A subagent enters `needs_attention` and the badge appears without throttle delay.
5. A nested child appears after expanding its parent.
6. Closing the panel aborts stale detail requests.
7. Switching sessions stops old observation updates.
8. Destroying a session clears all throttling and refresh timers.
9. Worktree creation proceeds while a child agent is waiting on a model.
10. Grok cache and live refresh proceed while a child agent is running.

### 13.3 Load Scenarios

- One long-running child with no tools.
- One child producing many tool events.
- Parallel children.
- Nested children up to the configured depth.
- Large partial output.
- Repeated panel open/close cycles.
- Ten-minute continuous child execution.

## 14. Acceptance Metrics

### Server

- Next.js parent CPU averages below 30% of one core during an idle/waiting child period.
- A five-second window consumes no more than 1.5 CPU seconds in the Next.js process.
- Worktree POST p95 is below 2 seconds, excluding Git-specific external delays.
- Grok cache GET is below 200 ms.
- Ordinary API p95 does not materially regress while a subagent is active.
- SSE progress event volume is reduced by at least one order of magnitude under high-frequency workloads.

### Browser

- Normal click response remains below 100 ms.
- AppShell does not rerender for every subagent progress update while the panel is closed.
- Visible summary updates appear within 300-500 ms.
- Closing the panel substantially reduces rendering work.
- Browser memory does not grow continuously during a ten-minute run.

### Functionality

- Running, complete, failed, timeout, detached, and needs-attention states remain accurate.
- Current tool, tool count, token count, routing, and elapsed time remain visible.
- Nested children remain inspectable on demand.
- Final output remains available after completion.
- Session destruction releases all observation resources.
- Worktree and Grok operations no longer recover only after the main turn ends.

## 15. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Throttling hides terminal state | Flush pending snapshot before every terminal event. |
| Needs-attention notification is delayed | Exempt control and error events from throttling. |
| Detail request reads stale data | Include session file modification fingerprint and refresh while expanded. |
| Disabling TUI fleet affects CLI users | Gate behavior on explicit WebUI capability, not a global default. |
| New metrics add overhead | Keep metrics opt-in and aggregate in bounded windows. |
| Process isolation complicates lifecycle | Defer until lightweight optimizations have been measured. |
| Nested registry grows indefinitely | Bound retained events and add safe cleanup independent of high-frequency rendering. |

## 16. Recommended First Iteration

Implement and measure only:

1. Opt-in performance instrumentation.
2. Explicit WebUI mode that disables TUI fleet/status timers.
3. Server-side subagent progress throttling at 300 ms.
4. Immediate delivery for terminal, error, and attention events.

Do not redesign nested details or move AgentSession to another process until the first iteration is measured. If this iteration brings Next.js CPU and API latency within the acceptance thresholds, later phases can remain targeted frontend and data-shaping improvements rather than an architectural migration.
