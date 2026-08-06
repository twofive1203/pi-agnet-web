export interface QuotaDisplayTier {
  name: string;
  utilization: number;
  resetsAt: string | null;
}

export interface CodexResetCreditDisplay {
  id: string;
  status: string;
  grantedAt: string;
  expiresAt: string;
}

export const QUOTA_TIER_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
};

/** Canonical Grok weekly window tier — same label path as Codex `seven_day` → "7d". */
export const GROK_WEEKLY_TIER_NAME = "seven_day";

/** Older Grok account caches wrote `weekly`; normalize to `seven_day` on read. */
const LEGACY_GROK_WEEKLY_TIER_NAME = "weekly";

function canonicalQuotaTierName(name: string): string {
  return name === LEGACY_GROK_WEEKLY_TIER_NAME ? GROK_WEEKLY_TIER_NAME : name;
}

export function isKnownQuotaTier(tier: QuotaDisplayTier): boolean {
  return canonicalQuotaTierName(tier.name) in QUOTA_TIER_LABELS;
}

/**
 * Filter to displayable tiers and normalize legacy Grok `weekly` → `seven_day`
 * so GPT/Grok share the same "7d" label path.
 */
export function knownQuotaTiers<T extends QuotaDisplayTier>(tiers: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    const name = canonicalQuotaTierName(tier.name);
    if (!(name in QUOTA_TIER_LABELS) || seen.has(name)) continue;
    seen.add(name);
    out.push(name === tier.name ? tier : { ...tier, name });
  }
  return out;
}

export function findWeeklyQuotaTier<T extends QuotaDisplayTier>(tiers: T[]): T | undefined {
  return knownQuotaTiers(tiers).find((tier) => tier.name === GROK_WEEKLY_TIER_NAME);
}

/**
 * 根据额度使用百分比返回展示颜色。
 *
 * @param utilization 使用百分比，范围通常为 0-100。
 * @returns CSS 颜色值。
 */
export function quotaColor(utilization: number): string {
  if (utilization >= 90) return "#f87171";
  if (utilization >= 70) return "#fb923c";
  return "#4ade80";
}

/**
 * 格式化额度窗口重置倒计时。
 *
 * @param resetsAt ISO 格式的重置时间。
 * @returns 简短倒计时文本，无法计算时返回 null。
 */
export function formatResetCountdown(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const diffMs = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null;

  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * 格式化额度查询的相对更新时间。
 *
 * @param timestamp 查询完成的毫秒时间戳。
 * @returns 简短相对时间文本。
 */
export function formatQuotaQueriedAt(timestamp: number | null): string {
  if (!timestamp) return "never";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return "just now";
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

export function earliestResetCreditExpiration(credits: CodexResetCreditDisplay[]): string | null {
  let earliest: { time: number; value: string } | null = null;
  for (const credit of credits) {
    const time = new Date(credit.expiresAt).getTime();
    if (!Number.isFinite(time)) continue;
    if (!earliest || time < earliest.time) earliest = { time, value: credit.expiresAt };
  }
  return earliest?.value ?? null;
}
