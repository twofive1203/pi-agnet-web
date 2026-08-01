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
    <div className="extension-status-bar" aria-label="Extension status">
      {items.map((item) => (
        <div className="extension-status-chip" key={item.key} title={item.key}>
          <span className="extension-status-key">
            {item.key}
          </span>
          <span className="extension-status-text">
            {item.text}
          </span>
        </div>
      ))}
    </div>
  );
}
