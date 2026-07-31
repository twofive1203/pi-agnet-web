/**
 * Deterministic action safety policy for browser_act.
 * Mirrored in extensions/chrome-tab-debug/action-policy.js — keep in sync.
 */

export type ActionPolicyInput = {
  action: string;
  tagName?: string | null;
  type?: string | null;
  name?: string | null;
  id?: string | null;
  href?: string | null;
  role?: string | null;
  autocomplete?: string | null;
  ariaLabel?: string | null;
  text?: string | null;
  download?: string | null | boolean;
  target?: string | null;
  rel?: string | null;
  inputMode?: string | null;
  isContentEditable?: boolean;
  key?: string | null;
  modifiers?: string[] | null;
};

export const ALLOWED_PRESS_KEYS = [
  "Enter", "Space", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
] as const;
export const ALLOWED_PRESS_MODIFIERS = ["Shift", "Control", "Alt", "Meta"] as const;

export type ActionPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const PASSWORD_LIKE_RE =
  /password|passwd|pwd|passcode|pin|cvv|cvc|card.?number|cc-?num|credit.?card|ssn|secret|one.?time.?code|otp/i;
const PAYMENT_RE = /payment|pay\b|checkout|billing|credit.?card|cardholder|iban|routing.?number/i;
const DESTRUCTIVE_TEXT_RE =
  /\b(delete|remove|destroy|drop\b|reset|wipe|deactivate|disable account|close account|terminate|purge|factory reset)\b/i;
const PERMISSION_RE =
  /\b(allow (camera|microphone|location|notifications|midi|clipboard)|request permission|getusermedia|enable notifications|share location)\b/i;
