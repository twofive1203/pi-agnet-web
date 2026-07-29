"use client";

export function AutomationInboxBadge(props: {
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="automation-inbox-badge"
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
    >
      <span aria-hidden>⏱</span>
      {props.count > 0 ? (
        <span className="automation-inbox-count" aria-live="polite">
          {props.count > 99 ? "99+" : props.count}
        </span>
      ) : null}
    </button>
  );
}
