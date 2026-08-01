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
    <div className="extension-widget-stack" aria-label="Extension widgets">
      {visibleItems.map((item) => (
        <div className="extension-widget-card" key={item.key}>
          <div className="extension-widget-key">
            {item.key}
          </div>
          <pre className="extension-widget-content">
            {item.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}
