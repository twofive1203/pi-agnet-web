/**
 * Deterministic action safety policy for browser_act.
 * Keep in sync with lib/browser-action-policy.ts.
 */

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

function joinMeta(input) {
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

export function isPasswordOrPaymentField(input) {
  const type = (input.type || "").toLowerCase();
  if (type === "password") return true;
  const meta = joinMeta(input);
  if (PASSWORD_LIKE_RE.test(meta)) return true;
  if (PAYMENT_RE.test(meta)) return true;
  if ((input.inputMode || "").toLowerCase() === "numeric" && /cvv|cvc|csc/i.test(meta)) return true;
  return false;
}

export function isFileInput(input) {
  const type = (input.type || "").toLowerCase();
  const tag = (input.tagName || "").toLowerCase();
  return tag === "input" && type === "file";
}

export function isDownloadLike(input) {
  if (input.download === true) return true;
  if (typeof input.download === "string" && input.tagName && input.tagName.toLowerCase() === "a") {
    return true;
  }
  const href = input.href || "";
  if (!href) return false;
  if (DOWNLOAD_HREF_RE.test(href)) return true;
  if (DOWNLOAD_EXT_RE.test(href)) return true;
  if (/[?&]download=/i.test(href)) return true;
  return false;
}

export function isPermissionTrigger(input) {
  const meta = joinMeta(input);
  if (PERMISSION_RE.test(meta)) return true;
  const role = (input.role || "").toLowerCase();
  if (role === "button" && /\b(camera|microphone|location|notification)s?\b/i.test(meta)) return true;
  return false;
}

export function isDestructiveControl(input) {
  const meta = joinMeta(input);
  return DESTRUCTIVE_TEXT_RE.test(meta);
}

export function evaluateActionPolicy(input) {
  const action = (input.action || "").toLowerCase();
  if (!action) return { allowed: false, reason: "Missing action" };

  if (action === "reload" || action === "highlight" || action === "scroll_into_view") {
    return { allowed: true };
  }

  if (action !== "click" && action !== "type" && action !== "select") {
    return { allowed: false, reason: `Unknown action ${action}` };
  }

  if (isFileInput(input)) {
    return { allowed: false, reason: "File inputs are blocked" };
  }

  if (isPasswordOrPaymentField(input) && (action === "type" || action === "click" || action === "select")) {
    return { allowed: false, reason: "Password/payment-like controls are blocked" };
  }

  if (action === "click" || action === "type") {
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

  if (action === "select") {
    const tag = (input.tagName || "").toLowerCase();
    const role = (input.role || "").toLowerCase();
    if (tag !== "select" && role !== "listbox" && role !== "combobox") {
      return { allowed: false, reason: "Target is not a select" };
    }
  }

  return { allowed: true };
}

export function elementActionMeta(el, action) {
  const tagName = el.tagName || "";
  const href = typeof el.href === "string" ? el.href : el.getAttribute?.("href") || "";
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
    download: el.hasAttribute?.("download") ? (el.getAttribute("download") ?? true) : false,
    target: el.getAttribute?.("target") || "",
    rel: el.getAttribute?.("rel") || "",
    inputMode: el.getAttribute?.("inputmode") || "",
    isContentEditable: Boolean(el.isContentEditable),
  };
}
