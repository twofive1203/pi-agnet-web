import {
  ExtensionWebUiBridge,
  isSuppressedExtensionWidgetKey,
} from "../lib/extension-web-ui";
import type { AgentEvent } from "../lib/rpc-manager";

let failures = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (condition) console.log(`ok: ${message}`);
  else {
    failures += 1;
    console.error(`FAIL: ${message}`);
  }
}

function main(): void {
  assert(isSuppressedExtensionWidgetKey("subagent-async"), "suppresses subagent-async");
  assert(isSuppressedExtensionWidgetKey("subagent-fleet-status"), "suppresses fleet status");
  assert(isSuppressedExtensionWidgetKey("powerbar"), "suppresses powerbar");
  assert(isSuppressedExtensionWidgetKey("PowerBar:cpu"), "suppresses powerbar prefix case-insensitively");
  assert(!isSuppressedExtensionWidgetKey("todo-list"), "keeps todo-list widgets");

  const events: AgentEvent[] = [];
  const bridge = new ExtensionWebUiBridge((event) => {
    events.push(event);
  });
  const ui = bridge.createContext();

  ui.setFooter(() => ({ render: () => [], invalidate: () => {} }));
  ui.setHeader(() => ({ render: () => [], invalidate: () => {} }));
  ui.setEditorComponent();
  ui.setWorkingMessage("busy");
  ui.setWorkingVisible(true);
  ui.setWorkingIndicator({});
  ui.setHiddenThinkingLabel("thinking");
  ui.addAutocompleteProvider();
  void ui.custom();
  assert(events.splice(0).length === 0, "TUI-only APIs stay silent (no extension_error spam)");

  ui.setWidget("powerbar", () => ({
    render: () => ["should not emit"],
    invalidate: () => {},
  }));
  ui.setWidget("subagent-async", ["async"]);
  assert(events.splice(0).length === 0, "suppressed widget keys emit nothing");

  ui.setWidget("needs-full-tui", () => {
    throw new Error("factory needs real TUI");
  });
  assert(events.splice(0).length === 0, "unmaterializable factories are dropped silently");

  ui.setWidget("todo-list", (_tui, theme) => {
    const themed = theme as { fg: (name: string, text: string) => string; strikethrough: (text: string) => string };
    return {
      render: () => [
        themed.fg("accent", " Todo List "),
        `  ✓ ${themed.fg("dim", themed.strikethrough("done item"))}`,
      ],
      invalidate: () => {},
    };
  }, { placement: "aboveEditor" });

  const materialized = events.splice(0);
  assert(materialized.length === 1, "materializable factory emits one setWidget request");
  const request = materialized[0] as AgentEvent & {
    method?: string;
    widgetKey?: string;
    widgetLines?: string[];
    widgetPlacement?: string;
  };
  assert(request.type === "extension_ui_request" && request.method === "setWidget", "emits setWidget method");
  assert(request.widgetKey === "todo-list", "preserves widget key");
  assert(
    Array.isArray(request.widgetLines) && request.widgetLines.some((line: string) => line.includes("Todo List")),
    "materializes plain text lines",
  );
  assert(request.widgetPlacement === "aboveEditor", "preserves placement");

  ui.setWidget("plain", ["a", "b"]);
  const plainEvents = events.splice(0);
  const plain = plainEvents[0] as AgentEvent & { widgetLines?: string[] };
  assert(plainEvents.length === 1 && plain.widgetLines?.[0] === "a", "string-array widgets still forward");

  if (failures > 0) process.exitCode = 1;
  else console.log("All extension-web-ui smokes passed.");
}

main();
