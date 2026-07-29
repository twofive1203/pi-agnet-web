"use client";

import { useEffect, useMemo, useState } from "react";
import { AutomationToolPicker } from "./AutomationToolPicker";

export type AutomationEditorValue = {
  name: string;
  description: string;
  cron: string;
  timezone: string;
  cwdSource: "project" | "default";
  cwd: string;
  provider: string;
  modelId: string;
  thinking: string;
  prompt: string;
  maxRuntimeMs: number;
  toolNames: string[];
  maxRunsPerDay: number;
  maxTokensPerRun: number;
  maxMonthlyCostUsd: number;
  consecutiveFailureThreshold: number;
  approvalExpiresAt: string;
};

const DEFAULT_VALUE: AutomationEditorValue = {
  name: "",
  description: "",
  cron: "0 8 * * *",
  timezone: "Asia/Shanghai",
  cwdSource: "default",
  cwd: "",
  provider: "anthropic",
  modelId: "claude-sonnet-4-20250514",
  thinking: "",
  prompt: "",
  maxRuntimeMs: 30 * 60 * 1000,
  toolNames: ["read", "grep", "find", "ls"],
  maxRunsPerDay: 48,
  maxTokensPerRun: 200_000,
  maxMonthlyCostUsd: 50,
  consecutiveFailureThreshold: 3,
  approvalExpiresAt: "",
};

