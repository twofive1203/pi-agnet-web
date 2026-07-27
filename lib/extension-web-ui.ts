import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@/lib/rpc-manager";
import type { ExtensionUiContextLike } from "@/lib/pi-types";

type DialogDefault = string | boolean | undefined;

type ExtensionUiResponse = {
  id: string;
  cancelled?: boolean;
  value?: string;
  confirmed?: boolean;
};

type PendingRequest = {
  event: AgentEvent;
  resolve: (response: ExtensionUiResponse) => void;
};

type ExtensionUiEmitter = (event: AgentEvent) => void;
type ListenerState = () => boolean;

/** Theme stub that strips styling so factory widgets can be rendered to plain text. */
const passthroughTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  dim: (text: string) => text,
  inverse: (text: string) => text,
};

const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * pi-subagents TUI HUDs that overlap the top-bar SubagentPanel.
 * Drop them in WebUI so we skip factory materialization + SSE churn.
 */
const SUPPRESSED_EXTENSION_WIDGET_KEYS = new Set([
  "subagent-fleet-status",
  "subagent-async",
]);

export function isSuppressedExtensionWidgetKey(key: string): boolean {
  return SUPPRESSED_EXTENSION_WIDGET_KEYS.has(key);
}

/**
 * Convert setWidget content to plain text lines for the Web UI.
 * Supports string arrays and TUI component factories (e.g. manage_todo_list).
 */
function materializeWidgetLines(
  content: string[] | ((tui: unknown, theme: unknown) => unknown) | undefined,
): string[] | undefined {
  if (content === undefined) return undefined;
  if (Array.isArray(content)) return content.map((line) => stripAnsi(String(line)));
  if (typeof content !== "function") return undefined;

  try {
    // Factories receive (tui, theme) and return a Component with render(width)=>string[].
    const component = content({}, passthroughTheme) as { render?: (width?: number) => unknown } | null | undefined;
    if (!component || typeof component.render !== "function") return undefined;
    const rendered = component.render(120);
    if (!Array.isArray(rendered)) return undefined;
    return rendered.map((line) => stripAnsi(String(line)));
  } catch {
    return undefined;
  }
}

function parseDialogResponse(method: string, fallback: DialogDefault, response: ExtensionUiResponse): DialogDefault {
  if (response.cancelled) return fallback;
  if (method === "confirm") return response.confirmed ?? false;
  if ("value" in response) return response.value;
  return fallback;
}

export class ExtensionWebUiBridge {
  private pending = new Map<string, PendingRequest>();

  constructor(private readonly emit: ExtensionUiEmitter, private readonly hasListener: ListenerState = () => false) {}

  createContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.createDialogPromise(opts, undefined, {
        method: "select",
        title,
        options,
        timeout: opts?.timeout,
      }).then((value) => typeof value === "string" ? value : undefined),
      confirm: (title, message, opts) => this.createDialogPromise(opts, false, {
        method: "confirm",
        title,
        message,
        timeout: opts?.timeout,
      }).then((value) => value === true),
      input: (title, placeholder, opts) => this.createDialogPromise(opts, undefined, {
        method: "input",
        title,
        placeholder,
        timeout: opts?.timeout,
      }).then((value) => typeof value === "string" ? value : undefined),
      editor: (title, prefill, opts) => this.createDialogPromise(opts, undefined, {
        method: "editor",
        title,
        prefill,
        timeout: opts?.timeout,
      }).then((value) => typeof value === "string" ? value : undefined),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type ?? "info",
        });
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        });
      },
      setWorkingMessage: (message) => {
        this.emitUnsupported("setWorkingMessage", message ? `message: ${message}` : undefined);
      },
      setWorkingVisible: () => {
        this.emitUnsupported("setWorkingVisible");
      },
      setWorkingIndicator: () => {
        this.emitUnsupported("setWorkingIndicator");
      },
      setHiddenThinkingLabel: () => {
        this.emitUnsupported("setHiddenThinkingLabel");
      },
      setWidget: (key, content, options) => {
        // Top-bar SubagentPanel owns subagent observability in WebUI.
        if (isSuppressedExtensionWidgetKey(key)) return;

        if (content === undefined) {
          this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setWidget",
            widgetKey: key,
            widgetLines: undefined,
            widgetPlacement: options?.placement,
          });
          return;
        }

        const widgetLines = materializeWidgetLines(
          content as string[] | ((tui: unknown, theme: unknown) => unknown),
        );
        if (widgetLines !== undefined) {
          this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setWidget",
            widgetKey: key,
            widgetLines,
            widgetPlacement: options?.placement,
          });
          return;
        }

        this.emitUnsupported(
          "setWidget",
          "component factory could not be materialized to text lines in WebUI",
        );
      },
      setFooter: () => this.emitUnsupported("setFooter"),
      setHeader: () => this.emitUnsupported("setHeader"),
      setTitle: (title) => {
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
      },
      custom: async () => {
        this.emitUnsupported("custom", "TUI custom components are not supported in WebUI");
        return undefined as never;
      },
      pasteToEditor: (text) => {
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
      },
      setEditorText: (text) => {
        this.emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => this.emitUnsupported("addAutocompleteProvider"),
      setEditorComponent: () => this.emitUnsupported("setEditorComponent"),
      getEditorComponent: () => undefined,
      theme: passthroughTheme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in WebUI extension mode" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  respond(response: ExtensionUiResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    this.pending.delete(response.id);
    pending.resolve(response);
    return true;
  }

  getPendingEvents(): AgentEvent[] {
    return Array.from(this.pending.values()).map((request) => request.event);
  }

  rejectAll(): void {
    for (const [id, request] of this.pending) {
      request.resolve({ id, cancelled: true });
    }
    this.pending.clear();
  }

  private createDialogPromise(
    opts: { signal?: AbortSignal; timeout?: number } | undefined,
    fallback: DialogDefault,
    request: Record<string, unknown>,
  ): Promise<string | boolean | undefined> {
    if (opts?.signal?.aborted) return Promise.resolve(fallback);

    const id = randomUUID();
    const event = { ...request, type: "extension_ui_request", id };
    const method = String(request.method ?? "dialog");
    // Allow a short grace period for the browser SSE to attach after /command send.
    const timeoutMs = opts?.timeout ?? (this.hasListener() ? undefined : 120_000);

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const finish = (response: ExtensionUiResponse) => {
        cleanup();
        resolve(parseDialogResponse(method, fallback, response));
      };
      const onAbort = () => finish({ id, cancelled: true });

      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs) timeoutId = setTimeout(onAbort, timeoutMs);

      this.pending.set(id, { event, resolve: finish });
      this.emit(event);
    });
  }

  private emitUnsupported(method: string, detail?: string): void {
    this.emit({
      type: "extension_error",
      extensionPath: "<webui-extension-host>",
      event: "ui",
      error: detail ? `${method} is not supported: ${detail}` : `${method} is not supported in WebUI extension mode`,
    });
  }
}
