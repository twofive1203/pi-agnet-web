# Deployment and Runtime Guide

This guide covers local runtime, npm installation, source builds, production deployment, and npm release operations for 蜗牛派 (Snail Pi Web).

## Runtime Requirements

| Dependency | Requirement | Notes |
| --- | --- | --- |
| Node.js | **>=22.19.0** (required; matches pi SDK engines) | Required by Next.js 16 / React 19 and `@earendil-works/pi-coding-agent`. Lower versions may fail to start. |
| npm | npm 10+ recommended | Used for `npx`, global installs, source installs, and publishing. |
| pi agent data directory | Defaults to `~/.pi/agent/` | Stores sessions, model config, settings, and pi-web settings. |
| Git | Optional, recommended | Required for Git status, branch switching, graph, and WorkTree features. |
| Local shell | Optional | Required only when Web Terminal is enabled. |
| Chrome (desktop) | Optional | Required only for the unpacked Tab Debug extension and browser tools. |

Web Terminal uses `@lydell/node-pty` as the server-side PTY dependency. If a target machine has native dependency issues, keep Web Terminal disabled; the session browser and chat flows do not require PTY support.

Browser tab debugging adds a loopback-only WebSocket bridge (default `127.0.0.1:62667`) started lazily when browser control is enabled. The Chrome MV3 extension package lives at `extensions/chrome-tab-debug` and is loaded unpacked during development. Pairing metadata is stored in `~/.pi/agent/browser-bridge.json`; temporary tab bindings are never restored across process restarts.

## npm Package Runtime

Published npm package name: `@twofive/snail-pi-web`

CLI command: `spi`

Run without installing:

```bash
npx @twofive/snail-pi-web@latest
```

Install globally:

```bash
npm install -g @twofive/snail-pi-web
spi
```

Default URL: `http://127.0.0.1:62666` (loopback only, no authentication). The CLI attempts to open the browser after the server is ready.

**Security defaults:** official launchers no longer inherit Next.js `0.0.0.0`. Any official non-loopback listen, or explicit `--server` / `PI_WEB_SERVER_MODE=1`, enables global access-key authentication. Server mode requires effective HTTPS for access-key login and authenticated requests by default. Use a trusted HTTPS reverse proxy; `--allow-insecure-http` is an explicit compatibility escape hatch only for transports already encrypted by another trusted layer.

### CLI Options

```bash
spi                              # loopback, auth off
spi --port 8080                  # custom port
spi --server                     # 0.0.0.0 + access-key auth
spi --server -H 127.0.0.1        # loopback backend + auth (HTTPS reverse proxy)
spi --server --rotate-access-key # mint a new access key; invalidate all sessions
spi --server --allow-insecure-http # explicit HTTP compatibility (trusted encrypted mesh only)
spi -H 0.0.0.0                   # non-loopback bind auto-enables auth and requires HTTPS
spi --no-open                    # do not open a browser on Ready
PORT=8080 spi
PI_WEB_HOSTNAME=10.0.0.5 spi     # listen host (do not use system HOSTNAME)
PI_WEB_SERVER_MODE=1 spi         # force auth (defaults bind 0.0.0.0 when host unset)
PI_WEB_TRUST_PROXY=1 spi --server -H 127.0.0.1   # trust X-Forwarded-Proto for Secure cookies
PI_WEB_ALLOW_INSECURE_HTTP=1 spi --server          # explicit compatibility escape hatch
# Optional one-shot env override (wins over the policy file when the var is set):
PI_WEB_AUTH_BYPASS_CIDRS=100.64.0.0/10 spi --server --no-open
spi --proxy http://127.0.0.1:7897
spi --socks-proxy socks5://127.0.0.1:7897
```

**Preferred durable config** — create `~/.pi/agent/server-access-policy.json` (or under `PI_CODING_AGENT_DIR`):

```json
{
  "version": 1,
  "authBypassCidrs": ["100.64.0.0/10"]
}
```

Bypass matches the **TCP socket remote address only** (not `X-Forwarded-For` / Host). LAN clients outside the list still need the access key. World-open rules and loopback rules (`127.0.0.0/8`, `::1`) are rejected: trusting loopback would also trust every client forwarded by a local reverse proxy. If `PI_WEB_AUTH_BYPASS_CIDRS` is set in the environment (even to empty), it overrides the file for that process.

`npx` accepts the same options:

