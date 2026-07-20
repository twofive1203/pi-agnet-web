"use client";

import type { ExtensionWidgetItem } from "@/lib/types";
import { isTodoWidget } from "./ExtensionTodoPanel";

interface Props {
  items: ExtensionWidgetItem[];
}

/**
 * Multi-line text cards for Pi extension `setWidget` content at a composer placement.
 * The standard todo widget is rendered by the floating task panel instead.
 */
export function ExtensionWidgetStack({ items }: Props) {
  const visibleItems = items.filter((item) => !isTodoWidget(item));
  if (visibleItems.length === 0) return null;

  return (
    <div
      aria-label="Extension widgets"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "6px 12px 0",
      }}
    >
      {visibleItems.map((item) => (
        <div
          key={item.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "4px 10px",
              borderBottom: "1px solid var(--border)",
              color: "var(--text-dim)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              letterSpacing: 0.2,
            }}
          >
            {item.key}
          </div>
          <pre
            style={{
              margin: 0,
              padding: "8px 10px",
              maxHeight: 180,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--text)",
              fontSize: 12,
              lineHeight: 1.45,
              fontFamily: "var(--font-mono)",
              background: "transparent",
            }}
          >
            {item.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}
