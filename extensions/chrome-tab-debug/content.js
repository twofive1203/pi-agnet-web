/**
 * Content script injected only after explicit activeTab confirmation.
 * Holds document-scoped element refs; invalidated when document identity changes.
 *
 * Action policy comes from action-policy.inject.js (generated from
 * lib/browser-action-policy.ts) — injected before this file by background.js.
 */
(() => {
  if (globalThis.__snailPiContentLoaded) return;
  globalThis.__snailPiContentLoaded = true;

  const policy = globalThis.__snailPiActionPolicy;
  if (!policy || typeof policy.evaluateActionPolicy !== "function") {
    console.error("Snail Pi: action policy missing; inject action-policy.inject.js before content.js");
  }
  const evaluateActionPolicy = (input) => (
    policy?.evaluateActionPolicy
      ? policy.evaluateActionPolicy(input)
      : { allowed: false, reason: "Action policy unavailable" }
  );
  const elementActionMeta = (el, action) => (
    policy?.elementActionMeta
      ? policy.elementActionMeta(el, action)
      : { action }
  );

  const MAX_NODES = 400;
  const MAX_DEPTH = 12;
  const MAX_TEXT = 8000;
  const refs = new Map();
  let refSeq = 0;
  let mutationVersion = 0;
  const cancelled = new Set();
  const expiredContexts = new Set();
  const documentId = `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  let contextId = Math.random().toString(36).slice(2, 10);
  if (typeof MutationObserver === "function") {
    const observer = new MutationObserver(() => { mutationVersion += 1; });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  function isSensitive(el) {
    if (!(el instanceof HTMLElement)) return true;
    if (el.isContentEditable) return true;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "file") return true;
    const name = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""} ${el.getAttribute("autocomplete") || ""}`;
    if (/password|passwd|pwd|card|cvv|ssn|secret/i.test(name)) return true;
    return false;
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    let current = el;
    while (current instanceof Element) {
      const style = window.getComputedStyle(current);
      if (
        style.display === "none"
        || style.visibility === "hidden"
        || style.opacity === "0"
        || current.getAttribute("aria-hidden") === "true"
      ) return false;
      current = current.parentElement || current.parentNode;
    }
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
    const id = `el_${contextId}_${++refSeq}`;
    refs.set(id, el);
    return id;
  }

  function resolveRef(ref) {
    const refContext = typeof ref === "string" ? /^el_([^_]+)_/.exec(ref)?.[1] : null;
    if (typeof ref !== "string" || refContext !== contextId) {
      const expired = refContext ? expiredContexts.has(refContext) : false;
      return {
        error: expired ? "STALE_ELEMENT_REF" : "WRONG_ELEMENT_CONTEXT",
        message: expired ? "elementRef was invalidated by a new snapshot" : "elementRef belongs to another document context",
        details: { reason: expired ? "snapshot_replaced" : "wrong_context", contextId },
      };
    }
    const el = refs.get(ref);
    if (!el || !el.isConnected) {
      return {
        error: "STALE_ELEMENT_REF",
        message: "elementRef is detached or expired",
        details: { reason: "detached", contextId },
      };
    }
    return { el };
  }

  function focusedElementSummary() {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    const sensitive = isSensitive(el);
    const safeName = el.isContentEditable
      ? (el.getAttribute("aria-label") || el.getAttribute("title") || "")
      : nameOf(el);
    return {
      role: roleOf(el).slice(0, 40),
      name: safeName.slice(0, 120),
      sensitive,
    };
  }

  function pageState() {
    return {
      documentId,
      contextId,
      url: location.href,
      origin: location.origin,
      title: String(document.title || "").slice(0, 200),
      readyState: document.readyState,
      mutationVersion,
      focus: focusedElementSummary(),
    };
  }

  function isDisabled(el) {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return true;
    let current = el;
    while (current instanceof Element) {
      if (
        current.tagName.toLowerCase() === "fieldset"
        && (current.disabled || current.getAttribute("aria-disabled") === "true")
      ) return true;
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function enabled(el) {
    return !isDisabled(el);
  }

  function interactabilityError(el, action) {
    if (!visible(el)) {
      return { error: "ELEMENT_HIDDEN", message: "Target element is hidden", details: { reason: "hidden", action } };
    }
    if (isDisabled(el)) {
      return { error: "ELEMENT_DISABLED", message: "Target element is disabled", details: { reason: "disabled", action } };
    }
    if (!["click", "type", "select"].includes(action)) return null;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min((window.innerWidth || rect.right) - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min((window.innerHeight || rect.bottom) - 1, rect.top + rect.height / 2));
    if (typeof document.elementFromPoint === "function") {
      const top = document.elementFromPoint(x, y);
      if (top && top !== el && !(typeof el.contains === "function" && el.contains(top))) {
        return { error: "ELEMENT_COVERED", message: "Target element is covered", details: { reason: "covered", action } };
      }
    }
    return null;
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
      enabled: enabled(el),
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
    expiredContexts.add(contextId);
    while (expiredContexts.size > 8) expiredContexts.delete(expiredContexts.values().next().value);
    contextId = Math.random().toString(36).slice(2, 10);
    const format = params.format || "accessibility";
    const maxDepth = Math.max(0, Math.min(MAX_DEPTH, Number(params.maxDepth) || MAX_DEPTH));
    const maxNodes = Math.max(1, Math.min(MAX_NODES, Number(params.maxNodes) || MAX_NODES));
    if (format === "visible_text") {
      const text = (document.body?.innerText || "").slice(0, MAX_TEXT);
      return {
        documentId,
        contextId,
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
      contextId,
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
        enabled: enabled(el),
        sensitive: isSensitive(el),
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      if (results.length >= limit) break;
    }
    return { documentId, contextId, results, count: results.length };
  }

  /**
   * Set input/textarea value in a way React/Vue controlled components observe.
   * Uses the native value setter + InputEvent when available.
   */
  function setNativeEditableValue(el, nextValue) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) {
      descriptor.set.call(el, nextValue);
    } else {
      el.value = nextValue;
    }
    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: nextValue,
      }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
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

    if (["click", "type", "select"].includes(action)) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    }
    const interactability = interactabilityError(el, action);
    if (interactability) return interactability;

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
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const next = params.clearFirst ? text : `${el.value}${text}`;
        setNativeEditableValue(el, next);
      } else {
        el.textContent = params.clearFirst ? text : `${el.textContent || ""}${text}`;
        try {
          el.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: text,
          }));
        } catch {
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
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
        if (message.type === "meta" || message.type === "state") return pageState();
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
