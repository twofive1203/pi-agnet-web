/**
 * GENERATED FILE — do not edit by hand.
 * Source: lib/browser-*.ts via scripts/generate-browser-extension-shared.ts
 * Regenerate: npx tsx scripts/generate-browser-extension-shared.ts
 */

(function (global) {
"use strict";
/**
 * Deterministic action safety policy for browser_act.
 * Mirrored in extensions/chrome-tab-debug/action-policy.js — keep in sync.
 */
const PASSWORD_LIKE_RE = /password|passwd|pwd|passcode|pin|cvv|cvc|card.?number|cc-?num|credit.?card|ssn|secret|one.?time.?code|otp/i;
const PAYMENT_RE = /payment|pay\b|checkout|billing|credit.?card|cardholder|iban|routing.?number/i;
const DESTRUCTIVE_TEXT_RE = /\b(delete|remove|destroy|drop\b|reset|wipe|deactivate|disable account|close account|terminate|purge|factory reset)\b/i;
const PERMISSION_RE = /\b(allow (camera|microphone|location|notifications|midi|clipboard)|request permission|getusermedia|enable notifications|share location)\b/i;
const DOWNLOAD_HREF_RE = /^(blob:|data:)/i;
const DOWNLOAD_EXT_RE = /\.(zip|rar|7z|tar|gz|tgz|exe|dmg|pkg|msi|apk|iso|bin|csv|xlsx?|docx?|pptx?|pdf|mp4|mp3|mov|wav)(\?|#|$)/i;
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
function isPasswordOrPaymentField(input) {
    const type = (input.type ?? "").toLowerCase();
    if (type === "password")
        return true;
    const meta = joinMeta(input);
    if (PASSWORD_LIKE_RE.test(meta))
        return true;
    if (PAYMENT_RE.test(meta))
        return true;
    if ((input.inputMode ?? "").toLowerCase() === "numeric" && /cvv|cvc|csc/i.test(meta))
        return true;
    return false;
}
function isFileInput(input) {
    const type = (input.type ?? "").toLowerCase();
    const tag = (input.tagName ?? "").toLowerCase();
    return tag === "input" && type === "file";
}
function isDownloadLike(input) {
    if (input.download === true)
        return true;
    if (typeof input.download === "string" && input.download.length >= 0 && input.tagName?.toLowerCase() === "a") {
        // presence of download attribute on anchor
        return true;
    }
    const href = input.href ?? "";
    if (!href)
        return false;
    if (DOWNLOAD_HREF_RE.test(href))
        return true;
    if (DOWNLOAD_EXT_RE.test(href))
        return true;
    if (/[?&]download=/i.test(href))
        return true;
    return false;
}
function isPermissionTrigger(input) {
    const meta = joinMeta(input);
    if (PERMISSION_RE.test(meta))
        return true;
    const role = (input.role ?? "").toLowerCase();
    if (role === "button" && /\b(camera|microphone|location|notification)s?\b/i.test(meta))
        return true;
    return false;
}
function isDestructiveControl(input) {
    const meta = joinMeta(input);
    if (DESTRUCTIVE_TEXT_RE.test(meta))
        return true;
    const type = (input.type ?? "").toLowerCase();
    if (type === "reset" && DESTRUCTIVE_TEXT_RE.test(meta || "reset"))
        return true;
    return false;
}
/**
 * Decide whether a DOM action is allowed against the given control metadata.
 * Policy is intentionally conservative and deterministic.
 */
function evaluateActionPolicy(input) {
    const action = (input.action || "").toLowerCase();
    if (!action)
        return { allowed: false, reason: "Missing action" };
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
    if (action === "type") {
        const tag = (input.tagName ?? "").toLowerCase();
        const type = (input.type ?? "").toLowerCase();
        const editable = input.isContentEditable
            || tag === "textarea"
            || (tag === "input" && !["button", "submit", "checkbox", "radio", "file", "image", "reset", "hidden"].includes(type))
            || tag === "select";
        if (!editable && tag !== "select") {
            // select is handled by select action; type into non-editable is blocked by caller
        }
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
function elementActionMeta(el, action) {
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

global.__snailPiActionPolicy = Object.freeze({
  isPasswordOrPaymentField,
  isFileInput,
  isDownloadLike,
  isPermissionTrigger,
  isDestructiveControl,
  evaluateActionPolicy,
  elementActionMeta,
});
})(typeof globalThis !== "undefined" ? globalThis : self);
