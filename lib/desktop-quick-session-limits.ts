/**
 * Renderer/main-safe quick-session input limits.
 * Kept free of server-only imports so the Electron pet bundle can share them.
 */

export const DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS = 8000;
export const DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN = /^p_[a-f0-9]{16}$/;

/** Provider/model ids stay path-free and short enough for the compact picker. */
export const DESKTOP_QUICK_SESSION_PROVIDER_MAX_CHARS = 64;
export const DESKTOP_QUICK_SESSION_MODEL_ID_MAX_CHARS = 200;
export const DESKTOP_QUICK_SESSION_MODEL_NAME_MAX_CHARS = 120;
export const DESKTOP_QUICK_SESSION_MODEL_LIST_LIMIT = 80;

const CONTROL_OR_PATH_CHARS = /[\0\\/]/;

export function isDesktopQuickSessionProvider(value: string): boolean {
  return (
    value.length > 0
    && value.length <= DESKTOP_QUICK_SESSION_PROVIDER_MAX_CHARS
    && value === value.trim()
    && !CONTROL_OR_PATH_CHARS.test(value)
  );
}

export function isDesktopQuickSessionModelId(value: string): boolean {
  return (
    value.length > 0
    && value.length <= DESKTOP_QUICK_SESSION_MODEL_ID_MAX_CHARS
    && value === value.trim()
    && !CONTROL_OR_PATH_CHARS.test(value)
  );
}
