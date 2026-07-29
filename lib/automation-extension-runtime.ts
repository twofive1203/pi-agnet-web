/**
 * In-memory verified extension execution.
 *
 * Bundle bytes are hashed once; factories and relative package imports resolve
 * exclusively from those verified bytes. Mutable filesystem extracts are never
 * imported for execution (eliminates verify→import TOCTOU).
 */

import { createHash } from "crypto";
import { createRequire } from "module";
import Module from "module";
import path from "path";
import vm from "vm";

export type ExtensionBundleV1 = {
  v: 1;
  entry: string;
  files: Record<string, string>; // relPath -> base64
};

export type VerifiedExtensionLoad = {
  bundleSha256: string;
  entryRel: string;
  /** Immutable relative paths present in the verified bundle. */
  packageClosure: string[];
  /** Factory exported by the entry module (default or module.exports). */
  factory: (pi: unknown) => unknown | Promise<unknown>;
};

export type DiscoveredExtensionRegistration = {
  sourcePath: string;
  entryRel: string;
  bundleSha256: string;
  packageClosure: string[];
  tools: Array<{
    name: string;
    description?: string;
    parameters?: unknown;
    label?: string;
  }>;
  hooks: string[];
  /** Non-tool registrations observed during factory probe. */
  flags: string[];
};

// Support both ESM (dev/tsx) and bundled CJS worker (import.meta may be empty).
function resolveRequireFilename(): string {
  try {
    // CJS bundle defines __filename; access via Function so ESM parse does not bind it.
    const cjsFilename = Function(
      "return typeof __filename !== 'undefined' ? __filename : null",
    )() as string | null;
    if (cjsFilename) return cjsFilename;
  } catch {
    // ignore
  }
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === "string" && metaUrl.length > 0) return metaUrl;
  } catch {
    // ignore
  }
  return path.join(process.cwd(), "lib", "automation-extension-runtime.js");
}
/** Lazy require — avoid top-level createRequire so bundlers do not warn on parse. */
function getNodeRequire(): NodeRequire {
  return createRequire(resolveRequireFilename());
}

