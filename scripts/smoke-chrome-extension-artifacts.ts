/**
 * Artifact-level smoke checks for extensions/chrome-tab-debug.
 * Loads production extension files under a mocked Chrome/WebSocket/DOM environment.
 * Does not duplicate production authorization/policy logic into the test.
 *
 * Run: npx tsx scripts/smoke-chrome-extension-artifacts.ts
 * (also wired into npm run test:browser)
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, "extensions", "chrome-tab-debug");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 3000, step = 20): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = fn();
    if (value) return value as T;
    await sleep(step);
  }
  throw new Error("waitFor timeout");
}

// ---------------------------------------------------------------------------
// Minimal DOM / Chrome mocks for production content.js + background.js
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => unknown;

function createEmitter() {
  const map = new Map<string, Set<Listener>>();
  return {
    addListener(fn: Listener) {
      if (!map.has("default")) map.set("default", new Set());
      map.get("default")!.add(fn);
    },
    removeListener(fn: Listener) {
      map.get("default")?.delete(fn);
    },
    addEventListener(type: string, fn: Listener) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      map.get(type)?.delete(fn);
    },
    emit(typeOrArg?: string | unknown, maybeArg?: unknown) {
      // chrome.*.onX.addListener(fn) style
      if (map.has("default")) {
        for (const fn of map.get("default")!) {
          if (typeof typeOrArg === "string" && maybeArg !== undefined) fn(typeOrArg, maybeArg);
          else fn(typeOrArg);
        }
      }
      if (typeof typeOrArg === "string" && map.has(typeOrArg)) {
        for (const fn of map.get(typeOrArg)!) fn(maybeArg);
      }
    },
    emitChrome(...args: unknown[]) {
      for (const fn of map.get("default") || []) fn(...args);
    },
  };
}

class MockNode {
  parentNode: MockElement | null = null;
  childNodes: MockNode[] = [];
  textContent = "";
  isConnected = true;
}

class MockElement extends MockNode {
  tagName: string;
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  id = "";
  disabled = false;
  isContentEditable = false;
  value = "";
  innerText = "";
  checked = false;
  events: Array<{ type?: string; key?: string }> = [];
  href = "";
  type = "";
  clicked = false;
  focused = false;
  onFocus: (() => void) | null = null;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  getAttribute(name: string): string | null {
    if (name === "id" && this.id) return this.id;
    if (name === "type" && this.type) return this.type;
    if (name === "href" && this.href) return this.href;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name]! : null;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
    if (name === "type") this.type = String(value);
    if (name === "href") this.href = String(value);
  }

  hasAttribute(name: string): boolean {
    if (name === "id") return Boolean(this.id);
    if (name === "type") return Boolean(this.type);
    if (name === "href") return Boolean(this.href);
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  appendChild(child: MockElement): MockElement {
    child.parentNode = this;
    this.children.push(child);
    this.childNodes.push(child);
    return child;
  }

  closest(selector: string): MockElement | null {
    if (this.matches(selector)) return this;
    let parent = this.parentNode;
    while (parent instanceof MockElement) {
      if (parent.matches(selector)) return parent;
      parent = parent.parentNode;
    }
    return null;
  }

  matches(selector: string): boolean {
    const sel = selector.trim();
    if (!sel) return false;
    if (sel.includes(",")) return sel.split(",").some((part) => this.matches(part.trim()));
    if (sel.startsWith(".")) return (this.attributes.class || "").split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    if (sel.includes("[")) {
      const m = /^([a-z0-9]*)\[([a-z0-9:-]+)(?:=\"([^\"]*)\")?\]$/i.exec(sel);
      if (!m) return false;
      if (m[1] && this.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
      const attr = m[2]!;
      if (m[3] !== undefined) return this.getAttribute(attr) === m[3];
      return this.hasAttribute(attr);
    }
    if (sel === "script" || sel === "style" || sel === "noscript" || sel === "template") {
      return this.tagName.toLowerCase() === sel;
    }
    if (sel === "body *") return this.tagName !== "BODY";
    if (sel.includes(" ")) {
      // descendant: "body *" already handled; treat as tag only last
      const last = sel.split(/\s+/).pop()!;
      return this.matches(last);
    }
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, width: 40, height: 16, top: 0, left: 0, right: 40, bottom: 16 };
  }

  focus() {
    this.focused = true;
    this.onFocus?.();
  }

  contains(node: MockNode): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  click() {
    this.clicked = true;
  }

  dispatchEvent(event: unknown) {
    const record = event as { type?: string; key?: string };
    this.events.push({ type: record?.type, key: record?.key });
    return true;
  }

  scrollIntoView() {
    // no-op
  }

  get outerHTML() {
    return `<${this.tagName.toLowerCase()}>${this.innerText || this.textContent || ""}</${this.tagName.toLowerCase()}>`;
  }
}

class MockHTMLElement extends MockElement {}
class MockHTMLInputElement extends MockHTMLElement {}
class MockHTMLTextAreaElement extends MockHTMLElement {}
class MockHTMLSelectElement extends MockHTMLElement {}

function createDomFixture() {
  const documentElement = new MockHTMLElement("html");
  const body = new MockHTMLElement("body");
  documentElement.appendChild(body);
  let activeElement: MockElement | null = null;
  let pointElement: MockElement | null = null;

  function el(tag: string, props: Record<string, string> = {}, text = ""): MockHTMLElement {
    let node: MockHTMLElement;
    const upper = tag.toUpperCase();
    if (upper === "INPUT") node = new MockHTMLInputElement(tag);
    else if (upper === "TEXTAREA") node = new MockHTMLTextAreaElement(tag);
    else if (upper === "SELECT") node = new MockHTMLSelectElement(tag);
    else node = new MockHTMLElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") {
        node.innerText = v;
        node.textContent = v;
      } else {
        node.setAttribute(k, v);
      }
    }
    if (text) {
      node.innerText = text;
      node.textContent = text;
    }
    if (props.href) node.href = props.href;
    if (props.type) node.type = props.type;
    if (props.value) node.value = props.value;
    if (props.contenteditable === "true") node.isContentEditable = true;
    node.onFocus = () => { activeElement = node; };
    body.appendChild(node);
    return node;
  }

  const benign = el("button", { role: "button", id: "save-draft" }, "Save draft");
  const destructive = el("button", { role: "button", id: "delete-account" }, "Delete account");
  const download = el("a", {
    id: "dl",
    href: "https://cdn.example.com/app.exe",
    download: "app.exe",
    role: "link",
  }, "Download installer");
  download.href = "https://cdn.example.com/app.exe";
  const password = el("input", { id: "pwd", type: "password", name: "password" });
  password.type = "password";
  const file = el("input", { id: "file", type: "file", name: "upload" });
  file.type = "file";
  const permission = el("button", { role: "button", id: "allow-cam" }, "Allow camera access");
  const payment = el("input", { id: "card", type: "text", name: "card_number", autocomplete: "cc-number" });
  const hidden = el("button", { role: "button", id: "hidden" }, "Hidden action");
  hidden.style.display = "none";
  const disabled = el("button", { role: "button", id: "disabled" }, "Disabled action");
  disabled.disabled = true;
  const covered = el("button", { role: "button", id: "covered" }, "Covered action");
  const overlay = el("div", { id: "overlay" }, "Overlay");
  const editor = el("div", { id: "editor", contenteditable: "true", "aria-label": "Editor" }, "Existing text");
  const textInput = el("input", { id: "semantic-input", type: "text", value: "old value" });
  const checkbox = el("input", { id: "semantic-checkbox", type: "checkbox" });
  const radio = el("input", { id: "semantic-radio", type: "radio" });
  const hoverTarget = el("button", { id: "hover-target", role: "button" }, "Open menu");
  const outerFieldset = el("fieldset", { id: "outer-fieldset" });
  outerFieldset.disabled = true;
  const innerFieldset = new MockHTMLElement("fieldset");
  const nestedDisabled = new MockHTMLInputElement("input");
  nestedDisabled.setAttribute("id", "nested-disabled");
  innerFieldset.appendChild(nestedDisabled);
  outerFieldset.appendChild(innerFieldset);

  const all = () => {
    const out: MockElement[] = [];
    const walk = (node: MockElement) => {
      out.push(node);
      for (const c of node.children) walk(c);
    };
    walk(body);
    return out;
  };
  Object.defineProperty(body, "innerText", {
    configurable: true,
    get: () => all().filter((node) => node !== body).map((node) => node.innerText || node.textContent || "").join(" "),
  });

  const document = {
    documentElement,
    body,
    title: "Fixture Page",
    readyState: "complete",
    get activeElement() {
      return activeElement;
    },
    elementFromPoint() {
      return pointElement;
    },
    querySelector(selector: string) {
      if (selector === "[") throw new Error("Invalid selector");
      return all().find((n) => n.matches(selector)) || null;
    },
    querySelectorAll(selector: string) {
      if (selector === "[") throw new Error("Invalid selector");
      if (selector === "body *") return all().filter((n) => n !== body);
      return all().filter((n) => n.matches(selector));
    },
  };

  const location = {
    href: "https://app.example.com/page",
    origin: "https://app.example.com",
    reload() {
      // no-op in smoke
    },
  };

  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    getComputedStyle(node: MockElement) {
      return {
        display: node.style.display || "block",
        visibility: node.style.visibility || "visible",
        opacity: node.style.opacity || "1",
      };
    },
  };

  return {
    document,
    location,
    window,
    nodes: { benign, destructive, download, password, file, permission, payment, hidden, disabled, covered, overlay, editor, nestedDisabled, textInput, checkbox, radio, hoverTarget },
    setPointElement(node: MockElement | null) {
      pointElement = node;
    },
  };
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private listeners = new Map<string, Set<Listener>>();
  onClientSend: ((data: string) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    });
  }

  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }

  send(data: string) {
    this.sent.push(String(data));
    try {
      this.onClientSend?.(String(data));
    } catch {
      // ignore test harness errors from auto-responders
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  emit(type: string, event?: unknown) {
    for (const fn of this.listeners.get(type) || []) {
      fn(event);
    }
  }

  receive(data: unknown) {
    this.emit("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

function createChromeMock(options: {
  contentMessageHandler?: (message: Record<string, unknown>) => Promise<unknown> | unknown;
}) {
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {
    bindings: {},
    primaryBySession: {},
    debugConsent: {},
    pendingRequest: null,
  };

  const runtimeListeners: Listener[] = [];
  const debuggerEvent = createEmitter();
  const debuggerDetach = createEmitter();
  const tabsRemoved = createEmitter();
  const tabsUpdated = createEmitter();
  let debuggerPermission = false;
  const attachedTabs = new Set<number>();

  const chrome = {
    storage: {
      local: {
        async get(keys: string[] | string) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in localStore) out[k] = localStore[k];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(localStore, values);
        },
        async remove(keys: string[] | string) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete localStore[k];
        },
      },
      session: {
        async get(keys: string[] | string) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in sessionStore) out[k] = sessionStore[k];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(sessionStore, values);
        },
      },
    },
    runtime: {
      id: "snail-pi-test-extension",
      getURL(path = "") {
        return `chrome-extension://snail-pi-test-extension/${path}`;
      },
      onMessage: {
        addListener(fn: Listener) {
          runtimeListeners.push(fn);
        },
      },
      sendMessage(message: Record<string, unknown>) {
        // Fan-out to runtime listeners (popup + content broadcast).
        return new Promise((resolve) => {
          let settled = false;
          const sendResponse = (value: unknown) => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          };
          let pendingAsync = false;
          for (const listener of runtimeListeners) {
            const ret = listener(message, {}, sendResponse);
            if (ret === true) pendingAsync = true;
          }
          if (!pendingAsync && !settled) resolve(undefined);
        });
      },
    },
    action: {
      async setBadgeText() {
        // no-op
      },
      async setBadgeBackgroundColor() {
        // no-op
      },
    },
    tabs: {
      async query() {
        return [{ id: 7, url: "https://app.example.com/page", title: "Fixture Page", windowId: 1 }];
      },
      async get(tabId: number) {
        return { id: tabId, url: "https://app.example.com/page", title: "Fixture Page", status: "complete", windowId: 1 };
      },
      async update() {
        return {};
      },
      async sendMessage(tabId: number, message: Record<string, unknown>) {
        void tabId;
        if (!options.contentMessageHandler) throw new Error("No content handler");
        return await options.contentMessageHandler(message);
      },
      async captureVisibleTab() {
        // Tiny 1x1 jpeg-ish payload under limits
        return "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z";
      },
      onRemoved: {
        addListener(fn: Listener) {
          tabsRemoved.addListener(fn);
        },
      },
      onUpdated: {
        addListener(fn: Listener) {
          tabsUpdated.addListener(fn);
        },
      },
    },
    scripting: {
      async executeScript() {
        return [{ result: true }];
      },
    },
    permissions: {
      async contains(req: { permissions?: string[] }) {
        if (req.permissions?.includes("debugger")) return debuggerPermission;
        return true;
      },
      async request(req: { permissions?: string[] }) {
        if (req.permissions?.includes("debugger")) {
          debuggerPermission = true;
          return true;
        }
        return false;
      },
    },
    debugger: {
      async attach(source: { tabId: number }) {
        if (!debuggerPermission) throw new Error("Optional debugger permission not granted");
        if (attachedTabs.has(source.tabId)) throw new Error("Debugger already attached by another client");
        attachedTabs.add(source.tabId);
      },
      async detach(source: { tabId: number }) {
        attachedTabs.delete(source.tabId);
      },
      async sendCommand() {
        return {};
      },
      onEvent: {
        addListener(fn: Listener) {
          debuggerEvent.addListener(fn);
        },
      },
      onDetach: {
        addListener(fn: Listener) {
          debuggerDetach.addListener(fn);
        },
      },
    },
    __test: {
      localStore,
      sessionStore,
      setDebuggerPermission(v: boolean) {
        debuggerPermission = v;
      },
      fireDebuggerEvent(source: { tabId: number }, method: string, params: unknown) {
        debuggerEvent.emitChrome(source, method, params);
      },
      runtimeListeners,
    },
  };

  return chrome;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkManifestAndAssets(): Promise<void> {
  const manifestPath = join(EXT_DIR, "manifest.json");
  assert(existsSync(manifestPath), "manifest.json missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    manifest_version: number;
    background?: { service_worker?: string; type?: string };
    action?: { default_popup?: string; default_icon?: Record<string, string> };
    permissions?: string[];
    optional_permissions?: string[];
    host_permissions?: string[];
    content_scripts?: unknown[];
    icons?: Record<string, string>;
    incognito?: string;
  };

  assert(manifest.manifest_version === 3, "MV3 required");
  assert(!manifest.content_scripts || manifest.content_scripts.length === 0, "no persistent content_scripts");
  const perms = manifest.permissions || [];
  const optional = manifest.optional_permissions || [];
  const hosts = manifest.host_permissions || [];
  assert(!perms.includes("<all_urls>"), "permissions must not include <all_urls>");
  assert(!hosts.includes("<all_urls>"), "host_permissions must not include <all_urls>");
  assert(!JSON.stringify(manifest).includes("<all_urls>"), "manifest must not mention <all_urls>");
  assert(!perms.includes("debugger"), "debugger must not be mandatory permission");
  assert(optional.includes("debugger"), "debugger must be optional_permissions");
  assert(perms.includes("activeTab"), "activeTab required");
  assert(perms.includes("scripting"), "scripting required");
  assert(perms.includes("storage"), "storage required");
  assert(hosts.every((h) => h.includes("127.0.0.1") || h.includes("localhost")), "hosts loopback only");
  assert(manifest.incognito === "not_allowed", "incognito not allowed");

  const referenced = new Set<string>();
  if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
  for (const icon of Object.values(manifest.action?.default_icon || {})) referenced.add(icon);
  for (const icon of Object.values(manifest.icons || {})) referenced.add(icon);

  // popup.html references
  const popupHtmlPath = join(EXT_DIR, manifest.action?.default_popup || "popup.html");
  const popupHtml = readFileSync(popupHtmlPath, "utf8");
  for (const match of popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const rel = match[1]!;
    if (rel.startsWith("http") || rel.startsWith("data:")) continue;
    referenced.add(rel);
  }

  // JS imports from background/popup + generated shared sources
  for (const entry of [
    "background.js",
    "popup.js",
    "content.js",
    "shared.js",
    "action-policy.js",
    "action-policy.inject.js",
    "redaction.js",
    "protocol-capabilities.js",
  ]) {
    referenced.add(entry);
  }

  for (const rel of referenced) {
    const abs = join(EXT_DIR, rel);
    assert(existsSync(abs), `referenced file missing: ${rel}`);
  }

  const backgroundSource = readFileSync(join(EXT_DIR, "background.js"), "utf8");
  assert(!backgroundSource.includes("${nextUrl}::nav"), "navigation document ids must not embed URLs");
  assert(
    backgroundSource.includes("acceptPendingForActiveTab(pairing.pending.pendingRequestId)"),
    "pairing click must auto-bind the pairing-targeted pending request",
  );
  const popupSource = readFileSync(join(EXT_DIR, "popup.js"), "utf8");
  assert(
    popupHtml.includes("Pair &amp; connect current tab") && popupSource.includes("Pairing & connecting…"),
    "popup must communicate the combined pairing and current-tab authorization",
  );

  // Generated files must declare their source marker.
  for (const file of ["action-policy.js", "action-policy.inject.js", "redaction.js", "protocol-capabilities.js"]) {
    const text = readFileSync(join(EXT_DIR, file), "utf8");
    assert(text.includes("GENERATED FILE"), `${file} missing generated marker`);
  }

  // Syntax-load service worker / content / popup / shared scripts via node --check
  for (const file of [
    "background.js",
    "content.js",
    "popup.js",
    "shared.js",
    "action-policy.js",
    "action-policy.inject.js",
    "redaction.js",
    "protocol-capabilities.js",
  ]) {
    const result = spawnSync(process.execPath, ["--check", join(EXT_DIR, file)], { encoding: "utf8" });
    assert(result.status === 0, `${file} syntax check failed: ${result.stderr || result.stdout}`);
  }

  const sourceProtocol = await import("../lib/browser-protocol");
  const generatedProtocol = await import(pathToFileURL(join(EXT_DIR, "protocol-capabilities.js")).href);
  assert(generatedProtocol.PROTOCOL_VERSION === sourceProtocol.BROWSER_PROTOCOL_VERSION, "generated protocol version matches source");
  assert(
    JSON.stringify(generatedProtocol.EXTENSION_FEATURES) === JSON.stringify(sourceProtocol.BROWSER_EXTENSION_FEATURES),
    "generated extension features match source",
  );
}

async function checkActionPolicyModule(): Promise<void> {
  const mod = await import(pathToFileURL(join(EXT_DIR, "action-policy.js")).href) as {
    evaluateActionPolicy: (input: Record<string, unknown>) => { allowed: boolean; reason?: string };
  };

  const blocked = [
    { action: "click", tagName: "input", type: "file" },
    { action: "type", tagName: "input", type: "password" },
    { action: "type", tagName: "input", name: "card_number" },
    { action: "click", tagName: "a", href: "https://x.test/app.exe", text: "Download" },
    { action: "click", tagName: "a", href: "https://x.test/a.pdf", download: true, text: "Get PDF" },
    { action: "click", role: "button", text: "Delete account" },
    { action: "click", role: "button", text: "Allow camera access" },
    { action: "click", role: "button", text: "Enable notifications" },
  ];
  for (const input of blocked) {
    const d = mod.evaluateActionPolicy(input);
    assert(!d.allowed, `expected block for ${JSON.stringify(input)} (${d.reason || "no reason"})`);
  }

  const allowed = mod.evaluateActionPolicy({
    action: "click",
    tagName: "button",
    role: "button",
    text: "Save draft",
  });
  assert(allowed.allowed, "benign control must be allowed");
}

async function checkContentScriptProductionPaths(): Promise<void> {
  const fixture = createDomFixture();
  const contentListeners: Listener[] = [];

  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn: Listener) {
          contentListeners.push(fn);
        },
      },
    },
  };

  class InputEventMock {
    type: string;
    bubbles: boolean;
    cancelable: boolean;
    inputType?: string;
    data?: string;
    constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean; inputType?: string; data?: string }) {
      this.type = type;
      this.bubbles = Boolean(init?.bubbles);
      this.cancelable = Boolean(init?.cancelable);
      this.inputType = init?.inputType;
      this.data = init?.data;
    }
  }

  const sandbox: Record<string, unknown> = {
    chrome,
    window: fixture.window,
    document: fixture.document,
    location: fixture.location,
    globalThis: null as unknown,
    self: null as unknown,
    HTMLElement: MockHTMLElement,
    Element: MockElement,
    HTMLInputElement: MockHTMLInputElement,
    HTMLTextAreaElement: MockHTMLTextAreaElement,
    HTMLSelectElement: MockHTMLSelectElement,
    Event: class Event {
      type: string;
      bubbles: boolean;
      constructor(type: string, init?: { bubbles?: boolean }) {
        this.type = type;
        this.bubbles = Boolean(init?.bubbles);
      }
    },
    InputEvent: InputEventMock,
    setTimeout,
    clearTimeout,
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    JSON,
    Date,
    TextEncoder,
    Error,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // content script assigns globalThis.__snailPiContentLoaded
  (sandbox as { __snailPiContentLoaded?: boolean }).__snailPiContentLoaded = false;

  // Mirror production inject order: policy IIFE then content.js
  const policyInject = readFileSync(join(EXT_DIR, "action-policy.inject.js"), "utf8");
  vm.runInNewContext(policyInject, sandbox, { filename: join(EXT_DIR, "action-policy.inject.js") });
  assert(
    typeof (sandbox as { __snailPiActionPolicy?: { evaluateActionPolicy?: unknown } }).__snailPiActionPolicy?.evaluateActionPolicy === "function",
    "action-policy.inject.js must install __snailPiActionPolicy",
  );

  const code = readFileSync(join(EXT_DIR, "content.js"), "utf8");
  vm.runInNewContext(code, sandbox, { filename: join(EXT_DIR, "content.js") });
  assert(contentListeners.length >= 1, "content.js registered onMessage listener");

  function sendContent(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("content response timeout")), 5000);
      let async = false;
      for (const listener of contentListeners) {
        const ret = listener(message, {}, (response: unknown) => {
          clearTimeout(timer);
          resolve((response || {}) as Record<string, unknown>);
        });
        if (ret === true) async = true;
      }
      if (!async) {
        clearTimeout(timer);
        reject(new Error("content listener did not request async response"));
      }
    });
  }

  const snap = await sendContent({ channel: "snail-pi-content", type: "snapshot", params: { format: "accessibility", maxNodes: 50 } });
  assert(typeof snap.documentId === "string" && snap.documentId.length > 0, "snapshot documentId");
  assert(!String(snap.documentId).includes("app.example.com"), "documentId is opaque and URL-free");
  assert(snap.origin === "https://app.example.com", "snapshot origin");

  async function findOne(text: string): Promise<string> {
    const found = await sendContent({
      channel: "snail-pi-content",
      type: "find",
      params: { text, limit: 5 },
    });
    const results = (found.results || []) as Array<{ elementRef?: string }>;
    assert(results.length >= 1, `find ${text}`);
    assert(results[0]?.elementRef, `ref for ${text}`);
    return results[0]!.elementRef!;
  }

  const benignRef = await findOne("Save draft");
  const destructiveRef = await findOne("Delete account");
  const downloadRef = await findOne("Download installer");
  const permissionRef = await findOne("Allow camera access");
  const hiddenRef = await findOne("Hidden action");
  const disabledRef = await findOne("Disabled action");
  const coveredRef = await findOne("Covered action");

  // Password / file inputs via css
  const pwdFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "input[type=\"password\"]", limit: 3 } });
  const pwdRef = ((pwdFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  assert(pwdRef, "password ref");
  const fileFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#file", limit: 3 } });
  const fileRef = ((fileFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  assert(fileRef, "file ref");

  const benignAct = await sendContent({
    channel: "snail-pi-content",
    type: "act",
    params: { action: "click", elementRef: benignRef },
  });
  assert(benignAct.ok === true, "benign click allowed");
  assert(fixture.nodes.benign.clicked, "benign clicked");

  const stateAfterClick = await sendContent({ channel: "snail-pi-content", type: "state", params: {} });
  assert(stateAfterClick.readyState === "complete", "state includes readyState");
  assert((stateAfterClick.focus as { role?: string })?.role === "button", "state includes bounded focus role");
  assert(!("value" in ((stateAfterClick.focus || {}) as Record<string, unknown>)), "focus never includes value");

  const wrongContext = await sendContent({
    channel: "snail-pi-content",
    type: "act",
    params: { action: "click", elementRef: "el_othercontext_1" },
  });
  assert(wrongContext.error === "WRONG_ELEMENT_CONTEXT", "cross-document ref rejected");

  const staleRef = await findOne("Save draft");
  fixture.nodes.benign.isConnected = false;
  const stale = await sendContent({
    channel: "snail-pi-content",
    type: "act",
    params: { action: "click", elementRef: staleRef },
  });
  assert(stale.error === "STALE_ELEMENT_REF", "detached ref rejected");
  fixture.nodes.benign.isConnected = true;

  const hidden = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "click", elementRef: hiddenRef } });
  assert(hidden.error === "ELEMENT_HIDDEN", "hidden control rejected");
  const disabled = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "click", elementRef: disabledRef } });
  assert(disabled.error === "ELEMENT_DISABLED", "disabled control rejected");
  const nestedDisabledFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#nested-disabled", limit: 1 } });
  const nestedDisabledRef = ((nestedDisabledFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  assert(nestedDisabledRef, "nested disabled ref");
  const nestedDisabledAct = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "click", elementRef: nestedDisabledRef } });
  assert(nestedDisabledAct.error === "ELEMENT_DISABLED", "disabled fieldset control rejected");
  fixture.setPointElement(fixture.nodes.overlay);
  const covered = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "click", elementRef: coveredRef } });
  fixture.setPointElement(null);
  assert(covered.error === "ELEMENT_COVERED", "covered control rejected");

  const editorFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#editor", limit: 1 } });
  const editorRef = ((editorFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  assert(editorRef, "contenteditable ref");
  const editorAct = await sendContent({
    channel: "snail-pi-content",
    type: "act",
    params: { action: "type", elementRef: editorRef, text: "content-secret", clearFirst: true },
  });
  assert(editorAct.ok === true, `contenteditable type allowed: ${JSON.stringify(editorAct)}`);
  const editorState = await sendContent({ channel: "snail-pi-content", type: "state", params: {} });
  assert(!JSON.stringify(editorState).includes("content-secret"), "contenteditable value never enters focus state");

  const semanticInputFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#semantic-input", limit: 1 } });
  const semanticInputRef = ((semanticInputFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  const checkboxFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#semantic-checkbox", limit: 1 } });
  const checkboxRef = ((checkboxFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  const radioFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#semantic-radio", limit: 1 } });
  const radioRef = ((radioFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  const hoverFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#hover-target", limit: 1 } });
  const hoverRef = ((hoverFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  assert(semanticInputRef && checkboxRef && radioRef && hoverRef, "semantic action refs");

  const filled = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "fill", elementRef: semanticInputRef, text: "replacement-value" } });
  assert(filled.ok === true && filled.changed === true, "fill replaces text");
  assert(fixture.nodes.textInput.value === "replacement-value", "fill value applied");
  assert(!JSON.stringify(filled).includes("replacement-value"), "fill result does not echo value");
  const cleared = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "clear", elementRef: semanticInputRef } });
  const clearedAgain = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "clear", elementRef: semanticInputRef } });
  assert(cleared.ok === true && cleared.changed === true, "clear changes non-empty input");
  assert(clearedAgain.ok === true && clearedAgain.changed === false, "clear is idempotent");

  const pressed = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "press", elementRef: semanticInputRef, key: "Enter", modifiers: ["Control"] } });
  assert(pressed.ok === true && pressed.key === "Enter", "press allowlisted key");
  assert(fixture.nodes.textInput.events.some((event) => event.type === "keydown" && event.key === "Enter"), "press dispatches keydown");
  const invalidPress = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "press", elementRef: semanticInputRef, key: "F12" } });
  assert(invalidPress.error === "INVALID_ACTION_TARGET", "press rejects arbitrary key");

  const checked = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "check", elementRef: checkboxRef } });
  const checkedAgain = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "check", elementRef: checkboxRef } });
  const unchecked = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "uncheck", elementRef: checkboxRef } });
  assert(checked.ok === true && checked.changed === true && checked.checked === true, "check changes checkbox");
  assert(checkedAgain.ok === true && checkedAgain.changed === false, "check is idempotent");
  assert(unchecked.ok === true && unchecked.changed === true && unchecked.checked === false, "uncheck changes checkbox");
  const radioUncheck = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "uncheck", elementRef: radioRef } });
  assert(radioUncheck.error === "INVALID_ACTION_TARGET", "radio cannot be unchecked");

  const hovered = await sendContent({ channel: "snail-pi-content", type: "act", params: { action: "hover", elementRef: hoverRef } });
  assert(hovered.ok === true && fixture.nodes.hoverTarget.events.some((event) => event.type === "mouseenter"), "hover dispatches pointer events");

  for (const [label, ref, action] of [
    ["destructive", destructiveRef, "click"],
    ["download", downloadRef, "click"],
    ["permission", permissionRef, "click"],
    ["password", pwdRef, "type"],
    ["file", fileRef, "click"],
  ] as const) {
    const result = await sendContent({
      channel: "snail-pi-content",
      type: "act",
      params: { action, elementRef: ref, text: action === "type" ? "secret" : undefined },
    });
  assert(result.error === "ACTION_BLOCKED", `${label} must be ACTION_BLOCKED, got ${JSON.stringify(result)}`);
  }

  const interactiveSnapshot = await sendContent({
    channel: "snail-pi-content",
    type: "snapshot",
    params: { format: "accessibility", mode: "interactive", maxNodes: 50 },
  });
  assert(interactiveSnapshot.mode === "interactive", "interactive snapshot mode");
  assert(!((interactiveSnapshot.root as { children?: Array<{ name?: string }> })?.children || []).some((node) => node.name === "Overlay"), "interactive snapshot omits non-actionable nodes");
  const scopedInputFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#semantic-input", limit: 1 } });
  const scopedInputRef = ((scopedInputFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  assert(scopedInputRef, "scoped snapshot ref");
  const scopedSnapshot = await sendContent({ channel: "snail-pi-content", type: "snapshot", params: { scopeElementRef: scopedInputRef, maxNodes: 10 } });
  assert((scopedSnapshot.root as { tag?: string })?.tag === "input", "scoped snapshot root");
  const nodeTruncated = await sendContent({ channel: "snail-pi-content", type: "snapshot", params: { maxNodes: 1 } });
  assert((nodeTruncated.truncation as { nodes?: boolean } | undefined)?.nodes === true, "snapshot node truncation metadata");
  const depthTruncated = await sendContent({ channel: "snail-pi-content", type: "snapshot", params: { maxDepth: 1, maxNodes: 50 } });
  assert((depthTruncated.truncation as { depth?: boolean } | undefined)?.depth === true, "snapshot depth truncation metadata");
  const textTruncated = await sendContent({ channel: "snail-pi-content", type: "snapshot", params: { format: "visible_text", maxTextChars: 100 } });
  assert((textTruncated.truncation as { text?: boolean } | undefined)?.text === true, "snapshot text truncation metadata");

  const clickableWait = await sendContent({ channel: "snail-pi-content", type: "wait", params: { condition: "clickable", value: "#semantic-input", timeoutMs: 1000 } });
  assert(clickableWait.ok === true && clickableWait.condition === "clickable", "clickable wait resolves");
  const urlPatternWait = await sendContent({ channel: "snail-pi-content", type: "wait", params: { condition: "url_pattern", value: "https://app.example.com/*", timeoutMs: 1000 } });
  assert(urlPatternWait.ok === true && urlPatternWait.condition === "url_pattern", "URL pattern wait resolves");
  const textChangeWait = await sendContent({ channel: "snail-pi-content", type: "wait", params: { condition: "text_change", selector: "#editor", value: "Existing text", timeoutMs: 1000 } });
  assert(textChangeWait.ok === true && textChangeWait.condition === "text_change", "text change wait resolves");
  const documentIdleWait = await sendContent({ channel: "snail-pi-content", type: "wait", params: { condition: "document_idle", value: "idle", timeoutMs: 1000 } });
  assert(documentIdleWait.ok === true && documentIdleWait.condition === "document_idle", "document idle wait resolves");
  const invalidWait = await sendContent({ channel: "snail-pi-content", type: "wait", params: { condition: "unknown", value: "x", timeoutMs: 1000 } });
  assert(invalidWait.error === "INVALID_WAIT_CONDITION", "invalid wait condition fails fast");
  const invalidSelectorWait = await sendContent({ channel: "snail-pi-content", type: "wait", params: { condition: "clickable", value: "[", timeoutMs: 1000 } });
  assert(invalidSelectorWait.error === "INVALID_SELECTOR", "invalid wait selector fails fast");

  const freshEditorFind = await sendContent({ channel: "snail-pi-content", type: "find", params: { css: "#editor", limit: 1 } });
  const freshEditorRef = ((freshEditorFind.results || []) as Array<{ elementRef: string }>)[0]?.elementRef;
  assert(freshEditorRef, "fresh editor ref");
  const replacedSnapshot = await sendContent({ channel: "snail-pi-content", type: "snapshot", params: { format: "accessibility", maxNodes: 10 } });
  assert(replacedSnapshot.contextId !== snap.contextId, "snapshot rotates ref context");
  const refAfterSnapshot = await sendContent({
    channel: "snail-pi-content",
    type: "act",
    params: { action: "click", elementRef: freshEditorRef },
  });
  assert(refAfterSnapshot.error === "STALE_ELEMENT_REF", "snapshot invalidates previous refs");

  // Cancel envelope aborts wait path in production content.js
  const waitReqId = "wait-req-1";
  const waitPromise = sendContent({
    channel: "snail-pi-content",
    type: "wait",
    requestId: waitReqId,
    params: { condition: "text", value: "this-text-never-appears-zz", timeoutMs: 5000 },
  });
  // Deliver cancel broadcast the same way background does.
  for (const listener of contentListeners) {
    listener({
      channel: "snail-pi-content-broadcast",
      type: "cancel",
      requestId: waitReqId,
    }, {}, () => undefined);
  }
  const waitResult = await waitPromise;
  assert(waitResult.error === "WAIT_CANCELLED", "cancelled wait has distinct code");
  assert(String(waitResult.message || "").toLowerCase().includes("cancel"), "cancel message");
}

async function checkBackgroundProductionPaths(): Promise<void> {
  // Isolate module load with globals installed first.
  const contentHandlers: Array<(message: Record<string, unknown>) => Promise<Record<string, unknown>>> = [];
  let activeContentHandler: ((message: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;

  const chrome = createChromeMock({
    contentMessageHandler: async (message) => {
      if (activeContentHandler) return activeContentHandler(message);
      if (message.type === "meta" || message.type === "state") {
        return {
          documentId: "doc-a",
          contextId: "ctx-a",
          url: "https://app.example.com/page",
          title: "Fixture Page",
          origin: "https://app.example.com",
          readyState: "complete",
          mutationVersion: 0,
          focus: null,
        };
      }
      if (message.type === "wait") {
        // Long wait so cancel can land first if requested.
        await sleep(800);
        return { ok: true, waitedMs: 800 };
      }
      if (message.type === "snapshot") {
        return {
          documentId: "doc-a",
          url: "https://app.example.com/page",
          title: "Fixture Page",
          origin: "https://app.example.com",
          root: { ref: "el_1", tag: "body", children: [] },
          nodeCount: 1,
        };
      }
      if (message.type === "act") {
        return { ok: true };
      }
      return { ok: true };
    },
  });

  // Seed install before importing background (startup auto-connects).
  const clientId = "ext_test_client_1";
  const installationSecret = "test-install-secret-value";
  await chrome.storage.local.set({
    clientId,
    installationSecret,
    webPort: 62666,
    bridgePort: 62667,
    pairedAt: Date.now(),
  });

  MockWebSocket.instances = [];
  const g = globalThis as unknown as {
    chrome?: unknown;
    WebSocket?: unknown;
    fetch: typeof fetch;
  };
  const previous = {
    chrome: g.chrome,
    WebSocket: g.WebSocket,
    fetch: g.fetch,
  };

  g.chrome = chrome;
  g.WebSocket = MockWebSocket;

  const connectToken = "connect-token-test";
  const nonce = "nonce-test";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/browser/pair") && init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}")) as { action?: string };
      if (body.action === "connect_token") {
        return new Response(JSON.stringify({
          port: 62667,
          connectToken,
          nonce,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: "unexpected fetch " + url }), { status: 500 });
  }) as typeof fetch;

  const pendingResponses = new Map<string, (msg: Record<string, unknown>) => void>();

  function attachAutoResponder(ws: MockWebSocket) {
    ws.onClientSend = (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.type === "auth") {
        // Background expects auth_ok after challenge.
        queueMicrotask(() => {
          ws.receive({ type: "auth_ok", protocolVersion: 1 });
        });
        return;
      }

      if (msg.kind === "request") {
        const payload = (msg.payload || {}) as { command?: string };
        // Auto-answer extension-originated client requests (reconcile/pending).
        queueMicrotask(() => {
          ws.receive({
            protocolVersion: 1,
            kind: "response",
            requestId: msg.requestId,
            clientId,
            timestamp: Date.now(),
            payload: {
              ok: true,
              result: payload.command === "reconcile"
                ? { bindings: [], pending: null }
                : payload.command === "binding.pending"
                  ? { pending: null }
                  : {},
            },
          });
        });
        return;
      }

      if (msg.kind === "response") {
        const resolver = pendingResponses.get(String(msg.requestId));
        if (resolver) {
          pendingResponses.delete(String(msg.requestId));
          resolver(msg);
        }
      }
    };
  }

  // Import production service worker (side effects: listeners + connect).
  // Cache-bust so repeated runs in same process still execute startup.
  const bgUrl = pathToFileURL(join(EXT_DIR, "background.js")).href + `?t=${Date.now()}`;
  await import(bgUrl);

  const ws = await waitFor(() => MockWebSocket.instances[0] || null, 3000);
  attachAutoResponder(ws);
  // If open already fired before attach, auth may still be pending — poke open path if needed.
  if (ws.sent.length === 0 && ws.readyState === MockWebSocket.OPEN) {
    // Startup connect may still be awaiting fetch; wait for auth send.
  }
  await waitFor(() => ws.sent.some((s) => s.includes("\"type\":\"auth\"")), 3000);

  // Ensure auth_ok processed (auto-responder handles it).
  await sleep(50);
  // Reconcile clears temporary state — seed binding after auth/reconcile.
  await sleep(50);

  const bindingId = "bind_1";
  const sessionId = "sess_a";
  const documentId = "doc-a";
  const origin = "https://app.example.com";
  const tabId = 7;

  await chrome.storage.session.set({
    bindings: {
      [bindingId]: {
        bindingId,
        sessionId,
        tabId,
        documentId,
        origin,
        title: "Fixture Page",
        url: `${origin}/page`,
        capabilities: ["dom"],
        state: "active_dom",
      },
    },
    primaryBySession: { [sessionId]: bindingId },
    debugConsent: {},
    pendingRequest: null,
  });

  function sendExtensionRequest(payload: Record<string, unknown>, requestId: string = randomUUID()): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (msg: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        pendingResponses.delete(requestId);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        pendingResponses.delete(requestId);
        reject(new Error(`no response for ${requestId}`));
      }, 5000);
      pendingResponses.set(requestId, finish);
      // Track responses also from ws.sent polling in case onClientSend order differs
      const poll = setInterval(() => {
        for (const raw of ws.sent) {
          try {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            if (msg.kind === "response" && msg.requestId === requestId) {
              finish(msg);
              return;
            }
          } catch {
            // ignore
          }
        }
      }, 15);
      ws.receive({
        protocolVersion: 1,
        kind: "request",
        requestId,
        clientId,
        timestamp: Date.now(),
        payload,
      });
    });
  }

  async function commandResult(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resp = await sendExtensionRequest(payload);
    return (resp.payload || {}) as Record<string, unknown>;
  }

  // Authorization rejections before debugger/script execution
  const cases: Array<{ name: string; payload: Record<string, unknown>; code: string }> = [
    {
      name: "missing binding",
      payload: {
        command: "page.snapshot",
        bindingId: "missing",
        sessionId,
        params: { __tabId: tabId, __documentId: documentId, __origin: origin },
      },
      code: "BINDING_NOT_FOUND",
    },
    {
      name: "wrong session",
      payload: {
        command: "page.snapshot",
        bindingId,
        sessionId: "sess_other",
        params: { __tabId: tabId, __documentId: documentId, __origin: origin },
      },
      code: "BINDING_NOT_FOUND",
    },
    {
      name: "wrong tab",
      payload: {
        command: "page.snapshot",
        bindingId,
        sessionId,
        params: { __tabId: 999, __documentId: documentId, __origin: origin },
      },
      code: "DOCUMENT_CHANGED",
    },
    {
      name: "wrong document",
      payload: {
        command: "page.snapshot",
        bindingId,
        sessionId,
        params: { __tabId: tabId, __documentId: "doc-stale", __origin: origin },
      },
      code: "DOCUMENT_CHANGED",
    },
    {
      name: "wrong origin",
      payload: {
        command: "page.snapshot",
        bindingId,
        sessionId,
        params: { __tabId: tabId, __documentId: documentId, __origin: "https://evil.example" },
      },
      code: "BINDING_SUSPENDED",
    },
    {
      name: "missing routing identities",
      payload: {
        command: "page.snapshot",
        bindingId,
        sessionId,
        params: {},
      },
      code: "DOCUMENT_CHANGED",
    },
    {
      name: "missing sessionId",
      payload: {
        command: "page.snapshot",
        bindingId,
        params: { __tabId: tabId, __documentId: documentId, __origin: origin },
      },
      code: "BINDING_NOT_FOUND",
    },
  ];

  for (const c of cases) {
    const result = await commandResult(c.payload);
    assert(result.ok === false, `${c.name}: expected failure`);
    const err = result.error as { code?: string } | undefined;
    assert(err?.code === c.code, `${c.name}: expected ${c.code}, got ${err?.code}`);
  }

  // binding.revoke / disable_debug must authorize before side effects.
  const revokeWrongSession = await commandResult({
    command: "binding.revoke",
    bindingId,
    sessionId: "sess_other",
    params: { __tabId: tabId },
  });
  assert((revokeWrongSession.error as { code?: string })?.code === "BINDING_NOT_FOUND", "revoke wrong session rejected");
  // Binding must still exist after rejected revoke.
  {
    const still = await chrome.storage.session.get(["bindings"]);
    assert((still.bindings as Record<string, unknown>)?.[bindingId], "binding remains after rejected revoke");
  }
  const disableWrongSession = await commandResult({
    command: "binding.disable_debug",
    bindingId,
    sessionId: "sess_other",
    params: { __tabId: tabId },
  });
  assert((disableWrongSession.error as { code?: string })?.code === "BINDING_NOT_FOUND", "disable_debug wrong session rejected");

  // Stale / non-operable binding state
  await chrome.storage.session.set({
    bindings: {
      [bindingId]: {
        bindingId,
        sessionId,
        tabId,
        documentId,
        origin,
        capabilities: ["dom"],
        state: "suspended",
      },
    },
    primaryBySession: { [sessionId]: bindingId },
    debugConsent: {},
    pendingRequest: null,
  });
  const suspended = await commandResult({
    command: "page.snapshot",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin },
  });
  assert((suspended.error as { code?: string })?.code === "BINDING_SUSPENDED", "suspended rejected");

  // Restore active binding for capability check
  await chrome.storage.session.set({
    bindings: {
      [bindingId]: {
        bindingId,
        sessionId,
        tabId,
        documentId,
        origin,
        capabilities: ["dom"],
        state: "active_dom",
      },
    },
    primaryBySession: { [sessionId]: bindingId },
    debugConsent: {},
    pendingRequest: null,
  });

  // Wrong capability: page.console without debug_readonly must fail before returning data
  const noCap = await commandResult({
    command: "page.console",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin },
  });
  assert((noCap.error as { code?: string })?.code === "CAPABILITY_REQUIRED", "console requires capability");

  // enable_debug without consent/permission rejected (no debugger attach)
  const noDebug = await commandResult({
    command: "binding.enable_debug",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin },
  });
  assert((noDebug.error as { code?: string })?.code === "CAPABILITY_REQUIRED", "debug consent required");

  // Authorized snapshot reaches content script path
  const okSnap = await commandResult({
    command: "page.snapshot",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin, format: "accessibility" },
  });
  assert(okSnap.ok === true, "authorized snapshot ok");

  const actionState = await commandResult({
    command: "page.act",
    bindingId,
    sessionId,
    params: {
      __tabId: tabId,
      __documentId: documentId,
      __origin: origin,
      action: "type",
      elementRef: "el_ctx-a_1",
      text: "never-echo-this-value",
    },
  });
  assert(actionState.ok === true, `authorized action ok: ${JSON.stringify(actionState)}`);
  const actionPayload = actionState.result as {
    completed?: boolean;
    postAction?: { stabilization?: string; state?: { url?: string; readyState?: string }; changes?: { changed?: boolean } };
  };
  assert(actionPayload.completed === true, "action reports completion");
  assert(actionPayload.postAction?.stabilization === "settled", "action state settles after two stable reads");
  assert(actionPayload.postAction?.state?.readyState === "complete", "action state includes loading status");
  assert(typeof actionPayload.postAction?.changes?.changed === "boolean", "action state includes change indicator");
  assert(!JSON.stringify(actionState).includes("never-echo-this-value"), "action response never echoes typed value");

  const loadingTabsGet = chrome.tabs.get.bind(chrome.tabs);
  chrome.tabs.get = async (id: number) => ({
    id,
    url: `${origin}/page/loading`,
    title: "Loading Page",
    status: "loading",
    windowId: 1,
  });
  activeContentHandler = async (message) => {
    if (message.type === "state") {
      return {
        documentId,
        contextId: "ctx-a",
        url: `${origin}/page/loading`,
        title: "Loading Page",
        origin,
        readyState: "complete",
        mutationVersion: 0,
        focus: null,
      };
    }
    return { ok: true };
  };
  try {
    const loadingAction = await commandResult({
      command: "page.act",
      bindingId,
      sessionId,
      params: { __tabId: tabId, __documentId: documentId, __origin: origin, action: "click", elementRef: "el_ctx-a_1" },
    });
    assert(
      (loadingAction.result as { postAction?: { stabilization?: string } })?.postAction?.stabilization === "pending",
      "tab loading keeps stabilization pending",
    );
  } finally {
    activeContentHandler = null;
    chrome.tabs.get = loadingTabsGet;
  }

  activeContentHandler = async (message) => {
    if (message.type === "state") {
      return {
        documentId: "doc-new",
        contextId: "ctx-new",
        url: `${origin}/next`,
        title: "Next Page",
        origin,
        readyState: "complete",
        mutationVersion: 0,
        focus: null,
      };
    }
    throw new Error("stale ref must fail before DOM action dispatch");
  };
  const staleAfterNavigation = await commandResult({
    command: "page.act",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin, action: "click", elementRef: "el_ctx-a_1" },
  });
  assert((staleAfterNavigation.error as { code?: string })?.code === "STALE_ELEMENT_REF", "post-navigation ref is stale");
  assert(
    (staleAfterNavigation.error as { details?: { reason?: string } })?.details?.reason === "document_changed",
    "stale navigation diagnostic includes reason",
  );

  activeContentHandler = async (message) => {
    if (message.type === "state") {
      return {
        documentId,
        contextId: "ctx-a",
        url: `${origin}/page?token=diagnostic-secret`,
        title: "Fixture Page",
        origin,
        readyState: "complete",
        mutationVersion: 0,
        focus: null,
      };
    }
    if (message.type === "act") {
      return { error: "ELEMENT_COVERED", message: "Target element is covered", details: { reason: "covered" } };
    }
    return { ok: true };
  };
  const coveredDiagnostic = await commandResult({
    command: "page.act",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin, action: "click", elementRef: "el_ctx-a_1" },
  });
  assert((coveredDiagnostic.error as { code?: string })?.code === "ELEMENT_COVERED", "covered action keeps typed code");
  const coveredDetails = (coveredDiagnostic.error as { details?: { reason?: string; url?: string; title?: string } })?.details;
  assert(coveredDetails?.reason === "covered", "covered diagnostic includes reason");
  assert(coveredDetails?.title === "Fixture Page", "covered diagnostic includes bounded title");
  assert(!String(coveredDetails?.url || "").includes("diagnostic-secret"), "diagnostic URL is redacted");

  let navigated = false;
  const originalActionTabsGet = chrome.tabs.get.bind(chrome.tabs);
  chrome.tabs.get = async (id: number) => ({
    id,
    url: navigated ? "https://other.example/next?token=navigation-secret" : `${origin}/page`,
    title: navigated ? "Other Page" : "Fixture Page",
    status: navigated ? "loading" : "complete",
    windowId: 1,
  });
  activeContentHandler = async (message) => {
    if (message.type === "state") {
      return {
        documentId,
        contextId: "ctx-a",
        url: `${origin}/page`,
        title: "Fixture Page",
        origin,
        readyState: "complete",
        mutationVersion: 0,
        focus: null,
      };
    }
    if (message.type === "act") {
      navigated = true;
      return { ok: true };
    }
    return { ok: true };
  };
  try {
    const navigationAction = await commandResult({
      command: "page.act",
      bindingId,
      sessionId,
      params: { __tabId: tabId, __documentId: documentId, __origin: origin, action: "click", elementRef: "el_ctx-a_1" },
    });
    const navigationPost = (navigationAction.result as {
      postAction?: { stabilization?: string; state?: { url?: string }; changes?: { documentChanged?: boolean; urlChanged?: boolean } };
    })?.postAction;
    assert(navigationPost?.stabilization === "pending", "cross-origin navigation remains pending");
    assert(navigationPost?.changes?.documentChanged === true, "navigation reports document change");
    assert(navigationPost?.changes?.urlChanged === true, "navigation reports URL change");
    assert(!String(navigationPost?.state?.url || "").includes("navigation-secret"), "post-action URL is redacted");
  } finally {
    activeContentHandler = null;
    chrome.tabs.get = originalActionTabsGet;
  }

  // Console/exception redaction via production debugger event path
  chrome.__test.setDebuggerPermission(true);
  await chrome.storage.session.set({
    bindings: {
      [bindingId]: {
        bindingId,
        sessionId,
        tabId,
        documentId,
        origin,
        capabilities: ["dom"],
        state: "active_dom",
      },
    },
    primaryBySession: { [sessionId]: bindingId },
    debugConsent: { [bindingId]: { at: Date.now() } },
    pendingRequest: null,
  });
  const enabled = await commandResult({
    command: "binding.enable_debug",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin },
  });
  assert(enabled.ok === true, "enable debug with consent");

  chrome.__test.fireDebuggerEvent({ tabId }, "Runtime.consoleAPICalled", {
    type: "log",
    args: [
      { value: "authorization: Bearer super-secret-token api_key=xyz cookie: a=b" },
    ],
  });
  chrome.__test.fireDebuggerEvent({ tabId }, "Runtime.exceptionThrown", {
    exceptionDetails: {
      text: "boom",
      exception: { description: "Error: token=eyJhbGciOiJIUzI1NiJ9.aaa.bbb password=hunter2" },
      stackTrace: {
        callFrames: [{
          functionName: "x",
          url: "https://app.example.com/a.js?token=stack-query-secret",
          lineNumber: 1,
        }],
      },
    },
  });
  // Network method tracking: POST must not be reported as GET.
  chrome.__test.fireDebuggerEvent({ tabId }, "Network.requestWillBeSent", {
    requestId: "req-post-1",
    request: { url: "https://api.example.com/v1?api_key=net-secret", method: "POST" },
  });
  chrome.__test.fireDebuggerEvent({ tabId }, "Network.responseReceived", {
    requestId: "req-post-1",
    type: "Fetch",
    response: { url: "https://api.example.com/v1?api_key=net-secret", status: 201, timing: { receiveHeadersEnd: 12 } },
  });
  chrome.__test.fireDebuggerEvent({ tabId }, "Network.loadingFinished", {
    requestId: "req-post-1",
  });

  // responseReceived then loadingFailed must still report POST (method map not deleted early).
  chrome.__test.fireDebuggerEvent({ tabId }, "Network.requestWillBeSent", {
    requestId: "req-post-fail-1",
    request: { url: "https://api.example.com/fail?api_key=net-secret", method: "POST" },
  });
  chrome.__test.fireDebuggerEvent({ tabId }, "Network.responseReceived", {
    requestId: "req-post-fail-1",
    type: "Fetch",
    response: { url: "https://api.example.com/fail?api_key=net-secret", status: 200, timing: { receiveHeadersEnd: 8 } },
  });
  chrome.__test.fireDebuggerEvent({ tabId }, "Network.loadingFailed", {
    requestId: "req-post-fail-1",
    type: "Fetch",
    errorText: "net::ERR_FAILED",
  });

  // Give async listener a tick
  await sleep(20);

  const consoleResult = await commandResult({
    command: "page.console",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin, limit: 20 },
  });
  assert(consoleResult.ok === true, "console ok");
  const items = ((consoleResult.result as { items?: Array<{ text?: string }> })?.items) || [];
  assert(items.length >= 2, "console items present");
  const joined = items.map((i) => i.text || "").join("\n");
  assert(joined.includes("[redacted]") || joined.includes("Bearer [redacted]"), "console redacted marker");
  assert(!joined.includes("super-secret-token"), "no bearer secret");
  assert(!joined.includes("api_key=xyz"), "no api key");
  assert(!joined.includes("password=hunter2"), "no password in exception");
  assert(!joined.includes("eyJhbGciOiJIUzI1NiJ9"), "no jwt");
  assert(!joined.includes("stack-query-secret"), "no stack URL query secret");

  const networkResult = await commandResult({
    command: "page.network",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin, limit: 20 },
  });
  assert(networkResult.ok === true, "network ok");
  const netItems = ((networkResult.result as { items?: Array<{ method?: string; url?: string; failed?: boolean; errorText?: string }> })?.items) || [];
  assert(netItems.some((n) => n.method === "POST"), "network method tracks POST from requestWillBeSent");
  assert(
    netItems.some((n) => n.method === "POST" && n.failed === true && String(n.errorText || "").includes("ERR_FAILED")),
    "response-then-loadingFailed still reports POST",
  );
  assert(netItems.every((n) => !String(n.url || "").includes("net-secret")), "network URL credentials redacted");

  // Screenshot metadata must redact URL query credentials.
  const originalTabsGet = chrome.tabs.get.bind(chrome.tabs);
  chrome.tabs.get = async (id: number) => ({
    id,
    url: "https://app.example.com/page?token=shot-secret&q=1",
    title: "Fixture Page",
    status: "complete",
    windowId: 1,
  });
  try {
    const shot = await commandResult({
      command: "page.screenshot",
      bindingId,
      sessionId,
      params: { __tabId: tabId, __documentId: documentId, __origin: origin },
    });
    assert(shot.ok === true, `screenshot ok: ${JSON.stringify(shot)}`);
    const shotUrl = String((shot.result as { url?: string })?.url || "");
    assert(!shotUrl.includes("shot-secret"), "screenshot url redacts token");
    assert(/(\[redacted\]|%5Bredacted%5D)/i.test(shotUrl), "screenshot url has redaction marker");
  } finally {
    chrome.tabs.get = originalTabsGet;
  }

  activeContentHandler = async (message) => {
    if (message.type === "wait") {
      return {
        error: "WAIT_TIMEOUT",
        message: "Wait condition not met",
        waitedMs: 123,
        condition: "clickable",
        state: {
          documentId: "doc-a",
          contextId: "ctx-a",
          url: "https://app.example.com/page?token=wait-secret",
          title: "Fixture Page",
          readyState: "complete",
          mutationVersion: 0,
          focus: null,
        },
      };
    }
    return { ok: true };
  };
  const waitTimeoutResponse = await commandResult({
    command: "page.wait",
    bindingId,
    sessionId,
    params: { __tabId: tabId, __documentId: documentId, __origin: origin, condition: "clickable", value: "#missing", timeoutMs: 1000 },
  });
  assert((waitTimeoutResponse.error as { code?: string })?.code === "WAIT_TIMEOUT", "wait timeout typed code");
  const waitTimeoutDetails = (waitTimeoutResponse.error as { details?: { condition?: string; elapsedMs?: number; state?: { url?: string } } })?.details;
  assert(waitTimeoutDetails?.condition === "clickable" && waitTimeoutDetails.elapsedMs === 123, "wait timeout details bounded");
  assert(!String(waitTimeoutDetails?.state?.url || "").includes("wait-secret"), "wait timeout state URL redacted");
  activeContentHandler = null;

  // Cancel envelope aborts in-flight wait via tabs.sendMessage (not runtime.sendMessage).
  activeContentHandler = async (message) => {
    if (message.type === "wait") {
      // Simulate content wait that ends when background cancel is delivered to the tab.
      const requestId = String(message.requestId || "");
      return await new Promise((resolve) => {
        const started = Date.now();
        const check = () => {
          if ((chrome as { __cancelIds?: Set<string> }).__cancelIds?.has(requestId)) {
            resolve({ error: "WAIT_CANCELLED", message: "Wait cancelled", waitedMs: Date.now() - started });
            return;
          }
          if (Date.now() - started > 2500) {
            resolve({ ok: true, waitedMs: Date.now() - started });
            return;
          }
          setTimeout(check, 20);
        };
        check();
      });
    }
    return { ok: true };
  };

  (chrome as { __cancelIds?: Set<string> }).__cancelIds = new Set();
  const realTabsSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
  chrome.tabs.sendMessage = async (tabId: number, message: Record<string, unknown>) => {
    if (message?.channel === "snail-pi-content-broadcast" && message.type === "cancel" && message.requestId) {
      (chrome as { __cancelIds?: Set<string> }).__cancelIds!.add(String(message.requestId));
      return undefined;
    }
    return await realTabsSendMessage(tabId, message);
  };

  const waitRequestId = "cancel-wait-req";
  const waitRespPromise = sendExtensionRequest({
    command: "page.wait",
    bindingId,
    sessionId,
    params: {
      __tabId: tabId,
      __documentId: documentId,
      __origin: origin,
      condition: "text",
      value: "never-match",
      timeoutMs: 5000,
    },
  }, waitRequestId);

  await sleep(40);
  ws.receive({
    protocolVersion: 1,
    kind: "cancel",
    requestId: waitRequestId,
    clientId,
    timestamp: Date.now(),
    payload: {},
  });

  const waitResp = await waitRespPromise;
  const waitPayload = (waitResp.payload || {}) as { ok?: boolean; error?: { code?: string; message?: string } };
  assert(waitPayload.ok === false, "cancelled wait not ok");
  assert(waitPayload.error?.code === "WAIT_CANCELLED", "cancel maps to WAIT_CANCELLED");

  // Popup channel is loadable (status handler responds)
  const status = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("popup status timeout")), 3000);
    for (const listener of chrome.__test.runtimeListeners) {
      const ret = listener({ channel: "snail-pi-popup", type: "status" }, {}, (response: unknown) => {
        clearTimeout(timer);
        resolve((response || {}) as Record<string, unknown>);
      });
      if (ret === true) return;
    }
    clearTimeout(timer);
    reject(new Error("no popup listener"));
  });
  assert(status.install && (status.install as { clientId?: string }).clientId === clientId, "popup status install");
  assert(Array.isArray(status.bindings), "popup status bindings");

  // Shared authorize helper still matches production semantics (import production module).
  const shared = await import(pathToFileURL(join(EXT_DIR, "shared.js")).href + `?t=${Date.now()}`) as {
    authorizeLocalBinding: (
      state: unknown,
      payload: Record<string, unknown>,
      params?: Record<string, unknown>,
      options?: { mode?: string },
    ) => { ok: boolean; code?: string };
    sanitizeConsoleText: (text: string) => string;
    redactUrl: (url: string) => string;
  };
  const authState = {
    bindings: {
      [bindingId]: {
        bindingId,
        sessionId,
        tabId,
        documentId,
        origin,
        capabilities: ["dom"],
        state: "active_dom",
      },
    },
  };
  assert(shared.authorizeLocalBinding(authState, { bindingId, sessionId }, {
    __tabId: tabId,
    __documentId: documentId,
    __origin: origin,
  }).ok, "shared auth ok");
  assert(!shared.authorizeLocalBinding(authState, { bindingId, sessionId }, { __tabId: 1 }).ok, "shared tab reject");
  assert(!shared.authorizeLocalBinding(authState, { bindingId, sessionId }, {}).ok, "shared missing identities reject");
  assert(shared.authorizeLocalBinding(authState, { bindingId, sessionId }, {}, { mode: "manage" }).ok, "shared manage ok");
  const redacted = shared.sanitizeConsoleText("Bearer abc.def.ghi api_key=zzz token=plain-secret");
  assert(redacted.includes("[redacted]"), "shared sanitize");
  assert(!redacted.includes("zzz"), "shared no secret");
  assert(!redacted.includes("plain-secret"), "shared plain token redacted");
  assert(!shared.redactUrl("https://x.test?token=abc").includes("abc"), "shared redactUrl");

  // Cross-origin suspension must stay suspended until explicit resume (no passive auto-resume).
  await chrome.storage.session.set({
    bindings: {
      [bindingId]: {
        bindingId,
        sessionId,
        tabId,
        documentId: "doc-new",
        origin: "https://other.example",
        title: "Other",
        url: "https://other.example/",
        capabilities: ["dom"],
        state: "suspended",
      },
    },
    primaryBySession: { [sessionId]: bindingId },
    debugConsent: {},
    pendingRequest: null,
  });
  const blockedWhileSuspended = await commandResult({
    command: "page.snapshot",
    bindingId,
    sessionId,
    params: {
      __tabId: tabId,
      __documentId: "doc-new",
      __origin: "https://other.example",
    },
  });
  assert(
    (blockedWhileSuspended.error as { code?: string })?.code === "BINDING_SUSPENDED",
    "suspended page command blocked",
  );

  // Explicit popup resume path.
  const originalTabsGet2 = chrome.tabs.get.bind(chrome.tabs);
  chrome.tabs.get = async (id: number) => ({
    id,
    url: "https://other.example/confirmed",
    title: "Confirmed",
    status: "complete",
    windowId: 1,
  });
  activeContentHandler = async (message) => {
    if (message.type === "meta") {
      return {
        documentId: "doc-resumed",
        url: "https://other.example/confirmed",
        title: "Confirmed",
        origin: "https://other.example",
      };
    }
    return { ok: true };
  };
  try {
    const resumeStatus = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("resume timeout")), 3000);
      for (const listener of chrome.__test.runtimeListeners) {
        const ret = listener({ channel: "snail-pi-popup", type: "resume", bindingId }, {}, (response: unknown) => {
          clearTimeout(timer);
          resolve((response || {}) as Record<string, unknown>);
        });
        if (ret === true) return;
      }
      clearTimeout(timer);
      reject(new Error("no resume listener"));
    });
    assert(resumeStatus.ok === true, `explicit resume ok: ${JSON.stringify(resumeStatus)}`);
    const afterResume = await chrome.storage.session.get(["bindings"]);
    const resumedBinding = (afterResume.bindings as Record<string, { state?: string; documentId?: string }>)?.[bindingId];
    assert(resumedBinding?.state === "active_dom", "resume sets active_dom");
    assert(resumedBinding?.documentId === "doc-resumed", "resume updates documentId");
    // binding.resumed event should have been emitted on the socket.
    assert(
      ws.sent.some((s) => s.includes("binding.resumed")),
      "binding.resumed event emitted",
    );
  } finally {
    chrome.tabs.get = originalTabsGet2;
  }

  // expected hash used by handshake — ensure production computed something
  const expected = createHash("sha256")
    .update(`snail-pi-browser-v1:${nonce}:${connectToken}`)
    .digest("hex");
  assert(ws.sent.some((s) => s.includes(expected) || s.includes("auth")), "auth handshake sent");

  // Unpair clears install + temporary state so reconnect/heartbeat timers stop.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 1500);
    for (const listener of chrome.__test.runtimeListeners) {
      const ret = listener({ channel: "snail-pi-popup", type: "unpair" }, {}, () => {
        clearTimeout(timer);
        resolve();
      });
      if (ret === true) return;
    }
    clearTimeout(timer);
    resolve();
  });
  for (const instance of MockWebSocket.instances) {
    try { instance.close(); } catch { /* ignore */ }
  }

  // Restore globals
  if (previous.chrome === undefined) delete g.chrome;
  else g.chrome = previous.chrome;
  if (previous.WebSocket === undefined) delete g.WebSocket;
  else g.WebSocket = previous.WebSocket;
  g.fetch = previous.fetch;

  void contentHandlers;
}

async function main(): Promise<void> {
  let failed = 0;
  async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`fail - ${name}:`, error instanceof Error ? error.message : error);
    }
  }

  assert(existsSync(EXT_DIR), `extension dir missing: ${EXT_DIR}`);

  await check("manifest.json security + referenced assets + syntax", checkManifestAndAssets);
  await check("production action-policy.js blocks/allows controls", checkActionPolicyModule);
  await check("production content.js authz paths: policy + cancel wait", checkContentScriptProductionPaths);
  await check("production background.js authz/redaction/cancel/popup", checkBackgroundProductionPaths);

  if (failed > 0) {
    console.error(`\n${failed} chrome extension artifact smoke check(s) failed`);
    process.exit(1);
  }
  console.log("\nall chrome extension artifact smoke checks passed");
  // Force exit: production background.js may retain reconnect timers across mocks.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
