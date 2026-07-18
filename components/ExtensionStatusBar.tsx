"use client";

import type { ExtensionStatusItem } from "@/lib/types";

interface Props {
  items: ExtensionStatusItem[];
}

/**
 * Compact chip row for Pi extension `setStatus` updates near the chat composer.
 */
export function ExtensionStatusBar({ items }: Props) {
  if (items.length === 0) return null;

  return (
    <div
      aria-label="Extension status"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: "6px 12px 0",
      }}
    >
      {items.map((item) => (
        <div
          key={item.key}
          title={item.key}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "100%",
            padding: "3px 8px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          <span
            style={{
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              flexShrink: 0,
            }}
          >
            {item.key}
          </span>
          <span
            style={{
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {item.text}
          </span>
        </div>
      ))}
    </div>
  );
}
