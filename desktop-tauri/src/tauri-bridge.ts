import { invoke } from "@tauri-apps/api/core";

export type PhaseAShellState = {
  visible: boolean;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  expanded: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  monitorCount: number;
  scaleFactor: number;
};

export type PhaseASnailPetBridge = {
  getState: () => Promise<PhaseAShellState>;
  toggleTray: () => Promise<PhaseAShellState>;
  hideToTray: () => Promise<PhaseAShellState>;
  moveBy: (dx: number, dy: number) => Promise<PhaseAShellState>;
  setClickThrough: (enabled: boolean) => Promise<PhaseAShellState>;
  setAlwaysOnTop: (enabled: boolean) => Promise<PhaseAShellState>;
  showPreview: () => Promise<PhaseAShellState>;
  quitPreview: () => Promise<void>;
};

const bridge: PhaseASnailPetBridge = Object.freeze({
  getState: () => invoke<PhaseAShellState>("get_shell_state"),
  toggleTray: () => invoke<PhaseAShellState>("toggle_expanded"),
  hideToTray: () => invoke<PhaseAShellState>("hide_to_tray"),
  moveBy: (dx, dy) => invoke<PhaseAShellState>("move_by", { dx, dy }),
  setClickThrough: (clickThrough) =>
    invoke<PhaseAShellState>("set_click_through", { clickThrough }),
  setAlwaysOnTop: (alwaysOnTop) =>
    invoke<PhaseAShellState>("set_always_on_top", { alwaysOnTop }),
  showPreview: () => invoke<PhaseAShellState>("show_preview"),
  quitPreview: () => invoke<void>("quit_preview"),
});

// Keep the existing host shape without exposing Tauri's generic invoke/event/window objects.
Object.defineProperty(window, "snailPet", {
  value: bridge,
  configurable: false,
  enumerable: true,
  writable: false,
});
// Static contract marker: the Phase B renderer will consume window.snailPet only.
void "window.snailPet";

const status = document.querySelector<HTMLElement>("#shell-status");
const panel = document.querySelector<HTMLElement>("#phase-a-panel");
const pet = document.querySelector<HTMLElement>("#pet-drag-surface");
const topToggle = document.querySelector<HTMLInputElement>("#always-on-top");

function render(state: PhaseAShellState): void {
  if (status) {
    const bounds = state.bounds
      ? `${state.bounds.x},${state.bounds.y} · ${state.bounds.width}×${state.bounds.height}`
      : "bounds unavailable";
    status.textContent = `${state.monitorCount} monitor · ${Math.round(state.scaleFactor * 100)}% · ${bounds}`;
  }
  panel?.classList.toggle("is-expanded", state.expanded);
  if (topToggle) topToggle.checked = state.alwaysOnTop;
}

async function run(action: () => Promise<PhaseAShellState>): Promise<void> {
  try {
    render(await action());
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : String(error);
  }
}

document.querySelector("#toggle-size")?.addEventListener("click", () => void run(bridge.toggleTray));
document.querySelector("#hide-preview")?.addEventListener("click", () => void run(bridge.hideToTray));
document.querySelector("#enable-click-through")?.addEventListener("click", () => {
  const hint = document.querySelector<HTMLElement>("#recovery-hint");
  if (hint) hint.hidden = false;
  void run(() => bridge.setClickThrough(true));
});
topToggle?.addEventListener("change", () => void run(() => bridge.setAlwaysOnTop(topToggle.checked)));

let dragPointerId: number | null = null;
let previousPoint: { x: number; y: number } | null = null;
let dragInFlight = false;
let queuedDelta = { dx: 0, dy: 0 };

async function flushDrag(): Promise<void> {
  if (dragInFlight || (queuedDelta.dx === 0 && queuedDelta.dy === 0)) return;
  dragInFlight = true;
  const delta = queuedDelta;
  queuedDelta = { dx: 0, dy: 0 };
  try {
    render(await bridge.moveBy(delta.dx, delta.dy));
  } finally {
    dragInFlight = false;
    void flushDrag();
  }
}

pet?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  dragPointerId = event.pointerId;
  previousPoint = { x: event.clientX, y: event.clientY };
  pet.setPointerCapture(event.pointerId);
  pet.classList.add("is-dragging");
});
pet?.addEventListener("pointermove", (event) => {
  if (event.pointerId !== dragPointerId || !previousPoint) return;
  queuedDelta.dx += event.clientX - previousPoint.x;
  queuedDelta.dy += event.clientY - previousPoint.y;
  previousPoint = { x: event.clientX, y: event.clientY };
  void flushDrag();
});
const endDrag = (event: PointerEvent): void => {
  if (event.pointerId !== dragPointerId) return;
  dragPointerId = null;
  previousPoint = null;
  pet?.classList.remove("is-dragging");
};
pet?.addEventListener("pointerup", endDrag);
pet?.addEventListener("pointercancel", endDrag);

void run(bridge.getState);
