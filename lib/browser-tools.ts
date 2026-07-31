/**
 * Pi browser tools — session id is injected from ctx.sessionManager, never from model args.
 */

import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getBrowserBindingManager,
  formatToolErrorResult,
  PART1_BROWSER_EXTENSION_FEATURES,
} from "./browser-binding-manager";
import { clampTimeoutMs, type BrowserCommandName } from "./browser-protocol";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    details: typeof data === "object" && data !== null ? data as Record<string, unknown> : { value: data },
  };
}

function sessionIdFromCtx(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  const id = ctx.sessionManager?.getSessionId?.();
  if (!id || typeof id !== "string") {
    throw new Error("Browser tools require an active Pi session id");
  }
  return id;
}

function asRecord(params: unknown): Record<string, unknown> {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

async function run(
  command: BrowserCommandName,
  ctx: { sessionManager?: { getSessionId?: () => string } },
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options?: {
    requiredCapability?: "dom" | "debug_readonly";
    requiredExtensionFeatures?: Array<"element_diagnostics_v1" | "post_action_state_v1">;
    bindingId?: string;
    timeoutMs?: number;
  },
) {
  const manager = getBrowserBindingManager();
  const sessionId = sessionIdFromCtx(ctx);
  const result = await manager.runToolCommand({
    sessionId,
    command,
    bindingId: options?.bindingId ?? (typeof params.bindingId === "string" ? params.bindingId : undefined),
    params,
    signal,
    timeoutMs: options?.timeoutMs,
    requiredCapability: options?.requiredCapability,
    requiredExtensionFeatures: options?.requiredExtensionFeatures,
  });
  return textResult(result);
}

const bindingIdParam = Type.Optional(Type.String({ description: "Opaque binding id from browser_tabs; defaults to primary tab" }));

export function createBrowserToolDefinitions(): ToolDefinition[] {
  const browserTabs: ToolDefinition = {
    name: "browser_tabs",
    label: "Browser Tabs",
    description:
      "List browser tabs bound to the current Snail Pi session, or set the primary tab. Never returns raw Chrome tab ids.",
    parameters: Type.Object({
      action: StringEnum(["list", "set_primary"] as const, { description: "list bindings or set_primary" }),
      bindingId: Type.Optional(Type.String({ description: "Required for set_primary" })),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      try {
        const params = asRecord(rawParams);
        if (params.action === "set_primary") {
          return await run("binding.set_primary", ctx, { bindingId: params.bindingId }, signal, {
            bindingId: typeof params.bindingId === "string" ? params.bindingId : undefined,
          });
        }
        return await run("binding.list", ctx, {}, signal);
      } catch (error) {
        return formatToolErrorResult(error);
      }
    },
  };

  const browserSnapshot: ToolDefinition = {
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Read a bounded accessibility/DOM/visible-text snapshot of the bound page.",
    parameters: Type.Object({
      bindingId: bindingIdParam,
      format: Type.Optional(StringEnum(["accessibility", "dom", "visible_text"] as const)),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      try {
        return await run("page.snapshot", ctx, asRecord(rawParams), signal, { requiredCapability: "dom" });
      } catch (error) {
        return formatToolErrorResult(error);
      }
    },
  };

  const browserFind: ToolDefinition = {
    name: "browser_find",
    label: "Browser Find",
    description: "Find elements by role/name/text/bounded CSS and return short-lived elementRef values.",
    parameters: Type.Object({
      bindingId: bindingIdParam,
      role: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      css: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      try {
        return await run("page.find", ctx, asRecord(rawParams), signal, { requiredCapability: "dom" });
      } catch (error) {
        return formatToolErrorResult(error);
      }
    },
  };

  const browserAct: ToolDefinition = {
    name: "browser_act",
    label: "Browser Act",
    description:
      "Perform one controlled DOM action: highlight, scroll_into_view, click, type, select, or reload. Sensitive fields and destructive actions are blocked.",
    parameters: Type.Object({
      bindingId: bindingIdParam,
      action: StringEnum(["highlight", "scroll_into_view", "click", "type", "select", "reload"] as const),
      elementRef: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      clearFirst: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      try {
        return await run("page.act", ctx, asRecord(rawParams), signal, {
          requiredCapability: "dom",
          requiredExtensionFeatures: PART1_BROWSER_EXTENSION_FEATURES,
        });
      } catch (error) {
        return formatToolErrorResult(error);
      }
    },
  };

  const browserWait: ToolDefinition = {
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for a bounded page condition (element/text/url/dom_idle) with timeout.",
    parameters: Type.Object({
      bindingId: bindingIdParam,
      condition: StringEnum(["element", "text", "url", "dom_idle"] as const),
      value: Type.String(),
      state: Type.Optional(StringEnum(["present", "absent", "visible", "hidden"] as const)),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000 })),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      try {
        const params = asRecord(rawParams);
        const timeoutMs = clampTimeoutMs(params.timeoutMs);
        return await run("page.wait", ctx, params, signal, {
          requiredCapability: "dom",
          timeoutMs,
        });
      } catch (error) {
        return formatToolErrorResult(error);
      }
    },
  };

  const browserScreenshot: ToolDefinition = {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Capture the current viewport of a bound tab (size-limited).",
    parameters: Type.Object({
      bindingId: bindingIdParam,
      format: Type.Optional(StringEnum(["png", "jpeg"] as const)),
      quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      try {
        const params = asRecord(rawParams);
        const result = await getBrowserBindingManager().runToolCommand({
          sessionId: sessionIdFromCtx(ctx),
          command: "page.screenshot",
          bindingId: typeof params.bindingId === "string" ? params.bindingId : undefined,
          params,
          signal,
          requiredCapability: "dom",
        }) as {
          mimeType?: string;
          base64?: string;
          width?: number;
          height?: number;
          url?: string;
          origin?: string;
          [key: string]: unknown;
        };

        if (result?.base64 && result?.mimeType) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  width: result.width,
                  height: result.height,
                  url: result.url,
                  origin: result.origin,
                  mimeType: result.mimeType,
                }, null, 2),
              },
              {
                type: "image" as const,
                data: result.base64,
                mimeType: result.mimeType,
              },
            ],
            details: {
              width: result.width,
              height: result.height,
              url: result.url,
              origin: result.origin,
            },
          };
        }
        return textResult(result);
      } catch (error) {
        return formatToolErrorResult(error);
      }
    },
  };

  const browserConsole: ToolDefinition = {
    name: "browser_console",
    label: "Browser Console",
    description: "Read bounded console/exception summaries. Requires user-enabled debug mode on the binding.",
    parameters: Type.Object({
      bindingId: bindingIdParam,
      levels: Type.Optional(Type.Array(StringEnum(["log", "info", "warning", "error"] as const))),
      since: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      try {
        return await run("page.console", ctx, asRecord(rawParams), signal, {
          requiredCapability: "debug_readonly",
        });
      } catch (error) {
        return formatToolErrorResult(error);
      }
    },
  };

  const browserNetwork: ToolDefinition = {
    name: "browser_network",
    label: "Browser Network",
    description:
      "Read redacted network URL/method/status/type/timing summaries. Requires debug mode. Never returns bodies or auth headers.",
    parameters: Type.Object({
      bindingId: bindingIdParam,
      since: Type.Optional(Type.Integer({ minimum: 0 })),
      status: Type.Optional(StringEnum(["all", "failed", "4xx", "5xx"] as const)),
      resourceTypes: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      try {
        return await run("page.network", ctx, asRecord(rawParams), signal, {
          requiredCapability: "debug_readonly",
        });
      } catch (error) {
        return formatToolErrorResult(error);
      }
    },
  };

  return [
    browserTabs,
    browserSnapshot,
    browserFind,
    browserAct,
    browserWait,
    browserScreenshot,
    browserConsole,
    browserNetwork,
  ];
}

/** Inline extension factory registered once per AgentSession. */
export function createBrowserToolsExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createBrowserToolDefinitions()) {
      pi.registerTool(tool);
    }
  };
}
