/**
 * Renderer/main-safe quick-session input limits.
 * Kept free of server-only imports so the Electron pet bundle can share them.
 */

export const DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS = 8000;
export const DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN = /^p_[a-f0-9]{16}$/;