function sha256Buf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Parse + verify bundle bytes once. Throws on digest/format mismatch. */
export function parseAndVerifyBundle(
  bundleBytes: Buffer,
  expectedSha256: string,
): { bundle: ExtensionBundleV1; files: Map<string, Buffer>; bundleSha256: string } {
  const live = sha256Buf(bundleBytes);
  if (live !== expectedSha256) {
    throw new Error(
      `extension bundle digest mismatch: expected ${expectedSha256.slice(0, 12)} got ${live.slice(0, 12)}`,
    );
  }
  let bundle: ExtensionBundleV1;
  try {
    bundle = JSON.parse(bundleBytes.toString("utf8")) as ExtensionBundleV1;
  } catch (error) {
    throw new Error(
      `extension bundle JSON invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bundle?.v !== 1 || typeof bundle.entry !== "string" || !bundle.files || typeof bundle.files !== "object") {
    throw new Error("extension bundle format invalid (expected v1 entry+files)");
  }
  const files = new Map<string, Buffer>();
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

function normalizeRel(spec: string, parentRel: string): string {
  const baseDir = path.posix.dirname(parentRel.replace(/\\/g, "/"));
  let joined = spec.replace(/\\/g, "/");
  if (joined.startsWith(".")) {
    joined = path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, joined));
  } else {
    joined = path.posix.normalize(joined);
  }
  return joined.replace(/^\.\//, "").replace(/^\/+/, "");
}

function resolveInBundle(files: Map<string, Buffer>, rel: string): string | null {
  const candidates = [
    rel,
    rel.endsWith(".js") || rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".cjs")
      ? null
      : `${rel}.js`,
    rel.endsWith(".js") || rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".cjs")
      ? null
      : `${rel}.cjs`,
    rel.endsWith(".js") || rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".cjs")
      ? null
      : `${rel}.mjs`,
    rel.endsWith(".js") || rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".cjs")
      ? null
      : `${rel}.ts`,
    path.posix.join(rel, "index.js"),
    path.posix.join(rel, "index.cjs"),
    path.posix.join(rel, "index.mjs"),
    path.posix.join(rel, "index.ts"),
    path.posix.join(rel, "package.json"),
  ].filter((x): x is string => Boolean(x));
  for (const c of candidates) {
    const norm = c.replace(/\\/g, "/");
    if (files.has(norm)) {
      if (norm.endsWith("package.json")) {
        try {
          const pkg = JSON.parse(files.get(norm)!.toString("utf8")) as { main?: string };
          if (pkg.main) {
            const mainRel = path.posix
              .join(path.posix.dirname(norm), pkg.main.replace(/^\.\//, ""))
              .replace(/\\/g, "/");
            const resolvedMain = resolveInBundle(files, mainRel);
            if (resolvedMain) return resolvedMain;
          }
        } catch {
          // fallthrough
        }
      } else {
        return norm;
      }
    }
  }
  return null;
}

/** Minimal ESM→CJS rewrite for common extension entry shapes. */
export function transformExtensionSourceToCjs(source: string): string {
  let code = source;
  // Strip type-only imports/exports (best-effort for .ts sources).
  code = code.replace(/^\s*import\s+type\s+[^;]+;?\s*$/gm, "");
  code = code.replace(/^\s*export\s+type\s+[^;]+;?\s*$/gm, "");

  // import X from "mod" / import { a } from "mod" / import * as X from "mod"
  code = code.replace(
    /^\s*import\s+(\w+)\s*,\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, def, named, mod) =>
      `const ${def} = require(${JSON.stringify(mod)}); const {${named}} = ${def};`,
  );
  code = code.replace(
    /^\s*import\s+(\w+)\s+from\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, def, mod) => `const ${def} = require(${JSON.stringify(mod)});`,
  );
  code = code.replace(
    /^\s*import\s+\*\s+as\s+(\w+)\s+from\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, def, mod) => `const ${def} = require(${JSON.stringify(mod)});`,
  );
  code = code.replace(
    /^\s*import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, named, mod) => `const {${named}} = require(${JSON.stringify(mod)});`,
  );
  code = code.replace(
    /^\s*import\s*["']([^"']+)["']\s*;?\s*$/gm,
    (_m, mod) => `require(${JSON.stringify(mod)});`,
  );

  // export default ...
  if (/export\s+default\s+/.test(code)) {
    code = code.replace(/export\s+default\s+async\s+function\s*\(/, "async function __ext_default(");
    code = code.replace(/export\s+default\s+function\s*\(/, "function __ext_default(");
    code = code.replace(/export\s+default\s+class\s+/, "class __ext_default ");
    code = code.replace(/export\s+default\s+/, "const __ext_default = ");
    code += "\nmodule.exports = __ext_default; module.exports.default = __ext_default;\n";
  }

  // export function/const/let/var name
  code = code.replace(
    /export\s+(async\s+function|function|class|const|let|var)\s+(\w+)/g,
    (_m, kind, name) => {
      return `${kind} ${name}`;
    },
  );
  // export { a, b as c }
  code = code.replace(/export\s*\{([^}]+)\}\s*;?/g, (_m, body) => {
    const parts = String(body)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts
      .map((p) => {
        const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(p);
        if (!m) return "";
        const from = m[1]!;
        const to = m[2] ?? from;
        return `module.exports[${JSON.stringify(to)}] = ${from};`;
      })
      .join("\n");
  });

  // export { a } from "mod"
  code = code.replace(
    /export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?/g,
    (_m, body, mod) => {
      const parts = String(body)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const lines = [`const __re = require(${JSON.stringify(mod)});`];
      for (const p of parts) {
        const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(p);
        if (!m) continue;
        const from = m[1]!;
        const to = m[2] ?? from;
        lines.push(`module.exports[${JSON.stringify(to)}] = __re[${JSON.stringify(from)}];`);
      }
      return lines.join("\n");
    },
  );

  return code;
}

/**
 * Evaluate the entry module and all relative imports strictly from verified
 * in-memory file bytes. External bare specifiers use the real Node require.
 */
export function loadFactoryFromVerifiedBundleBytes(
  bundleBytes: Buffer,
  expectedSha256: string,
): VerifiedExtensionLoad {
  const { bundle, files, bundleSha256 } = parseAndVerifyBundle(bundleBytes, expectedSha256);
  const entryRel = bundle.entry.replace(/\\/g, "/");
  const moduleCache = new Map<string, NodeModule>();
  const virtualRoot = path.join(
    path.sep === "\\" ? "C:\\__automation_verified__" : "/__automation_verified__",
    bundleSha256.slice(0, 16),
  );

  function loadRel(relSpec: string, parentRel: string): unknown {
    let rel = relSpec.replace(/\\/g, "/");
    if (rel.startsWith(".")) {
      rel = normalizeRel(rel, parentRel);
    } else if (!rel.startsWith("/") && files.has(rel)) {
      // bare path present in bundle
    } else if (!rel.startsWith(".")) {
      // external package
      return getNodeRequire()(relSpec);
    }
    const resolved = resolveInBundle(files, rel);
    if (!resolved) {
      // Try external as last resort for non-relative
      if (!relSpec.startsWith(".")) {
        return getNodeRequire()(relSpec);
      }
      throw new Error(`Missing module in verified extension bundle: ${rel} (from ${parentRel})`);
    }
    if (moduleCache.has(resolved)) {
      return moduleCache.get(resolved)!.exports;
    }

    const filename = path.join(virtualRoot, resolved);
    const mod = new Module(filename) as NodeModule & {
      paths: string[];
    };
    mod.filename = filename;
    mod.paths = (Module as unknown as { _nodeModulePaths: (p: string) => string[] })._nodeModulePaths(
      path.dirname(filename),
    );
    mod.exports = {};
    moduleCache.set(resolved, mod);

    const raw = files.get(resolved)!.toString("utf8");
    const code = transformExtensionSourceToCjs(raw);
    const dirname = path.dirname(filename);

    const localRequire = Object.assign(
      (id: string) => {
        if (id.startsWith(".") || files.has(id.replace(/\\/g, "/"))) {
          return loadRel(id, resolved);
        }
        // Prefer in-bundle package-style paths
        const asRel = resolveInBundle(files, id.replace(/\\/g, "/"));
        if (asRel) return loadRel(asRel, resolved);
        return getNodeRequire()(id);
      },
      {
        resolve: (id: string) => {
          if (id.startsWith(".")) {
            const r = resolveInBundle(files, normalizeRel(id, resolved));
            if (r) return path.join(virtualRoot, r);
          }
          return getNodeRequire().resolve(id);
        },
        cache: {},
        extensions: (Module as unknown as { _extensions: unknown })._extensions,
        main: process.mainModule,
      },
    ) as NodeRequire;

    mod.require = localRequire;

    const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${code}\n})`;
    const compiled = vm.runInThisContext(wrapper, {
      filename,
      lineOffset: 0,
      displayErrors: true,
    }) as (
      exports: unknown,
      require: NodeRequire,
      module: NodeModule,
      __filename: string,
      __dirname: string,
    ) => void;
    compiled(mod.exports, localRequire, mod, filename, dirname);

    // ESM interop: some modules only set .default
    const exp = mod.exports as { default?: unknown };
    if (
      exp &&
      typeof exp === "object" &&
      "default" in exp &&
      (exp as { __esModule?: boolean }).__esModule !== false
    ) {
      // keep both
    }
    return mod.exports;
  }

  const entryExports = loadRel(entryRel, entryRel) as { default?: unknown } | ((pi: unknown) => unknown);
  let factory: (pi: unknown) => unknown | Promise<unknown>;
  if (typeof entryExports === "function") {
    factory = entryExports as (pi: unknown) => unknown;
  } else if (entryExports && typeof entryExports === "object" && typeof entryExports.default === "function") {
    factory = entryExports.default as (pi: unknown) => unknown;
  } else {
    throw new Error(
      `Extension entry did not export a factory function: ${entryRel}`,
    );
  }

  return {
    bundleSha256,
    entryRel,
    packageClosure: [...files.keys()].sort(),
    factory,
  };
}

/** Build a mock ExtensionAPI that records registrations without side effects. */
export function createDiscoveryExtensionApi(): {
  api: Record<string, unknown>;
  tools: DiscoveredExtensionRegistration["tools"];
  hooks: string[];
  flags: string[];
} {
  const tools: DiscoveredExtensionRegistration["tools"] = [];
  const hooks: string[] = [];
  const flags: string[] = [];
  const api: Record<string, unknown> = {
    registerTool: (tool: {
      name?: string;
      label?: string;
      description?: string;
      parameters?: unknown;
    }) => {
      if (tool?.name) {
        tools.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          label: tool.label,
        });
      }
    },
    on: (event: string) => {
      if (event) hooks.push(String(event));
    },
    registerCommand: (cmd: { name?: string }) => {
      if (cmd?.name) flags.push(`command:${cmd.name}`);
    },
    registerFlag: (flag: { name?: string } | string) => {
      const name = typeof flag === "string" ? flag : flag?.name;
      if (name) flags.push(`flag:${name}`);
    },
    registerShortcut: (s: { name?: string }) => {
      if (s?.name) flags.push(`shortcut:${s.name}`);
    },
    registerMessageRenderer: () => {
      flags.push("messageRenderer");
    },
    appendEntry: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    setModel: () => undefined,
    setThinkingLevel: () => undefined,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => undefined,
    getCommands: () => [],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  // Proxy unknown methods as no-ops so factories don't throw on optional APIs.
  const proxied = new Proxy(api, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string") {
        return () => undefined;
      }
      return undefined;
    },
  });
  return { api: proxied as Record<string, unknown>, tools, hooks, flags };
}

/**
 * Load factory from verified bytes and probe registrations (no durable side effects).
 */
export async function discoverExtensionRegistrationFromBytes(input: {
  bundleBytes: Buffer;
  bundleSha256: string;
  sourcePath: string;
}): Promise<DiscoveredExtensionRegistration> {
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
    flags: probe.flags,
  };
}
