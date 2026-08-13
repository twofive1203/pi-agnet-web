"use strict";

"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/automation-extension-runtime.ts
var automation_extension_runtime_exports = {};
__export(automation_extension_runtime_exports, {
  createDiscoveryExtensionApi: () => createDiscoveryExtensionApi,
  discoverExtensionRegistrationFromBytes: () => discoverExtensionRegistrationFromBytes,
  loadFactoryFromVerifiedBundleBytes: () => loadFactoryFromVerifiedBundleBytes,
  parseAndVerifyBundle: () => parseAndVerifyBundle,
  transformExtensionSourceToCjs: () => transformExtensionSourceToCjs
});
function resolveRequireFilename() {
  try {
    const cjsFilename = Function(
      "return typeof __filename !== 'undefined' ? __filename : null"
    )();
    if (cjsFilename) return cjsFilename;
  } catch {
  }
  try {
    const metaUrl = import_meta.url;
    if (typeof metaUrl === "string" && metaUrl.length > 0) return metaUrl;
  } catch {
  }
  return import_path2.default.join(process.cwd(), "lib", "automation-extension-runtime.js");
}
function getNodeRequire() {
  return (0, import_module.createRequire)(resolveRequireFilename());
}
function sha256Buf(buf) {
  return (0, import_crypto2.createHash)("sha256").update(buf).digest("hex");
}
function parseAndVerifyBundle(bundleBytes, expectedSha256) {
  const live = sha256Buf(bundleBytes);
  if (live !== expectedSha256) {
    throw new Error(
      `extension bundle digest mismatch: expected ${expectedSha256.slice(0, 12)} got ${live.slice(0, 12)}`
    );
  }
  let bundle;
  try {
    bundle = JSON.parse(bundleBytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `extension bundle JSON invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (bundle?.v !== 1 || typeof bundle.entry !== "string" || !bundle.files || typeof bundle.files !== "object") {
    throw new Error("extension bundle format invalid (expected v1 entry+files)");
  }
  const files = /* @__PURE__ */ new Map();
  for (const [rel, b64] of Object.entries(bundle.files)) {
    const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    try {
      files.set(norm, Buffer.from(b64, "base64"));
    } catch {
      throw new Error(`extension bundle file not base64: ${norm}`);
    }
  }
  if (!files.has(bundle.entry.replace(/\\/g, "/"))) {
    throw new Error(`extension bundle entry missing: ${bundle.entry}`);
  }
  return { bundle, files, bundleSha256: live };
}
function normalizeRel(spec, parentRel) {
  const baseDir = import_path2.default.posix.dirname(parentRel.replace(/\\/g, "/"));
  let joined = spec.replace(/\\/g, "/");
  if (joined.startsWith(".")) {
    joined = import_path2.default.posix.normalize(import_path2.default.posix.join(baseDir === "." ? "" : baseDir, joined));
  } else {
    joined = import_path2.default.posix.normalize(joined);
  }
  return joined.replace(/^\.\//, "").replace(/^\/+/, "");
}
function resolveInBundle(files, rel) {
  const candidates = [
    rel,
    rel.endsWith(".js") || rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".cjs") ? null : `${rel}.js`,
    rel.endsWith(".js") || rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".cjs") ? null : `${rel}.cjs`,
    rel.endsWith(".js") || rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".cjs") ? null : `${rel}.mjs`,
    rel.endsWith(".js") || rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".cjs") ? null : `${rel}.ts`,
    import_path2.default.posix.join(rel, "index.js"),
    import_path2.default.posix.join(rel, "index.cjs"),
    import_path2.default.posix.join(rel, "index.mjs"),
    import_path2.default.posix.join(rel, "index.ts"),
    import_path2.default.posix.join(rel, "package.json")
  ].filter((x) => Boolean(x));
  for (const c of candidates) {
    const norm = c.replace(/\\/g, "/");
    if (files.has(norm)) {
      if (norm.endsWith("package.json")) {
        try {
          const pkg = JSON.parse(files.get(norm).toString("utf8"));
          if (pkg.main) {
            const mainRel = import_path2.default.posix.join(import_path2.default.posix.dirname(norm), pkg.main.replace(/^\.\//, "")).replace(/\\/g, "/");
            const resolvedMain = resolveInBundle(files, mainRel);
            if (resolvedMain) return resolvedMain;
          }
        } catch {
        }
      } else {
        return norm;
      }
    }
  }
  return null;
}
function transformExtensionSourceToCjs(source) {
  let code = source;
  code = code.replace(/^\s*import\s+type\s+[^;]+;?\s*$/gm, "");
  code = code.replace(/^\s*export\s+type\s+[^;]+;?\s*$/gm, "");
  code = code.replace(
    /^\s*import\s+(\w+)\s*,\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, def, named, mod) => `const ${def} = require(${JSON.stringify(mod)}); const {${named}} = ${def};`
  );
  code = code.replace(
    /^\s*import\s+(\w+)\s+from\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, def, mod) => `const ${def} = require(${JSON.stringify(mod)});`
  );
  code = code.replace(
    /^\s*import\s+\*\s+as\s+(\w+)\s+from\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, def, mod) => `const ${def} = require(${JSON.stringify(mod)});`
  );
  code = code.replace(
    /^\s*import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, named, mod) => `const {${named}} = require(${JSON.stringify(mod)});`
  );
  code = code.replace(
    /^\s*import\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, mod) => `require(${JSON.stringify(mod)});`
  );
  if (/export\s+default\s+/.test(code)) {
    code = code.replace(/export\s+default\s+async\s+function\s*\(/, "async function __ext_default(");
    code = code.replace(/export\s+default\s+function\s*\(/, "function __ext_default(");
    code = code.replace(/export\s+default\s+class\s+/, "class __ext_default ");
    code = code.replace(/export\s+default\s+/, "const __ext_default = ");
    code += "\nmodule.exports = __ext_default; module.exports.default = __ext_default;\n";
  }
  code = code.replace(
    /export\s+(async\s+function|function|class|const|let|var)\s+(\w+)/g,
    (_m, kind, name) => {
      return `${kind} ${name}`;
    }
  );
  code = code.replace(/export\s*\{([^}]+)\}\s*;?/g, (_m, body) => {
    const parts = String(body).split(",").map((p) => p.trim()).filter(Boolean);
    return parts.map((p) => {
      const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(p);
      if (!m) return "";
      const from = m[1];
      const to = m[2] ?? from;
      return `module.exports[${JSON.stringify(to)}] = ${from};`;
    }).join("\n");
  });
  code = code.replace(
    /export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?/g,
    (_m, body, mod) => {
      const parts = String(body).split(",").map((p) => p.trim()).filter(Boolean);
      const lines = [`const __re = require(${JSON.stringify(mod)});`];
      for (const p of parts) {
        const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(p);
        if (!m) continue;
        const from = m[1];
        const to = m[2] ?? from;
        lines.push(`module.exports[${JSON.stringify(to)}] = __re[${JSON.stringify(from)}];`);
      }
      return lines.join("\n");
    }
  );
  return code;
}
function loadFactoryFromVerifiedBundleBytes(bundleBytes, expectedSha256) {
  const { bundle, files, bundleSha256 } = parseAndVerifyBundle(bundleBytes, expectedSha256);
  const entryRel = bundle.entry.replace(/\\/g, "/");
  const moduleCache = /* @__PURE__ */ new Map();
  const virtualRoot = import_path2.default.join(
    import_path2.default.sep === "\\" ? "C:\\__automation_verified__" : "/__automation_verified__",
    bundleSha256.slice(0, 16)
  );
  function loadRel(relSpec, parentRel) {
    let rel = relSpec.replace(/\\/g, "/");
    if (rel.startsWith(".")) {
      rel = normalizeRel(rel, parentRel);
    } else if (!rel.startsWith("/") && files.has(rel)) {
    } else if (!rel.startsWith(".")) {
      return getNodeRequire()(relSpec);
    }
    const resolved = resolveInBundle(files, rel);
    if (!resolved) {
      if (!relSpec.startsWith(".")) {
        return getNodeRequire()(relSpec);
      }
      throw new Error(`Missing module in verified extension bundle: ${rel} (from ${parentRel})`);
    }
    if (moduleCache.has(resolved)) {
      return moduleCache.get(resolved).exports;
    }
    const filename = import_path2.default.join(virtualRoot, resolved);
    const mod = new import_module2.default(filename);
    mod.filename = filename;
    mod.paths = import_module2.default._nodeModulePaths(
      import_path2.default.dirname(filename)
    );
    mod.exports = {};
    moduleCache.set(resolved, mod);
    const raw = files.get(resolved).toString("utf8");
    const code = transformExtensionSourceToCjs(raw);
    const dirname3 = import_path2.default.dirname(filename);
    const localRequire = Object.assign(
      (id) => {
        if (id.startsWith(".") || files.has(id.replace(/\\/g, "/"))) {
          return loadRel(id, resolved);
        }
        const asRel = resolveInBundle(files, id.replace(/\\/g, "/"));
        if (asRel) return loadRel(asRel, resolved);
        return getNodeRequire()(id);
      },
      {
        resolve: (id) => {
          if (id.startsWith(".")) {
            const r = resolveInBundle(files, normalizeRel(id, resolved));
            if (r) return import_path2.default.join(virtualRoot, r);
          }
          return getNodeRequire().resolve(id);
        },
        cache: {},
        extensions: import_module2.default._extensions,
        main: process.mainModule
      }
    );
    mod.require = localRequire;
    const wrapper = `(function (exports, require, module, __filename, __dirname) {
${code}
})`;
    const compiled = import_vm.default.runInThisContext(wrapper, {
      filename,
      lineOffset: 0,
      displayErrors: true
    });
    compiled(mod.exports, localRequire, mod, filename, dirname3);
    const exp = mod.exports;
    if (exp && typeof exp === "object" && "default" in exp && exp.__esModule !== false) {
    }
    return mod.exports;
  }
  const entryExports = loadRel(entryRel, entryRel);
  let factory;
  if (typeof entryExports === "function") {
    factory = entryExports;
  } else if (entryExports && typeof entryExports === "object" && typeof entryExports.default === "function") {
    factory = entryExports.default;
  } else {
    throw new Error(
      `Extension entry did not export a factory function: ${entryRel}`
    );
  }
  return {
    bundleSha256,
    entryRel,
    packageClosure: [...files.keys()].sort(),
    factory
  };
}
function createDiscoveryExtensionApi() {
  const tools = [];
  const hooks = [];
  const flags = [];
  const api = {
    registerTool: (tool) => {
      if (tool?.name) {
        tools.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          label: tool.label
        });
      }
    },
    on: (event) => {
      if (event) hooks.push(String(event));
    },
    registerCommand: (cmd) => {
      if (cmd?.name) flags.push(`command:${cmd.name}`);
    },
    registerFlag: (flag) => {
      const name = typeof flag === "string" ? flag : flag?.name;
      if (name) flags.push(`flag:${name}`);
    },
    registerShortcut: (s) => {
      if (s?.name) flags.push(`shortcut:${s.name}`);
    },
    registerMessageRenderer: () => {
      flags.push("messageRenderer");
    },
    appendEntry: () => void 0,
    sendMessage: () => void 0,
    sendUserMessage: () => void 0,
    setModel: () => void 0,
    setThinkingLevel: () => void 0,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => void 0,
    getCommands: () => [],
    exec: async () => ({ code: 0, stdout: "", stderr: "" })
  };
  const proxied = new Proxy(api, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string") {
        return () => void 0;
      }
      return void 0;
    }
  });
  return { api: proxied, tools, hooks, flags };
}
async function discoverExtensionRegistrationFromBytes(input) {
  const loaded = loadFactoryFromVerifiedBundleBytes(input.bundleBytes, input.bundleSha256);
  const probe = createDiscoveryExtensionApi();
  await Promise.resolve(loaded.factory(probe.api));
  return {
    sourcePath: input.sourcePath,
    entryRel: loaded.entryRel,
    bundleSha256: loaded.bundleSha256,
    packageClosure: loaded.packageClosure,
    tools: probe.tools,
    hooks: probe.hooks,
    flags: probe.flags
  };
}
var import_crypto2, import_module, import_module2, import_path2, import_vm, import_meta;
var init_automation_extension_runtime = __esm({
  "lib/automation-extension-runtime.ts"() {
    "use strict";
    import_crypto2 = require("crypto");
    import_module = require("module");
    import_module2 = __toESM(require("module"));
    import_path2 = __toESM(require("path"));
    import_vm = __toESM(require("vm"));
    import_meta = {};
  }
});

// lib/pi-session-lifecycle.ts
var pi_session_lifecycle_exports = {};
__export(pi_session_lifecycle_exports, {
  disposeAgentSession: () => disposeAgentSession,
  drainAgentSession: () => drainAgentSession
});
function delay(ms) {
  return new Promise((resolve2) => {
    setTimeout(resolve2, ms);
  });
}
async function drainAgentSession(session, timeoutMs = SESSION_DRAIN_TIMEOUT_MS) {
  if (!session) return;
  try {
    session.abortCompaction?.();
  } catch {
  }
  if (!session.abort) return;
  try {
    await Promise.race([Promise.resolve(session.abort()), delay(timeoutMs)]);
  } catch {
  }
}
async function disposeAgentSession(session, reason = "quit") {
  if (!session) return;
  await drainAgentSession(session);
  try {
    const runner = session.extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown") && runner.emit) {
      await runner.emit({ type: "session_shutdown", reason });
    }
  } catch {
  }
  try {
    session.dispose?.();
  } catch {
  }
}
var SESSION_DRAIN_TIMEOUT_MS;
var init_pi_session_lifecycle = __esm({
  "lib/pi-session-lifecycle.ts"() {
    "use strict";
    SESSION_DRAIN_TIMEOUT_MS = 1e4;
  }
});

// lib/automation-network-policy.ts
function normalizeHostname(hostname) {
  let h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  if (h.includes("%")) {
    h = h.split("%")[0] ?? h;
  }
  return h;
}
function expandIpv6Hextets(ip) {
  const bare = ip.trim().toLowerCase().split("%")[0] ?? "";
  if (!bare) return null;
  let normalized = bare;
  const v4Tail = normalized.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const mappedV4 = v4Tail[2].split(".").map((p) => Number(p));
    if (mappedV4.length !== 4 || mappedV4.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
      return null;
    }
    const [a, b, c, d] = mappedV4;
    const hi = (a << 8 | b).toString(16);
    const lo = (c << 8 | d).toString(16);
    normalized = `${v4Tail[1]}${hi}:${lo}`;
  }
  if (normalized.includes(".")) return null;
  const sides = normalized.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":").filter((p) => p.length > 0) : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(":").filter((p) => p.length > 0) : [];
  let full;
  if (sides.length === 1) {
    if (left.length !== 8) return null;
    full = left;
  } else {
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    full = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
    if (full.length !== 8) return null;
  }
  const out = [];
  for (const h of full) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    out.push(h.padStart(4, "0"));
  }
  return out;
}
function isIpv6LinkLocal(ip) {
  const hextets = expandIpv6Hextets(ip);
  if (!hextets) return false;
  const first = Number.parseInt(hextets[0], 16);
  return first >= 65152 && first <= 65215;
}
function isPrivateOrSpecialIp(ip) {
  const bare = ip.includes("%") ? ip.split("%")[0] : ip;
  const v = (0, import_net.isIP)(bare);
  if (v === 4) {
    const parts = bare.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const lower = bare.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const hextets = expandIpv6Hextets(bare);
    if (hextets) {
      const first = Number.parseInt(hextets[0], 16);
      if ((first & 65024) === 64512) return true;
      if (first >= 65152 && first <= 65215) return true;
      if ((first & 65280) === 65280) return true;
      const isV4Mapped = hextets.slice(0, 5).every((h) => h === "0000") && hextets[5] === "ffff";
      const isV4Compat = hextets.slice(0, 6).every((h) => h === "0000") && !(hextets[6] === "0000" && (hextets[7] === "0000" || hextets[7] === "0001"));
      if (isV4Mapped || isV4Compat) {
        const hi = Number.parseInt(hextets[6], 16);
        const lo = Number.parseInt(hextets[7], 16);
        const mapped = `${hi >> 8 & 255}.${hi & 255}.${lo >> 8 & 255}.${lo & 255}`;
        return isPrivateOrSpecialIp(mapped);
      }
      return false;
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (isIpv6LinkLocal(bare)) return true;
    if (lower.startsWith("ff")) return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if ((0, import_net.isIP)(mapped) === 4) return isPrivateOrSpecialIp(mapped);
    }
    return false;
  }
  return true;
}
function assertUrlAllowedForAutomation(rawUrl) {
  let url;
  try {
    url = new import_url.URL(rawUrl);
  } catch {
    throw new AutomationNetworkError(`Invalid URL: ${rawUrl}`);
  }
  if (!AUTOMATION_NET_DEFAULTS.allowedProtocols.includes(url.protocol)) {
    throw new AutomationNetworkError(`Protocol not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new AutomationNetworkError("URL userinfo is not allowed");
  }
  const host = normalizeHostname(url.hostname);
  if (!host) throw new AutomationNetworkError("URL hostname required");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new AutomationNetworkError(`Hostname blocked: ${host}`);
  }
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new AutomationNetworkError(`Hostname blocked: ${host}`);
  }
  if ((0, import_net.isIP)(host)) {
    if (isPrivateOrSpecialIp(host)) {
      throw new AutomationNetworkError(`Private/special IP blocked: ${host}`);
    }
  }
  if (/%00/i.test(rawUrl) || host.includes(" ")) {
    throw new AutomationNetworkError("Malformed host");
  }
  return url;
}
async function resolveAndAssertPublicHostname(hostname) {
  const host = normalizeHostname(hostname);
  if ((0, import_net.isIP)(host)) {
    if (isPrivateOrSpecialIp(host)) {
      throw new AutomationNetworkError(`Private/special IP blocked: ${host}`);
    }
    return [host];
  }
  let records;
  try {
    records = await (0, import_promises.lookup)(host, { all: true, verbatim: true });
  } catch (error) {
    throw new AutomationNetworkError(
      `DNS lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!records.length) {
    throw new AutomationNetworkError(`DNS returned no addresses for ${host}`);
  }
  const addresses = records.map((r) => r.address);
  for (const address of addresses) {
    if (isPrivateOrSpecialIp(address)) {
      throw new AutomationNetworkError(`Resolved private/special IP blocked: ${address}`);
    }
  }
  return addresses;
}
async function assertConnectIpPublic(hostname, port, resolvedAddresses, timeoutMs = AUTOMATION_NET_DEFAULTS.connectTimeoutMs) {
  const candidates = resolvedAddresses.length ? resolvedAddresses : await resolveAndAssertPublicHostname(hostname);
  let lastError;
  for (const address of candidates) {
    if (isPrivateOrSpecialIp(address)) {
      throw new AutomationNetworkError(`Connect IP blocked: ${address}`);
    }
    try {
      const peer = await new Promise((resolve2, reject) => {
        const socket = (0, import_net.connect)({ host: address, port, family: (0, import_net.isIP)(address) === 6 ? 6 : 4 });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new AutomationNetworkError(`Connect timeout to ${address}:${port}`));
        }, timeoutMs);
        socket.once("connect", () => {
          const peerAddr = socket.remoteAddress ?? address;
          clearTimeout(timer);
          socket.destroy();
          if (isPrivateOrSpecialIp(peerAddr)) {
            reject(new AutomationNetworkError(`Connected peer IP blocked: ${peerAddr}`));
            return;
          }
          resolve2(peerAddr);
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return peer;
    } catch (error) {
      lastError = error;
    }
  }
  throw new AutomationNetworkError(
    `Connect IP verification failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
function requestPinned(url, connectIp, options) {
  return new Promise((resolve2, reject) => {
    const isHttps = url.protocol === "https:";
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const headers = {
      Host: url.host,
      ...options.headers ?? {}
    };
    if (options.body != null) {
      headers["Content-Length"] = String(Buffer.byteLength(options.body));
    }
    const reqFn = isHttps ? import_https.request : import_http.request;
    const req = reqFn(
      {
        protocol: url.protocol,
        hostname: connectIp,
        port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers,
        servername: isHttps ? url.hostname : void 0,
        timeout: options.timeoutMs
        // Reject unauthorized is default; keep it.
      },
      (res) => {
        resolve2({
          status: res.statusCode ?? 0,
          headers: res.headers,
          stream: res,
          destroy: () => {
            try {
              res.destroy();
            } catch {
            }
          }
        });
      }
    );
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new AutomationNetworkError(`Request timed out after ${options.timeoutMs}ms`));
    });
    req.on("error", (error) => {
      reject(
        error instanceof AutomationNetworkError ? error : new AutomationNetworkError(
          `Network request failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    });
    if (options.body != null) req.write(options.body);
    req.end();
  });
}
async function readStreamLimited(stream, maxBytes, timeoutMs, destroy) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      destroy();
      reject(new AutomationNetworkError(`Response body timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve2(buf ?? Buffer.alloc(0));
    };
    stream.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        destroy();
        finish(new AutomationNetworkError(`Response exceeds ${maxBytes} bytes (streaming limit)`));
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", () => finish(void 0, Buffer.concat(chunks, total)));
    stream.on(
      "error",
      (error) => finish(
        error instanceof AutomationNetworkError ? error : new AutomationNetworkError(
          `Stream error: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    );
  });
}
async function automationSafeFetch(rawUrl, options) {
  const maxRedirects = options?.maxRedirects ?? AUTOMATION_NET_DEFAULTS.maxRedirects;
  const maxResponseBytes = options?.maxResponseBytes ?? AUTOMATION_NET_DEFAULTS.maxResponseBytes;
  const timeoutMs = options?.timeoutMs ?? AUTOMATION_NET_DEFAULTS.timeoutMs;
  let current = assertUrlAllowedForAutomation(rawUrl);
  let addresses = await resolveAndAssertPublicHostname(current.hostname);
  let redirected = false;
  let lastConnectIp;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const port = current.port ? Number(current.port) : current.protocol === "https:" ? 443 : 80;
    addresses = await resolveAndAssertPublicHostname(current.hostname);
    if (!options?.fetchImpl) {
      lastConnectIp = await assertConnectIpPublic(current.hostname, port, addresses);
    }
    if (options?.fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await options.fetchImpl(current.toString(), {
          method: options?.method ?? "GET",
          headers: options?.headers,
          body: options?.body,
          redirect: "manual",
          signal: controller.signal
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new AutomationNetworkError("Redirect without Location");
          const next = new import_url.URL(location, current);
          assertUrlAllowedForAutomation(next.toString());
          await resolveAndAssertPublicHostname(next.hostname);
          current = next;
          redirected = true;
          continue;
        }
        const cl2 = response.headers.get("content-length");
        if (cl2 && Number(cl2) > maxResponseBytes) {
          throw new AutomationNetworkError(`Response exceeds ${maxResponseBytes} bytes`);
        }
        const reader = response.body?.getReader?.();
        if (reader) {
          const chunks = [];
          let total = 0;
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              total += value.byteLength;
              if (total > maxResponseBytes) {
                try {
                  await reader.cancel();
                } catch {
                }
                throw new AutomationNetworkError(
                  `Response exceeds ${maxResponseBytes} bytes (streaming limit)`
                );
              }
              chunks.push(value);
            }
          }
          const buf3 = Buffer.concat(chunks.map((c) => Buffer.from(c)));
          const bodyText2 = new TextDecoder("utf-8", { fatal: false }).decode(buf3);
          return {
            url: rawUrl,
            finalUrl: current.toString(),
            status: response.status,
            contentType: response.headers.get("content-type"),
            bodyText: bodyText2,
            bytes: buf3.byteLength,
            redirected,
            connectIp: lastConnectIp
          };
        }
        const buf2 = Buffer.from(await response.arrayBuffer());
        if (buf2.byteLength > maxResponseBytes) {
          throw new AutomationNetworkError(`Response exceeds ${maxResponseBytes} bytes`);
        }
        return {
          url: rawUrl,
          finalUrl: current.toString(),
          status: response.status,
          contentType: response.headers.get("content-type"),
          bodyText: new TextDecoder("utf-8", { fatal: false }).decode(buf2),
          bytes: buf2.byteLength,
          redirected,
          connectIp: lastConnectIp
        };
      } catch (error) {
        if (error instanceof AutomationNetworkError) throw error;
        if (error?.name === "AbortError") {
          throw new AutomationNetworkError(`Request timed out after ${timeoutMs}ms`);
        }
        throw new AutomationNetworkError(
          `Network request failed: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        clearTimeout(timer);
      }
    }
    const raw = await requestPinned(current, lastConnectIp, {
      method: options?.method ?? "GET",
      headers: options?.headers,
      body: options?.body,
      timeoutMs
    });
    if ([301, 302, 303, 307, 308].includes(raw.status)) {
      raw.destroy();
      const locationHeader = raw.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      if (!location) throw new AutomationNetworkError("Redirect without Location");
      const next = new import_url.URL(location, current);
      assertUrlAllowedForAutomation(next.toString());
      current = next;
      redirected = true;
      continue;
    }
    const contentTypeHeader = raw.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] ?? null : contentTypeHeader ?? null;
    const clHeader = raw.headers["content-length"];
    const cl = Array.isArray(clHeader) ? clHeader[0] : clHeader;
    if (cl && Number(cl) > maxResponseBytes) {
      raw.destroy();
      throw new AutomationNetworkError(`Response exceeds ${maxResponseBytes} bytes`);
    }
    const buf = await readStreamLimited(raw.stream, maxResponseBytes, timeoutMs, raw.destroy);
    const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return {
      url: rawUrl,
      finalUrl: current.toString(),
      status: raw.status,
      contentType,
      bodyText,
      bytes: buf.byteLength,
      redirected,
      connectIp: lastConnectIp
    };
  }
  throw new AutomationNetworkError(`Too many redirects (>${maxRedirects})`);
}
var import_net, import_promises, import_http, import_https, import_url, AutomationNetworkError, AUTOMATION_NET_DEFAULTS, BLOCKED_HOSTNAMES;
var init_automation_network_policy = __esm({
  "lib/automation-network-policy.ts"() {
    "use strict";
    import_net = require("net");
    import_promises = require("dns/promises");
    import_http = require("http");
    import_https = require("https");
    import_url = require("url");
    AutomationNetworkError = class extends Error {
      constructor(message) {
        super(message);
        this.code = "blocked";
        this.blockedReason = "policy_violation";
        this.name = "AutomationNetworkError";
      }
    };
    AUTOMATION_NET_DEFAULTS = {
      maxRedirects: 3,
      maxResponseBytes: 2 * 1024 * 1024,
      timeoutMs: 2e4,
      allowedProtocols: ["http:", "https:"],
      connectTimeoutMs: 8e3
    };
    BLOCKED_HOSTNAMES = /* @__PURE__ */ new Set([
      "localhost",
      "metadata.google.internal",
      "metadata",
      "metadata.azure.com"
    ]);
  }
});

// lib/automation-reviewed-web-tools.ts
var automation_reviewed_web_tools_exports = {};
__export(automation_reviewed_web_tools_exports, {
  AUTOMATION_REVIEWED_WEB_REGISTRY: () => AUTOMATION_REVIEWED_WEB_REGISTRY,
  assertReviewedWebSnapshot: () => assertReviewedWebSnapshot,
  buildReviewedWebToolSnapshot: () => buildReviewedWebToolSnapshot,
  createAutomationReviewedWebTools: () => createAutomationReviewedWebTools,
  isReviewedWebRegistryName: () => isReviewedWebRegistryName,
  listReviewedWebCatalogDescriptors: () => listReviewedWebCatalogDescriptors,
  reviewedWebImplementationFingerprint: () => reviewedWebImplementationFingerprint,
  reviewedWebToolDigest: () => reviewedWebToolDigest
});
function isReviewedWebRegistryName(name) {
  return name === "web_search" || name === "web_fetch";
}
function tryReadModuleSource(fileBase) {
  const bases = [
    typeof __dirname !== "undefined" ? __dirname : "",
    (0, import_path3.join)(process.cwd(), "lib"),
    process.cwd()
  ].filter(Boolean);
  const names = [`${fileBase}.ts`, `${fileBase}.js`, `${fileBase}.mjs`, `${fileBase}.cjs`];
  for (const base of bases) {
    for (const name of names) {
      const full = (0, import_path3.join)(base, name);
      try {
        if ((0, import_fs2.existsSync)(full)) return (0, import_fs2.readFileSync)(full, "utf8");
      } catch {
      }
    }
  }
  try {
    const alt = (0, import_path3.join)((0, import_path3.dirname)(typeof __filename !== "undefined" ? __filename : process.cwd()), `${fileBase}.js`);
    if ((0, import_fs2.existsSync)(alt)) return (0, import_fs2.readFileSync)(alt, "utf8");
  } catch {
  }
  return "";
}
function reviewedWebImplementationFingerprint(name) {
  const networkSrc = tryReadModuleSource("automation-network-policy");
  const adapterSrc = tryReadModuleSource("automation-reviewed-web-tools");
  const h = (0, import_crypto3.createHash)("sha256");
  h.update(`tool:${name}
`);
  h.update("network-module:\n");
  h.update(networkSrc || automationSafeFetch.toString());
  h.update("\nadapter-module:\n");
  h.update(adapterSrc || `${ddgSearch.toString()}
${createAutomationReviewedWebTools.toString()}`);
  h.update("\nfn:automationSafeFetch:\n");
  h.update(automationSafeFetch.toString());
  if (name === "web_search") {
    h.update("\nfn:ddgSearch:\n");
    h.update(ddgSearch.toString());
  }
  return h.digest("hex");
}
function reviewedWebToolDigest(name) {
  const entry = AUTOMATION_REVIEWED_WEB_REGISTRY[name];
  const impl = reviewedWebImplementationFingerprint(name);
  return (0, import_crypto3.createHash)("sha256").update(JSON.stringify({ entry, implementationFingerprint: impl })).digest("hex");
}
function buildReviewedWebToolSnapshot(name) {
  const entry = AUTOMATION_REVIEWED_WEB_REGISTRY[name];
  const schemaHash = (0, import_crypto3.createHash)("sha256").update(JSON.stringify(entry.schema)).digest("hex");
  const configHash = (0, import_crypto3.createHash)("sha256").update(JSON.stringify(entry.config)).digest("hex");
  return {
    name: entry.name,
    origin: "custom",
    description: entry.description,
    sourceIdentity: entry.sourceIdentity,
    executableDigest: reviewedWebToolDigest(name),
    schemaHash,
    configHash,
    hookInventory: [],
    risks: {
      headlessCompatible: true,
      localMutation: false,
      networkEgress: true,
      credentialUse: false,
      interactionRequired: false,
      blocked: false
    }
  };
}
function listReviewedWebCatalogDescriptors() {
  return Object.keys(AUTOMATION_REVIEWED_WEB_REGISTRY).map((name) => {
    const snap = buildReviewedWebToolSnapshot(name);
    return {
      name: snap.name,
      description: snap.description ?? "",
      origin: "custom",
      sourceIdentity: snap.sourceIdentity,
      schema: AUTOMATION_REVIEWED_WEB_REGISTRY[name].schema,
      risks: snap.risks,
      blocked: false,
      executableDigest: snap.executableDigest,
      schemaHash: snap.schemaHash,
      configHash: snap.configHash
    };
  });
}
function assertReviewedWebSnapshot(tool) {
  if (!isReviewedWebRegistryName(tool.name)) {
    throw new Error(`Not a reviewed web tool: ${tool.name}`);
  }
  const expected = buildReviewedWebToolSnapshot(tool.name);
  if (tool.sourceIdentity !== expected.sourceIdentity || tool.executableDigest !== expected.executableDigest || tool.schemaHash !== expected.schemaHash || tool.configHash !== expected.configHash) {
    throw new Error(`Reviewed web tool drift for ${tool.name}`);
  }
}
async function ddgSearch(query, limit) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await automationSafeFetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "SnailPi-Automation/1.0",
      Accept: "text/html"
    }
  });
  const links = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(res.bodyText)) && links.length < limit) {
    const href = match[1] ?? "";
    const title = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
    if (href.startsWith("http")) links.push({ title, href });
  }
  return { query, results: links, bytes: res.bytes, finalUrl: res.finalUrl };
}
function createAutomationReviewedWebTools(approved) {
  const out = [];
  for (const tool of approved) {
    if (!isReviewedWebRegistryName(tool.name)) {
      throw new Error(`Unsupported reviewed web tool (refusing silent drop): ${tool.name}`);
    }
    assertReviewedWebSnapshot(tool);
    const entry = AUTOMATION_REVIEWED_WEB_REGISTRY[tool.name];
    if (tool.name === "web_fetch") {
      out.push({
        name: "web_fetch",
        label: "Web Fetch",
        description: entry.description,
        parameters: entry.schema,
        async execute(_id, params) {
          const url = String(params.url ?? "");
          const res = await automationSafeFetch(url, {
            maxResponseBytes: entry.config.maxResponseBytes,
            timeoutMs: entry.config.timeoutMs
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    url: res.url,
                    finalUrl: res.finalUrl,
                    status: res.status,
                    contentType: res.contentType,
                    bytes: res.bytes,
                    bodyText: res.bodyText.slice(0, 1e5)
                  },
                  null,
                  2
                )
              }
            ],
            details: { status: res.status, bytes: res.bytes }
          };
        }
      });
    } else if (tool.name === "web_search") {
      out.push({
        name: "web_search",
        label: "Web Search",
        description: entry.description,
        parameters: entry.schema,
        async execute(_id, params) {
          const query = String(params.query ?? "");
          const limit = Math.min(
            10,
            Math.max(1, typeof params.limit === "number" ? params.limit : 5)
          );
          const result = await ddgSearch(query, limit);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      });
    }
  }
  return out;
}
var import_crypto3, import_fs2, import_path3, AUTOMATION_REVIEWED_WEB_REGISTRY;
var init_automation_reviewed_web_tools = __esm({
  "lib/automation-reviewed-web-tools.ts"() {
    "use strict";
    import_crypto3 = require("crypto");
    import_fs2 = require("fs");
    import_path3 = require("path");
    init_automation_network_policy();
    AUTOMATION_REVIEWED_WEB_REGISTRY = Object.freeze({
      web_search: Object.freeze({
        name: "web_search",
        version: 1,
        sourceIdentity: "reviewed:automation/web_search@1",
        description: "Headless web search via Automation-reviewed SSRF-safe adapter",
        schema: Object.freeze({
          type: "object",
          properties: Object.freeze({
            query: Object.freeze({ type: "string" }),
            limit: Object.freeze({ type: "number" })
          }),
          required: Object.freeze(["query"])
        }),
        config: Object.freeze({ provider: "duckduckgo-html", maxResults: 5 })
      }),
      web_fetch: Object.freeze({
        name: "web_fetch",
        version: 1,
        sourceIdentity: "reviewed:automation/web_fetch@1",
        description: "Headless HTTP(S) fetch via Automation-reviewed SSRF-safe adapter",
        schema: Object.freeze({
          type: "object",
          properties: Object.freeze({
            url: Object.freeze({ type: "string" })
          }),
          required: Object.freeze(["url"])
        }),
        config: Object.freeze({ maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 2e4 })
      })
    });
  }
});

