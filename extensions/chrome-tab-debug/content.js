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
          : el.tagName === "INPUT" ? ((el.getAttribute("type") || "text").toLowerCase() === "checkbox" ? "checkbox"
            : (el.getAttribute("type") || "text").toLowerCase() === "radio" ? "radio" : "textbox")
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
    if (!["click", "type", "select", "fill", "clear", "press", "check", "uncheck", "hover"].includes(action)) return null;
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

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    return ["a", "button", "input", "select", "textarea", "summary"].includes(tag)
      || ["button", "checkbox", "combobox", "link", "listbox", "menuitem", "radio", "textbox"].includes(role)
      || el.hasAttribute("tabindex")
      || Boolean(el.isContentEditable);
  }

  function visibleTextForRegion(root, region) {
    if (!region) return root?.innerText || root?.textContent || "";
    const parts = [];
    const visit = (el) => {
      if (!(el instanceof Element) || !visible(el) || !intersectsRegion(el, region)) return;
      const directText = Array.from(el.childNodes || [])
        .filter((node) => node && node.nodeType === 3)
        .map((node) => String(node.textContent || "").trim())
        .filter(Boolean)
        .join(" ");
      if (directText) parts.push(directText);
      const children = Array.from(el.children || []);
      if (children.length === 0 && !directText) {
        const text = String(el.innerText || el.textContent || "").trim();
        if (text) parts.push(text);
      } else {
        for (const child of children) visit(child);
      }
    };
    visit(root);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function focusableElements() {
    const root = document.body || document.documentElement;
    if (!root || typeof root.querySelectorAll !== "function") return [];
    return Array.from(root.querySelectorAll("a,button,input,select,textarea,[tabindex]"))
      .filter((candidate) => candidate instanceof HTMLElement && visible(candidate) && enabled(candidate))
      .filter((candidate) => candidate.getAttribute("tabindex") !== "-1");
  }

  function moveFocusWithTab(current, backwards) {
    const candidates = focusableElements();
    const index = candidates.indexOf(current);
    if (index < 0 || candidates.length < 2) return false;
    const nextIndex = (index + (backwards ? -1 : 1) + candidates.length) % candidates.length;
    candidates[nextIndex].focus();
    return true;
  }

  function simulatePressDefault(el, key, modifiers) {
    if (key === "Tab") {
      return moveFocusWithTab(el, modifiers.includes("Shift")) ? "focus_moved" : "not_simulated";
    }
    const tag = el.tagName.toLowerCase();
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const isButtonLike = tag === "button" || tag === "summary" || role === "button" || role === "menuitem";
    const isLinkLike = tag === "a" || role === "link";
    const type = String(el.getAttribute("type") || "").toLowerCase();
    const isCheckable = tag === "input" && (type === "checkbox" || type === "radio");
    if ((key === "Enter" && (isButtonLike || isLinkLike)) || (key === "Space" && (isButtonLike || isCheckable))) {
      if (typeof el.click === "function") {
        el.click();
        return "clicked";
      }
    }
    return "not_simulated";
  }

  function snapshotVisibleText(root, region, maxTextChars) {
    const rawText = visibleTextForRegion(root, region);
    const text = rawText.slice(0, maxTextChars);
    return {
      text,
      truncation: { nodes: false, depth: false, text: rawText.length > maxTextChars, bytes: false },
    };
  }

  function intersectsRegion(el, region) {
    if (!region) return true;
    const rect = el.getBoundingClientRect();
    return rect.right >= region.x
      && rect.left <= region.x + region.width
      && rect.bottom >= region.y
      && rect.top <= region.y + region.height;
  }

  function snapshotNode(el, depth, acc, maxDepth, maxNodes, options) {
    if (!(el instanceof Element)) return null;
    if (el.closest("script, style, noscript, template")) return null;
    if (options.region && depth > 0 && !intersectsRegion(el, options.region)) return null;
    if (acc.nodes >= maxNodes) {
      acc.truncation.nodes = true;
      return null;
    }
    acc.nodes += 1;
    if (depth >= maxDepth && el.children.length > 0) acc.truncation.depth = true;

    const includeSelf = !options.interactiveOnly || depth === 0 || isInteractive(el);
    const children = [];
    if (depth < maxDepth) {
      for (const child of el.children) {
        if (acc.nodes >= maxNodes) {
          acc.truncation.nodes = true;
          break;
        }
        const childNode = snapshotNode(child, depth + 1, acc, maxDepth, maxNodes, options);
        if (childNode) children.push(childNode);
      }
    }
    if (!includeSelf && children.length === 0) return null;
    const node = {
      ...(includeSelf ? { ref: makeRef(el) } : {}),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el).slice(0, 200),
      visible: visible(el),
      enabled: enabled(el),
      sensitive: isSensitive(el),
      interactive: includeSelf,
      children,
    };
    return node;
  }

  function handleSnapshot(params) {
    let scope;
    if (params.scopeElementRef) {
      const resolved = resolveRef(params.scopeElementRef);
      if (resolved.error) return resolved;
      scope = resolved.el;
    }
    refs.clear();
    refSeq = 0;
    expiredContexts.add(contextId);
    while (expiredContexts.size > 8) expiredContexts.delete(expiredContexts.values().next().value);
    contextId = Math.random().toString(36).slice(2, 10);
    const format = params.format || "accessibility";
    const mode = params.mode === "interactive" ? "interactive" : "full";
    const maxDepth = Math.max(0, Math.min(MAX_DEPTH, Number(params.maxDepth) || MAX_DEPTH));
    const maxNodes = Math.max(1, Math.min(MAX_NODES, Number(params.maxNodes) || MAX_NODES));
    const maxTextChars = Math.max(100, Math.min(MAX_TEXT, Number(params.maxTextChars) || MAX_TEXT));
    const region = params.region && typeof params.region === "object" ? params.region : null;
    const scopeRoot = scope || document.body || document.documentElement;
    if (format === "visible_text") {
      const textResult = snapshotVisibleText(scopeRoot, region, maxTextChars);
      const truncation = textResult.truncation;
      const text = textResult.text;
      return {
        documentId,
        contextId,
        url: location.href,
        title: document.title,
        origin: location.origin,
        format,
        mode,
        text,
        truncated: truncation.text,
        truncation,
        maxDepth,
        maxNodes,
        maxTextChars,
      };
    }
    const acc = { nodes: 0, truncation: { nodes: false, depth: false, text: false, bytes: false } };
    const root = snapshotNode(scope || document.body || document.documentElement, 0, acc, maxDepth, maxNodes, {
      interactiveOnly: mode === "interactive",
      region,
    });
    const result = {
      documentId,
      contextId,
      url: location.href,
      title: document.title,
      origin: location.origin,
      format,
      mode,
      scopeElementRef: params.scopeElementRef ? true : undefined,
      root,
      nodeCount: acc.nodes,
      truncated: Object.values(acc.truncation).some(Boolean),
      truncation: acc.truncation,
      maxDepth,
      maxNodes,
      maxTextChars,
    };
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
      if (bytes > 220_000) result.truncation.bytes = true;
      result.truncated = Object.values(result.truncation).some(Boolean);
    } catch {
      result.truncation.bytes = true;
      result.truncated = true;
    }
    return result;
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
    const previous = String(el.value || "");
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
    return previous !== String(el.value || "");
  }

  function setContentEditableValue(el, nextValue) {
    const previous = String(el.textContent || "");
    el.textContent = nextValue;
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
    return previous !== nextValue;
  }

  function editableValue(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || "");
    return String(el.textContent || "");
  }

  function dispatchKeyboard(el, type, key, modifiers) {
    const eventKey = key === "Space" ? " " : key;
    const init = {
      key: eventKey,
      code: key,
      bubbles: true,
      cancelable: true,
      shiftKey: modifiers.includes("Shift"),
      ctrlKey: modifiers.includes("Control"),
      altKey: modifiers.includes("Alt"),
      metaKey: modifiers.includes("Meta"),
    };
    try {
      el.dispatchEvent(new KeyboardEvent(type, init));
    } catch {
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [name, value] of Object.entries(init)) {
        try { Object.defineProperty(event, name, { value }); } catch { /* ignore */ }
      }
      el.dispatchEvent(event);
    }
  }

  function dispatchHover(el) {
    for (const type of ["mouseover", "mouseenter", "mousemove"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch {
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      }
    }
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
    const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map((item) => String(item)) : [];
    const allowedKeys = policy?.ALLOWED_PRESS_KEYS || ["Enter", "Space", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    const allowedModifiers = policy?.ALLOWED_PRESS_MODIFIERS || ["Shift", "Control", "Alt", "Meta"];
    if (params.action === "press" && (!allowedKeys.includes(String(params.key)) || modifiers.some((item) => !allowedModifiers.includes(item)))) {
      return { error: "INVALID_ACTION_TARGET", message: "Press key or modifier is not allowlisted", synthetic: true };
    }
    const decision = evaluateActionPolicy(action === "press" ? { ...meta, key: String(params.key), modifiers } : meta);
    if (!decision.allowed) {
      return { error: "ACTION_BLOCKED", message: decision.reason };
    }

    if (["click", "type", "select", "fill", "clear", "press", "check", "uncheck", "hover"].includes(action)) {
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
        return { error: "INVALID_ACTION_TARGET", message: "Target is not editable" };
      }
      el.focus();
      const text = String(params.text ?? "");
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const next = params.clearFirst ? text : `${el.value}${text}`;
        const changed = String(el.value || "") !== next;
        setNativeEditableValue(el, next);
        return { ok: true, changed };
      }
      return { ok: true, changed: setContentEditableValue(el, params.clearFirst ? text : `${el.textContent || ""}${text}`) };
    }
    if (action === "fill" || action === "clear") {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.isContentEditable) {
        return { error: "INVALID_ACTION_TARGET", message: "Target is not editable" };
      }
      el.focus();
      const text = action === "clear" ? "" : String(params.text ?? "");
      const previous = editableValue(el);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeEditableValue(el, text);
      } else {
        setContentEditableValue(el, text);
      }
      return { ok: true, changed: previous !== text };
    }
    if (action === "press") {
      el.focus();
      dispatchKeyboard(el, "keydown", String(params.key), modifiers);
      dispatchKeyboard(el, "keyup", String(params.key), modifiers);
      const defaultAction = simulatePressDefault(el, String(params.key), modifiers);
      return { ok: true, key: String(params.key), modifiers, synthetic: true, defaultAction };
    }
    if (action === "check" || action === "uncheck") {
      const type = String(el.getAttribute("type") || "").toLowerCase();
      if (!(el instanceof HTMLInputElement) || (type !== "checkbox" && type !== "radio")) {
        return { error: "INVALID_ACTION_TARGET", message: "Target is not a checkbox or radio input" };
      }
      if (action === "uncheck" && type === "radio") {
        return { error: "INVALID_ACTION_TARGET", message: "Radio inputs cannot be unchecked" };
      }
      const checked = action === "check";
      const changed = Boolean(el.checked) !== checked;
      if (changed) {
        el.checked = checked;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: true, changed, checked: Boolean(el.checked) };
    }
    if (action === "hover") {
      dispatchHover(el);
      return { ok: true, hovered: true };
    }
    if (action === "select") {
      if (!(el instanceof HTMLSelectElement)) {
        return { error: "INVALID_ACTION_TARGET", message: "Target is not a select" };
      }
      el.value = String(params.value ?? "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    return { error: "INVALID_ACTION_TARGET", message: `Unknown action ${action}` };
  }

  function urlMatchesPattern(url, pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try {
      return new RegExp(`^${escaped}$`).test(url);
    } catch {
      return false;
    }
  }

  function clickable(el) {
    if (!visible(el) || !enabled(el)) return false;
    const rect = el.getBoundingClientRect();
    if (typeof document.elementFromPoint !== "function") return true;
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !top || top === el || (typeof el.contains === "function" && el.contains(top));
  }

  function waitText(selector) {
    if (!selector) return document.body?.innerText || "";
    const el = document.querySelector(selector);
    return el ? (el.textContent || el.innerText || "") : "";
  }

  function handleWait(params, requestId) {
    const timeoutMs = Math.min(120000, Math.max(1000, Number(params.timeoutMs) || 10000));
    const started = Date.now();
    const condition = params.condition;
    const value = String(params.value || "");
    const state = params.state || "present";
    const selector = typeof params.selector === "string" ? params.selector : "";
    const supported = ["element", "text", "url", "dom_idle", "clickable", "url_pattern", "text_change", "document_idle"];
    if (!supported.includes(condition)) {
      return Promise.resolve({ error: "INVALID_WAIT_CONDITION", message: "Unsupported browser wait condition", condition });
    }
    let previousMutationVersion = mutationVersion;
    let quietSince = Date.now();

    return new Promise((resolve) => {
      const tick = () => {
        if (requestId && cancelled.has(requestId)) {
          cancelled.delete(requestId);
          resolve({ error: "WAIT_CANCELLED", message: "Wait cancelled", waitedMs: Date.now() - started, condition });
          return;
        }
        if (mutationVersion !== previousMutationVersion) {
          previousMutationVersion = mutationVersion;
          quietSince = Date.now();
        }
        let matched = false;
        try {
          if (condition === "url") matched = location.href.includes(value);
          else if (condition === "url_pattern") matched = urlMatchesPattern(location.href, value);
          else if (condition === "text") matched = (document.body?.innerText || "").includes(value);
          else if (condition === "text_change") matched = waitText(selector) !== value;
          else if (condition === "dom_idle") matched = document.readyState === "complete";
          else if (condition === "document_idle") matched = document.readyState === "complete" && Date.now() - quietSince >= 100;
          else if (condition === "element") {
            const el = document.querySelector(value);
            if (!el) matched = false;
            else if (state === "visible") matched = visible(el);
            else if (state === "hidden") matched = !visible(el);
            else matched = true;
          } else if (condition === "clickable") {
            const el = document.querySelector(value);
            matched = Boolean(el && clickable(el));
          }
        } catch {
          resolve({ error: "INVALID_SELECTOR", message: "Invalid selector for wait", condition });
          return;
        }
        if (state === "absent") matched = !matched;
        if (matched) {
          resolve({ ok: true, waitedMs: Date.now() - started, condition, state: pageState() });
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve({
            error: "WAIT_TIMEOUT",
            message: "Wait condition not met",
            waitedMs: Date.now() - started,
            condition,
            state: pageState(),
          });
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
