"use client";

import { useI18n } from "@/components/I18nProvider";
import { useEffect, useState } from "react";
import {
  SettingsActionRow,
  SettingsButton,
  SettingsField,
  SettingsInput,
  SettingsSelect,
  SettingsSurface,
} from "@/components/ui/SettingsPrimitives";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <SettingsField label={label}>{children}</SettingsField>;
}

type HeaderRow = { id: string; key: string; value: string };

let headerRowSeq = 0;
function nextHeaderRowId(): string {
  headerRowSeq += 1;
  return `hdr-${headerRowSeq}`;
}

function headersToRows(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({
    id: nextHeaderRowId(),
    key,
    value,
  }));
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    record[key] = row.value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

export function HeadersEditor({
  headers,
  onChange,
  hint,
}: {
  headers?: Record<string, string>;
  onChange: (headers: Record<string, string> | undefined) => void;
  hint?: string;
}) {
  const { t } = useI18n();
  const headersFingerprint = JSON.stringify(headers ?? {});
  const [rows, setRows] = useState<HeaderRow[]>(() => headersToRows(headers));

  useEffect(() => {
    setRows(headersToRows(headers));
    // Re-sync when parent injects defaults or config reloads; fingerprint avoids loop on same content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headersFingerprint]);

  const commit = (nextRows: HeaderRow[]) => {
    setRows(nextRows);
    onChange(rowsToHeaders(nextRows));
  };

  const updateRow = (id: string, patch: Partial<Pick<HeaderRow, "key" | "value">>) => {
    commit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: string) => {
    commit(rows.filter((row) => row.id !== id));
  };

  const addRow = () => {
    commit([...rows, { id: nextHeaderRowId(), key: "", value: "" }]);
  };

  return (
    <SettingsSurface className="models-headers-editor">
      <SettingsActionRow>
        <SectionTitle>{t("settings.models.customHeaders")}</SectionTitle>
        <SettingsButton size="sm" onClick={addRow}>{t("settings.models.addHeader")}</SettingsButton>
      </SettingsActionRow>
      {hint && <div className="settings-surface-muted">{hint}</div>}
      {rows.length === 0 ? (
        <div className="settings-surface-muted">{t("settings.models.noCustomHeaders")}</div>
      ) : (
        <div className="models-header-list">
          {rows.map((row) => (
            <div key={row.id} className="models-header-row">
              <TextInput value={row.key} onChange={(value) => updateRow(row.id, { key: value })} placeholder={t("settings.models.headerName")} mono />
              <TextInput value={row.value} onChange={(value) => updateRow(row.id, { value })} placeholder={t("settings.models.headerValuePlaceholder")} mono />
              <SettingsButton variant="ghost" size="icon" onClick={() => removeRow(row.id)} aria-label={`Remove header ${row.key || "row"}`} title={t("settings.models.removeHeader")} className="models-danger-text">−</SettingsButton>
            </div>
          ))}
        </div>
      )}
      <div className="settings-surface-muted">{t("settings.models.headerValuesHint")}</div>
    </SettingsSurface>
  );
}

export function TextInput({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <SettingsInput value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={mono ? "settings-control-mono" : undefined} />;
}

export function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div className="models-secret-control" style={style}>
      <SettingsInput
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={mono ? "settings-control-mono" : undefined}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? t("settings.models.hideApiKey") : t("settings.models.showApiKey")} title={visible ? t("settings.models.hideApiKey") : t("settings.models.showApiKey")} className="models-secret-toggle">
        {visible ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

export function NumInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <SettingsInput type="number" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />;
}

export function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  return (
    <SettingsSelect value={value} onChange={(event) => onChange(event.target.value)}>
      {!required && <option value="">— inherit / none —</option>}
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </SettingsSelect>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="models-checkbox"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="models-section-label">{children}</div>;
}
