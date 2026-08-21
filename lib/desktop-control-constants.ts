/**
 * Shared desktop-control wire constants.
 *
 * Kept free of server-only imports so the Electron pet bundle can depend on
 * this module without pulling Automation/rpc/Next runtime graphs.
 */

export const DESKTOP_CONTROL_TOKEN_HEADER = "x-spi-desktop-control-token";
/** Short-lived write token — independent of the 15-minute observer TTL. */
export const DESKTOP_CONTROL_TOKEN_TTL_MS = 5 * 60 * 1000;
export const DESKTOP_CONTROL_PRODUCT = "snail-pi-web" as const;
export const DESKTOP_CONTROL_API_PREFIX = "/api/desktop-control";

/** First-release control scopes. Observer tokens never carry these. */
export const DESKTOP_CONTROL_SCOPE_QUICK_SESSION = "quick_session" as const;

export const DESKTOP_CONTROL_SCOPES = [DESKTOP_CONTROL_SCOPE_QUICK_SESSION] as const;

export type DesktopControlScope = (typeof DESKTOP_CONTROL_SCOPES)[number];

/** Additive protocol capability advertised on the observer protocol probe. */
export const DESKTOP_PROTOCOL_CAPABILITY_QUICK_SESSION = "quick_session" as const;
/** Additive capability: server accepts remote (non-loopback) desktop attach. */
export const DESKTOP_PROTOCOL_CAPABILITY_REMOTE_ATTACH = "remote_attach" as const;

export const DESKTOP_PROTOCOL_CAPABILITIES = [
  DESKTOP_PROTOCOL_CAPABILITY_QUICK_SESSION,
  DESKTOP_PROTOCOL_CAPABILITY_REMOTE_ATTACH,
] as const;

export type DesktopProtocolCapability = (typeof DESKTOP_PROTOCOL_CAPABILITIES)[number];
