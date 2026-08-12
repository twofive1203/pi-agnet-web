/**
 * Shared desktop-observer wire constants.
 *
 * Kept free of server-only imports so the Electron pet bundle can depend on
 * this module without pulling Automation/rpc/Next runtime graphs.
 */

export const DESKTOP_OBSERVER_TOKEN_HEADER = "x-spi-desktop-observer-token";
export const DESKTOP_OBSERVER_TOKEN_TTL_MS = 15 * 60 * 1000;
export const DESKTOP_OBSERVER_PRODUCT = "snail-pi-web" as const;
