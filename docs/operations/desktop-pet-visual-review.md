# Desktop Pet Visual Review

- **Date:** 2026-08-13
- **Plan unit:** U3 (`DESKTOP_PET_NEXT_PHASE_IMPLEMENTATION_PLAN.md`)
- **Preview:** `npm run desktop:preview` then open `desktop/.preview/index.html`
- **Safety:** preview loads only static sanitized fixtures. It does not attach to the observer, read session/cwd, or expose production preload/IPC.
- **Current P0 run:** [`desktop-pet-p0-validation-2026-08-13.md`](desktop-pet-p0-validation-2026-08-13.md) — P0 closed on 2026-08-14 with the remaining visual matrix accepted as documented residual risk; Running redesign remains P1.

Use this sheet for the eight presentation states, two built-in pets, three sizes, tray/settings, and reduced-motion. Automated smokes prove the preview is isolated; they do not replace this visual matrix.

**Known review focus:** the shared Running `pet-scoot` loop has been reported as an unnatural repeated arching/thrusting motion. Do not mark Running Pass solely because it renders without clipping; watch each relevant combination for 10–20 seconds and judge the motion itself.

## How to review

1. Run `npm run desktop:build` then `npm run desktop:preview`.
2. Open `desktop/.preview/index.html` in a desktop browser.
3. Walk every combination in the generated `desktop/.preview/review/checklist.md`.
4. Record Pass / Fail / Blocked below. Do not mark a combination Pass from smoke output alone.
5. Capture screenshots only with synthetic titles. Never include tokens, cwd, prompts, or live session text.

The generated preview directory is local-only and ignored by Forge packaging.

## Combinations

Mark each row after visual inspection.

| ID | Combination | Result | Notes |
| --- | --- | --- | --- |
| snail-default-small-idle | 星海蜗牛 / small / idle | **未执行** | |
| snail-default-small-running | 星海蜗牛 / small / running | **未执行** | |
| snail-default-small-retrying | 星海蜗牛 / small / retrying | **未执行** | |
| snail-default-small-needs_input | 星海蜗牛 / small / needs_input | **未执行** | |
| snail-default-small-ready | 星海蜗牛 / small / ready | **未执行** | |
| snail-default-small-blocked | 星海蜗牛 / small / blocked | **未执行** | |
| snail-default-small-disconnected | 星海蜗牛 / small / disconnected | **未执行** | |
| snail-default-small-service_not_running | 星海蜗牛 / small / service_not_running | **未执行** | |
| snail-default-medium-idle | 星海蜗牛 / medium / idle | **未执行** | |
| snail-default-medium-running | 星海蜗牛 / medium / running | **未执行** | |
| snail-default-medium-retrying | 星海蜗牛 / medium / retrying | **未执行** | |
| snail-default-medium-needs_input | 星海蜗牛 / medium / needs_input | **未执行** | |
| snail-default-medium-ready | 星海蜗牛 / medium / ready | **未执行** | |
| snail-default-medium-blocked | 星海蜗牛 / medium / blocked | **未执行** | |
| snail-default-medium-disconnected | 星海蜗牛 / medium / disconnected | **未执行** | |
| snail-default-medium-service_not_running | 星海蜗牛 / medium / service_not_running | **未执行** | |
| snail-default-large-idle | 星海蜗牛 / large / idle | **未执行** | |
| snail-default-large-running | 星海蜗牛 / large / running | **未执行** | |
| snail-default-large-retrying | 星海蜗牛 / large / retrying | **未执行** | |
| snail-default-large-needs_input | 星海蜗牛 / large / needs_input | **未执行** | |
| snail-default-large-ready | 星海蜗牛 / large / ready | **未执行** | |
| snail-default-large-blocked | 星海蜗牛 / large / blocked | **未执行** | |
| snail-default-large-disconnected | 星海蜗牛 / large / disconnected | **未执行** | |
| snail-default-large-service_not_running | 星海蜗牛 / large / service_not_running | **未执行** | |
| snail-classic-small-idle | 经典蜗牛 / small / idle | **未执行** | |
| snail-classic-small-running | 经典蜗牛 / small / running | **未执行** | |
| snail-classic-small-retrying | 经典蜗牛 / small / retrying | **未执行** | |
| snail-classic-small-needs_input | 经典蜗牛 / small / needs_input | **未执行** | |
| snail-classic-small-ready | 经典蜗牛 / small / ready | **未执行** | |
| snail-classic-small-blocked | 经典蜗牛 / small / blocked | **未执行** | |
| snail-classic-small-disconnected | 经典蜗牛 / small / disconnected | **未执行** | |
| snail-classic-small-service_not_running | 经典蜗牛 / small / service_not_running | **未执行** | |
| snail-classic-medium-idle | 经典蜗牛 / medium / idle | **未执行** | |
| snail-classic-medium-running | 经典蜗牛 / medium / running | **未执行** | |
| snail-classic-medium-retrying | 经典蜗牛 / medium / retrying | **未执行** | |
| snail-classic-medium-needs_input | 经典蜗牛 / medium / needs_input | **未执行** | |
| snail-classic-medium-ready | 经典蜗牛 / medium / ready | **未执行** | |
| snail-classic-medium-blocked | 经典蜗牛 / medium / blocked | **未执行** | |
| snail-classic-medium-disconnected | 经典蜗牛 / medium / disconnected | **未执行** | |
| snail-classic-medium-service_not_running | 经典蜗牛 / medium / service_not_running | **未执行** | |
| snail-classic-large-idle | 经典蜗牛 / large / idle | **未执行** | |
| snail-classic-large-running | 经典蜗牛 / large / running | **未执行** | |
| snail-classic-large-retrying | 经典蜗牛 / large / retrying | **未执行** | |
| snail-classic-large-needs_input | 经典蜗牛 / large / needs_input | **未执行** | |
| snail-classic-large-ready | 经典蜗牛 / large / ready | **未执行** | |
| snail-classic-large-blocked | 经典蜗牛 / large / blocked | **未执行** | |
| snail-classic-large-disconnected | 经典蜗牛 / large / disconnected | **未执行** | |
| snail-classic-large-service_not_running | 经典蜗牛 / large / service_not_running | **未执行** | |
| tray-running | Activity tray / running | **未执行** | |
| settings-ready | Settings / ready | **未执行** | |
| reduced-motion-running | Reduced motion / running | **未执行** | |

## Accessibility and clipping checks

| Check | Expected | Result |
| --- | --- | --- |
| Keyboard: Tab opens/closes tray, enters settings, returns to task list | Focus ring visible; Escape closes settings then tray | **未执行** |
| Non-color state cues | Glyph + short Chinese label remain readable without color | **未执行** |
| Reduced motion | No looping animation on running/retrying/ready | **未执行** |
| Long Chinese title | Truncates in 140px collapsed caption and Activity tray; does not expand the window | **未执行** |
| 100% / 150% / 200% zoom | Pet, badge, and tray stay inside the preview frame | **未执行** |

## Security checks (automated)

| Check | Expected | Result |
| --- | --- | --- |
| Preview fixtures | Only static sanitized views; no token/cwd/prompt/command | Automated via `test:desktop-contract` |
| Production preload/IPC | No preview channel or debug fixture loader | Automated via `test:desktop-contract` |
| Production package | `desktop/.preview` and preview script stay out of the pet package | Automated via `test:desktop-package` |

## Residual

Formal spritesheet art is out of U3. Visual Pass/Fail rows remain **未执行** until a human walks the preview matrix.
