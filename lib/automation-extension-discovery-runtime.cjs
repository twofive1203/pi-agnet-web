"use strict";

"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// lib/automation-extension-discovery-host.ts
var automation_extension_discovery_host_exports = {};
__export(automation_extension_discovery_host_exports, {
  runDiscoveryWorkerMain: () => main
});
module.exports = __toCommonJS(automation_extension_discovery_host_exports);

// lib/automation-extension-runtime.ts
var import_crypto = require("crypto");
var import_module = require("module");
var import_module2 = __toESM(require("module"));
var import_path = __toESM(require("path"));
var import_vm = __toESM(require("vm"));
var import_meta = {};
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
  return import_path.default.join(process.cwd(), "lib", "automation-extension-runtime.js");
}
function getNodeRequire() {
  return (0, import_module.createRequire)(resolveRequireFilename());
}
function sha256Buf(buf) {
  return (0, import_crypto.createHash)("sha256").update(buf).digest("hex");
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
  const baseDir = import_path.default.posix.dirname(parentRel.replace(/\\/g, "/"));
  let joined = spec.replace(/\\/g, "/");
  if (joined.startsWith(".")) {
    joined = import_path.default.posix.normalize(import_path.default.posix.join(baseDir === "." ? "" : baseDir, joined));
  } else {
    joined = import_path.default.posix.normalize(joined);
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
    import_path.default.posix.join(rel, "index.js"),
    import_path.default.posix.join(rel, "index.cjs"),
    import_path.default.posix.join(rel, "index.mjs"),
    import_path.default.posix.join(rel, "index.ts"),
    import_path.default.posix.join(rel, "package.json")
  ].filter((x) => Boolean(x));
  for (const c of candidates) {
    const norm = c.replace(/\\/g, "/");
    if (files.has(norm)) {
      if (norm.endsWith("package.json")) {
        try {
          const pkg = JSON.parse(files.get(norm).toString("utf8"));
          if (pkg.main) {
            const mainRel = import_path.default.posix.join(import_path.default.posix.dirname(norm), pkg.main.replace(/^\.\//, "")).replace(/\\/g, "/");
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
  const virtualRoot = import_path.default.join(
    import_path.default.sep === "\\" ? "C:\\__automation_verified__" : "/__automation_verified__",
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
    const filename = import_path.default.join(virtualRoot, resolved);
    const mod = new import_module2.default(filename);
    mod.filename = filename;
    mod.paths = import_module2.default._nodeModulePaths(
      import_path.default.dirname(filename)
    );
    mod.exports = {};
    moduleCache.set(resolved, mod);
    const raw = files.get(resolved).toString("utf8");
    const code = transformExtensionSourceToCjs(raw);
    const dirname = import_path.default.dirname(filename);
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
            if (r) return import_path.default.join(virtualRoot, r);
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
    compiled(mod.exports, localRequire, mod, filename, dirname);
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

// lib/automation-extension-discovery-host.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  let req;
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      process.stdout.write(JSON.stringify({ ok: false, error: "empty discovery request" }));
      process.exitCode = 2;
      return;
    }
    req = JSON.parse(raw);
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: `invalid discovery request JSON: ${error instanceof Error ? error.message : String(error)}`
      })
    );
    process.exitCode = 2;
    return;
  }
  if (typeof req.bundleBytesBase64 !== "string" || typeof req.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(req.expectedSha256) || typeof req.sourcePath !== "string") {
    process.stdout.write(
      JSON.stringify({ ok: false, error: "discovery request fields invalid" })
    );
    process.exitCode = 2;
    return;
  }
  try {
    const bundleBytes = Buffer.from(req.bundleBytesBase64, "base64");
    const registration = await discoverExtensionRegistrationFromBytes({
      bundleBytes,
      bundleSha256: req.expectedSha256.toLowerCase(),
      sourcePath: req.sourcePath
    });
    const response = { ok: true, registration };
    process.stdout.write(JSON.stringify(response));
    process.exitCode = 0;
  } catch (error) {
    const response = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
    process.stdout.write(JSON.stringify(response));
    process.exitCode = 1;
  }
}
var entryHint = (process.argv[1] ?? "").replace(/\\/g, "/");
var isDirect = /automation-extension-discovery-(host|runtime)/.test(entryHint) || typeof require !== "undefined" && typeof module !== "undefined" && typeof require.main !== "undefined" && require.main === module;
if (isDirect) {
  void main();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runDiscoveryWorkerMain
});
