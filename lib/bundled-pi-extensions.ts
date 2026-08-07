import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { PiWebBundledExtensionsConfig } from "./pi-web-config";
import { readPiWebConfig } from "./pi-web-config";
import {
  BUNDLED_PI_EXTENSIONS,
  type BundledPiExtensionDefinition,
  type BundledPiExtensionId,
} from "./bundled-pi-extension-registry";

export {
  BUNDLED_PI_EXTENSIONS,
  type BundledPiExtensionDefinition,
  type BundledPiExtensionId,
} from "./bundled-pi-extension-registry";

interface SourceInfoLike {
  path?: string;
  source?: string;
  scope?: string;
  origin?: string;
  baseDir?: string;
}

interface ExtensionLike {
  path: string;
  resolvedPath?: string;
  sourceInfo?: SourceInfoLike;
}

interface FileResourceLike {
  filePath?: string;
  path?: string;
  sourceInfo?: SourceInfoLike;
}

interface ResourceDiagnosticLike {
  type?: string;
  message?: string;
  path?: string;
  collision?: {
    winnerPath?: string;
    loserPath?: string;
  };
}

interface ResourceLoaderLike {
  reload: (options?: unknown) => Promise<void>;
  getExtensions: () => { extensions: ExtensionLike[]; errors: Array<{ path: string; error: string }> };
  getSkills: () => { skills: FileResourceLike[]; diagnostics: ResourceDiagnosticLike[] };
  getPrompts: () => { prompts: FileResourceLike[]; diagnostics: ResourceDiagnosticLike[] };
}

interface ResourceLoaderOptionsLike {
  cwd: string;
  agentDir: string;
  additionalExtensionPaths?: string[];
}

export interface BundledPiExtensionRuntimeStatus {
  id: BundledPiExtensionId;
  packageName: string;
  pinnedVersion: string;
  installedVersion?: string;
  displayName: string;
  description: string;
  enabled: boolean;
  packageRoot?: string;
  available: boolean;
  source: "webui-bundled";
  ignoredDuplicateCount: number;
  diagnostic?: string;
}

interface ResolvedBundle {
  definition: BundledPiExtensionDefinition;
  root?: string;
  installedVersion?: string;
  diagnostic?: string;
}

const BUNDLE_STATE = Symbol("snail-pi-web.bundled-extensions");

type LoaderWithBundleState = ResourceLoaderLike & {
  [BUNDLE_STATE]?: BundledPiExtensionRuntimeStatus[];
};

function resolveRequireFilename(): string {
  try {
    const cjsFilename = Function(
      "return typeof __filename !== 'undefined' ? __filename : null",
    )() as string | null;
    if (cjsFilename) return cjsFilename;
  } catch {
    // ESM runtimes do not define __filename.
  }
  try {
    if (typeof import.meta.url === "string" && import.meta.url) return import.meta.url;
  } catch {
    // Bundled runtimes may not expose import.meta.url.
  }
  return join(process.cwd(), "lib", "bundled-pi-extensions.js");
}

function getNodeRequire(): NodeRequire {
  return createRequire(resolveRequireFilename());
}

function findPackageRoot(packageName: string): { root?: string; version?: string; diagnostic?: string } {
  let entryPath: string;
  try {
    entryPath = getNodeRequire().resolve(packageName);
  } catch (entryError) {
    try {
      const manifestPath = getNodeRequire().resolve(`${packageName}/package.json`);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name === packageName) {
        return {
          root: dirname(manifestPath),
          version: typeof manifest.version === "string" ? manifest.version : undefined,
        };
      }
    } catch {
      // Fall through to the entry-point diagnostic below.
    }
    return { diagnostic: `Bundled dependency could not be resolved: ${entryError instanceof Error ? entryError.message : String(entryError)}` };
  }

  let current = dirname(entryPath);
  while (true) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === packageName) {
          return {
            root: current,
            version: typeof manifest.version === "string" ? manifest.version : undefined,
          };
        }
      } catch {
        // Keep walking; an ancestor manifest may own the resolved entry.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { diagnostic: `Resolved ${packageName}, but its package root could not be identified.` };
}

let resolvedBundlesCache: ResolvedBundle[] | undefined;

