"use client";

import { riskDimensions } from "@/lib/automation-ui-state";

type Tool = {
  name: string;
  description?: string;
  origin?: string;
  blocked?: boolean;
  risks?: {
    headlessCompatible?: boolean;
    localMutation?: boolean;
    networkEgress?: boolean;
    credentialUse?: boolean;
    interactionRequired?: boolean;
    blocked?: boolean;
  };
};

export function AutomationToolPicker(props: {
  tools: Tool[];
  selected: string[];
  onChange: (names: string[]) => void;
  label: string;
  riskLabels?: Record<string, string>;
}) {
  const riskLabel = (d: string) => props.riskLabels?.[d] ?? d;
  return (
    <fieldset className="automation-tool-picker">
      <legend>{props.label}</legend>
      <ul className="automation-tool-list">
        {props.tools.map((tool) => {
          const blocked = tool.blocked || tool.risks?.blocked || tool.risks?.interactionRequired;
          const dims = riskDimensions(tool);
          const checked = props.selected.includes(tool.name);
          return (
            <li key={tool.name}>
              <label className={blocked ? "is-blocked" : undefined}>
                <input
                  type="checkbox"
                  disabled={Boolean(blocked)}
                  checked={checked}
                  onChange={(e) => {
                    if (e.target.checked) props.onChange([...props.selected, tool.name]);
                    else props.onChange(props.selected.filter((n) => n !== tool.name));
                  }}
                />
                <span>
                  <strong>{tool.name}</strong>
                  {tool.description ? <span className="muted"> — {tool.description}</span> : null}
                  {dims.length ? (
                    <span className="automation-risk-badges">
                      {dims.map((d) => (
                        <span key={d} className={`risk-badge risk-${d}`} title={riskLabel(d)}>
                          {riskLabel(d)}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
