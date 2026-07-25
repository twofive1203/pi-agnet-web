/**
 * Content script injected only after explicit activeTab confirmation.
 * Holds document-scoped element refs; invalidated when document identity changes.
 * Action policy mirrored from action-policy.js / lib/browser-action-policy.ts.
 */
(() => {
  if (globalThis.__snailPiContentLoaded) return;
  globalThis.__snailPiContentLoaded = true;

  const MAX_NODES = 400;
  const MAX_DEPTH = 12;
  const MAX_TEXT = 8000;
  const refs = new Map();
  let refSeq = 0;
  const cancelled = new Set();
  const documentId = `${location.href}::${document.documentElement?.outerHTML?.length || 0}::${Date.now()}::${Math.random().toString(36).slice(2)}`;

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
    return [input.name, input.id, input.autocomplete, input.ariaLabel, input.role, input.text]
      .filter(Boolean)
      .join(" ");
  }

  function elementActionMeta(el, action) {
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

  function evaluateActionPolicy(input) {
    const action = (input.action || "").toLowerCase();
    if (!action) return { allowed: false, reason: "Missing action" };
    if (action === "reload" || action === "highlight" || action === "scroll_into_view") {
      return { allowed: true };
    }
    if (action !== "click" && action !== "type" && action !== "select") {
      return { allowed: false, reason: `Unknown action ${action}` };
    }
    const type = (input.type || "").toLowerCase();
    const tag = (input.tagName || "").toLowerCase();
    if (tag === "input" && type === "file") {
      return { allowed: false, reason: "File inputs are blocked" };
    }
    const meta = joinMeta(input);
    const passwordLike = type === "password" || PASSWORD_LIKE_RE.test(meta) || PAYMENT_RE.test(meta);
    if (passwordLike && (action === "type" || action === "click" || action === "select")) {
      return { allowed: false, reason: "Password/payment-like controls are blocked" };
    }
    if (action === "click" || action === "type") {
      const href = input.href || "";
      const downloadLike = input.download === true
        || (typeof input.download === "string" && tag === "a")
        || DOWNLOAD_HREF_RE.test(href)
        || DOWNLOAD_EXT_RE.test(href)
        || /[?&]download=/i.test(href);
      if (downloadLike) return { allowed: false, reason: "Download links/controls are blocked" };
      if (PERMISSION_RE.test(meta) || ((input.role || "").toLowerCase() === "button" && /\b(camera|microphone|location|notification)s?\b/i.test(meta))) {
        return { allowed: false, reason: "Permission-triggering controls are blocked" };
      }
      if (DESTRUCTIVE_TEXT_RE.test(meta)) {
        return { allowed: false, reason: "Destructive controls are blocked" };
      }
    }
    if (action === "select") {
      const role = (input.role || "").toLowerCase();
      if (tag !== "select" && role !== "listbox" && role !== "combobox") {
        return { allowed: false, reason: "Target is not a select" };
      }
    }
    return { allowed: true };
  }

  function isSensitive(el) {
    if (!(el instanceof HTMLElement)) return true;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "file") return true;
    const name = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""} ${el.getAttribute("autocomplete") || ""}`;
    if (/password|passwd|pwd|card|cvv|ssn|secret/i.test(name)) return true;
    return false;
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function roleOf(el) {
    return el.getAttribute("role")
      || (el.tagName === "BUTTON" ? "button"
        : el.tagName === "A" ? "link"
          : el.tagName === "INPUT" ? "textbox"
            : el.tagName === "SELECT" ? "combobox"
              : el.tagName === "TEXTAREA" ? "textbox"
                : el.tagName.toLowerCase());
  }

  function nameOf(el) {
    return (
      el.getAttribute("aria-label")
      || el.getAttribute("alt")
      || el.getAttribute("placeholder")
      || (el.innerText || el.textContent || "").trim().slice(0, 200)
      || ""
    );
  }

  function makeRef(el) {
    const id = `el_${++refSeq}`;
    refs.set(id, el);
    return id;
  }

  function resolveRef(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) {
      return { error: "STALE_ELEMENT_REF" };
    }
    return { el };
  }

  function snapshotNode(el, depth, acc, maxDepth, maxNodes) {
    if (acc.nodes >= maxNodes || depth > maxDepth) {
      acc.truncated = true;
      return null;
    }
    if (!(el instanceof Element)) return null;
    if (el.closest("script, style, noscript, template")) return null;
    acc.nodes += 1;
    const ref = makeRef(el);
    const node = {
      ref,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el).slice(0, 200),
      visible: visible(el),
      enabled: !el.disabled,
      sensitive: isSensitive(el),
      children: [],
    };
    if (depth < maxDepth) {
      for (const child of el.children) {
        const childNode = snapshotNode(child, depth + 1, acc, maxDepth, maxNodes);
        if (childNode) node.children.push(childNode);
        if (acc.nodes >= maxNodes) {
          acc.truncated = true;
          break;
        }
      }
    }
    return node;
  }

  function handleSnapshot(params) {
    refs.clear();
    refSeq = 0;
    const format = params.format || "accessibility";
    const maxDepth = Math.max(0, Math.min(MAX_DEPTH, Number(params.maxDepth) || MAX_DEPTH));
    const maxNodes = Math.max(1, Math.min(MAX_NODES, Number(params.maxNodes) || MAX_NODES));
    if (format === "visible_text") {
      const text = (document.body?.innerText || "").slice(0, MAX_TEXT);
      return {
        documentId,
        url: location.href,
        title: document.title,
        origin: location.origin,
        format,
        text,
        truncated: (document.body?.innerText || "").length > MAX_TEXT,
        maxDepth,
        maxNodes,
      };
    }
    const acc = { nodes: 0, truncated: false };
    const root = snapshotNode(document.body || document.documentElement, 0, acc, maxDepth, maxNodes);
    return {
      documentId,
      url: location.href,
      title: document.title,
      origin: location.origin,
      format,
      root,
      nodeCount: acc.nodes,
      truncated: acc.truncated,
      maxDepth,
      maxNodes,
    };
  }

  function handleFind(params) {
    const limit = Math.min(25, Number(params.limit) || 10);
    const results = [];
    const all = [...document.querySelectorAll("body *")].slice(0, 5000);
    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      if (params.css) {
        try {
          if (!el.matches(params.css)) continue;
        } catch {
          return { error: "ACTION_BLOCKED", message: "Invalid or disallowed CSS selector" };
        }
      }
      const role = roleOf(el);
      const name = nameOf(el);
      const text = (el.innerText || "").trim();
      if (params.role && role.toLowerCase() !== String(params.role).toLowerCase()) continue;
      if (params.name && !name.toLowerCase().includes(String(params.name).toLowerCase())) continue;
      if (params.text && !text.toLowerCase().includes(String(params.text).toLowerCase())) continue;
      if (!params.css && !params.role && !params.name && !params.text) continue;
      const rect = el.getBoundingClientRect();
      results.push({
        elementRef: makeRef(el),
        role,
        name: name.slice(0, 200),
        text: text.slice(0, 200),
        visible: visible(el),
        enabled: !el.disabled,
        sensitive: isSensitive(el),
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      if (results.length >= limit) break;
    }
    return { documentId, results, count: results.length };
  }

  function handleAct(params) {
    const action = params.action;
    if (action === "reload") {
      location.reload();
      return { ok: true, navigated: true };
    }
    if (!params.elementRef) return { error: "STALE_ELEMENT_REF", message: "elementRef required" };
    const resolved = resolveRef(params.elementRef);
    if (resolved.error) return resolved;
    const el = resolved.el;

    const meta = elementActionMeta(el, action);
    const decision = evaluateActionPolicy(meta);
    if (!decision.allowed) {
      return { error: "ACTION_BLOCKED", message: decision.reason };
    }

    if (action === "highlight") {
      const prev = el.style.outline;
      el.style.outline = "2px solid #f59e0b";
      setTimeout(() => { el.style.outline = prev; }, 1200);
      return { ok: true };
    }
    if (action === "scroll_into_view") {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      return { ok: true };
    }
    if (action === "click") {
      el.focus();
      el.click();
      return { ok: true };
    }
    if (action === "type") {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.isContentEditable) {
        return { error: "ACTION_BLOCKED", message: "Target is not editable" };
      }
      el.focus();
      const text = String(params.text ?? "");
      if (params.clearFirst && "value" in el) el.value = "";
      if ("value" in el) {
        el.value = params.clearFirst ? text : `${el.value}${text}`;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        el.textContent = params.clearFirst ? text : `${el.textContent || ""}${text}`;
      }
      return { ok: true };
    }
    if (action === "select") {
      if (!(el instanceof HTMLSelectElement)) {
        return { error: "ACTION_BLOCKED", message: "Target is not a select" };
      }
      el.value = String(params.value ?? "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    return { error: "ACTION_BLOCKED", message: `Unknown action ${action}` };
  }

  function handleWait(params, requestId) {
    const timeoutMs = Math.min(120000, Math.max(1000, Number(params.timeoutMs) || 10000));
    const started = Date.now();
    const condition = params.condition;
    const value = String(params.value || "");
    const state = params.state || "present";

    return new Promise((resolve) => {
      const tick = () => {
        if (requestId && cancelled.has(requestId)) {
          cancelled.delete(requestId);
          resolve({ error: "REQUEST_TIMEOUT", message: "Wait cancelled", waitedMs: Date.now() - started });
          return;
        }
        let matched = false;
        if (condition === "url") matched = location.href.includes(value);
        else if (condition === "text") matched = (document.body?.innerText || "").includes(value);
        else if (condition === "dom_idle") matched = document.readyState === "complete";
        else if (condition === "element") {
          try {
            const el = document.querySelector(value);
            if (!el) matched = false;
            else if (state === "visible") matched = visible(el);
            else if (state === "hidden") matched = !visible(el);
            else matched = true;
          } catch {
            resolve({ error: "ACTION_BLOCKED", message: "Invalid selector for wait" });
            return;
          }
        }
        if (state === "absent") matched = !matched;
        if (matched) {
          resolve({ ok: true, waitedMs: Date.now() - started, documentId, url: location.href });
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve({ error: "REQUEST_TIMEOUT", message: "Wait condition not met", waitedMs: Date.now() - started });
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.channel === "snail-pi-content-broadcast" && message.type === "cancel") {
      if (message.requestId) cancelled.add(message.requestId);
      return false;
    }
    if (message.channel !== "snail-pi-content") return false;
    const run = async () => {
      try {
        if (message.type === "meta") {
          return { documentId, url: location.href, title: document.title, origin: location.origin };
        }
        if (message.type === "snapshot") return handleSnapshot(message.params || {});
        if (message.type === "find") return handleFind(message.params || {});
        if (message.type === "act") return handleAct(message.params || {});
        if (message.type === "wait") return await handleWait(message.params || {}, message.requestId);
        return { error: "INVALID_FRAME", message: "Unknown content command" };
      } catch (error) {
        return { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
      }
    };
    run().then(sendResponse);
    return true;
  });
})();
