# Desktop pet art direction

Use this file when writing image prompts. The runtime only cares about a 108×92 cell; the viewer only cares about silhouette and state.

## Why previous packs failed

The old one-shot prompt said “cute `<CHARACTER>` with clean dark outlines” and asked for 16 tiny poses in one image. Models then:

- reused one chubby sticker body
- changed only eyebrows / mouth
- lost species cues (Pikachu without cheeks/tail lightning, Charmander without a snout)
- kept every character facing the same 3/4 sit

Do not reuse that prompt.

## Style recipes

Pick **one**. Copy the recipe block into every prompt.

### chibi-cel (default)

```
Style: 2D chibi game mascot, cel-shaded, 1–2 highlight shapes per material.
Line: single dark outline, 2 px at 108 height — not a fat sticker stroke.
Shading: one warm highlight + one cool contact shadow, no airbrush glow.
Camera: full body, side-facing RIGHT, slight 3/4, feet planted near the bottom.
Negative: thick vinyl-sticker look, extra sparkles, text, watermark, extra limbs,
close-up portrait, isometric, chibi head bigger than the body.
```

### pixel-16

```
Style: 16-color pixel sprite, crisp nearest-neighbor pixels, no anti-alias smear.
Outline: 1 px dark index. No sub-pixel strokes.
Camera: full body, facing RIGHT, feet on an invisible ground line.
Negative: blur, painterly shading, text, watermark, high-res filter.
```

### soft-clay

```
Style: soft clay render, rounded volumes, visible material, muted studio light.
Outline: none — use a darker form edge, not a cartoon stroke.
Camera: full body, facing RIGHT, grounded.
Negative: plastic toy photo, text, watermark, extra props, busy backdrop.
```

## Pose language (read at 108 px)

Describe **body change**, not mood adjectives. Mood adjectives produce identical sits.

| state | silhouette change the model must draw |
| --- | --- |
| idle | upright rest; weight on both feet / haunches. Frame 2 = eyes fully shut (not squint). |
| running | 20° forward lean; one contact limb, one recovery limb in the air; accessory trails. |
| retrying | 15–20° back or side tilt; one limb tapping or recoiling. |
| needs_input | neck stretched up; one limb above the head, clearly waving. |
| ready | airborne or both limbs in a V; chest open; happy closed crescents. |
| blocked | hunched, 10–15% smaller bounding box, limbs tucked, frown. |
| disconnected | same family as idle, desaturated / vacant stare — do not invent new anatomy. |
| service_not_running | unique tucked / sleeping pose (shell closed, curled, powered down). |

Forbidden as the *only* difference between states: eyebrow tilt, blush, mouth curve, a 2 px bob.

## Frozen identity

Copy these from the hero onto every later frame:

- body mass and height inside the cell (~70–80% of 108×92, feet near the bottom)
- outline weight
- eye size and placement
- signature accessory (leaf, scarf, antenna, kettle, …)
- facing RIGHT

If a strip drifts, discard the strip, not the hero.

## Prompts

Replace the `<…>` tokens from the character card. Always attach `hero.png` after it exists.

### Hero (one character, square-ish or 108×92)

```
Original desktop-pet mascot, not a licensed character.
Species: <species>.
Silhouette: <3 nouns>.
Signature accessory: <accessory>.
Face: <eye shape>, small <mouth>, facing RIGHT.
<PASTE STYLE RECIPE>
Single character, transparent background, full body, no crop, no text,
no watermark, no other characters, no UI chrome.
The design must still read as <species> when scaled to 108 pixels tall.
```

### State strip (attach hero.png)

```
Animation strip of the SAME character as the attached hero reference.
Keep identity frozen: same body mass, outline, eye placement, accessory, facing RIGHT.
Output a single PNG, exactly <WIDTH>x92 pixels, transparent background,
<N> frames in a horizontal row, each frame a 108x92 cell, no gutters, no borders.
The 108x92 character stays centered; feet stay on the same ground line.
State: <STATE>.
Pose (mandatory, not optional flavor): <POSE FROM TABLE>.
Frame-to-frame change must move a limb or eyelid by a large, obvious amount.
No text, letters, numbers, icons, or watermarks.
<PASTE STYLE RECIPE>
```

Widths: idle/running `324` (`N=3`); retrying/needs_input/ready/blocked `216` (`N=2`); disconnected/service_not_running `108` (`N=1`).

Generate at most two states per call. Prefer one state per call if the last strip drifted.

## Human review after stitch

Open the sheet. Fail the pack yourself when any box is no:

- [ ] Species is obvious without the folder name
- [ ] Accessory is visible on every standing frame
- [ ] Idle blink is a real closed eye, not a thinner oval
- [ ] Running / ready / blocked silhouettes are three different shapes
- [ ] Disconnected is a gray idle, not a new creature
- [ ] Sleep pose is unique
- [ ] No text, sparkles-as-badge, or left-facing frames

`review` can catch frozen frames and jitter. It cannot catch “this is still a generic blob”.
