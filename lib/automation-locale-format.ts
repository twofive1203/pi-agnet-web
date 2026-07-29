/**
 * Pure locale formatters for Automation UI confirmations and diagnostics.
 * Kept free of React so smoke tests and hooks can share the same paths.
 */

export type AutomationTranslate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Convert snake_case / kebab-case machine status to PascalCase key segment. */
export function toPascalStatusKey(status: string): string {
  return status
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

/**
 * Split compound runtime values such as `dispose_unconfirmed:abort` into a
 * declared reason plus technical detail. Declared reasons stay in the union;
 * the detail is never shown as the primary enum label.
 */
export function splitUnavailableReason(value: string | null | undefined): {
  reason: string | null;
  detail: string | null;
} {
  if (!value) return { reason: null, detail: null };
  const idx = value.indexOf(":");
  if (idx <= 0) return { reason: value, detail: null };
  return {
    reason: value.slice(0, idx),
    detail: value.slice(idx + 1) || null,
  };
}

export function formatStatusLabel(status: string, t: AutomationTranslate): string {
  if (!status) return t("automation.fallbackNone");
  const key = `automation.status${toPascalStatusKey(status)}`;
  const localized = t(key);
  if (localized === key) {
    return t("automation.fallbackUnknownWithContext", {
      context: t("automation.technicalCode"),
    });
  }
  return localized;
}

export function formatTriggerLabel(
  trigger: string | undefined,
  t: AutomationTranslate,
): string {
  if (!trigger) return t("automation.fallbackNone");
  const normalized = trigger === "runNow" ? "run_now" : trigger;
  const key = `automation.trigger_${normalized}`;
  const localized = t(key);
  if (localized !== key) return localized;
  const legacyMap: Record<string, string> = {
    manual: "automation.triggerManual",
    scheduled: "automation.triggerScheduled",
    run_now: "automation.triggerRunNow",
  };
  const legacy = legacyMap[normalized];
  if (legacy) {
    const leg = t(legacy);
    if (leg !== legacy) return leg;
  }
  return t("automation.fallbackUnknownWithContext", {
    context: t("automation.technicalCode"),
  });
}

export function formatEnumLabel(
  prefix: string,
  value: string | null | undefined,
  t: AutomationTranslate,
): string {
  if (!value) return t("automation.fallbackNone");
  // Normalize legacy compound dispose_unconfirmed:<detail> values.
  let reason = value;
  let detail: string | null = null;
  if (prefix === "unavailableReason") {
    const split = splitUnavailableReason(value);
    reason = split.reason ?? value;
    detail = split.detail;
  }
  const key = `automation.${prefix}_${reason}`;
  const localized = t(key);
  if (localized === key) {
    return t("automation.fallbackUnknownWithContext", {
      context: t("automation.technicalCode"),
    });
  }
  if (detail) {
    return t("automation.unavailableReasonWithDetail", {
      reason: localized,
      detail: t("automation.technicalDetailValue", { detail }),
    });
  }
  return localized;
}

export function formatUnavailableReasonLabel(
  reason: string | null | undefined,
  detail: string | null | undefined,
  t: AutomationTranslate,
): string {
  const split = splitUnavailableReason(reason);
  const primary = formatEnumLabel("unavailableReason", split.reason, t);
  const tech = detail || split.detail;
  if (!tech) return primary;
  // Avoid double-wrapping when formatEnumLabel already appended compound detail.
  if (split.detail && !detail) return primary;
  return t("automation.unavailableReasonWithDetail", {
    reason: primary,
    detail: t("automation.technicalDetailValue", { detail: tech }),
  });
}

export function formatCwdSourceLabel(
  source: string | undefined,
  t: AutomationTranslate,
): string {
  if (!source) return t("automation.fallbackNone");
  const key = `automation.cwdSource_${source}`;
  const localized = t(key);
  if (localized === key) {
    return t("automation.fallbackUnknownWithContext", {
      context: t("automation.technicalCode"),
    });
  }
  return localized;
}

export function formatOmissionKindLabel(kind: string, t: AutomationTranslate): string {
  if (!kind) return t("automation.fallbackNone");
  const key = `automation.omissionKind_${kind}`;
  const localized = t(key);
  if (localized === key) {
    return t("automation.fallbackUnknownWithContext", {
      context: t("automation.technicalCode"),
    });
  }
  return localized;
}

export function formatActionLabel(action: string | undefined, t: AutomationTranslate): string {
  if (!action) return t("automation.fallbackNone");
  const key = `automation.action_${action}`;
  const localized = t(key);
  if (localized === key) {
    return t("automation.fallbackUnknownWithContext", {
      context: t("automation.technicalCode"),
    });
  }
  return localized;
}

function formatOrigin(origin: string, t: AutomationTranslate): string {
  if (origin === "builtin") return t("automation.originBuiltinShort");
  if (origin === "extension") return t("automation.originExtensionShort");
  if (origin === "custom") return t("automation.originCustomShort");
  return origin;
}

function formatRiskToken(risk: string, t: AutomationTranslate): string {
  const map: Record<string, string> = {
    network: "automation.authRiskNetwork",
    filesystem: "automation.authRiskFilesystem",
    credentials: "automation.authRiskCredentials",
    interactive: "automation.authRiskInteractive",
  };
  const key = map[risk];
  return key ? t(key) : risk;
}

/**
 * Format structured authority/approval summary through the active locale.
 * Never interpolates raw action/status/cwd-source enums into the visible text.
 */
export function formatAuthoritySummaryLines(
  structured: Record<string, unknown> | undefined,
  fallback: string[] | undefined,
  t: AutomationTranslate,
): string[] {
  if (!structured || typeof structured !== "object") return fallback ?? [];
  const auth = (structured.authority ?? {}) as {
    policyHash?: string;
    approvalExpiresAt?: string | null;
    budgets?: { maxRunsPerDay?: number; maxTokensPerRun?: number; maxMonthlyCostUsd?: number };
    tools?: Array<{ name: string; origin: string; risks?: string[]; digestShort?: string }>;
    extensionCount?: number;
  };
  const lines: string[] = [];
  if (typeof structured.action === "string" && structured.action) {
    lines.push(
      t("automation.authAction", {
        action: formatActionLabel(structured.action, t),
      }),
    );
  }
  if (structured.proposedConfigHash) {
    lines.push(
      t("automation.authProposedConfigHash", {
        hash: String(structured.proposedConfigHash).slice(0, 16),
      }),
    );
  }
  if (structured.runId) {
    lines.push(t("automation.authRunId", { id: String(structured.runId) }));
  }
  if (typeof structured.runStatus === "string" && structured.runStatus) {
    lines.push(
      t("automation.authRunStatus", {
        status: formatStatusLabel(structured.runStatus, t),
      }),
    );
  }
  if (structured.name != null || structured.cron != null || structured.cwd != null) {
    lines.push(
      t("automation.authName", { name: String(structured.name ?? "") }),
      t("automation.authSchedule", {
        cron: String(structured.cron ?? ""),
        timezone: String(structured.timezone ?? ""),
      }),
      t("automation.authCwd", {
        source: formatCwdSourceLabel(
          typeof structured.cwdSource === "string" ? structured.cwdSource : undefined,
          t,
        ),
        cwd: String(structured.cwd ?? ""),
      }),
      t("automation.authModel", {
        provider: String(structured.provider ?? ""),
        model: String(structured.modelId ?? ""),
      }),
      t("automation.authThinking", {
        thinking: structured.thinking
          ? String(structured.thinking)
          : t("automation.thinkingDefault"),
      }),
      t("automation.authMaxRuntime", { min: String(structured.maxRuntimeMin ?? "") }),
      t("automation.authPromptHash", { hash: String(structured.promptHash ?? "") }),
      t("automation.authPolicyHash", {
        hash: String(auth.policyHash ?? structured.policyHash ?? "").slice(0, 16),
      }),
      t("automation.authApprovalExpires", {
        at: auth.approvalExpiresAt ?? t("automation.fallbackNone"),
      }),
      t("automation.authBudgets", {
        runs: String(auth.budgets?.maxRunsPerDay ?? ""),
        tokens: String(auth.budgets?.maxTokensPerRun ?? ""),
        cost: String(auth.budgets?.maxMonthlyCostUsd ?? ""),
      }),
      t("automation.authToolsHeader", { count: String(auth.tools?.length ?? 0) }),
    );
    if (auth.tools?.length) {
      for (const tool of auth.tools) {
        const riskText = tool.risks?.length
          ? `; ${tool.risks.map((r) => formatRiskToken(r, t)).join(", ")}`
          : "";
        lines.push(
          t("automation.authToolLine", {
            name: tool.name,
            origin: formatOrigin(tool.origin, t),
            risks: riskText,
            digest: tool.digestShort ?? "",
          }),
        );
      }
    } else {
      lines.push(t("automation.authNoTools"));
    }
    lines.push(t("automation.authExtensions", { count: String(auth.extensionCount ?? 0) }));
    lines.push(t("automation.authServiceOnline"));
  }
  return lines.length ? lines : fallback ?? [];
}

export function formatSchedulerDiagnosticRows(
  rows: Array<{ key: string; value: string }> | string[],
  t: AutomationTranslate,
): string[] {
  if (!rows?.length) return [];
  if (typeof rows[0] === "string") return rows as string[];
  return (rows as Array<{ key: string; value: string }>).map((row) => {
    const labelKey = `automation.diagnostics_${row.key}`;
    const label = t(labelKey);
    const niceLabel =
      label === labelKey
        ? t("automation.fallbackUnknownWithContext", {
            context: t("automation.technicalCode"),
          })
        : label;
    let value = row.value;
    if (
      row.key === "available" ||
      row.key === "globalDisabled" ||
      row.key === "repairRequired" ||
      row.key === "inProcessStarted"
    ) {
      if (value === "true") value = t("automation.enable");
      if (value === "false") value = t("automation.disable");
    } else if (value === "" || value == null) {
      value = t("automation.fallbackNone");
    }
    return `${niceLabel}: ${value}`;
  });
}
