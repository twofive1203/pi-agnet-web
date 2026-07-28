import { normalizeFilePathSlashes } from "./file-paths";

export interface FileViewerLocation {
  filePath: string;
  line?: number;
  column?: number;
}

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function splitPosition(filePath: string): FileViewerLocation {
  const match = filePath.match(/:(\d+)(?::(\d+))?$/);
  if (!match) return { filePath };

  const line = Number(match[1]);
  const column = match[2] ? Number(match[2]) : undefined;
  return {
    filePath: filePath.slice(0, match.index),
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(column && Number.isSafeInteger(column) && column > 0 ? { column } : {}),
  };
}

export function isAbsoluteFilePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\\\");
}

export function parseLegacyWindowsFilePath(pathname: string): FileViewerLocation | null {
  const decoded = decodePath(pathname);
  if (!decoded) return null;

  const withoutLeadingSlash = decoded.replace(/^\/+/, "");
  if (!WINDOWS_ABSOLUTE_RE.test(withoutLeadingSlash)) return null;
  return splitPosition(normalizeFilePathSlashes(withoutLeadingSlash));
}

/**
 * Recognize file URLs emitted by local coding agents without converting normal
 * web links. Canonical /file links are deliberately left untouched.
 */
export function parseLocalFileHref(href?: string): FileViewerLocation | null {
  if (!href || href.startsWith("/file?") || href.startsWith("/api/")) return null;

  if (WINDOWS_ABSOLUTE_RE.test(href)) {
    const decoded = decodePath(href);
    return decoded ? splitPosition(normalizeFilePathSlashes(decoded)) : null;
  }

  if (/^\/[a-zA-Z]:[\\/]/.test(href)) {
    return parseLegacyWindowsFilePath(href);
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol === "file:") {
    const decoded = decodePath(url.pathname);
    if (!decoded) return null;
    const normalized = normalizeFilePathSlashes(decoded);
    const filePath = /^\/[a-zA-Z]:\//.test(normalized) ? normalized.slice(1) : normalized;
    return isAbsoluteFilePath(filePath) ? splitPosition(filePath) : null;
  }

  if ((url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname)) {
    return parseLegacyWindowsFilePath(url.pathname);
  }

  return null;
}

export function buildStandaloneFileUrl(
  filePath: string,
  options: { line?: number; column?: number; cwd?: string } = {},
): string {
  const params = new URLSearchParams({ path: normalizeFilePathSlashes(filePath) });
  if (options.line && Number.isSafeInteger(options.line) && options.line > 0) {
    params.set("line", String(options.line));
  }
  if (options.column && Number.isSafeInteger(options.column) && options.column > 0) {
    params.set("column", String(options.column));
  }
  if (options.cwd) params.set("cwd", normalizeFilePathSlashes(options.cwd));
  return `/file?${params.toString()}`;
}