```bash
npx @twofive/snail-pi-web@latest --port 8080
```

When proxy options or proxy environment variables are present, `spi` forwards
`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, and appends
`--use-env-proxy` to `NODE_OPTIONS` so Node/Next server-side fetch calls use the
proxy. It also accepts the same environment aliases as the proxy startup scripts:
`PROXY_URL` for HTTP/HTTPS proxy and `SOCKS_PROXY_URL` for `ALL_PROXY`.

## Data and Configuration

Default data directory is `~/.pi/agent/`; override it with `PI_CODING_AGENT_DIR`:

```bash
PI_CODING_AGENT_DIR=/path/to/pi-agent-data spi
```

| File/dir | Purpose |
| --- | --- |
| `sessions/` | Session JSONL files, grouped by encoded workspace path. |
| `models.json` | Model provider/model configuration. |
| `settings.json` | pi settings, including default model. |
| `pi-web.json` | Web UI settings, including WorkTree defaults, Usage scope, Web Terminal settings, ChatGPT panel/auto-refresh settings, Grok usage panel toggle, Editor settings, and SnFlow panel preferences. Unknown legacy root keys such as `trellis` are ignored and preserved on disk. |
| `server-access.json` | Server-mode access-key verifier (scrypt) + opaque session hashes. No plaintext access key. Persist this directory across container/PM2 restarts. Restrict file permissions; first-start key may also appear in process logs. |
| `server-access-policy.json` | Optional durable auth policy (e.g. `authBypassCidrs` for Tailscale/mesh peers). Kept separate from `pi-web.json` so Settings UI cannot rewrite it. Env `PI_WEB_AUTH_BYPASS_CIDRS` overrides this file when set. |
| `chatgpt-usage-refresh.lock` | Backend ChatGPT usage auto-refresh lock file; stale locks can be repaired from the ChatGPT panel fault handler. |
| `grok-usage-refresh.lock` | Backend Grok usage auto-refresh lock file; stale locks can be repaired from the Grok panel fault handler. |

Session path format:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

## Local Development

```bash
npm install
npm run dev      # http://localhost:62666
```

Use `npm run dev` for development. Do not run `next build` directly during dev.

Minimum validation:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

## Source Production Build

```bash
npm run build    # runs scripts/build-next.js
npm run start    # serves on port 62666
```

`npm run build` uses `scripts/build-next.js`, which sets `HOME` and `USERPROFILE` to `.next-build-home/` to avoid protected Windows home junction issues. Do not run `next build` directly for project validation.

`npm run start` and `npm run dev` both go through `bin/pi-web.js` (same security defaults as `spi`):

```bash
npm run start -- --port 8080
npm run start -- --server -H 127.0.0.1
PORT=8080 npm run start
```

### HTTPS reverse proxy (recommended for remote access)

1. Run the backend on loopback with auth enabled and trusted proxy protocol handling:

```bash
PI_WEB_TRUST_PROXY=1 spi --server -H 127.0.0.1 -p 62666 --no-open
```

2. Terminate TLS on Caddy/Nginx and proxy to `http://127.0.0.1:62666`; the proxy must overwrite `X-Forwarded-Proto` and `X-Forwarded-Host`.
3. Only set `PI_WEB_TRUST_PROXY=1` when the proxy is trusted and the backend bind is loopback — this lets effective HTTPS pass the transport gate and makes cookies `Secure`.
4. Save the one-time access key printed on first server start; later restarts reuse the verifier and do not reprint it.
5. If the key is lost or leaked: `spi --server --rotate-access-key` (invalidates every browser session).
6. **Tailscale / trusted mesh without unlock page:** bind directly with `--server` and put exact peers or the intended mesh CIDR in `server-access-policy.json` (`authBypassCidrs`, e.g. one device `/32`; use `100.64.0.0/10` only when every tailnet peer is trusted). Optional env override: `PI_WEB_AUTH_BYPASS_CIDRS`. Loopback entries are rejected and must never be used for a reverse proxy.

**Breaking change:** hosts that previously relied on implicit LAN exposure via Next's default `0.0.0.0` must migrate to `--server` (or an explicit non-loopback hostname).

## PM2

`ecosystem.config.cjs` runs the official launcher in **single-process fork** mode:

