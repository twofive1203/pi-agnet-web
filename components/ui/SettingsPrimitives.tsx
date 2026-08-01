"use client";

import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function SettingsSection({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes("settings-section", className)} {...props} />;
}

export function SettingsSectionHeader({
  title,
  description,
  meta,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="settings-section-header">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{title}</h3>
        {description && <div className="settings-section-description">{description}</div>}
        {meta && <div className="settings-section-meta">{meta}</div>}
      </div>
      {action && <div className="settings-section-header-action">{action}</div>}
    </div>
  );
}

export function SettingsField({
  label,
  description,
  error,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={classes("settings-field", Boolean(error) && "settings-field-error", className)} htmlFor={htmlFor}>
      <span className="settings-field-label">{label}</span>
      {children}
      {description && <span className="settings-field-description">{description}</span>}
      {error && <span className="settings-field-error-text" role="alert">{error}</span>}
    </label>
  );
}

export const SettingsInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function SettingsInput(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={classes("settings-control", className)} {...props} />;
});

export const SettingsSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function SettingsSelect(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={classes("settings-control settings-select", className)} {...props} />;
});

export const SettingsTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function SettingsTextarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={classes("settings-control settings-textarea", className)} {...props} />;
});

export function SettingsTextInput({
  value,
  onChange,
  mono = true,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
}) {
  return (
    <SettingsInput
      {...props}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={props.spellCheck ?? false}
      className={classes(mono && "settings-control-mono", className)}
    />
  );
}

export function SettingsToggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={classes("settings-toggle", checked && "settings-toggle-checked", className)}
    >
      <span className="settings-toggle-copy">
        <span className="settings-toggle-label">{label}</span>
        {description && <span id={descriptionId} className="settings-toggle-description">{description}</span>}
      </span>
      <span className="settings-toggle-track" aria-hidden="true">
        <span className="settings-toggle-thumb" />
      </span>
    </button>
  );
}

type SettingsButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type SettingsButtonSize = "sm" | "md" | "icon";
type SettingsTone = "neutral" | "accent" | "success" | "warning" | "danger";

export function SettingsButton({
  variant = "secondary",
  size = "md",
  busy = false,
  className,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: SettingsButtonVariant;
  size?: SettingsButtonSize;
  busy?: boolean;
}) {
  return (
    <button
      type={props.type ?? "button"}
      className={classes("settings-button", `settings-button-${variant}`, `settings-button-${size}`, className)}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...props}
    >
      {children}
    </button>
  );
}

export function SettingsBadge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: SettingsTone;
  children: ReactNode;
  className?: string;
}) {
  return <span className={classes("settings-badge", `settings-badge-${tone}`, className)}>{children}</span>;
}

export function SettingsActionRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes("settings-action-row", className)} {...props} />;
}

export function SettingsNotice({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={classes("settings-notice", `settings-notice-${tone}`, className)}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function SettingsState({
  kind = "empty",
  title,
  description,
  action,
  className,
}: {
  kind?: "loading" | "empty" | "error";
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={classes("settings-state", `settings-state-${kind}`, className)}
      role={kind === "error" ? "alert" : kind === "loading" ? "status" : undefined}
      aria-live={kind === "loading" ? "polite" : undefined}
    >
      <div className="settings-state-title">{title}</div>
      {description && <div className="settings-state-description">{description}</div>}
      {action && <div className="settings-state-action">{action}</div>}
    </div>
  );
}
