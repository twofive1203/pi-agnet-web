/**
 * Main-process deep link open gate (U7).
 *
 * Renderer may only request open-by-activity-id or a relative allowlisted href.
 * Absolute/remote URLs are rejected before shell.openExternal (R22 / AE6).
 */

import {
  isAllowlistedDesktopDeepLink,
  resolveDesktopDeepLink,
} from "../../lib/desktop-deep-link";

export type OpenExternalFn = (url: string) => Promise<void> | void;

export type DeepLinkOpenResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Validate relative href against loopback origin, then open in the default browser.
 */
export function openValidatedDeepLink(input: {
  origin: string;
  relativeHref: string;
  openExternal: OpenExternalFn;
}): DeepLinkOpenResult {
  const href = input.relativeHref.trim();
  if (!href) return { ok: false, reason: "empty" };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//")) {
    return { ok: false, reason: "absolute_or_protocol_relative" };
  }
  if (!isAllowlistedDesktopDeepLink(href)) {
    return { ok: false, reason: "not_allowlisted" };
  }
  const resolved = resolveDesktopDeepLink(input.origin, href);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  try {
    void input.openExternal(resolved.url);
  } catch {
    return { ok: false, reason: "open_failed" };
  }
  return { ok: true, url: resolved.url };
}

/** Reject renderer-supplied absolute URLs without attempting open. Always fails. */
export function rejectArbitraryRendererUrl(raw: string): { ok: false; reason: string } {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "empty" };
  if (
    /^https?:\/\//i.test(value) ||
    /^\/\//.test(value) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
  ) {
    return { ok: false, reason: "absolute_url_rejected" };
  }
  return { ok: false, reason: "not_allowlisted" };
}