- process name `snail-pi-web`
- `instances: 1`, `exec_mode: "fork"` (cluster / multi-instance is unsupported — auth state is single-writer; ordinary chat wrappers and SSE listeners are process-local)
- args: `--server --no-open -H 127.0.0.1 -p 62666` (auth on, loopback backend for HTTPS reverse proxy)
- `PI_WEB_TRUST_PROXY=1` so the trusted proxy's HTTPS protocol passes the transport gate and produces Secure cookies
- persist `PI_CODING_AGENT_DIR` so `server-access.json` survives restarts

Start with:

```bash
pm2 start ecosystem.config.cjs
```

For direct LAN listen, change args to `--server --no-open -H 0.0.0.0 -p 62666` **and remove `PI_WEB_TRUST_PROXY`**; clients still need HTTPS unless they match an approved mesh CIDR or the deployment explicitly enables the insecure-HTTP compatibility escape hatch on an already encrypted transport.

### Single-instance guardrails

- Official launchers and Node instrumentation refuse known multi-instance markers by default (`NODE_APP_INSTANCE`, Node cluster `NODE_UNIQUE_ID`, `WEB_CONCURRENCY>1`, `instances>1`).
- Ready/boot logs print `pid`, `instanceId`, `mode` (`local`|`server`), and `bind` so operators can confirm which process is live.
- Emergency override only: `PI_WEB_ALLOW_MULTI_INSTANCE=1` (still unsupported; logs a strong warning). **Sticky load-balancing does not make multi-replica supported** until cross-process session coordination exists.
- Automation already has its own cross-process scheduler lock/leader/standby path; that does **not** extend to ordinary chat sessions.

### Runtime health

`GET /api/health` is a public minimal probe (no session ids, cwds, paths, or secrets):

```bash
curl -sS http://127.0.0.1:62666/api/health
```

Useful fields: `pid`, `instanceId`, `mode`, `bind`, `liveSessions`, `sseListeners`, `singleInstance`, and `scheduler.role` (`leader`|`standby`|`inactive`|`unavailable`).

## Proxy Startup

- `scripts/start-pi-web-proxy.sh` starts Snail Pi Web with `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NODE_OPTIONS=--use-env-proxy`.
- `scripts/start-pi-web-proxy.ps1` provides the same proxy startup flow for PowerShell and accepts launcher flags directly:
  - `.\scripts\start-pi-web-proxy.ps1` — local loopback, auth off
  - `.\scripts\start-pi-web-proxy.ps1 -Server -NoOpen` — server mode (auth on, HTTPS required; default no browser)
  - `.\scripts\start-pi-web-proxy.ps1 -Dev` — dev via official launcher
  - `.\scripts\start-pi-web-proxy.ps1 -Server -AuthBypassCidrs "100.64.0.0/10"` — one-shot bypass override
  - `.\scripts\start-pi-web-proxy.ps1 -Server -AllowInsecureHttp` — explicit HTTP compatibility for an already encrypted trusted mesh
- Prefer durable bypass in `server-access-policy.json` over repeating `-AuthBypassCidrs`.
- Legacy: `PI_WEB_CMD` still overrides the whole command when set.

Default proxy is `http://127.0.0.1:7897`; override with `PROXY_URL` or `SOCKS_PROXY_URL` where supported.

## Repository Remotes

The shared upstream repository is `git@github.com:twofive1203/pi-agnet-web.git`. Configure it once with:

```bash
git remote add upstream git@github.com:twofive1203/pi-agnet-web.git
# or, if upstream already exists:
git remote set-url upstream git@github.com:twofive1203/pi-agnet-web.git
```

Fetch upstream `main` with:

```bash
git fetch upstream main
```

## Windows Desktop Pet (separate artifact)

The desktop pet is an **attach-only** Electron companion. It is **not** part of the npm `@twofive/snail-pi-web` / `spi` package (`package.json#files` excludes `desktop/` and `forge.config.ts`).

### Independent startup

Either order works; the pet reconnects when the service becomes available.

**From this repo (dev):**

```bash
# terminal A
npm run dev                   # or: spi --no-open

# terminal B
npm run desktop:build         # esbuild → desktop/main/main.js + preload
npm run desktop:dev           # rebuild if stale, then Electron
# npm run desktop:dev:rebuild
```

`desktop:dev` never starts `spi`. Requires devDependencies `electron` and `esbuild` (not published in the npm `spi` tarball).

**Installed / packaged pet:**

```bash
spi --no-open                 # local service, default http://127.0.0.1:62666
# then launch SnailPiPet / snail-pi-pet (installer or packaged exe)
```

