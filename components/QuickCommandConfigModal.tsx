"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import {
  SettingsButton,
  SettingsField,
  SettingsInput,
  SettingsTextarea,
} from "@/components/ui/SettingsPrimitives";
import type { QuickCommandsApi } from "@/hooks/useQuickCommands";

interface Props {
  api: QuickCommandsApi;
}

export function QuickCommandConfigModal({ api }: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const {
    configOpen,
    setConfigOpen,
    configLoading,
    configSaving,
    configError,
    configPath,
    editorRows,
    addEditorRow,
    updateEditorRow,
    removeEditorRow,
    saveConfig,
  } = api;

  useEffect(() => {
    if (!configOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialogRef.current;
    window.setTimeout(() => {
      node?.querySelector<HTMLElement>("button, [href], input, select, textarea")?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfigOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [configOpen, setConfigOpen]);

  if (!configOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="quick-command-config-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="quick-command-config-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="quick-command-config-header">
          <div>
            <h2 id={titleId}>{t("panels.quickCommands.configTitle")}</h2>
            <p className="quick-command-config-subtitle">{t("panels.quickCommands.configSubtitle")}</p>
            {configPath && <p className="quick-command-config-path" title={configPath}>{configPath}</p>}
          </div>
          <SettingsButton type="button" variant="ghost" onClick={() => setConfigOpen(false)} aria-label={t("common.close")}>
            ×
          </SettingsButton>
        </div>

        <div className="quick-command-config-body">
          {configLoading ? (
            <div className="quick-command-config-state">{t("panels.quickCommands.loading")}</div>
          ) : (
            <>
              {editorRows.length === 0 && (
                <div className="quick-command-config-empty">{t("panels.quickCommands.configEmpty")}</div>
              )}
              {editorRows.map((row, index) => (
                <div key={`${row.id || "new"}-${index}`} className="quick-command-config-card">
                  <div className="quick-command-config-card-header">
                    <strong>{t("panels.quickCommands.commandN", { n: index + 1 })}</strong>
                    <SettingsButton type="button" variant="ghost" onClick={() => removeEditorRow(index)}>
                      {t("panels.quickCommands.remove")}
                    </SettingsButton>
                  </div>
                  <div className="quick-command-config-grid">
                    <SettingsField label={t("panels.quickCommands.fieldName")}>
                      <SettingsInput
                        value={row.name}
                        onChange={(event) => updateEditorRow(index, { name: event.target.value })}
                        maxLength={80}
                        required
                      />
                    </SettingsField>
                    <SettingsField label={t("panels.quickCommands.fieldCommand")}>
                      <SettingsInput
                        value={row.command}
                        onChange={(event) => updateEditorRow(index, { command: event.target.value })}
                        maxLength={4000}
                        required
                        className="is-mono"
                      />
                    </SettingsField>
                    <SettingsField label={t("panels.quickCommands.fieldDescription")}>
                      <SettingsInput
                        value={row.description}
                        onChange={(event) => updateEditorRow(index, { description: event.target.value })}
                        maxLength={400}
                      />
                    </SettingsField>
                    <SettingsField
                      label={t("panels.quickCommands.fieldCwd")}
                      description={t("panels.quickCommands.fieldCwdHint")}
                    >
                      <SettingsInput
                        value={row.cwd}
                        onChange={(event) => updateEditorRow(index, { cwd: event.target.value })}
                        maxLength={500}
                        placeholder="."
                        className="is-mono"
                      />
                    </SettingsField>
                    <SettingsField
                      label={t("panels.quickCommands.fieldEnv")}
                      description={t("panels.quickCommands.fieldEnvHint")}
                    >
                      <SettingsTextarea
                        value={row.envText}
                        onChange={(event) => updateEditorRow(index, { envText: event.target.value })}
                        rows={3}
                        className="is-mono"
                      />
                    </SettingsField>
                  </div>
                  <div className="quick-command-config-toggles">
                    <label>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(event) => updateEditorRow(index, { enabled: event.target.checked })}
                      />
                      {t("panels.quickCommands.fieldEnabled")}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={row.autoExpandOutput}
                        onChange={(event) => updateEditorRow(index, { autoExpandOutput: event.target.checked })}
                      />
                      {t("panels.quickCommands.fieldAutoExpand")}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={row.confirmBeforeRun}
                        onChange={(event) => updateEditorRow(index, { confirmBeforeRun: event.target.checked })}
                      />
                      {t("panels.quickCommands.fieldConfirmEvery")}
                    </label>
                  </div>
                </div>
              ))}
            </>
          )}
          {configError && <div className="quick-command-config-error" role="alert">{configError}</div>}
        </div>

        <div className="quick-command-config-footer">
          <SettingsButton type="button" variant="secondary" onClick={addEditorRow} disabled={configLoading || configSaving}>
            {t("panels.quickCommands.addCommand")}
          </SettingsButton>
          <div className="quick-command-config-footer-actions">
            <SettingsButton type="button" variant="ghost" onClick={() => setConfigOpen(false)} disabled={configSaving}>
              {t("common.cancel")}
            </SettingsButton>
            <SettingsButton
              type="button"
              variant="primary"
              disabled={configLoading || configSaving}
              onClick={() => {
                void saveConfig().then((ok) => {
                  if (ok) setConfigOpen(false);
                });
              }}
            >
              {configSaving ? t("panels.quickCommands.saving") : t("common.save")}
            </SettingsButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