// lib/pi-runtime-resolver.ts
function trimEnv(value) {
  const trimmed = value?.trim();
  return trimmed || void 0;
}
function addPackageCliCandidates(candidates, base) {
  if (!base) return;
  for (const segments of PI_CLI_SEGMENTS) {
    candidates.push((0, import_node_path.join)(base, ...segments));
  }
}
function resolveExplicitCli() {
  for (const key of EXPLICIT_PI_CLI_ENV_KEYS) {
    const value = trimEnv(process.env[key]);
    if (!value) continue;
    const cliPath = (0, import_node_path.resolve)(value);
    if ((0, import_node_fs.existsSync)(cliPath)) return { cliPath, source: key };
  }
  return void 0;
}
function resolveLocalPiCli(cwd, agentDir) {
  const explicit = resolveExplicitCli();
  if (explicit) return explicit;
  const candidates = [];
  for (const arg of process.argv) {
    if (/pi-coding-agent[\\/]dist[\\/]cli\.js$/i.test(arg)) {
      candidates.push((0, import_node_path.resolve)(arg));
    }
  }
  addPackageCliCandidates(candidates, cwd);
  addPackageCliCandidates(candidates, process.cwd());
  addPackageCliCandidates(candidates, (0, import_node_path.join)(agentDir, "npm"));
  const prefix = trimEnv(process.env.npm_config_prefix) ?? trimEnv(process.env.NPM_CONFIG_PREFIX);
  if (prefix) {
    addPackageCliCandidates(candidates, prefix);
    addPackageCliCandidates(candidates, (0, import_node_path.join)(prefix, "lib"));
  }
  const appData = trimEnv(process.env.APPDATA);
  if (appData) addPackageCliCandidates(candidates, (0, import_node_path.join)(appData, "npm"));
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const entry of pathValue.split(import_node_path.delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    addPackageCliCandidates(candidates, dir);
    addPackageCliCandidates(candidates, (0, import_node_path.dirname)(dir));
    addPackageCliCandidates(candidates, (0, import_node_path.join)((0, import_node_path.dirname)(dir), "lib"));
  }
  for (const candidate of [...new Set(candidates)]) {
    if ((0, import_node_fs.existsSync)(candidate)) return { cliPath: candidate, source: "local-package" };
  }
  return void 0;
}
function quoteShell(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function escapeCmdPath(value) {
  return value.replace(/%/g, "%%");
}
function ensurePiPackageResolution(agentDir, cliPath) {
  const packageRoot = (0, import_node_path.dirname)((0, import_node_path.dirname)(cliPath));
  const packageLinkPath = (0, import_node_path.join)(agentDir, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
  if ((0, import_node_fs.existsSync)((0, import_node_path.join)(packageLinkPath, "package.json"))) return packageLinkPath;
  try {
    if ((0, import_node_fs.lstatSync)(packageLinkPath).isSymbolicLink()) (0, import_node_fs.rmSync)(packageLinkPath, { recursive: true, force: true });
  } catch {
  }
  try {
    (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(packageLinkPath), { recursive: true });
    (0, import_node_fs.symlinkSync)(packageRoot, packageLinkPath, process.platform === "win32" ? "junction" : "dir");
    return packageLinkPath;
  } catch {
    return void 0;
  }
}
function writePiShim(agentDir, cliPath) {
  const shimDir = (0, import_node_path.join)(agentDir, "pi-web-runtime", "bin");
  (0, import_node_fs.mkdirSync)(shimDir, { recursive: true });
  if (process.platform === "win32") {
    const shimPath2 = (0, import_node_path.join)(shimDir, "pi.cmd");
    const content2 = [
      "@echo off",
      "setlocal",
      `"${escapeCmdPath(process.execPath)}" "${escapeCmdPath(cliPath)}" %*`,
      "exit /b %ERRORLEVEL%",
      ""
    ].join("\r\n");
    (0, import_node_fs.writeFileSync)(shimPath2, content2, "utf-8");
    return { shimDir, shimPath: shimPath2 };
  }
  const shimPath = (0, import_node_path.join)(shimDir, "pi");
  const content = [
    "#!/usr/bin/env sh",
    `exec ${quoteShell(process.execPath)} ${quoteShell(cliPath)} "$@"`,
    ""
  ].join("\n");
  (0, import_node_fs.writeFileSync)(shimPath, content, { encoding: "utf-8", mode: 493 });
  (0, import_node_fs.chmodSync)(shimPath, 493);
  return { shimDir, shimPath };
}
function pathEnvKey() {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") === "Path" ? "Path" : "PATH";
}
function prependPathOnce(dir) {
  const key = pathEnvKey();
  const current = process.env[key] ?? "";
  const parts = current.split(import_node_path.delimiter).filter(Boolean);
  const normalized = process.platform === "win32" ? dir.toLowerCase() : dir;
  const exists = parts.some((part) => (process.platform === "win32" ? part.toLowerCase() : part) === normalized);
  if (!exists) process.env[key] = [dir, ...parts].join(import_node_path.delimiter);
}
function preparePiRuntimeEnvironment(options) {
  try {
    const resolution = resolveLocalPiCli(options.cwd, options.agentDir);
    if (!resolution) {
      return { ok: false, error: "Unable to locate @earendil-works/pi-coding-agent dist/cli.js" };
    }
    const packageLinkPath = ensurePiPackageResolution(options.agentDir, resolution.cliPath);
    const { shimDir, shimPath } = writePiShim(options.agentDir, resolution.cliPath);
    prependPathOnce(shimDir);
    process.env.PI_WEB_PI_CLI_JS = resolution.cliPath;
    if (!trimEnv(process.env.TRELLIS_PI_CLI_JS)) process.env.TRELLIS_PI_CLI_JS = resolution.cliPath;
    if (process.platform !== "win32" && !trimEnv(process.env[PI_SUBAGENT_PI_BINARY_ENV])) {
      process.env[PI_SUBAGENT_PI_BINARY_ENV] = shimPath;
    }
    return {
      ok: true,
      cliPath: resolution.cliPath,
      shimPath,
      packageLinkPath,
      source: resolution.source
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
var import_node_fs, import_node_path, PI_CLI_SEGMENTS, EXPLICIT_PI_CLI_ENV_KEYS, PI_SUBAGENT_PI_BINARY_ENV;
var init_pi_runtime_resolver = __esm({
  "lib/pi-runtime-resolver.ts"() {
    "use strict";
    import_node_fs = require("node:fs");
    import_node_path = require("node:path");
    PI_CLI_SEGMENTS = [
      ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"],
      ["node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"]
    ];
    EXPLICIT_PI_CLI_ENV_KEYS = ["PI_WEB_PI_CLI_JS", "TRELLIS_PI_CLI_JS"];
    PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
  }
});

// lib/agent-session-services.ts
var agent_session_services_exports = {};
__export(agent_session_services_exports, {
  createAgentSessionWithServices: () => createAgentSessionWithServices,
  createTargetCwdRuntime: () => createTargetCwdRuntime
});
async function loadPiSdk() {
  return await import("@earendil-works/pi-coding-agent");
}
async function createTargetCwdRuntime(options) {
  const sdk = await loadPiSdk();
  const agentDir = options.agentDir ?? sdk.getAgentDir();
  preparePiRuntimeEnvironment({ cwd: options.cwd, agentDir });
  const settingsManager = sdk.SettingsManager.create(options.cwd, agentDir);
  let resourceLoader;
  if (options.createResourceLoader) {
    resourceLoader = await options.createResourceLoader(sdk, { cwd: options.cwd, agentDir });
    const loader = resourceLoader;
    if (loader?.reload) await loader.reload();
  }
  return { sdk, cwd: options.cwd, agentDir, settingsManager, resourceLoader };
}
async function createAgentSessionWithServices(input) {
  const runtime = await createTargetCwdRuntime({
    cwd: input.cwd,
    agentDir: input.agentDir
  });
  const { session, extensionsResult } = await runtime.sdk.createAgentSession({
    cwd: input.cwd,
    agentDir: runtime.agentDir,
    sessionManager: input.sessionManager,
    ...input.resourceLoader ? { resourceLoader: input.resourceLoader } : {},
    ...input.customTools ? { customTools: input.customTools } : {},
    ...input.tools ? { tools: input.tools } : {},
    ...input.settingsManager || runtime.settingsManager ? { settingsManager: input.settingsManager ?? runtime.settingsManager } : {}
  });
  return { session, extensionsResult, sdk: runtime.sdk };
}
var init_agent_session_services = __esm({
  "lib/agent-session-services.ts"() {
    "use strict";
    init_pi_runtime_resolver();
  }
});

// lib/automation-worker-host.ts
var automation_worker_host_exports = {};
__export(automation_worker_host_exports, {
  deriveMaxOutputTokens: () => deriveMaxOutputTokens,
  estimatePromptTokens: () => estimatePromptTokens,
  hashDirectoryClosure: () => hashDirectoryClosure2,
  runJob: () => runJob,
  verifyAndLoadExtensionFactories: () => verifyAndLoadExtensionFactories,
  verifyExtensionArtifacts: () => verifyExtensionArtifacts
});
module.exports = __toCommonJS(automation_worker_host_exports);
var import_crypto4 = require("crypto");
var import_fs3 = require("fs");
var import_path4 = require("path");

// lib/automation-token-budget.ts
function utf8ByteLength(text) {
  if (!text) return 0;
  return Buffer.byteLength(text, "utf8");
}
function estimateTextTokens(text) {
  if (!text) return 0;
  return Math.max(utf8ByteLength(text), 1);
}
function estimateContextTokens(input) {
  let total = 0;
  total += estimateTextTokens(input.systemPrompt ?? "");
  total += 384;
  if (input.tools?.length) {
    for (const tool of input.tools) {
      total += estimateTextTokens(tool.name ?? "");
      total += estimateTextTokens(tool.description ?? "");
      try {
        total += estimateTextTokens(JSON.stringify(tool.parameters ?? {}));
      } catch {
        total += 64;
      }
      total += 48;
    }
  }
  if (input.messages?.length) {
    for (const msg of input.messages) {
      try {
        total += estimateTextTokens(stableSerialize(msg));
      } catch {
        total += 128;
      }
    }
  }
  total += estimateTextTokens(input.extraText ?? "");
  return total;
}
function stableSerialize(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${k}:${stableSerialize(obj[k])}`).join(",")}}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function decideRequestBudget(input) {
  const margin = input.safetyMargin ?? 64;
  const max = Math.max(0, input.maxTokensPerRun);
  if (max <= 0) {
    return {
      ok: true,
      maxOutputTokens: 0,
      remaining: 0,
      estimatedInputTokens: input.estimatedInputTokens,
      reservation: 0
    };
  }
  const spent = Math.max(0, input.spentTokens);
  const reserved = Math.max(0, input.reservedTokens ?? 0);
  const remainingAfterCommitted = max - spent - reserved;
  if (remainingAfterCommitted <= margin) {
    return {
      ok: false,
      reason: `Token budget exhausted: spent=${spent} reserved=${reserved} maxTokensPerRun=${max}`,
      remaining: Math.max(0, remainingAfterCommitted),
      estimatedInputTokens: input.estimatedInputTokens
    };
  }
  const estimatedInput = Math.max(0, input.estimatedInputTokens);
  if (estimatedInput + margin >= remainingAfterCommitted) {
    return {
      ok: false,
      reason: `Estimated input tokens (${estimatedInput}) plus safety margin (${margin}) exhaust remaining budget (${remainingAfterCommitted}) under maxTokensPerRun=${max} (spent=${spent} reserved=${reserved})`,
      remaining: remainingAfterCommitted,
      estimatedInputTokens: estimatedInput
    };
  }
  const remaining = remainingAfterCommitted - estimatedInput - margin;
  const maxOutputTokens = Math.max(1, remaining);
  const reservation = estimatedInput + maxOutputTokens + margin;
  return {
    ok: true,
    maxOutputTokens,
    remaining,
    estimatedInputTokens: estimatedInput,
    reservation
  };
}
function tryReserveRequestBudget(state, reservation) {
  if (reservation <= 0) return true;
  const max = Math.max(0, state.maxTokensPerRun);
  if (max <= 0) return true;
  const available = max - Math.max(0, state.spentTokens) - Math.max(0, state.reservedTokens ?? 0);
  if (reservation > available) return false;
  state.reservedTokens = Math.max(0, state.reservedTokens ?? 0) + reservation;
  return true;
}
function settleRequestBudget(state, reservation, actualUsage) {
  if (reservation > 0) {
    state.reservedTokens = Math.max(0, (state.reservedTokens ?? 0) - reservation);
  }
  const max = Math.max(0, state.maxTokensPerRun);
  if (actualUsage) {
    const total = typeof actualUsage.totalTokens === "number" && Number.isFinite(actualUsage.totalTokens) ? actualUsage.totalTokens : Math.max(0, Number(actualUsage.inputTokens ?? 0)) + Math.max(0, Number(actualUsage.outputTokens ?? 0));
    if (total > 0) {
      state.spentTokens = Math.max(0, state.spentTokens) + total;
    }
    if (max > 0 && state.spentTokens > max) {
      state.spentTokens = Math.max(state.spentTokens, max + 1);
    }
  } else if (reservation > 0) {
    state.spentTokens = Math.max(0, state.spentTokens) + reservation;
    if (max > 0 && state.spentTokens > max) {
      state.spentTokens = Math.max(state.spentTokens, max + 1);
    }
  }
}
function wrapStreamFnWithTokenBudget(base, state, options) {
  if (state.reservedTokens == null || !Number.isFinite(state.reservedTokens)) {
    state.reservedTokens = 0;
  }
  const wrapped = (model, context, streamOpts) => {
    const ctx = context ?? {};
    const estimatedInput = estimateContextTokens({
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      messages: ctx.messages
    });
    const decision = decideRequestBudget({
      maxTokensPerRun: state.maxTokensPerRun,
      spentTokens: state.spentTokens,
      reservedTokens: state.reservedTokens,
      estimatedInputTokens: estimatedInput
    });
    if (!decision.ok) {
      options?.onReject?.(decision.reason);
      const err = Object.assign(new Error(decision.reason), {
        code: "budget",
        errorCategory: "budget"
      });
      throw err;
    }
    const reservation = decision.reservation;
    if (!tryReserveRequestBudget(state, reservation)) {
      const reason = `Token budget reservation race: could not reserve ${reservation} under maxTokensPerRun=${state.maxTokensPerRun} (spent=${state.spentTokens} reserved=${state.reservedTokens})`;
      options?.onReject?.(reason);
      throw Object.assign(new Error(reason), { code: "budget", errorCategory: "budget" });
    }
    const nextOpts = { ...streamOpts ?? {} };
    const prevMax = typeof nextOpts.maxTokens === "number" && Number.isFinite(nextOpts.maxTokens) ? nextOpts.maxTokens : decision.maxOutputTokens;
    nextOpts.maxTokens = Math.min(prevMax, decision.maxOutputTokens);
    if (model && typeof model === "object") {
      const m = model;
      if (typeof m.maxTokens === "number") {
        m.maxTokens = Math.min(m.maxTokens, decision.maxOutputTokens);
      } else {
        m.maxTokens = decision.maxOutputTokens;
      }
    }
    let settled = false;
    const settle = (usage) => {
      if (settled) return;
      settled = true;
      settleRequestBudget(state, reservation, usage);
      if (usage && options?.onUsage) {
        const inputTokens = Math.max(0, Number(usage.inputTokens ?? 0));
        const outputTokens = Math.max(0, Number(usage.outputTokens ?? 0));
        const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : inputTokens + outputTokens;
        options.onUsage({ inputTokens, outputTokens, totalTokens });
      }
    };
    try {
      const result = base(model, context, nextOpts);
      return wrapStreamResultWithUsageAccounting(result, settle);
    } catch (err) {
      settle(null);
      throw err;
    }
  };
  return wrapped;
}
function wrapStreamResultWithUsageAccounting(result, settle) {
  if (result == null) {
    settle(null);
    return result;
  }
  if (typeof result.then === "function") {
    return result.then(
      (v) => {
        const usage = extractUsageFromUnknown(v);
        settle(usage);
        return v;
      },
      (err) => {
        settle(null);
        throw err;
      }
    );
  }
  const stream = result;
  if (typeof stream.result === "function") {
    const origResult = stream.result.bind(stream);
    stream.result = async () => {
      try {
        const msg = await origResult();
        settle(extractUsageFromUnknown(msg));
        return msg;
      } catch (err) {
        settle(null);
        throw err;
      }
    };
  }
  if (typeof stream[Symbol.asyncIterator] === "function") {
    const origAsyncFn = stream[Symbol.asyncIterator];
    const origAsync = origAsyncFn.bind(stream);
    stream[Symbol.asyncIterator] = function patchedAsyncIterator() {
      const it = origAsync();
      return {
        async next() {
          const n = await it.next();
          if (!n.done) {
            const ev = n.value;
            if (ev && (ev.type === "done" || ev.type === "error")) {
              const msg = ev.type === "done" ? ev.message : ev.error;
              settle(extractUsageFromUnknown(msg ?? ev.partial));
            }
          } else {
            settle(null);
          }
          return n;
        },
        async return(value) {
          settle(null);
          if (it.return) return it.return(value);
          return { done: true, value: void 0 };
        },
        async throw(e) {
          settle(null);
          if (it.throw) return it.throw(e);
          throw e;
        }
      };
    };
    return stream;
  }
  const direct = extractUsageFromUnknown(result);
  if (direct) settle(direct);
  else settle(null);
  return result;
}
function extractUsageFromUnknown(value) {
  if (!value || typeof value !== "object") return null;
  const obj = value;
  const u = obj.usage ?? obj;
  if (!u || typeof u !== "object") return null;
  const inputTokens = Math.max(
    0,
    Number(u.input ?? u.inputTokens ?? 0)
  );
  const outputTokens = Math.max(
    0,
    Number(u.output ?? u.outputTokens ?? 0)
  );
  const totalTokens = Math.max(
    0,
    Number(u.totalTokens ?? inputTokens + outputTokens)
  );
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    if ("usage" in obj || "totalTokens" in u || "input" in u || "output" in u) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    return null;
  }
  return { inputTokens, outputTokens, totalTokens };
}
function recordSpentTokens(state, usage) {
  if (!usage) return;
  const total = typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) ? usage.totalTokens : Math.max(0, Number(usage.inputTokens ?? 0)) + Math.max(0, Number(usage.outputTokens ?? 0));
  if (total > state.spentTokens) {
    state.spentTokens = total;
  }
}
function classifySessionOutcome(session, options) {
  const state = session.agent?.state;
  const hasAgentState = Boolean(session.agent && "state" in session.agent);
  const errMsg = (state?.errorMessage ?? "").trim();
  const messages = state?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const stop = (lastAssistant?.stopReason ?? "").toLowerCase();
  const assistantErr = (lastAssistant?.errorMessage ?? "").trim();
  const combined = `${errMsg}
${assistantErr}
${stop}`.toLowerCase();
  const authHints = /auth|unauthorized|unauthenticated|invalid[_ -]?api[_ -]?key|api[_ -]?key|401|403|permission|credential|forbidden|invalid.?key|authentication/i;
  const providerHints = /provider|rate.?limit|overloaded|model.?not.?found|billing|quota|connection.?refused|enotfound|econnrefused|fetch failed|network/i;
  if (stop === "error" || stop === "aborted" || errMsg || assistantErr) {
    if (authHints.test(combined)) {
      return {
        ok: false,
        status: "failed",
        errorCategory: "auth",
        errorMessage: assistantErr || errMsg || "Provider authentication failed"
      };
    }
    if (providerHints.test(combined)) {
      return {
        ok: false,
        status: "failed",
        errorCategory: "provider",
        errorMessage: assistantErr || errMsg || "Provider request failed"
      };
    }
    return {
      ok: false,
      status: "failed",
      errorCategory: "provider",
      errorMessage: assistantErr || errMsg || `Model stopReason=${stop || "error"}`
    };
  }
  if (hasAgentState) {
    if (!lastAssistant) {
      return {
        ok: false,
        status: "failed",
        errorCategory: "provider",
        errorMessage: "No assistant response after prompt"
      };
    }
    return { ok: true, status: "succeeded", errorCategory: null, errorMessage: null };
  }
  if (options?.promptResolved) {
    return { ok: true, status: "succeeded", errorCategory: null, errorMessage: null };
  }
  return {
    ok: false,
    status: "failed",
    errorCategory: "provider",
    errorMessage: "No session outcome available"
  };
}

// lib/automation-resource-catalog.ts
var import_crypto = require("crypto");
var import_fs = require("fs");
var import_path = __toESM(require("path"));
function hashContent(content) {
  return (0, import_crypto.createHash)("sha256").update(content).digest("hex");
}
function hashPathClosure(rootPath) {
  if (!(0, import_fs.existsSync)(rootPath)) return hashContent(`missing:${rootPath}`);
  let st;
  try {
    st = (0, import_fs.statSync)(rootPath);
  } catch {
    return hashContent(`unreadable-stat:${rootPath}`);
  }
  if (st.isFile()) {
    try {
      return hashContent((0, import_fs.readFileSync)(rootPath));
    } catch {
      return hashContent(`unreadable:${rootPath}:${st.size}`);
    }
  }
  if (!st.isDirectory()) {
    return hashContent(`unsupported-type:${rootPath}`);
  }
  const files = [];
  const walk = (dir) => {
    let names;
    try {
      names = (0, import_fs.readdirSync)(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git" || name === ".hg" || name === ".svn") continue;
      const full = import_path.default.join(dir, name);
      let child;
      try {
        child = (0, import_fs.statSync)(full);
      } catch {
        continue;
      }
      if (child.isDirectory()) walk(full);
      else if (child.isFile()) files.push(full);
    }
  };
  walk(rootPath);
  files.sort((a, b) => a.replace(/\\/g, "/").localeCompare(b.replace(/\\/g, "/")));
  const h = (0, import_crypto.createHash)("sha256");
  h.update("dir-closure:v2\0");
  for (const f of files) {
    const rel = f.slice(rootPath.length).replace(/\\/g, "/").replace(/^\//, "");
    h.update(rel);
    h.update("\0");
    try {
      h.update((0, import_fs.readFileSync)(f));
    } catch {
      h.update(`unreadable:${rel}`);
    }
    h.update("\0");
  }
  return h.digest("hex");
}
function hashDirectoryClosure(root) {
  return hashPathClosure(root);
}

// lib/automation-worker-protocol.ts
function hashDirectoryClosure2(root) {
  return hashDirectoryClosure(root);
}
function estimatePromptTokens(text) {
  return estimateTextTokens(text) + 256;
}
function deriveMaxOutputTokens(input) {
  const decision = decideRequestBudget({
    maxTokensPerRun: input.maxTokensPerRun,
    spentTokens: 0,
    estimatedInputTokens: input.estimatedInputTokens,
    safetyMargin: input.safetyMargin
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };
  return { ok: true, maxOutputTokens: decision.maxOutputTokens };
}

// lib/automation-worker-host.ts
function findJsonl(sessionDir) {
  try {
    const files = (0, import_fs3.readdirSync)(sessionDir).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) return null;
    files.sort();
    return (0, import_path4.join)(sessionDir, files[files.length - 1]);
  } catch {
    return null;
  }
}
function sealSessionFile(sessionFile) {
  if (!sessionFile || !(0, import_fs3.existsSync)(sessionFile)) return null;
  try {
    const buf = (0, import_fs3.readFileSync)(sessionFile);
    const st = (0, import_fs3.statSync)(sessionFile);
    const text = buf.toString("utf8");
    return {
      size: st.size,
      sha256: (0, import_crypto4.createHash)("sha256").update(buf).digest("hex"),
      entryCount: text.split(/\r?\n/).filter((l) => l.trim()).length,
      sealedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch {
    return null;
  }
}
function extractUsage(session) {
  try {
    const stats = session.getSessionStats?.();
    if (stats?.tokens) {
      const input = Number(stats.tokens.input ?? 0);
      const output = Number(stats.tokens.output ?? 0);
      const total = Number(stats.tokens.total ?? input + output);
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        costUsd: Number(stats.cost ?? 0)
      };
    }
  } catch {
  }
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}
function verifyAndLoadExtensionFactories(artifacts) {
  const extensions = [];
  for (const art of artifacts) {
    if (!art.bundleSha256 || !art.bundleBytesBase64) {
      return { ok: false, reason: `extension artifact missing in-memory bundle for ${art.sourceIdentity}` };
    }
    let bundleBytes;
    try {
      bundleBytes = Buffer.from(art.bundleBytesBase64, "base64");
    } catch {
      return { ok: false, reason: `extension bundle bytes not base64 for ${art.sourceIdentity}` };
    }
    const live = (0, import_crypto4.createHash)("sha256").update(bundleBytes).digest("hex");
    if (live !== art.bundleSha256) {
      return {
        ok: false,
        reason: `extension bundle digest mismatch for ${art.sourceIdentity}: expected ${art.bundleSha256.slice(0, 12)} got ${live.slice(0, 12)}`
      };
    }
    try {
      const { loadFactoryFromVerifiedBundleBytes: loadFactoryFromVerifiedBundleBytes2 } = (init_automation_extension_runtime(), __toCommonJS(automation_extension_runtime_exports));
      const loaded = loadFactoryFromVerifiedBundleBytes2(bundleBytes, art.bundleSha256);
      extensions.push({
        sourceIdentity: art.sourceIdentity,
        sourcePath: art.sourcePath,
        bundleSha256: art.bundleSha256,
        entryRel: loaded.entryRel,
        factory: loaded.factory,
        packageClosure: loaded.packageClosure
      });
    } catch (error) {
      return {
        ok: false,
        reason: `extension in-memory load failed for ${art.sourceIdentity}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  return { ok: true, extensions };
}
function verifyExtensionArtifacts(artifacts) {
  const loaded = verifyAndLoadExtensionFactories(artifacts);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    paths: loaded.extensions.map((e) => `<in-memory:${e.bundleSha256.slice(0, 12)}:${e.entryRel}>`),
    extensions: loaded.extensions
  };
}
function emptySession(reason, sealed = false) {
  return {
    sessionId: null,
    sessionFile: null,
    availability: "unavailable",
    unavailableReason: reason,
    sealed,
    seal: null
  };
}
async function runJob(job, signal) {
  if (job.maxTokensPerRun > 0) {
    const bound = deriveMaxOutputTokens({
      maxTokensPerRun: job.maxTokensPerRun,
      estimatedInputTokens: job.estimatedInputTokens
    });
    if (!bound.ok) {
      return {
        status: "failed",
        summary: null,
        errorCategory: "budget",
        errorMessage: bound.reason,
        usage: {
          inputTokens: job.estimatedInputTokens,
          outputTokens: 0,
          totalTokens: job.estimatedInputTokens,
          costUsd: 0
        },
        actualModel: null,
        session: emptySession("budget_preflight"),
        sideEffectsStarted: false
      };
    }
  }
  const verified = verifyAndLoadExtensionFactories(job.extensionArtifacts ?? []);
  if (!verified.ok) {
    return {
      status: "blocked",
      summary: null,
      errorCategory: "preflight",
      errorMessage: verified.reason,
      usage: null,
      actualModel: null,
      session: emptySession("extension_digest_mismatch"),
      sideEffectsStarted: false
    };
  }
  let sessionObj = null;
  let sessionHandle = null;
  let sideEffectsStarted = false;
  let disposalConfirmed = false;
  let appliedModel = null;
  const budgetState = {
    maxTokensPerRun: job.maxTokensPerRun,
    spentTokens: 0,
    reservedTokens: 0
  };
  const disposeThenSeal = async (reason) => {
    let disposeOk = false;
    try {
      if (sessionObj) {
        const { disposeAgentSession: disposeAgentSession2 } = await Promise.resolve().then(() => (init_pi_session_lifecycle(), pi_session_lifecycle_exports));
        await disposeAgentSession2(sessionObj, "quit");
        disposeOk = true;
      } else {
        disposeOk = true;
      }
    } catch {
      disposeOk = false;
    }
    await new Promise((r) => setTimeout(r, 50));
    disposalConfirmed = disposeOk;
    const sessionFile = sessionHandle?.sessionFile ?? findJsonl(job.sessionDir);
    if (!disposeOk) {
      return {
        sessionId: sessionHandle?.sessionId ?? null,
        sessionFile,
        availability: sessionFile && (0, import_fs3.existsSync)(sessionFile) ? "available" : "unavailable",
        unavailableReason: "dispose_unconfirmed",
        unavailableDetail: reason || null,
        sealed: false,
        seal: null
      };
    }
    const seal = sealSessionFile(sessionFile);
    return {
      sessionId: sessionHandle?.sessionId ?? null,
      sessionFile,
      availability: sessionFile && (0, import_fs3.existsSync)(sessionFile) ? "available" : "unavailable",
      unavailableReason: sessionFile ? null : "no_session_file",
      sealed: Boolean(seal),
      seal
    };
  };
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const agentDir = job.agentDir || sdk.getAgentDir();
    const settingsManager = sdk.SettingsManager.create(job.cwd, agentDir);
    const verifiedAgain = verifyAndLoadExtensionFactories(job.extensionArtifacts ?? []);
    if (!verifiedAgain.ok) {
      return {
        status: "blocked",
        summary: null,
        errorCategory: "preflight",
        errorMessage: verifiedAgain.reason,
        usage: null,
        actualModel: null,
        session: emptySession("extension_digest_mismatch"),
        sideEffectsStarted: false
      };
    }
    const extensionFactories = verifiedAgain.extensions.map((ext, index) => ({
      name: `automation-verified-${index}-${ext.bundleSha256.slice(0, 12)}`,
      factory: ext.factory
    }));
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: job.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [],
      extensionFactories,
      extensionsOverride: ((base) => {
        const exts = (base.extensions ?? []).filter((e) => {
          const p = e.path ?? "";
          return p.startsWith("<inline:") || p.includes("automation-verified-");
        });
        return { ...base, extensions: exts };
      })
    });
    await resourceLoader.reload();
    sideEffectsStarted = true;
    const loaded = resourceLoader.getExtensions?.();
    for (const ext of loaded?.extensions ?? []) {
      const p = ext.path ?? "";
      if (!(p.startsWith("<inline:") || p.includes("automation-verified-"))) {
        throw new Error(`Unapproved extension loaded in worker: ${ext.path}`);
      }
    }
    (0, import_fs3.mkdirSync)(job.sessionDir, { recursive: true });
    const sessionManager = sdk.SessionManager.create(job.cwd, job.sessionDir);
    let customTools;
    const reviewedSnaps = job.reviewedWebTools && job.reviewedWebTools.length ? job.reviewedWebTools : (job.reviewedWebToolNames ?? []).map((name) => {
      const { buildReviewedWebToolSnapshot: buildReviewedWebToolSnapshot2 } = (init_automation_reviewed_web_tools(), __toCommonJS(automation_reviewed_web_tools_exports));
      if (name !== "web_search" && name !== "web_fetch") {
        throw new Error(`Unsupported reviewed web tool name: ${name}`);
      }
      const snap = buildReviewedWebToolSnapshot2(name);
      return {
        name: snap.name,
        origin: "custom",
        sourceIdentity: snap.sourceIdentity,
        executableDigest: snap.executableDigest,
        schemaHash: snap.schemaHash,
        configHash: snap.configHash,
        description: snap.description,
        risks: snap.risks
      };
    });
    if (reviewedSnaps.length) {
      const { createAutomationReviewedWebTools: createAutomationReviewedWebTools2 } = await Promise.resolve().then(() => (init_automation_reviewed_web_tools(), automation_reviewed_web_tools_exports));
      customTools = createAutomationReviewedWebTools2(
        reviewedSnaps.map((t) => ({
          name: t.name,
          origin: "custom",
          sourceIdentity: t.sourceIdentity,
          executableDigest: t.executableDigest,
          schemaHash: t.schemaHash,
          configHash: t.configHash,
          description: t.description,
          hookInventory: [],
          risks: t.risks ?? {
            headlessCompatible: true,
            localMutation: false,
            networkEgress: true,
            credentialUse: false,
            interactionRequired: false,
            blocked: false
          }
        }))
      );
      if (customTools.length !== reviewedSnaps.length) {
        const got = new Set(customTools.map((t) => t.name));
        const missing = reviewedSnaps.filter((t) => !got.has(t.name)).map((t) => t.name);
        throw Object.assign(
          new Error(
            `Reviewed web tools failed exact registry match (refusing silent drop): ${missing.join(", ")}`
          ),
          { code: "blocked", blockedReason: "reauthorization_required" }
        );
      }
    }
    const { createAgentSessionWithServices: createAgentSessionWithServices2 } = await Promise.resolve().then(() => (init_agent_session_services(), agent_session_services_exports));
    const { session } = await createAgentSessionWithServices2({
      cwd: job.cwd,
      agentDir,
      sessionManager,
      resourceLoader,
      tools: job.toolNames.length ? job.toolNames : [],
      customTools: customTools?.length ? customTools : void 0,
      settingsManager
    });
    sessionObj = session;
    sessionHandle = session;
    const blockUi = () => {
      throw Object.assign(new Error("Headless automation cannot satisfy interactive UI request"), {
        code: "blocked",
        blockedReason: "interaction_required"
      });
    };
    const headlessUi = {
      mode: "print",
      confirm: blockUi,
      select: blockUi,
      input: blockUi,
      editor: blockUi,
      notify: () => void 0
    };
    let headlessBound = false;
    if (typeof sessionHandle?.bindExtensions === "function") {
      try {
        await sessionHandle.bindExtensions({ uiContext: headlessUi, mode: "print" });
        headlessBound = true;
      } catch (bindErr) {
        const sessionMeta = await disposeThenSeal("bind_extensions_failed");
        return {
          status: "blocked",
          summary: null,
          errorCategory: "interaction_required",
          errorMessage: `bindExtensions/uiContext failed: ${bindErr instanceof Error ? bindErr.message : String(bindErr)}`,
          usage: null,
          actualModel: appliedModel,
          session: sessionMeta,
          sideEffectsStarted: true
        };
      }
    }
    if (sessionHandle?.ui) {
      sessionHandle.ui.confirm = blockUi;
      sessionHandle.ui.select = blockUi;
      sessionHandle.ui.input = blockUi;
      sessionHandle.ui.editor = blockUi;
      headlessBound = true;
    }
    if (sessionHandle?.agent && typeof sessionHandle.agent === "object") {
      try {
        sessionHandle.agent.ui = headlessUi;
        headlessBound = true;
      } catch {
      }
    }
    if (!headlessBound) {
      const sessionMeta = await disposeThenSeal("headless_ui_unbound");
      return {
        status: "blocked",
        summary: null,
        errorCategory: "interaction_required",
        errorMessage: "Headless UI binding unavailable (no bindExtensions/ui surface)",
        usage: null,
        actualModel: appliedModel,
        session: sessionMeta,
        sideEffectsStarted: true
      };
    }
    appliedModel = {
      provider: job.model.provider,
      modelId: job.model.modelId,
      thinking: job.model.thinking ?? null
    };
    try {
      const model = sessionHandle?.modelRuntime?.getModel?.(job.model.provider, job.model.modelId);
      if (model && typeof sessionHandle?.setModel === "function") {
        if (job.maxOutputTokens > 0 && model && typeof model === "object") {
          const m = model;
          const cap = job.maxOutputTokens;
          if (typeof m.maxTokens === "number") {
            m.maxTokens = Math.min(m.maxTokens, cap);
          } else {
            m.maxTokens = cap;
          }
          if (m.request && typeof m.request === "object") {
            if (typeof m.request.max_tokens === "number") {
              m.request.max_tokens = Math.min(m.request.max_tokens, cap);
            } else {
              m.request.max_tokens = cap;
            }
            if (typeof m.request.maxTokens === "number") {
              m.request.maxTokens = Math.min(m.request.maxTokens, cap);
            }
          }
        }
        await sessionHandle.setModel(model);
      }
      if (job.model.thinking && typeof sessionHandle?.setThinkingLevel === "function") {
        await sessionHandle.setThinkingLevel(job.model.thinking);
      }
      appliedModel = {
        provider: sessionHandle?.model?.provider ?? appliedModel.provider,
        modelId: sessionHandle?.model?.id ?? appliedModel.modelId,
        thinking: sessionHandle?.thinkingLevel ?? appliedModel.thinking
      };
    } catch (error) {
      throw new Error(
        `Failed to apply model: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (sessionHandle?.agent && typeof sessionHandle.agent === "object") {
      const agent = sessionHandle.agent;
      if (typeof agent.streamFunction === "function") {
        const base = agent.streamFunction.bind(agent);
        agent.streamFunction = wrapStreamFnWithTokenBudget(base, budgetState, {
          onReject: (reason) => {
            try {
              sessionHandle?.abort?.();
            } catch {
            }
            if (typeof process.send === "function") {
              process.send({ type: "progress", budgetExceeded: true, reason });
            }
          }
        });
      }
    }
    let budgetAborted = false;
    const tokenMonitor = setInterval(() => {
      if (budgetAborted || signal.aborted) return;
      try {
        const usage = extractUsage(sessionHandle ?? {});
        recordSpentTokens(budgetState, usage);
        const total = usage?.totalTokens ?? 0;
        if (job.maxTokensPerRun > 0 && total > job.maxTokensPerRun) {
          budgetAborted = true;
          try {
            sessionHandle?.abort?.();
          } catch {
          }
          if (typeof process.send === "function") {
            process.send({ type: "progress", usage, budgetExceeded: true });
          }
        } else if (usage && typeof process.send === "function") {
          process.send({ type: "progress", usage });
        }
      } catch {
      }
    }, 250);
    tokenMonitor.unref?.();
    const onAbort = () => {
      try {
        sessionHandle?.abort?.();
      } catch {
      }
    };
    signal.addEventListener("abort", onAbort);
    try {
      if (signal.aborted) {
        return {
          status: "cancelled",
          summary: null,
          errorCategory: "cancelled",
          errorMessage: "Cancelled before prompt",
          usage: extractUsage(sessionHandle ?? {}),
          actualModel: appliedModel,
          session: await disposeThenSeal("cancelled_before_prompt"),
          sideEffectsStarted: true
        };
      }
      if (job.maxTokensPerRun > 0 && sessionHandle?.agent) {
        const st = sessionHandle.agent.state;
        const estimated = estimateContextTokens({
          systemPrompt: st?.systemPrompt,
          tools: st?.tools,
          messages: st?.messages,
          extraText: job.prompt
        });
        const decision = decideRequestBudget({
          maxTokensPerRun: job.maxTokensPerRun,
          spentTokens: budgetState.spentTokens,
          estimatedInputTokens: estimated
        });
        if (!decision.ok) {
          return {
            status: "failed",
            summary: null,
            errorCategory: "budget",
            errorMessage: decision.reason,
            usage: {
              inputTokens: estimated,
              outputTokens: 0,
              totalTokens: estimated,
              costUsd: 0
            },
            actualModel: appliedModel,
            session: await disposeThenSeal("budget_pre_prompt"),
            sideEffectsStarted: true
          };
        }
      }
      if (typeof sessionHandle?.prompt !== "function") {
        throw new Error("Session missing prompt()");
      }
      const promptResult = await sessionHandle.prompt(job.prompt);
      const usage = extractUsage(sessionHandle);
      recordSpentTokens(budgetState, usage);
      const total = usage?.totalTokens ?? 0;
      const overBudget = budgetAborted || job.maxTokensPerRun > 0 && total > job.maxTokensPerRun;
      const overOutput = job.maxOutputTokens > 0 && (usage?.outputTokens ?? 0) > job.maxOutputTokens + 64;
      if (overBudget || overOutput) {
        return {
          status: "failed",
          summary: null,
          errorCategory: "budget",
          errorMessage: overOutput ? `Output tokens exceeded hard maxOutputTokens=${job.maxOutputTokens}` : `Exceeded maxTokensPerRun=${job.maxTokensPerRun}`,
          usage,
          actualModel: appliedModel,
          session: await disposeThenSeal("budget"),
          sideEffectsStarted: true
        };
      }
      if (signal.aborted) {
        return {
          status: "cancelled",
          summary: null,
          errorCategory: "cancelled",
          errorMessage: "Cancelled",
          usage,
          actualModel: appliedModel,
          session: await disposeThenSeal("cancelled"),
          sideEffectsStarted: true
        };
      }
      const outcome = classifySessionOutcome(
        {
          agent: sessionHandle?.agent
        },
        { promptResolved: true }
      );
      if (!outcome.ok) {
        return {
          status: outcome.status,
          summary: null,
          errorCategory: outcome.errorCategory,
          errorMessage: outcome.errorMessage,
          usage,
          actualModel: appliedModel,
          session: await disposeThenSeal(outcome.errorCategory ?? "provider"),
          sideEffectsStarted: true
        };
      }
      return {
        status: "succeeded",
        summary: typeof promptResult === "string" ? promptResult.slice(0, 500) : "Automation completed",
        errorCategory: null,
        errorMessage: null,
        usage,
        actualModel: appliedModel,
        session: await disposeThenSeal("success"),
        sideEffectsStarted: true
      };
    } finally {
      clearInterval(tokenMonitor);
      signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = error?.code;
    const errorCategory = code === "budget" || error?.errorCategory === "budget" ? "budget" : code === "blocked" || error?.blockedReason ? "preflight" : "runner";
    const status = errorCategory === "budget" ? "failed" : errorCategory === "preflight" ? "blocked" : "failed";
    let sessionResult;
    if (sessionObj || sessionHandle) {
      sessionResult = await disposeThenSeal(errorCategory);
    } else {
      sessionResult = emptySession(errorCategory);
    }
    if (!disposalConfirmed && (sessionObj || sessionHandle)) {
      sessionResult = {
        ...sessionResult,
        sealed: false,
        seal: null,
        unavailableReason: sessionResult.unavailableReason ?? "dispose_unconfirmed"
      };
    }
    return {
      status,
      summary: null,
      errorCategory,
      errorMessage: msg,
      usage: sessionHandle ? extractUsage(sessionHandle) : null,
      actualModel: appliedModel,
      session: sessionResult,
      sideEffectsStarted
    };
  }
}
var isWorkerEntrypoint = typeof process.send === "function" && Boolean(process.argv[1]) && /automation-worker-(host|runtime)/.test(String(process.argv[1]).replace(/\\/g, "/"));
if (isWorkerEntrypoint) {
  for (const banned of ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[banned]) {
      process.send?.({
        type: "error",
        message: `Worker refused ambient injection env: ${banned}`
      });
      process.exit(2);
    }
  }
  const ac = new AbortController();
  process.on("message", (msg) => {
    const m = msg;
    if (m?.type === "abort") {
      ac.abort();
      return;
    }
    if (m?.type === "start" && m.job) {
      void runJob(m.job, ac.signal).then((result) => {
        process.send?.({ type: "result", result });
        setTimeout(() => process.exit(0), 50);
      }).catch((error) => {
        process.send?.({
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
        setTimeout(() => process.exit(1), 50);
      });
    }
  });
  process.send?.({ type: "ready" });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  deriveMaxOutputTokens,
  estimatePromptTokens,
  hashDirectoryClosure,
  runJob,
  verifyAndLoadExtensionFactories,
  verifyExtensionArtifacts
});