**UI basics:** drag the top grip to move; click the pet to toggle Activity tray; **×** hides to tray; tray Quit ends only the pet.

| Rule | Detail |
| --- | --- |
| Loopback only | `127.0.0.1` local mode; server mode / remote / multi-instance aggregation are rejected. |
| No process ownership | Pet never spawns, stops, signals, or stores a service PID. |
| Service not running | UI shows 蜗牛派服务未启动 + copyable `spi --no-open` + Retry (never auto-executes). |
| Quit / uninstall | Leaving or removing the pet must not stop `spi` or delete `~/.pi/agent`. |
| Node requirement | Packaged pet must not require a system Node install; `spi` remains a separate Node/npm install. |

### Packaging contract

```bash
npm run desktop:package   # build bundles, then create desktop/out/SnailPiPet-win32-x64
npm run desktop:make      # build bundles, package, then create Squirrel Setup/NUPKG
# Windows PowerShell:
$env:DESKTOP_PACKAGE_OUT = "desktop/out"; npm run test:desktop-package
```

The scripts call the repository-pinned `@electron-forge/cli` directly (never the obsolete unscoped `electron-forge`) and run `desktop:build` first. Forge uses the private `desktop/package.json` as the application root; the root package remains the separate npm `spi` publish surface.

- Config: root `forge.config.ts` + `DESKTOP_PACKAGE_CONTRACT` (pet-only ignore list, Squirrel maker, AppUserModelID `com.twofive.snail-pi-pet`).
- Source app: `desktop/` (`desktop/package.json` is `private: true`, name `snail-pi-pet`).
- Branded assets: `desktop/assets/icons/icon.ico`, `icon.png`, and `desktop/assets/tray/tray-icon.png`.
- Contract smoke: `npm run test:desktop-package` (and full `npm run test:desktop-observer`). With `DESKTOP_PACKAGE_OUT=desktop/out`, it scans expanded resources, ASAR entries, and Squirrel NUPKG paths for forbidden server runtime (`.next`, Next/pi SDK, node-pty, Automation workers, `bin/pi-web.js`, …) and required pet bundles/assets.
- Signing: set both `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD` in the packaging environment. `CSC_LINK` / `CSC_KEY_PASSWORD` remain reserved alternate CI placeholders. Never commit certificate material. Unsigned builds are for engineering QA; SmartScreen may warn until signed.
- Full AE matrix and manual Windows gates: [`docs/operations/desktop-pet-validation.md`](../operations/desktop-pet-validation.md).

> Do not publish the pet inside the npm `spi` tarball. Do not bundle Next/pi/Automation workers/node-pty into the pet installer.

## npm Package Release

Before publishing, authenticate and validate the release bundle:

```bash
npm whoami
npm run lint
node_modules/.bin/tsc --noEmit
npm run test:server-auth
npm run test:runtime
npm run test:desktop-package
npm run build
npm run test:server-auth:e2e
npm pack --dry-run
```

Confirm `npm pack --dry-run` does **not** list `desktop/` or `forge.config.ts`.

Publish the current version:

```bash
npm publish --access public
```

For later patch releases, use the release script, which bumps the version, runs `prepublishOnly`, and publishes publicly:

```bash
npm run release:patch
```

If publishing with a token, configure npm carefully and never commit tokens:

```bash
npm config set registry https://registry.npmjs.org/
npm config set @twofive:registry https://registry.npmjs.org/
npm config set //registry.npmjs.org/:_authToken "<token>"
```

After publishing, verify the package:

```bash
npm view @twofive/snail-pi-web version --prefer-online
npx @twofive/snail-pi-web@latest --port 62666
```

## Scheduled Agent Automation

- Scheduler starts from root `instrumentation.ts` on the Node runtime only. Schedules execute while the Snail Pi Web process is alive (no OS daemon in v1).
- Cross-process leader lease uses `~/.pi/agent/automations/scheduler.lock` with epoch fencing; stale leaders cannot finalize runs after takeover.
- Automation HTTP APIs require a proven loopback connection (socket remote address captured at request start). Reverse-proxy / non-loopback deployments are rejected in v1.
- Data roots: `~/.pi/agent/automations/` and default workspace `~/pi-automation-cwd`.
- Validate with `npm run test:automation`. Release builds must use `npm run build` (never bare `next build`).
- Node engine in `package.json` is `>=22.19.0`.
