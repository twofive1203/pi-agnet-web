/**
 * Optional launch-at-login helper (U7).
 *
 * Only toggles the pet process login item — never starts/stops the Snail Pi service.
 */

export type LoginItemSettings = {
  openAtLogin: boolean;
  openAsHidden?: boolean;
};

export type LoginItemHost = {
  getLoginItemSettings(): LoginItemSettings;
  setLoginItemSettings(settings: LoginItemSettings): void;
};

export function readLaunchAtLogin(host: LoginItemHost): boolean {
  try {
    return host.getLoginItemSettings().openAtLogin === true;
  } catch {
    return false;
  }
}

/**
 * Apply desired launch-at-login. Failures are swallowed — preference still persists locally.
 */
export function applyLaunchAtLogin(host: LoginItemHost, enabled: boolean): boolean {
  try {
    host.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
    });
    return readLaunchAtLogin(host) === enabled;
  } catch {
    return false;
  }
}
