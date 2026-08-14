/**
 * Generate the built-in "snail-sprite" spritesheet PNG (placeholder art).
 *
 * Dependency-free: hand-rolled PNG encoder (zlib + CRC32) and a small 2D raster
 * with supersampled shape primitives. No canvas/imaging package is required.
 *
 * The sheet is 4 columns x 8 rows of 108x92 cells (row-major, one state per row,
 * single-row contiguous frame runs so the renderer's `steps()` animation stays
 * on integer cells). Every frame is drawn facing right and keeps a transparent
 * background so the pet floats over the desktop.
 *
 * Usage: node scripts/generate-desktop-pet-sheet.mjs
 *        (output: desktop/assets/pets/snail-sprite/snail.png)
 *
 * NOTE: this is pipeline-proving placeholder art, not final shipped art. Real
 * character art should replace this file without changing the runtime or the
 * manifest contract (see docs/research/desktop-pet-improvements-2026-08-13.md).
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "desktop", "assets", "pets", "snail-sprite", "snail.png");

const FRAME_W = 108;
const FRAME_H = 92;
const COLUMNS = 4;
const ROWS = 8;
const SUPERSAMPLE = 2; // draw at 2x then average for smooth edges

// ---- palette ----
const OUTLINE = [30, 66, 70, 255];
const BODY_HI = [226, 250, 241, 255];
const BODY_LO = [168, 224, 208, 255];
const TAIL = [188, 236, 218, 255];
const SHELL_HI = [140, 226, 210, 255];
const SHELL_LO = [63, 148, 170, 255];
const SHELL_DEEP = [40, 98, 117, 255];
const SPIRAL = [216, 255, 244, 255];
const EYE = [23, 54, 58, 255];
const MOUTH = [63, 124, 113, 255];
const SHADOW = [0, 0, 0, 66];

// ---- raster ----
class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  set(x, y, [r, g, b, a = 255]) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  blend(x, y, [r, g, b, a]) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const sa = a / 255;
    const da = this.data[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) {
      this.data[i + 3] = 0;
      return;
    }
    this.data[i] = Math.round((r * sa + this.data[i] * da * (1 - sa)) / outA);
    this.data[i + 1] = Math.round((g * sa + this.data[i + 1] * da * (1 - sa)) / outA);
    this.data[i + 2] = Math.round((b * sa + this.data[i + 2] * da * (1 - sa)) / outA);
    this.data[i + 3] = Math.round(outA * 255);
  }

  fillEllipse(cx, cy, rx, ry, color, blend = false) {
    const put = blend ? (x, y) => this.blend(x, y, color) : (x, y) => this.set(x, y, color);
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) put(x, y);
      }
    }
  }

  ringEllipse(cx, cy, rx, ry, thickness, color) {
    for (let y = Math.floor(cy - ry - thickness); y <= Math.ceil(cy + ry + thickness); y += 1) {
      for (let x = Math.floor(cx - rx - thickness); x <= Math.ceil(cx + rx + thickness); x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(d - 1) * Math.max(rx, ry) <= thickness) this.set(x, y, color);
      }
    }
  }

  fillCircle(cx, cy, r, color) {
    this.fillEllipse(cx, cy, r, r, color);
  }

  line(x0, y0, x1, y1, width, color) {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) * 2;
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      this.fillCircle(x, y, width / 2, color);
    }
  }
}

// ---- snail drawing ----
function drawSnail(pose) {
  const w = FRAME_W * SUPERSAMPLE;
  const h = FRAME_H * SUPERSAMPLE;
  const k = SUPERSAMPLE;
  const r = new Raster(w, h);

  const shellLift = pose.shellLift || 0;
  const bodyLift = pose.bodyLift || 0;
  const headDx = pose.headDx || 0;
  const headDy = pose.headDy || 0;
  const tailExtend = pose.tailExtend || 0;
  const antennaLift = pose.antennaLift || 0;

  // ground shadow
  r.fillEllipse(54 * k, (86 + shellLift * 0.2) * k, 40 * k, 4 * k, SHADOW, true);

  // tail
  r.fillEllipse((15 - tailExtend) * k, (73 + bodyLift) * k, (8 + tailExtend) * k, 5 * k, TAIL);

  // body
  r.fillEllipse(56 * k, (70 + bodyLift) * k, 38 * k, 11 * k, BODY_LO);
  r.ringEllipse(56 * k, (70 + bodyLift) * k, 38 * k, 11 * k, 1.4 * k, OUTLINE);
  r.fillEllipse(57 * k, (66 + bodyLift) * k, 30 * k, 6 * k, BODY_HI);

  // shell (behind head, left of body)
  r.fillEllipse(38 * k, (46 + shellLift) * k, 29 * k, 27 * k, SHELL_LO);
  r.ringEllipse(38 * k, (46 + shellLift) * k, 29 * k, 27 * k, 1.6 * k, SHELL_DEEP);
  r.fillEllipse(33 * k, (38 + shellLift) * k, 19 * k, 15 * k, SHELL_HI);
  r.ringEllipse(38 * k, (46 + shellLift) * k, 13 * k, 13 * k, 2.4 * k, SPIRAL);
  r.fillCircle(39 * k, (48 + shellLift) * k, 3 * k, SPIRAL);

  // antennae
  const leftAntTipY = (26 - antennaLift) * k;
  const rightAntTipY = (24 - antennaLift) * k;
  r.line(79 * k, 46 * k, 74 * k, leftAntTipY, 1.6 * k, OUTLINE);
  r.line(92 * k, 45 * k, 96 * k, rightAntTipY, 1.6 * k, OUTLINE);
  r.fillCircle(74 * k, leftAntTipY, 3 * k, BODY_HI);
  r.fillCircle(96 * k, rightAntTipY, 3 * k, BODY_HI);

  // head
  const hx = (86 + headDx) * k;
  const hy = (59 + headDy + bodyLift) * k;
  r.fillEllipse(hx, hy, 14 * k, 14 * k, BODY_HI);
  r.ringEllipse(hx, hy, 14 * k, 14 * k, 1.4 * k, OUTLINE);

  // eyes
  drawEyes(r, hx, hy, k, pose.eyeMode);

  // mouth
  drawMouth(r, hx, hy, k, pose.mouthMode);

  return r;
}

function drawEyes(r, hx, hy, k, mode) {
  const eyeY = hy - 3 * k;
  const leftX = hx - 5 * k;
  const rightX = hx + 5 * k;
  if (mode === "closed") {
    r.line(leftX - 2 * k, eyeY, leftX + 2 * k, eyeY, 1.3 * k, EYE);
    r.line(rightX - 2 * k, eyeY, rightX + 2 * k, eyeY, 1.3 * k, EYE);
    return;
  }
  if (mode === "half") {
    r.fillEllipse(leftX, eyeY, 2.4 * k, 1.2 * k, EYE);
    r.fillEllipse(rightX, eyeY, 2.4 * k, 1.2 * k, EYE);
    return;
  }
  if (mode === "dash") {
    r.line(leftX - 2 * k, eyeY, leftX + 2 * k, eyeY, 1.4 * k, EYE);
    r.line(rightX - 2 * k, eyeY, rightX + 2 * k, eyeY, 1.4 * k, EYE);
    return;
  }
  // open (default)
  r.fillCircle(leftX, eyeY, 2.4 * k, EYE);
  r.fillCircle(rightX, eyeY, 2.4 * k, EYE);
}

function drawMouth(r, hx, hy, k, mode) {
  const my = hy + 6 * k;
  const mx = hx + 1 * k;
  if (mode === "smile") {
    // wider happy arc
    for (let x = -6; x <= 6; x += 1) {
      const t = x / 6;
      const y = my - Math.sqrt(Math.max(0, 1 - t * t)) * 3 * k;
      r.set(mx + x * k, y, MOUTH);
    }
    return;
  }
  if (mode === "frown") {
    for (let x = -4; x <= 4; x += 1) {
      const t = x / 4;
      const y = my + Math.sqrt(Math.max(0, 1 - t * t)) * 2.4 * k;
      r.set(mx + x * k, y, MOUTH);
    }
    return;
  }
  if (mode === "o") {
    r.fillEllipse(mx, my - 1 * k, 2.4 * k, 2.6 * k, MOUTH);
    return;
  }
  // flat (default)
  r.line(mx - 3 * k, my, mx + 3 * k, my, 1.2 * k, MOUTH);
}

// ---- per-state poses ----
function poseFor(state, frameIndex) {
  switch (state) {
    case "idle":
      return [
        { eyeMode: "open", mouthMode: "flat" },
        { eyeMode: "open", mouthMode: "flat", bodyLift: -1, shellLift: -1 },
        { eyeMode: "open", mouthMode: "flat" },
      ][frameIndex];
    case "running":
      return [
        { eyeMode: "open", mouthMode: "flat", headDx: 2, headDy: -1, tailExtend: 2, antennaLift: 1 },
        { eyeMode: "open", mouthMode: "flat", headDx: 1, bodyLift: -1, tailExtend: 1 },
        { eyeMode: "open", mouthMode: "flat", headDx: 0, tailExtend: 0 },
      ][frameIndex];
    case "retrying":
      return [
        { eyeMode: "half", mouthMode: "frown", headDx: -1, headDy: 1, shellLift: 1 },
        { eyeMode: "open", mouthMode: "flat", headDx: 1, headDy: -1, shellLift: 0 },
      ][frameIndex];
    case "needs_input":
      return [
        { eyeMode: "open", mouthMode: "o", antennaLift: 3, headDy: -1 },
        { eyeMode: "open", mouthMode: "o", antennaLift: 5, headDy: -2, headDx: 1 },
      ][frameIndex];
    case "ready":
      return [
        { eyeMode: "closed", mouthMode: "smile", bodyLift: -2, shellLift: -1 },
        { eyeMode: "closed", mouthMode: "smile", bodyLift: -4, shellLift: -2, headDy: -1 },
      ][frameIndex];
    case "blocked":
      return [
        { eyeMode: "dash", mouthMode: "frown", headDy: 2, headDx: -1, antennaLift: -3 },
        { eyeMode: "dash", mouthMode: "frown", headDy: 3, headDx: -2, antennaLift: -5 },
      ][frameIndex];
    case "disconnected":
      return { eyeMode: "half", mouthMode: "flat", antennaLift: -2 };
    case "service_not_running":
      return { eyeMode: "closed", mouthMode: "flat", antennaLift: -3, headDy: 1 };
    default:
      return { eyeMode: "open", mouthMode: "flat" };
  }
}

const STATES = [
  "idle",
  "running",
  "retrying",
  "needs_input",
  "ready",
  "blocked",
  "disconnected",
  "service_not_running",
];
const FRAMES_PER_STATE = {
  idle: 3,
  running: 3,
  retrying: 2,
  needs_input: 2,
  ready: 2,
  blocked: 2,
  disconnected: 1,
  service_not_running: 1,
};

// ---- downsample one high-res frame into the sheet ----
function downsample(src, dst, dx, dy) {
  const s = SUPERSAMPLE;
  for (let y = 0; y < FRAME_H; y += 1) {
    for (let x = 0; x < FRAME_W; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < s; sy += 1) {
        for (let sx = 0; sx < s; sx += 1) {
          const i = ((y * s + sy) * (FRAME_W * s) + (x * s + sx)) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
        }
      }
      const n = s * s;
      const out = ((dy + y) * (FRAME_W * COLUMNS) + (dx + x)) * 4;
      dst.data[out] = Math.round(r / n);
      dst.data[out + 1] = Math.round(g / n);
      dst.data[out + 2] = Math.round(b / n);
      dst.data[out + 3] = Math.round(a / n);
    }
  }
}

// ---- PNG encoding ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildSheet() {
  const sheet = new Raster(FRAME_W * COLUMNS, FRAME_H * ROWS);
  let frameIndex = 0;
  for (let row = 0; row < STATES.length; row += 1) {
    const state = STATES[row];
    const count = FRAMES_PER_STATE[state];
    for (let f = 0; f < count; f += 1) {
      const hi = drawSnail(poseFor(state, f));
      const col = frameIndex % COLUMNS;
      downsample(hi, sheet, col * FRAME_W, row * FRAME_H);
      frameIndex += 1;
    }
  }
  return encodePng(sheet.width, sheet.height, sheet.data);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, buildSheet());
console.log(`wrote ${path.relative(ROOT, OUT)}`);
