/**
 * Dev-only visual state preview for the desktop pet (U3).
 *
 * Writes a static HTML matrix under desktop/.preview/. The page injects a
 * sanitized view fixture into the existing renderer. It never starts Electron,
 * never contacts the observer, and is ignored by Forge packaging.
 *
 * Usage: node scripts/preview-desktop-pet-states.mjs
 *        npm run desktop:preview
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "desktop", ".preview");
const REVIEW_DIR = path.join(OUT_DIR, "review");
const RENDERER_DIR = path.join(ROOT, "desktop", "renderer");

const STATES = [
  "idle",
  "running",
  "retrying",
  "needs_input",
  "ready",
  "blocked",
  "disconnected",
  "service_not_running",
];
const PETS = [
  { id: "snail-default", name: "星海蜗牛" },
  { id: "snail-classic", name: "经典蜗牛" },
  { id: "snail-sprite", name: "像素蜗牛" },
];
const SCALES = ["small", "medium", "large"];
const LONG_TITLE = "超长安全标题用于检查折叠窗口与活动列表是否会被撑破一二三四五六七八九十";

function emptyAggregate() {
  return {
    active: 0,
    running: 0,
    retrying: 0,
    needsInput: 0,
    blocked: 0,
    ready: 0,
    unread: 0,
  };
}

function baseView(overrides = {}) {
  return {
    presentation: "idle",
    connectionStatus: "connected",
    connectionReasonCode: null,
    origin: "http://127.0.0.1:62666",
    port: 62666,
    startCommand: "spi --no-open",
    canCopyStartCommand: false,
    hasAccessKey: false,
    needsAccessKey: false,
    stale: false,
    trayOpen: false,
    trayAnchor: "top-left",
    selectedActivityId: "preview-activity",
    selectedPetId: "snail-default",
    petScale: "medium",
    alwaysOnTop: true,
    clickThrough: false,
    launchAtLogin: false,
    showContextMeter: true,
    dndEnabled: false,
    quickSessionAvailable: true,
    notification: { needsInput: true, blocked: true, completion: "background-only" },
    reducedMotion: false,
    reset: false,
    revision: 1,
    instanceId: "preview",
    generatedAt: "2026-08-13T00:00:00.000Z",
    aggregate: emptyAggregate(),
    projects: [],
    diagnostics: [],
    attentionCount: 0,
    activeCount: 0,
    ...overrides,
  };
}

function activityFor(state) {
  const map = {
    idle: { executionState: "idle", outcome: "none", attention: "none", phase: "idle" },
    running: { executionState: "running", outcome: "none", attention: "none", phase: "tool" },
    retrying: { executionState: "running", outcome: "none", attention: "none", phase: "retry" },
    needs_input: { executionState: "waiting", outcome: "none", attention: "needs_input", phase: "awaiting" },
    ready: { executionState: "settled", outcome: "succeeded", attention: "none", phase: "done" },
    blocked: { executionState: "settled", outcome: "failed", attention: "blocked", phase: "blocked" },
    disconnected: { executionState: "idle", outcome: "none", attention: "none", phase: "idle" },
    service_not_running: { executionState: "idle", outcome: "none", attention: "none", phase: "idle" },
  };
  const flags = map[state];
  return {
    taskKey: `preview:${state}`,
    activityId: `preview-activity-${state}`,
    source: "agent",
    projectKey: "preview-project",
    projectName: "Preview Project",
    title: LONG_TITLE,
    presentation: state === "disconnected" || state === "service_not_running" ? "idle" : state,
    executionState: flags.executionState,
    outcome: flags.outcome,
    attention: flags.attention,
    phase: flags.phase,
    progress:
      state === "running"
        ? { kind: "ratio", current: 2, total: 5 }
        : { kind: "indeterminate" },
    activeModel: { provider: "anthropic", modelId: "claude-sonnet-4" },
    sessionResources: {
      context: {
        percent: state === "disconnected" ? null : 42.3,
        usedTokens: 84600,
        contextWindow: 200000,
      },
      billing: { totalTokens: 128400, costUsd: 0.0842 },
      performance: { avgTps: 31.8, sampleCount: 6 },
    },
    deepLink: "/?session=preview",
    lastTransitionId: `preview-transition-${state}`,
    unread: state === "ready" || state === "needs_input" || state === "blocked",
    elapsedMs: 65000,
    children:
      state === "running"
        ? [
            {
              childId: "preview-child",
              title: "子任务摘要",
              executionState: "running",
              outcome: "none",
              attention: "none",
              phase: "search",
              updatedAt: "2026-08-13T00:00:00.000Z",
            },
          ]
        : [],
  };
}

function viewForCell({ state, petId, petScale, trayOpen, settingsOpen, reducedMotion }) {
  const connectionStatus =
    state === "service_not_running"
      ? "service-not-running"
      : state === "disconnected"
        ? "reconnecting"
        : "connected";
  const activity = activityFor(state);
  const showActivity = state !== "idle";
  return baseView({
    presentation: state,
    connectionStatus,
    connectionReasonCode: state === "service_not_running" ? "connection_refused" : null,
    canCopyStartCommand: state === "service_not_running",
    trayOpen,
    selectedActivityId: showActivity ? activity.activityId : null,
    selectedPetId: petId,
    petScale,
    reducedMotion,
    settingsOpen,
    stale: state === "disconnected" || state === "service_not_running",
    attentionCount: activity.unread ? 1 : 0,
    activeCount: state === "running" || state === "retrying" || state === "needs_input" ? 1 : 0,
    aggregate: {
      ...emptyAggregate(),
      active: state === "running" || state === "retrying" ? 1 : 0,
      running: state === "running" ? 1 : 0,
      retrying: state === "retrying" ? 1 : 0,
      needsInput: state === "needs_input" ? 1 : 0,
      blocked: state === "blocked" ? 1 : 0,
      ready: state === "ready" ? 1 : 0,
      unread: activity.unread ? 1 : 0,
    },
    projects: showActivity
      ? [
          {
            projectKey: "preview-project",
            displayName: "Preview Project",
            counts: {
              active: state === "running" || state === "retrying" ? 1 : 0,
              needsInput: state === "needs_input" ? 1 : 0,
              blocked: state === "blocked" ? 1 : 0,
              ready: state === "ready" ? 1 : 0,
              unread: activity.unread ? 1 : 0,
            },
            activities: [activity],
          },
        ]
      : [],
  });
}

function cells() {
  const list = [];
  for (const pet of PETS) {
    for (const scale of SCALES) {
      for (const state of STATES) {
        list.push({
          id: `${pet.id}-${scale}-${state}`,
          title: `${pet.name} / ${scale} / ${state}`,
          view: viewForCell({
            state,
            petId: pet.id,
            petScale: scale,
            trayOpen: false,
            settingsOpen: false,
            reducedMotion: false,
          }),
        });
      }
    }
  }
  list.push({
    id: "tray-running",
    title: "Activity tray / running",
    view: viewForCell({
      state: "running",
      petId: "snail-default",
      petScale: "medium",
      trayOpen: true,
      settingsOpen: false,
      reducedMotion: false,
    }),
  });
  list.push({
    id: "settings-ready",
    title: "Settings / ready",
    view: viewForCell({
      state: "ready",
      petId: "snail-classic",
      petScale: "large",
      trayOpen: true,
      settingsOpen: true,
      reducedMotion: false,
    }),
  });
  list.push({
    id: "reduced-motion-running",
    title: "Reduced motion / running",
    view: viewForCell({
      state: "running",
      petId: "snail-default",
      petScale: "medium",
      trayOpen: false,
      settingsOpen: false,
      reducedMotion: true,
    }),
  });
  const qsProject = {
    projectRef: "p_aaaaaaaaaaaaaaaa",
    displayName: "alpha",
    latestModified: "2026-08-17T12:00:00.000Z",
    archived: false,
    worktree: false,
  };
  const qsBase = {
    state: "idle",
    petId: "snail-default",
    petScale: "medium",
    trayOpen: true,
    settingsOpen: false,
    reducedMotion: false,
  };
  list.push({
    id: "quick-session-editing",
    title: "Quick session / editing",
    view: {
      ...viewForCell(qsBase),
      quickSessionPreview: {
        phase: "editing",
        projects: [qsProject, { ...qsProject, projectRef: "p_bbbbbbbbbbbbbbbb", displayName: "alpha", disambiguator: "bb22" }],
        truncated: false,
        omitted: 0,
        query: "",
        selectedProjectRef: qsProject.projectRef,
        draft: "检查当前测试失败原因",
        requestId: null,
        errorCode: null,
        success: null,
      },
    },
  });
  list.push({
    id: "quick-session-submitting",
    title: "Quick session / submitting",
    view: {
      ...viewForCell({ ...qsBase, petScale: "small" }),
      quickSessionPreview: {
        phase: "submitting",
        projects: [qsProject],
        truncated: false,
        omitted: 0,
        query: "",
        selectedProjectRef: qsProject.projectRef,
        draft: "检查当前测试失败原因",
        requestId: "11111111-1111-4111-8111-111111111111",
        errorCode: null,
        success: null,
      },
    },
  });
  list.push({
    id: "quick-session-success",
    title: "Quick session / success",
    view: {
      ...viewForCell({ ...qsBase, petScale: "large" }),
      quickSessionPreview: {
        phase: "success",
        projects: [qsProject],
        truncated: false,
        omitted: 0,
        query: "",
        selectedProjectRef: qsProject.projectRef,
        draft: "",
        requestId: null,
        errorCode: null,
        success: { sessionId: "sess-preview", deepLink: "/?session=sess-preview" },
      },
    },
  });
  list.push({
    id: "quick-session-empty",
    title: "Quick session / empty",
    view: {
      ...viewForCell({ ...qsBase, reducedMotion: true }),
      quickSessionAvailable: false,
      quickSessionPreview: {
        phase: "error",
        projects: [],
        truncated: false,
        omitted: 0,
        query: "",
        selectedProjectRef: null,
        draft: "草稿仍在",
        requestId: null,
        errorCode: "project_unknown",
        success: null,
      },
    },
  });
  return list;
}

function copyRendererAssets() {
  for (const name of ["pet.css", "pet-app.js"]) {
    const src = path.join(RENDERER_DIR, name);
    if (!existsSync(src)) {
      throw new Error(`missing ${name}; run npm run desktop:build first`);
    }
    writeFileSync(path.join(OUT_DIR, name), readFileSync(src));
  }
}

function writeIndex(cellList) {
  const fixtures = Object.fromEntries(cellList.map((cell) => [cell.id, cell.view]));
  const options = cellList
    .map((cell) => `<option value="${cell.id}">${cell.title}</option>`)
    .join("");
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    />
    <title>Desktop pet visual preview</title>
    <style>
      body { margin: 0; background: #1b212a; color: #f4f7fb; font: 13px/1.4 "Segoe UI", system-serif; }
      .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 12px; background: #12161d; }
      select, button { font: inherit; }
      iframe { width: 100%; height: calc(100vh - 48px); border: 0; background: transparent; }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <strong>桌宠视觉验收台</strong>
      <label>组合 <select id="cell">${options}</select></label>
      <button type="button" id="prev">上一组</button>
      <button type="button" id="next">下一组</button>
      <span id="meta"></span>
    </div>
    <iframe id="frame" title="pet preview"></iframe>
    <script>
      const fixtures = ${JSON.stringify(fixtures)};
      const ids = ${JSON.stringify(cellList.map((cell) => cell.id))};
      const titles = ${JSON.stringify(Object.fromEntries(cellList.map((cell) => [cell.id, cell.title])))};
      const select = document.getElementById("cell");
      const frame = document.getElementById("frame");
      const meta = document.getElementById("meta");
      function show(id) {
        const view = fixtures[id];
        if (!view) return;
        select.value = id;
        meta.textContent = titles[id] + " · tray=" + view.trayOpen + " · motion=" + (view.reducedMotion ? "reduce" : "full");
        const src = new URL("./frame.html", window.location.href);
        src.searchParams.set("cell", id);
        frame.src = src.href;
      }
      select.addEventListener("change", () => show(select.value));
      document.getElementById("prev").addEventListener("click", () => {
        const index = Math.max(0, ids.indexOf(select.value) - 1);
        show(ids[index]);
      });
      document.getElementById("next").addEventListener("click", () => {
        const index = Math.min(ids.length - 1, ids.indexOf(select.value) + 1);
        show(ids[index]);
      });
      show(ids[0]);
    </script>
  </body>
</html>
`;
  writeFileSync(path.join(OUT_DIR, "index.html"), html);
  writeFileSync(path.join(OUT_DIR, "fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
  writeFileSync(
    path.join(OUT_DIR, "fixtures.js"),
    `window.__SNAIL_PET_PREVIEW_FIXTURES__ = ${JSON.stringify(fixtures)};\n`,
  );
  writeFileSync(
    path.join(OUT_DIR, "preview-frame-bootstrap.js"),
    `(() => {
  const cell = new URLSearchParams(window.location.search).get("cell");
  const fixtures = window.__SNAIL_PET_PREVIEW_FIXTURES__;
  window.__SNAIL_PET_PREVIEW__ = cell && fixtures ? fixtures[cell] ?? null : null;
})();
`,
  );
}

function writeFrame() {
  const source = readFileSync(path.join(RENDERER_DIR, "index.html"), "utf8");
  const injected = source
    .replace("frame-ancestors 'none'", "frame-ancestors 'self'")
    .replace(
      '<script src="./pet-app.js"></script>',
      `<script src="./fixtures.js"></script>
    <script src="./preview-frame-bootstrap.js"></script>
    <script src="./pet-app.js"></script>`,
    );
  writeFileSync(path.join(OUT_DIR, "frame.html"), injected);
}

function writeReviewTemplate(cellList) {
  mkdirSync(REVIEW_DIR, { recursive: true });
  const rows = cellList
    .map((cell) => `| ${cell.id} | ${cell.title} |  |  |  |`)
    .join("\n");
  writeFileSync(
    path.join(REVIEW_DIR, "checklist.md"),
    `# Desktop pet visual review sheet

Generated: ${new Date().toISOString()}
Preview: \`desktop/.preview/index.html\`
Record: copy results into \`docs/operations/desktop-pet-visual-review.md\`.

| ID | Combination | Result | Notes | Reviewer |
| --- | --- | --- | --- | --- |
${rows}
`,
  );
}

function assertFixturesSafe(cellList) {
  const forbidden = /"(token|observerToken|accessKey|password|pid|servicePid|cwd|firstMessage|prompt|command|output|child_process)"\s*:/;
  for (const cell of cellList) {
    const json = JSON.stringify(cell.view);
    if (forbidden.test(json)) {
      throw new Error(`preview fixture leaked key: ${cell.id}`);
    }
    if (typeof cell.view.presentation !== "string" || !Array.isArray(cell.view.projects)) {
      throw new Error(`preview fixture incomplete: ${cell.id}`);
    }
  }
}

async function main() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const cellList = cells();
  assertFixturesSafe(cellList);
  copyRendererAssets();
  writeIndex(cellList);
  writeFrame();
  writeReviewTemplate(cellList);
  console.log(`desktop pet preview written: ${path.relative(ROOT, OUT_DIR).replaceAll("\\\\", "/")}`);
  console.log(`open ${path.relative(ROOT, path.join(OUT_DIR, "index.html")).replaceAll("\\\\", "/")}`);
  console.log(`cells=${cellList.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