function resolveBundles(): ResolvedBundle[] {
  if (resolvedBundlesCache) return resolvedBundlesCache;
  resolvedBundlesCache = BUNDLED_PI_EXTENSIONS.map((definition) => {
    const resolvedPackage = findPackageRoot(definition.packageName);
    const versionMismatch = resolvedPackage.version && resolvedPackage.version !== definition.version
      ? `Expected ${definition.version}, resolved ${resolvedPackage.version}.`
      : undefined;
    return {
      definition,
      root: resolvedPackage.root,
      installedVersion: resolvedPackage.version,
      diagnostic: resolvedPackage.diagnostic ?? versionMismatch,
    };
  });
  return resolvedBundlesCache;
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function owningPackageName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  let current = dirname(resolve(path));
  while (true) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
        if (typeof manifest.name === "string") return manifest.name;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resourcePath(resource: ExtensionLike | FileResourceLike): string | undefined {
  if ("resolvedPath" in resource && resource.resolvedPath) return resource.resolvedPath;
  if ("filePath" in resource && resource.filePath) return resource.filePath;
  return resource.path;
}

function bundledSourceInfo(bundle: ResolvedBundle, path: string): SourceInfoLike {
  return {
    path,
    source: `webui-bundled:${bundle.definition.packageName}@${bundle.definition.version}`,
    scope: "temporary",
    origin: "package",
    baseDir: bundle.root,
  };
}

function enabledBundles(config: PiWebBundledExtensionsConfig): ResolvedBundle[] {
  return resolveBundles().filter((bundle) => config[bundle.definition.id]);
}

function findBundleForPath(path: string | undefined, bundles: ResolvedBundle[]): ResolvedBundle | undefined {
  if (!path) return undefined;
  return bundles.find((bundle) => bundle.root && isPathInside(path, bundle.root));
}

function isDuplicateResource(path: string | undefined, bundles: ResolvedBundle[]): ResolvedBundle | undefined {
  if (!path) return undefined;
  const owner = owningPackageName(path);
  if (!owner) return undefined;
  return bundles.find((bundle) => (
    bundle.root
    && bundle.definition.packageName === owner
    && !isPathInside(path, bundle.root)
  ));
}

function filterCollisionDiagnostics(diagnostics: ResourceDiagnosticLike[], bundles: ResolvedBundle[]): ResourceDiagnosticLike[] {
  return diagnostics.filter((diagnostic) => {
    const paths = [diagnostic.path, diagnostic.collision?.winnerPath, diagnostic.collision?.loserPath];
    return !paths.some((path) => isDuplicateResource(path, bundles));
  });
}

function annotateLoadedResources(
  loader: LoaderWithBundleState,
  bundles: ResolvedBundle[],
  config: PiWebBundledExtensionsConfig,
  duplicateCounts: Map<BundledPiExtensionId, number>,
): void {
  for (const extension of loader.getExtensions().extensions) {
    const path = resourcePath(extension);
    const bundle = findBundleForPath(path, bundles);
    if (bundle && path) extension.sourceInfo = bundledSourceInfo(bundle, path);
  }
  for (const resource of loader.getSkills().skills) {
    const path = resourcePath(resource);
    const bundle = findBundleForPath(path, bundles);
    if (bundle && path) resource.sourceInfo = bundledSourceInfo(bundle, path);
  }
  for (const resource of loader.getPrompts().prompts) {
    const path = resourcePath(resource);
    const bundle = findBundleForPath(path, bundles);
    if (bundle && path) resource.sourceInfo = bundledSourceInfo(bundle, path);
  }

  loader[BUNDLE_STATE] = resolveBundles().map((bundle) => ({
    id: bundle.definition.id,
    packageName: bundle.definition.packageName,
    pinnedVersion: bundle.definition.version,
    installedVersion: bundle.installedVersion,
    displayName: bundle.definition.displayName,
    description: bundle.definition.description,
    enabled: config[bundle.definition.id],
    packageRoot: bundle.root,
    available: !!bundle.root && bundle.installedVersion === bundle.definition.version,
    source: "webui-bundled" as const,
    ignoredDuplicateCount: duplicateCounts.get(bundle.definition.id) ?? 0,
    diagnostic: bundle.diagnostic,
  }));
}

/**
 * Build the WebUI interactive resource loader. Automation must keep using its
 * reviewed loader and must not call this helper.
 */
export function createBundledPiResourceLoader<T, O>(
  ResourceLoader: new (options: O) => T,
  options: O & ResourceLoaderOptionsLike,
): T {
  let config = readPiWebConfig().bundledExtensions;
  let bundles = enabledBundles(config);
  let loadableBundles = bundles.filter((bundle) => bundle.root && bundle.installedVersion === bundle.definition.version);
  let bundleRoots = loadableBundles.flatMap((bundle) => bundle.root ? [bundle.root] : []);
  const callerAdditionalExtensionPaths = options.additionalExtensionPaths ?? [];
  const refreshBundleSelection = () => {
    config = readPiWebConfig().bundledExtensions;
    bundles = enabledBundles(config);
    loadableBundles = bundles.filter((bundle) => bundle.root && bundle.installedVersion === bundle.definition.version);
    bundleRoots = loadableBundles.flatMap((bundle) => bundle.root ? [bundle.root] : []);
  };
  type ExtensionOverrideBase = {
    extensions: ExtensionLike[];
    errors: Array<{ path: string; error: string }>;
    [key: string]: unknown;
  };
  type SkillsOverrideBase = {
    skills: FileResourceLike[];
    diagnostics: ResourceDiagnosticLike[];
  };
  type PromptsOverrideBase = {
    prompts: FileResourceLike[];
    diagnostics: ResourceDiagnosticLike[];
  };
  const overrides = options as O & {
    extensionsOverride?: (base: ExtensionOverrideBase) => ExtensionOverrideBase;
    skillsOverride?: (base: SkillsOverrideBase) => SkillsOverrideBase;
    promptsOverride?: (base: PromptsOverrideBase) => PromptsOverrideBase;
  };
  const callerExtensionsOverride = overrides.extensionsOverride;
  const callerSkillsOverride = overrides.skillsOverride;
  const callerPromptsOverride = overrides.promptsOverride;
  const duplicateCounts = new Map<BundledPiExtensionId, number>();

  const loaderOptions = {
    ...options,
    additionalExtensionPaths: [
      ...bundleRoots,
      ...callerAdditionalExtensionPaths,
    ],
    extensionsOverride: (base: ExtensionOverrideBase) => {
      duplicateCounts.clear();
      for (const extension of base.extensions) {
        const duplicateBundle = isDuplicateResource(resourcePath(extension), loadableBundles);
        if (duplicateBundle) {
          duplicateCounts.set(
            duplicateBundle.definition.id,
            (duplicateCounts.get(duplicateBundle.definition.id) ?? 0) + 1,
          );
        }
      }
      const filtered = {
        ...base,
        extensions: base.extensions.filter((extension) => !isDuplicateResource(resourcePath(extension), loadableBundles)),
        errors: [
          ...base.errors.filter((error) => !isDuplicateResource(error.path, loadableBundles)),
          ...bundles
            .filter((bundle) => !loadableBundles.includes(bundle))
            .map((bundle) => ({
              path: `<webui-bundled:${bundle.definition.packageName}>`,
              error: bundle.diagnostic ?? `Expected bundled version ${bundle.definition.version} is unavailable.`,
            })),
        ],
      };
      return callerExtensionsOverride ? callerExtensionsOverride(filtered) : filtered;
    },
    skillsOverride: (base: SkillsOverrideBase) => {
      const filtered = {
        ...base,
        skills: base.skills.filter((skill) => !isDuplicateResource(resourcePath(skill), loadableBundles)),
        diagnostics: filterCollisionDiagnostics(base.diagnostics, loadableBundles),
      };
      return callerSkillsOverride ? callerSkillsOverride(filtered) : filtered;
    },
    promptsOverride: (base: PromptsOverrideBase) => {
      const filtered = {
        ...base,
        prompts: base.prompts.filter((prompt) => !isDuplicateResource(resourcePath(prompt), loadableBundles)),
        diagnostics: filterCollisionDiagnostics(base.diagnostics, loadableBundles),
      };
      return callerPromptsOverride ? callerPromptsOverride(filtered) : filtered;
    },
  } as O;
  const loader = new ResourceLoader(loaderOptions);
  const runtimeLoader = loader as unknown as LoaderWithBundleState;
  const originalReload = runtimeLoader.reload.bind(runtimeLoader);
  runtimeLoader.reload = async (reloadOptions?: unknown) => {
    refreshBundleSelection();
    // Pi 0.83+/0.84 stores this TypeScript-private field as a normal instance
    // property. Refresh it so Settings toggles take effect through /reload,
    // not only when a new AgentSession is constructed.
    (runtimeLoader as unknown as { additionalExtensionPaths: string[] }).additionalExtensionPaths = [
      ...bundleRoots,
      ...callerAdditionalExtensionPaths,
    ];
    await originalReload(reloadOptions);
    annotateLoadedResources(runtimeLoader, loadableBundles, config, duplicateCounts);
  };
  return loader;
}

export function projectBundledPiSourceInfo<T extends SourceInfoLike>(sourceInfo: T | undefined): T | undefined {
  const path = sourceInfo?.path;
  if (!path) return sourceInfo;
  const bundle = findBundleForPath(path, enabledBundles(readPiWebConfig().bundledExtensions));
  return bundle ? bundledSourceInfo(bundle, path) as T : sourceInfo;
}

export function isBundledPiResourcePath(path: string): boolean {
  return resolveBundles().some((bundle) => bundle.root && isPathInside(path, bundle.root));
}

export function getBundledPiExtensionRuntimeStatus(loader?: unknown): BundledPiExtensionRuntimeStatus[] {
  const status = (loader as LoaderWithBundleState | undefined)?.[BUNDLE_STATE];
  if (status) return status.map((item) => ({ ...item }));
  const config = readPiWebConfig().bundledExtensions;
  return resolveBundles().map((bundle) => ({
    id: bundle.definition.id,
    packageName: bundle.definition.packageName,
    pinnedVersion: bundle.definition.version,
    installedVersion: bundle.installedVersion,
    displayName: bundle.definition.displayName,
    description: bundle.definition.description,
    enabled: config[bundle.definition.id],
    packageRoot: bundle.root,
    available: !!bundle.root && bundle.installedVersion === bundle.definition.version,
    source: "webui-bundled",
    ignoredDuplicateCount: 0,
    diagnostic: bundle.diagnostic,
  }));
}