export function AutomationTaskEditor(props: {
  initial?: Partial<AutomationEditorValue>;
  catalog: Array<{ name: string; description?: string; blocked?: boolean; risks?: never }>;
  models?: Array<{ provider: string; id: string; name?: string }>;
  nextPreview?: Array<{ utc: string; localWallTime: string }>;
  schedulerOnline?: boolean;
  authoritySummary?: string[];
  labels: {
    saveDraft: string;
    reviewActivate: string;
    tools: string;
    prompt: string;
    model: string;
    cron: string;
    timezone: string;
    cwd: string;
    budgets?: string;
    nextPreview?: string;
    authoritySummary?: string;
    approvalExpiry?: string;
    schedulerOnline?: string;
    name?: string;
    description?: string;
    thinking?: string;
    maxRunsPerDay?: string;
    maxTokensPerRun?: string;
    maxMonthlyCost?: string;
    consecutiveFailureThreshold?: string;
    approvalExpiresNone?: string;
    approvalExpiresAt?: string;
    schedulerOnlineRequired?: string;
    schedulerOfflineHint?: string;
    schedulerOfflineActivateHint?: string;
    budgetsLine?: string;
    cwdDefaultOption?: string;
    cwdProjectOption?: string;
    cwdProjectPlaceholder?: string;
    modelHint?: string;
    riskLocalMutation?: string;
    riskNetworkEgress?: string;
    riskCredentialUse?: string;
    riskInteractionRequired?: string;
    riskBlocked?: string;
  };
  onDirty?: (dirty: boolean) => void;
  onChangeMeta?: (value: AutomationEditorValue) => void;
  onSaveDraft: (value: AutomationEditorValue) => Promise<void>;
  onReviewActivate?: (value: AutomationEditorValue) => Promise<void>;
}) {
  const [value, setValue] = useState<AutomationEditorValue>({ ...DEFAULT_VALUE, ...props.initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof AutomationEditorValue>(key: K, v: AutomationEditorValue[K]) {
    setValue((prev) => {
      const next = { ...prev, [key]: v };
      props.onChangeMeta?.(next);
      return next;
    });
    props.onDirty?.(true);
  }

  const modelOptions = props.models ?? [];
  const selectedModelKey = `${value.provider}/${value.modelId}`;

  const L = props.labels;
  const normalizedAuthority = useMemo(() => {
    // Labels are supplied by the i18n-aware panel; never embed English machine copy here.
    const lines = [...(props.authoritySummary ?? [])];
    if (value.approvalExpiresAt) {
      if (L.approvalExpiresAt) {
        lines.push(L.approvalExpiresAt.replace("{at}", value.approvalExpiresAt));
      }
    } else if (L.approvalExpiresNone) {
      lines.push(L.approvalExpiresNone);
    }
    if (props.schedulerOnline) {
      if (L.schedulerOnlineRequired) lines.push(L.schedulerOnlineRequired);
    } else if (L.schedulerOfflineHint) {
      lines.push(L.schedulerOfflineHint);
    }
    if (L.budgetsLine) {
      lines.push(
        L.budgetsLine
          .replace("{runs}", String(value.maxRunsPerDay))
          .replace("{tokens}", String(value.maxTokensPerRun))
          .replace("{cost}", String(value.maxMonthlyCostUsd))
          .replace("{threshold}", String(value.consecutiveFailureThreshold)),
      );
    }
    return lines;
  }, [props.authoritySummary, props.schedulerOnline, value, L]);

  useEffect(() => {
    props.onChangeMeta?.(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="automation-task-editor">
      <label>
        {L.name ?? props.labels.name ?? ""}
        <input value={value.name} onChange={(e) => update("name", e.target.value)} />
      </label>
      <label>
        {L.description ?? props.labels.description ?? ""}
        <input value={value.description} onChange={(e) => update("description", e.target.value)} />
      </label>
      <label>
        {props.labels.cron}
        <input value={value.cron} onChange={(e) => update("cron", e.target.value)} />
      </label>
      <label>
        {props.labels.timezone}
        <input value={value.timezone} onChange={(e) => update("timezone", e.target.value)} />
      </label>

      {props.nextPreview && props.nextPreview.length > 0 ? (
        <div className="automation-next-preview" aria-live="polite">
          <h4>{props.labels.nextPreview ?? ""}</h4>
          <ul>
            {props.nextPreview.map((p) => (
              <li key={p.utc}>
                <span>{p.localWallTime}</span>
                <span className="muted"> ({p.utc})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label>
        {props.labels.cwd}
        <select
          value={value.cwdSource}
          onChange={(e) => update("cwdSource", e.target.value as "project" | "default")}
        >
          <option value="default">{L.cwdDefaultOption ?? "default"}</option>
          <option value="project">{L.cwdProjectOption ?? "project"}</option>
        </select>
        {value.cwdSource === "project" ? (
          <input
            value={value.cwd}
            onChange={(e) => update("cwd", e.target.value)}
            placeholder={L.cwdProjectPlaceholder ?? ""}
          />
        ) : null}
      </label>

      <label>
        {props.labels.model}
        {modelOptions.length > 0 ? (
          <select
            value={selectedModelKey}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split("/");
              update("provider", provider || "");
              update("modelId", rest.join("/") || "");
            }}
          >
            {!modelOptions.some((m) => `${m.provider}/${m.id}` === selectedModelKey) ? (
              <option value={selectedModelKey}>{selectedModelKey}</option>
            ) : null}
            {modelOptions.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.provider}/{m.id}
                {m.name ? ` — ${m.name}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={selectedModelKey}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split("/");
              update("provider", provider || "");
              update("modelId", rest.join("/") || "");
            }}
            aria-describedby="automation-model-hint"
          />
        )}
        <span id="automation-model-hint" className="muted">
          {L.modelHint ?? props.labels.model}
        </span>
      </label>

      <label>
        {L.thinking ?? ""}
        <input value={value.thinking} onChange={(e) => update("thinking", e.target.value)} />
      </label>
      <label>
        {props.labels.prompt}
        <textarea value={value.prompt} onChange={(e) => update("prompt", e.target.value)} rows={8} />
      </label>

      <fieldset className="automation-budgets-editor">
        <legend>{L.budgets ?? ""}</legend>
        <label>
          {L.maxRunsPerDay ?? ""}
          <input
            type="number"
            min={1}
            value={value.maxRunsPerDay}
            onChange={(e) => update("maxRunsPerDay", Number(e.target.value) || 1)}
          />
        </label>
        <label>
          {L.maxTokensPerRun ?? ""}
          <input
            type="number"
            min={0}
            value={value.maxTokensPerRun}
            onChange={(e) => update("maxTokensPerRun", Number(e.target.value) || 0)}
          />
        </label>
        <label>
          {L.maxMonthlyCost ?? ""}
          <input
            type="number"
            min={0}
            step="0.01"
            value={value.maxMonthlyCostUsd}
            onChange={(e) => update("maxMonthlyCostUsd", Number(e.target.value) || 0)}
          />
        </label>
        <label>
          {L.consecutiveFailureThreshold ?? ""}
          <input
            type="number"
            min={1}
            value={value.consecutiveFailureThreshold}
            onChange={(e) => update("consecutiveFailureThreshold", Number(e.target.value) || 1)}
          />
        </label>
        <label>
          {L.approvalExpiry ?? ""}
          <input
            type="text"
            value={value.approvalExpiresAt}
            onChange={(e) => update("approvalExpiresAt", e.target.value)}
          />
        </label>
      </fieldset>

      <details className="automation-authority-summary" open>
        <summary>{props.labels.authoritySummary ?? ""}</summary>
        <pre>{normalizedAuthority.join("\n")}</pre>
        <p className="muted" role="status">
          {props.schedulerOnline
            ? L.schedulerOnline ?? ""
            : L.schedulerOfflineActivateHint ?? ""}
        </p>
      </details>

      <AutomationToolPicker
        label={props.labels.tools}
        tools={props.catalog as never}
        selected={value.toolNames}
        onChange={(names) => update("toolNames", names)}
        riskLabels={{
          localMutation: L.riskLocalMutation ?? "",
          networkEgress: L.riskNetworkEgress ?? "",
          credentialUse: L.riskCredentialUse ?? "",
          interactionRequired: L.riskInteractionRequired ?? "",
          blocked: L.riskBlocked ?? "",
        }}
      />
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="automation-editor-actions">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await props.onSaveDraft(value);
              props.onDirty?.(false);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {props.labels.saveDraft}
        </button>
        {props.onReviewActivate ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await props.onReviewActivate?.(value);
                props.onDirty?.(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {props.labels.reviewActivate}
          </button>
        ) : null}
      </div>
    </div>
  );
}