const DOWNLOAD_HREF_RE = /^(blob:|data:)/i;
const DOWNLOAD_EXT_RE =
  /\.(zip|rar|7z|tar|gz|tgz|exe|dmg|pkg|msi|apk|iso|bin|csv|xlsx?|docx?|pptx?|pdf|mp4|mp3|mov|wav)(\?|#|$)/i;

function joinMeta(input: ActionPolicyInput): string {
  return [
    input.name,
    input.id,
    input.autocomplete,
    input.ariaLabel,
    input.role,
    input.text,
  ]
    .filter(Boolean)
    .join(" ");
}

export function isPasswordOrPaymentField(input: ActionPolicyInput): boolean {
  const type = (input.type ?? "").toLowerCase();
  if (type === "password") return true;
  const meta = joinMeta(input);
  if (PASSWORD_LIKE_RE.test(meta)) return true;
  if (PAYMENT_RE.test(meta)) return true;
  if ((input.inputMode ?? "").toLowerCase() === "numeric" && /cvv|cvc|csc/i.test(meta)) return true;
  return false;
}

export function isFileInput(input: ActionPolicyInput): boolean {
  const type = (input.type ?? "").toLowerCase();
  const tag = (input.tagName ?? "").toLowerCase();
  return tag === "input" && type === "file";
}

export function isDownloadLike(input: ActionPolicyInput): boolean {
  if (input.download === true) return true;
  if (typeof input.download === "string" && input.download.length >= 0 && input.tagName?.toLowerCase() === "a") {
    // presence of download attribute on anchor
    return true;
  }
  const href = input.href ?? "";
  if (!href) return false;
  if (DOWNLOAD_HREF_RE.test(href)) return true;
  if (DOWNLOAD_EXT_RE.test(href)) return true;
  if (/[?&]download=/i.test(href)) return true;
  return false;
}

export function isPermissionTrigger(input: ActionPolicyInput): boolean {
  const meta = joinMeta(input);
  if (PERMISSION_RE.test(meta)) return true;
  const role = (input.role ?? "").toLowerCase();
  if (role === "button" && /\b(camera|microphone|location|notification)s?\b/i.test(meta)) return true;
  return false;
}

export function isDestructiveControl(input: ActionPolicyInput): boolean {
  const meta = joinMeta(input);
  if (DESTRUCTIVE_TEXT_RE.test(meta)) return true;
  const type = (input.type ?? "").toLowerCase();
  if (type === "reset" && DESTRUCTIVE_TEXT_RE.test(meta || "reset")) return true;
  return false;
}

/**
 * Decide whether a DOM action is allowed against the given control metadata.
 * Policy is intentionally conservative and deterministic.
 */
export function evaluateActionPolicy(input: ActionPolicyInput): ActionPolicyDecision {
  const action = (input.action || "").toLowerCase();
  if (!action) return { allowed: false, reason: "Missing action" };

  if (action === "reload" || action === "highlight" || action === "scroll_into_view") {
    return { allowed: true };
  }

  if (action !== "click" && action !== "type" && action !== "select" && action !== "fill" && action !== "clear" && action !== "press" && action !== "check" && action !== "uncheck" && action !== "hover") {
    return { allowed: false, reason: `Unknown action ${action}` };
  }

  if (action === "press") {
    if (!ALLOWED_PRESS_KEYS.includes(input.key as typeof ALLOWED_PRESS_KEYS[number])) {
      return { allowed: false, reason: "Key is not allowed" };
    }
    if ((input.modifiers ?? []).some((modifier) => !ALLOWED_PRESS_MODIFIERS.includes(modifier as typeof ALLOWED_PRESS_MODIFIERS[number]))) {
      return { allowed: false, reason: "Modifier is not allowed" };
    }
  }

  if (isFileInput(input)) {
    return { allowed: false, reason: "File inputs are blocked" };
  }

  if (isPasswordOrPaymentField(input) && ["type", "fill", "clear", "click", "select", "press", "check", "uncheck", "hover"].includes(action)) {
    return { allowed: false, reason: "Password/payment-like controls are blocked" };
  }

  if (action === "click" || action === "type" || action === "fill" || action === "clear" || action === "press" || action === "check" || action === "uncheck" || action === "hover") {
    if (isDownloadLike(input)) {
      return { allowed: false, reason: "Download links/controls are blocked" };
    }
    if (isPermissionTrigger(input)) {
      return { allowed: false, reason: "Permission-triggering controls are blocked" };
    }
    if (isDestructiveControl(input)) {
      return { allowed: false, reason: "Destructive controls are blocked" };
    }
  }

  if (action === "type" || action === "fill" || action === "clear") {
    const tag = (input.tagName ?? "").toLowerCase();
    const type = (input.type ?? "").toLowerCase();
    const editable =
      input.isContentEditable
      || tag === "textarea"
      || (tag === "input" && !["button", "submit", "checkbox", "radio", "file", "image", "reset", "hidden"].includes(type));
    if (!editable) return { allowed: false, reason: "Target is not editable" };
  }

  if (action === "select") {
    const tag = (input.tagName ?? "").toLowerCase();
    const role = (input.role ?? "").toLowerCase();
    if (tag !== "select" && role !== "listbox" && role !== "combobox") {
      return { allowed: false, reason: "Target is not a select" };
    }
  }

  return { allowed: true };
}

/** Build policy input from a live DOM element (extension content script). */
export function elementActionMeta(
  el: {
    tagName?: string;
    type?: string;
    id?: string;
    href?: string;
    value?: string;
    innerText?: string;
    textContent?: string | null;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    hasAttribute?: (name: string) => boolean;
  },
  action: string,
): ActionPolicyInput {
  const tagName = el.tagName || "";
  const href = typeof el.href === "string"
    ? el.href
    : el.getAttribute?.("href") || "";
  return {
    action,
    tagName,
    type: el.getAttribute?.("type") || el.type || "",
    name: el.getAttribute?.("name") || "",
    id: el.id || "",
    href,
    role: el.getAttribute?.("role") || "",
    autocomplete: el.getAttribute?.("autocomplete") || "",
    ariaLabel: el.getAttribute?.("aria-label") || "",
    text: (el.innerText || el.textContent || "").trim().slice(0, 200),
    download: el.hasAttribute?.("download") ? (el.getAttribute?.("download") ?? true) : false,
    target: el.getAttribute?.("target") || "",
    rel: el.getAttribute?.("rel") || "",
    inputMode: el.getAttribute?.("inputmode") || "",
    isContentEditable: Boolean(el.isContentEditable),
  };
}
