/**
 * Desktop custom pet pack helper (U6 slice 1).
 *
 * Assists the desktop-pet-assets skill (and users) with folder drop-in custom
 * pets: validate a pack against the real runtime contract, stitch per-state
 * frame strips into the grid spritesheet, review obvious visual defects, and
 * list installed packs.
 *
 * Usage:
 *   node scripts/desktop-custom-pet.mjs list [root]
 *   node scripts/desktop-custom-pet.mjs check <petDir>
 *   node scripts/desktop-custom-pet.mjs review <petDir>
 *   node scripts/desktop-custom-pet.mjs stitch <petDir> --frames <framesDir> [--force]
 *   node scripts/desktop-custom-pet.mjs selftest
 *
 * Dependency-free at runtime (node:zlib for PNG): PNG support is 8-bit RGB/RGBA
 * non-interlaced, which covers the output of all mainstream image tools.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import * as esbuild from "esbuild";

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// PNG encode/decode (8-bit RGB/RGBA, non-interlaced)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** IHDR only: width/height/bitDepth/colorType/interlace. */
function readPngHeader(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(buf) {
  const header = readPngHeader(buf);
  if (!header) throw new Error("not a PNG file");
  if (header.bitDepth !== 8) throw new Error(`PNG bit depth ${header.bitDepth} unsupported (need 8)`);
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new Error(`PNG color type ${header.colorType} unsupported (need RGB or RGBA)`);
  }
  if (header.interlace !== 0) throw new Error("interlaced PNG unsupported");
  const { width, height, colorType } = header;
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`PNG filter ${filter} unsupported`);
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp];
      out[o + 1] = cur[x * bpp + 1];
      out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = colorType === 6 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, rgba: out };
}

// ---------------------------------------------------------------------------
// Runtime-contract validator (esbuild-bundled, same modules the pet ships)
// ---------------------------------------------------------------------------

let validatorPromise = null;

function loadValidator() {
  if (!validatorPromise) {
    validatorPromise = esbuild
      .build({
        absWorkingDir: PROJECT_ROOT,
        entryPoints: [path.join(PROJECT_ROOT, "scripts", "desktop-custom-pet-validator.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        write: false,
        logLevel: "silent",
      })
      .then(async (bundle) => {
        const source = bundle.outputFiles[0]?.text;
        if (!source) throw new Error("failed to compile pet validator entry");
        return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      })
      .catch((error) => {
        validatorPromise = null;
        throw error;
      });
  }
  return validatorPromise;
}

function nodeCustomPetsIo() {
  return {
    listDirs: (root) => {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    readText: (p) => readFileSync(p, "utf8"),
    readBinary: (p) => readFileSync(p),
    exists: (p) => existsSync(p),
    size: (p) => statSync(p).size,
    encodeBase64: (bytes) =>
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
    join: (...parts) => path.join(...parts),
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    statMtimeMs: (p) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function cmdList(rootDir) {
  const { scanCustomPets, resolveCustomPetsRoot, CUSTOM_PET_MAX_COUNT } = await loadValidator();
  const dir = rootDir ?? resolveCustomPetsRoot({ env: process.env, homedir: os.homedir() });
  console.log(`custom pets root: ${dir}`);
  const result = scanCustomPets(dir, nodeCustomPetsIo());
  if (result.pets.length === 0) console.log("  (no valid packs found)");
  for (const pet of result.pets) {
    const sheet = pet.manifest.sheet;
    console.log(
      `  ok  ${pet.id}  "${pet.manifest.name}"  ${pet.manifest.renderMode} ` +
        `${sheet ? `${sheet.columns}x${sheet.rows} @ ${sheet.frameWidth}x${sheet.frameHeight}` : ""}`,
    );
  }
  if (result.errors.length > 0) {
    console.log(`  rejected (${result.errors.length}):`);
    for (const error of result.errors.slice(0, 20)) {
      console.log(`    - ${error.petId ?? "<root>"}: ${error.reason}`);
    }
  }
  console.log(`cap: ${CUSTOM_PET_MAX_COUNT} packs max`);
}

async function cmdCheck(petDir) {
  const { scanCustomPets, PET_ASSET_LIMITS } = await loadValidator();
  const root = path.resolve(petDir);
  const name = path.basename(root);
  if (!existsSync(path.join(root, "manifest.json"))) {
    fail(`${root} has no manifest.json`);
    return;
  }
  const parent = path.dirname(root);
  const result = scanCustomPets(parent, nodeCustomPetsIo());
  const pet = result.pets.find((p) => p.id === name);
  if (!pet) {
    const errors = result.errors.filter((e) => e.petId === name);
    if (errors.length === 0) fail(`pack folder "${name}" not found under ${parent}`);
    for (const error of errors) fail(`contract rejects "${name}": ${error.reason}`);
    return;
  }

  const sheet = pet.manifest.sheet;
  const sheetPath = path.join(root, sheet.src);
  if (!existsSync(sheetPath)) {
    fail(`sheet missing: ${sheetPath}`);
    return;
  }
  const sheetSize = statSync(sheetPath).size;
  if (sheetSize <= 0 || sheetSize > PET_ASSET_LIMITS.maxFileBytes) {
    fail(`sheet size ${sheetSize} bytes exceeds ${PET_ASSET_LIMITS.maxFileBytes}`);
    return;
  }

  const expectedWidth = sheet.frameWidth * sheet.columns;
  const expectedHeight = sheet.frameHeight * sheet.rows;
  const warnings = [];
  if (/\.png$/i.test(sheet.src)) {
    const header = readPngHeader(readFileSync(sheetPath));
    if (!header) {
      fail(`sheet is not a readable PNG: ${sheetPath}`);
      return;
    }
    if (header.width !== expectedWidth || header.height !== expectedHeight) {
      fail(
        `sheet dimensions ${header.width}x${header.height} != expected ` +
          `${expectedWidth}x${expectedHeight} (${sheet.columns} cols x ${sheet.rows} rows of ` +
          `${sheet.frameWidth}x${sheet.frameHeight})`,
      );
      return;
    }
    if (header.bitDepth !== 8) warnings.push(`PNG bit depth ${header.bitDepth} (want 8)`);
    if (header.colorType !== 6) warnings.push(`PNG color type ${header.colorType} (RGBA=6 recommended for transparency)`);
  }

  console.log(`PASS ${name}`);
  console.log(`  manifest: "${pet.manifest.name}" v${pet.manifest.version} ${pet.manifest.renderMode}`);
  console.log(`  sheet: ${sheetPath}`);
  console.log(`  grid: ${sheet.columns}x${sheet.rows} cells of ${sheet.frameWidth}x${sheet.frameHeight}`);
  console.log(`  image: ${expectedWidth}x${expectedHeight}, ${sheetSize} bytes`);
  for (const state of Object.keys(pet.manifest.states)) {
    const frame = pet.manifest.states[state];
    console.log(
      `    ${state.padEnd(20)} frames ${frame.firstFrame}+${frame.frameCount} ` +
        `${frame.durationMs}ms static#${frame.staticFrameIndex}`,
    );
  }
  for (const warning of warnings) console.log(`  warn: ${warning}`);
}

const REVIEW_ALPHA_ON = 24;
const REVIEW_MASK_COLS = 12;
const REVIEW_MASK_ROWS = 10;
const REVIEW_MIN_OCCUPANCY = 0.10;
const REVIEW_MAX_OCCUPANCY = 0.78;
const REVIEW_EMPTY_OCCUPANCY = 0.02;
const REVIEW_FROZEN_MASK = 0.028;
const REVIEW_FROZEN_PIXEL = 0.008;
const REVIEW_POSE_MASK = 0.07;
const REVIEW_FOOT_JITTER_PX = 10;
const REVIEW_SIZE_JITTER = 0.28;
const REVIEW_STANDING = ["idle", "running", "ready", "blocked"];
const REVIEW_LIMB_STATES = ["running", "retrying", "needs_input", "ready", "blocked"];

function extractSheetCell(decoded, col, row, frameWidth, frameHeight) {
  const rgba = Buffer.alloc(frameWidth * frameHeight * 4);
  for (let y = 0; y < frameHeight; y++) {
    const src = ((row * frameHeight + y) * decoded.width + col * frameWidth) * 4;
    decoded.rgba.copy(rgba, y * frameWidth * 4, src, src + frameWidth * 4);
  }
  return rgba;
}

function analyzeSheetCell(rgba, frameWidth, frameHeight) {
  let opaque = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = frameWidth;
  let minY = frameHeight;
  let maxX = -1;
  let maxY = -1;
  const mask = Buffer.alloc(REVIEW_MASK_COLS * REVIEW_MASK_ROWS);
  const maskHits = new Uint16Array(REVIEW_MASK_COLS * REVIEW_MASK_ROWS);
  const binW = frameWidth / REVIEW_MASK_COLS;
  const binH = frameHeight / REVIEW_MASK_ROWS;
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      const a = rgba[(y * frameWidth + x) * 4 + 3];
      if (a <= REVIEW_ALPHA_ON) continue;
      opaque += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const mx = Math.min(REVIEW_MASK_COLS - 1, Math.floor(x / binW));
      const my = Math.min(REVIEW_MASK_ROWS - 1, Math.floor(y / binH));
      maskHits[my * REVIEW_MASK_COLS + mx] += 1;
    }
  }
  const binArea = binW * binH;
  for (let i = 0; i < mask.length; i++) mask[i] = maskHits[i] >= binArea * 0.18 ? 1 : 0;
  return {
    occupancy: opaque / (frameWidth * frameHeight),
    cx: opaque ? sumX / opaque : 0,
    cy: opaque ? sumY / opaque : 0,
    width: maxX >= minX ? maxX - minX + 1 : 0,
    height: maxY >= minY ? maxY - minY + 1 : 0,
    footY: maxY < 0 ? 0 : maxY,
    mask,
    rgba,
  };
}

function maskDistance(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff += 1;
  return diff / a.length;
}

function pixelDelta(a, b) {
  const n = a.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (n * 255);
}

function reviewDecodedSheet(manifest, decoded) {
  const sheet = manifest.sheet;
  const findings = [];
  const notes = [];
  const byState = {};
  for (const state of Object.keys(manifest.states)) {
    const frame = manifest.states[state];
    const col0 = frame.firstFrame % sheet.columns;
    const row = Math.floor(frame.firstFrame / sheet.columns);
    const cells = [];
    for (let i = 0; i < frame.frameCount; i++) {
      const col = col0 + i;
      const rgba = extractSheetCell(decoded, col, row, sheet.frameWidth, sheet.frameHeight);
      const stats = analyzeSheetCell(rgba, sheet.frameWidth, sheet.frameHeight);
      cells.push({ col, row, ...stats });
      if (stats.occupancy < REVIEW_MIN_OCCUPANCY) {
        findings.push(`${state} frame ${i} empty_or_tiny occupancy=${stats.occupancy.toFixed(3)}`);
      } else if (stats.occupancy > REVIEW_MAX_OCCUPANCY) {
        findings.push(`${state} frame ${i} flooded occupancy=${stats.occupancy.toFixed(3)}`);
      }
    }
    for (let col = col0 + frame.frameCount; col < sheet.columns; col++) {
      const rgba = extractSheetCell(decoded, col, row, sheet.frameWidth, sheet.frameHeight);
      const stats = analyzeSheetCell(rgba, sheet.frameWidth, sheet.frameHeight);
      if (stats.occupancy > REVIEW_EMPTY_OCCUPANCY) {
        findings.push(`${state} reserved cell ${row * sheet.columns + col} leak occupancy=${stats.occupancy.toFixed(3)}`);
      }
    }
    if (cells.length > 1) {
      let maxMask = 0;
      let maxPixel = 0;
      for (let i = 1; i < cells.length; i++) {
        maxMask = Math.max(maxMask, maskDistance(cells[0].mask, cells[i].mask));
        maxPixel = Math.max(maxPixel, pixelDelta(cells[0].rgba, cells[i].rgba));
        const maskJump = maskDistance(cells[0].mask, cells[i].mask);
        const footJump = Math.abs(cells[i].footY - cells[0].footY);
        const sizeJump = Math.max(
          Math.abs(cells[i].width - cells[0].width) / Math.max(cells[0].width, 1),
          Math.abs(cells[i].height - cells[0].height) / Math.max(cells[0].height, 1),
        );
        if (footJump > REVIEW_FOOT_JITTER_PX) {
          findings.push(`${state} jitter feet ${footJump.toFixed(1)}px between frame 0 and ${i}`);
        }
        // A limb that leaves the body is wanted motion. Flag scale only when the
        // silhouette stays the same but the character was redrawn larger/smaller.
        if (sizeJump > REVIEW_SIZE_JITTER && maskJump < REVIEW_FROZEN_MASK) {
          findings.push(`${state} jitter scale ${(sizeJump * 100).toFixed(0)}% between frame 0 and ${i}`);
        }
      }
      const needsLimb = REVIEW_LIMB_STATES.includes(state);
      const frozen = needsLimb
        ? maxMask < REVIEW_FROZEN_MASK
        : maxMask < REVIEW_FROZEN_MASK && maxPixel < REVIEW_FROZEN_PIXEL;
      if (frozen) {
        findings.push(
          `${state} frozen_frames mask=${maxMask.toFixed(3)} pixel=${maxPixel.toFixed(3)} ` +
            `(need ${needsLimb ? "a limb/pose change" : "a blink or body change"}, not a copied still)`,
        );
      }
      notes.push(`${state} motion mask=${maxMask.toFixed(3)} pixel=${maxPixel.toFixed(3)}`);
    }
    byState[state] = cells;
  }
  for (let i = 0; i < REVIEW_STANDING.length; i++) {
    for (let j = i + 1; j < REVIEW_STANDING.length; j++) {
      const a = byState[REVIEW_STANDING[i]]?.[0];
      const b = byState[REVIEW_STANDING[j]]?.[0];
      if (!a || !b) continue;
      const dist = maskDistance(a.mask, b.mask);
      if (dist < REVIEW_POSE_MASK) {
        findings.push(
          `pose_too_similar ${REVIEW_STANDING[i]} vs ${REVIEW_STANDING[j]} mask=${dist.toFixed(3)} ` +
            `(change the silhouette, not only the face)`,
        );
      }
    }
  }
  return { findings, notes };
}

async function cmdReview(petDir) {
  const { scanCustomPets } = await loadValidator();
  const root = path.resolve(petDir);
  const name = path.basename(root);
  if (!existsSync(path.join(root, "manifest.json"))) {
    fail(`${root} has no manifest.json`);
    return;
  }
  const parent = path.dirname(root);
  const result = scanCustomPets(parent, nodeCustomPetsIo());
  const pet = result.pets.find((p) => p.id === name);
  if (!pet) {
    const errors = result.errors.filter((e) => e.petId === name);
    if (errors.length === 0) fail(`pack folder "${name}" not found under ${parent}`);
    for (const error of errors) fail(`contract rejects "${name}": ${error.reason}`);
    return;
  }
  const sheet = pet.manifest.sheet;
  const sheetPath = path.join(root, sheet.src);
  if (!existsSync(sheetPath)) {
    fail(`sheet missing: ${sheetPath}`);
    return;
  }
  if (!/\.png$/i.test(sheet.src)) {
    console.log(`REVIEW SKIP ${name}: pixel review is PNG-only (got ${sheet.src})`);
    return;
  }
  let decoded;
  try {
    decoded = decodePng(readFileSync(sheetPath));
  } catch (error) {
    fail(`sheet is not a readable PNG: ${error.message}`);
    return;
  }
  const expectedWidth = sheet.frameWidth * sheet.columns;
  const expectedHeight = sheet.frameHeight * sheet.rows;
  if (decoded.width !== expectedWidth || decoded.height !== expectedHeight) {
    fail(`sheet dimensions ${decoded.width}x${decoded.height} != expected ${expectedWidth}x${expectedHeight}`);
    return;
  }
  const { findings, notes } = reviewDecodedSheet(pet.manifest, decoded);
  if (findings.length > 0) {
    fail(`review ${name}: ${findings.length} issue(s)`);
    for (const finding of findings) console.error(`  - ${finding}`);
    for (const note of notes) console.error(`  note: ${note}`);
    return;
  }
  console.log(`REVIEW PASS ${name}`);
  for (const note of notes) console.log(`  ${note}`);
}

async function cmdStitch(petDir, framesDir, force) {
  const { validatePetManifestDocument } = await loadValidator();
  const root = path.resolve(petDir);
  const name = path.basename(root);
  const manifestPath = path.join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`${root} has no manifest.json`);
    return;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    fail("manifest.json is not valid JSON");
    return;
  }
  const validated = validatePetManifestDocument(raw, name);
  if (!validated.ok) {
    fail(`manifest rejected: ${validated.reason}`);
    return;
  }
  const manifest = validated.manifest;
  if (manifest.renderMode !== "spritesheet" || !manifest.sheet) {
    fail("only spritesheet packs can be stitched (css custom packs are unsupported)");
    return;
  }
  const sheet = manifest.sheet;
  const framesRoot = path.resolve(framesDir);
  if (!existsSync(framesRoot)) {
    fail(`frames dir missing: ${framesRoot}`);
    return;
  }

  const grid = Buffer.alloc(sheet.frameWidth * sheet.frameHeight * sheet.columns * sheet.rows * 4);
  const placed = [];
  for (const state of Object.keys(manifest.states)) {
    const frame = manifest.states[state];
    const stripPath = path.join(framesRoot, `${state}.png`);
    if (!existsSync(stripPath)) {
      fail(`missing strip ${state}.png (expected ${frame.frameCount} frames x ${sheet.frameWidth}x${sheet.frameHeight})`);
      return;
    }
    let strip;
    try {
      strip = decodePng(readFileSync(stripPath));
    } catch (error) {
      fail(`${state}.png: ${error.message}`);
      return;
    }
    if (strip.width !== frame.frameCount * sheet.frameWidth || strip.height !== sheet.frameHeight) {
      fail(
        `${state}.png is ${strip.width}x${strip.height}, expected ` +
          `${frame.frameCount * sheet.frameWidth}x${sheet.frameHeight}`,
      );
      return;
    }
    const col = frame.firstFrame % sheet.columns;
    const row = Math.floor(frame.firstFrame / sheet.columns);
    for (let i = 0; i < frame.frameCount; i++) {
      const dstX = (col + i) * sheet.frameWidth;
      const dstY = row * sheet.frameHeight;
      const srcX = i * sheet.frameWidth;
      for (let y = 0; y < sheet.frameHeight; y++) {
        const dstRow = (dstY + y) * sheet.columns * sheet.frameWidth * 4;
        const srcRow = y * strip.width * 4;
        strip.rgba.copy(grid, dstRow + dstX * 4, srcRow + srcX * 4, srcRow + (srcX + sheet.frameWidth) * 4);
      }
    }
    placed.push(`${state} -> cell ${frame.firstFrame}`);
  }

  const outPath = path.join(root, sheet.src);
  if (existsSync(outPath) && !force) {
    fail(`${outPath} exists; pass --force to overwrite`);
    return;
  }
  writeFileSync(outPath, encodePng(sheet.columns * sheet.frameWidth, sheet.rows * sheet.frameHeight, grid));
  const size = statSync(outPath).size;
  console.log(`PASS stitched ${name}`);
  for (const line of placed) console.log(`  ${line}`);
  console.log(`  wrote ${outPath} (${sheet.columns * sheet.frameWidth}x${sheet.rows * sheet.frameHeight}, ${size} bytes)`);
  await cmdCheck(root);
}

async function cmdSelfTest() {
  await loadValidator();
  const tmp = path.join(os.tmpdir(), `pet-pack-selftest-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const petDir = path.join(tmp, "turtle-sprite");
    const framesDir = path.join(tmp, "frames");
    mkdirSync(petDir, { recursive: true });
    mkdirSync(framesDir, { recursive: true });
    const states = [
      "idle", "running", "retrying", "needs_input",
      "ready", "blocked", "disconnected", "service_not_running",
    ];
    const frameCounts = [3, 3, 2, 2, 2, 2, 1, 1];
    const manifest = {
      id: "turtle-sprite",
      name: "Pixel Turtle",
      version: 2,
      renderMode: "spritesheet",
      states: {},
      sheet: { src: "turtle.png", frameWidth: 108, frameHeight: 92, columns: 4, rows: 8 },
    };
    states.forEach((state, i) => {
      // One state per row, first frame at column 0 (builtin layout).
      manifest.states[state] = {
        frame: "idle",
        staticFrame: "idle",
        label: "L",
        glyph: "·",
        firstFrame: i * 4,
        frameCount: frameCounts[i],
        durationMs: 200,
        staticFrameIndex: 0,
      };
      const strip = Buffer.alloc(frameCounts[i] * 108 * 92 * 4);
      for (let p = 3; p < strip.length; p += 4) strip[p] = 40 + i * 20;
      writeFileSync(path.join(framesDir, `${state}.png`), encodePng(frameCounts[i] * 108, 92, strip));
    });
    writeFileSync(path.join(petDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    // cmdCheck reports failures through process.exitCode; start from a clean 0.
    process.exitCode = 0;
    await cmdStitch(petDir, framesDir, true);
    const sheetPath = path.join(petDir, "turtle.png");
    const decoded = decodePng(readFileSync(sheetPath));
    if (decoded.width !== 432 || decoded.height !== 736) {
      throw new Error(`stitched sheet ${decoded.width}x${decoded.height} != 432x736`);
    }
    // Cell (0,0) must carry the first strip color; the empty cell (3,0) must stay transparent.
    const idle = decoded.rgba;
    if (idle[3] !== 40) throw new Error("first cell alpha wrong");
    if (idle[3 * 108 * 4 + 3] !== 0) throw new Error("empty cell not transparent");
    if (process.exitCode !== 0) throw new Error("check reported failure");

    await assertReviewSelfTest(tmp);

    // Decoder coverage: PNG scanline filters 1-4 (real image tools use these;
    // the stitcher must decode them, not just filter-0 output).
    for (const filter of [1, 2, 3, 4]) {
      const w = 3;
      const h = 2;
      const stride = w * 4;
      const raw = Buffer.alloc((stride + 1) * h);
      const valueAt = (i, y) => (i * 7 + y * 5) & 0xff;
      for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = filter;
        for (let i = 0; i < stride; i++) {
          const value = valueAt(i, y);
          const a = i >= 4 ? valueAt(i - 4, y) : 0;
          const b = y > 0 ? valueAt(i, y - 1) : 0;
          const c = i >= 4 && y > 0 ? valueAt(i - 4, y - 1) : 0;
          let stored = value;
          if (filter === 1) stored = (value - a) & 0xff;
          else if (filter === 2) stored = (value - b) & 0xff;
          else if (filter === 3) stored = (value - ((a + b) >> 1)) & 0xff;
          else stored = (value - paeth(a, b, c)) & 0xff;
          raw[y * (stride + 1) + 1 + i] = stored;
        }
      }
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0);
      ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8;
      ihdr[9] = 6;
      const filteredPng = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
      ]);
      const round = decodePng(filteredPng);
      for (let y = 0; y < h; y++) {
        for (let i = 0; i < stride; i++) {
          if (round.rgba[y * stride + i] !== valueAt(i, y)) {
            throw new Error(`filter ${filter} decode mismatch at ${i},${y}`);
          }
        }
      }
    }
    console.log("selftest: ok");
  } finally {
    fsRecursiveRemove(tmp);
  }
}

function paintBlob(rgba, width, height, { x0, y0, x1, y1, r, g, b, a = 255 }) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
}

function writeReviewFixtureSheet(filePath, kind) {
  const width = 432;
  const height = 736;
  const rgba = Buffer.alloc(width * height * 4);
  const frozenBody = [[28, 22, 80, 78]];
  const poses = {
    idle: {
      0: [[28, 22, 80, 78]],
      1: [[28, 22, 80, 78], [46, 36, 62, 44]],
      2: [[28, 22, 80, 78]],
    },
    running: {
      0: [[20, 28, 78, 80], [16, 58, 28, 80]],
      1: [[20, 28, 78, 80], [70, 48, 86, 78]],
      2: [[20, 28, 78, 80], [16, 58, 28, 80]],
    },
    retrying: {
      0: [[36, 24, 86, 80]],
      1: [[36, 24, 86, 80], [78, 52, 102, 80]],
    },
    needs_input: {
      0: [[28, 24, 80, 80], [70, 8, 86, 26]],
      1: [[28, 24, 80, 80], [78, 4, 100, 32]],
    },
    ready: {
      0: [[32, 12, 86, 56], [22, 8, 36, 24], [82, 8, 98, 24]],
      1: [[32, 12, 86, 56], [16, 2, 36, 22], [84, 2, 104, 22]],
    },
    blocked: {
      0: [[38, 40, 74, 80]],
      1: [[38, 40, 74, 80], [24, 54, 40, 80]],
    },
    disconnected: { 0: [[28, 22, 80, 78]] },
    service_not_running: { 0: [[34, 48, 76, 82]] },
  };
  const states = [
    { name: "idle", count: 3 },
    { name: "running", count: 3 },
    { name: "retrying", count: 2 },
    { name: "needs_input", count: 2 },
    { name: "ready", count: 2 },
    { name: "blocked", count: 2 },
    { name: "disconnected", count: 1 },
    { name: "service_not_running", count: 1 },
  ];
  states.forEach((state, row) => {
    for (let i = 0; i < state.count; i++) {
      const originX = i * 108;
      const originY = row * 92;
      const blobs = kind === "varied" ? poses[state.name][i] : frozenBody;
      blobs.forEach(([x0, y0, x1, y1], blobIndex) => {
        paintBlob(rgba, width, height, {
          x0: originX + x0,
          y0: originY + y0,
          x1: originX + x1,
          y1: originY + y1,
          r: blobIndex === 1 ? 20 : 40 + row * 12,
          g: blobIndex === 1 ? 20 : 120,
          b: blobIndex === 1 ? 20 : 80 + i * 20,
        });
      });
    }
  });
  writeFileSync(filePath, encodePng(width, height, rgba));
}

function makeReviewManifest() {
  const states = [
    "idle", "running", "retrying", "needs_input",
    "ready", "blocked", "disconnected", "service_not_running",
  ];
  const frameCounts = [3, 3, 2, 2, 2, 2, 1, 1];
  const manifest = {
    id: "review-sprite",
    name: "Review Sprite",
    version: 2,
    renderMode: "spritesheet",
    states: {},
    sheet: { src: "review.png", frameWidth: 108, frameHeight: 92, columns: 4, rows: 8 },
  };
  states.forEach((state, i) => {
    manifest.states[state] = {
      frame: "idle",
      staticFrame: "idle",
      label: "L",
      glyph: "·",
      firstFrame: i * 4,
      frameCount: frameCounts[i],
      durationMs: 200,
      staticFrameIndex: 0,
    };
  });
  return manifest;
}

async function assertReviewSelfTest(tmp) {
  const frozenDir = path.join(tmp, "review-sprite");
  mkdirSync(frozenDir, { recursive: true });
  writeFileSync(path.join(frozenDir, "manifest.json"), JSON.stringify(makeReviewManifest(), null, 2));
  writeReviewFixtureSheet(path.join(frozenDir, "review.png"), "frozen");
  process.exitCode = 0;
  await cmdReview(frozenDir);
  if (process.exitCode !== 1) throw new Error("frozen fixture should fail review");
  process.exitCode = 0;

  const variedDir = path.join(tmp, "review-ok");
  const variedManifest = makeReviewManifest();
  variedManifest.id = "review-ok";
  mkdirSync(variedDir, { recursive: true });
  writeFileSync(path.join(variedDir, "manifest.json"), JSON.stringify(variedManifest, null, 2));
  writeReviewFixtureSheet(path.join(variedDir, "review.png"), "varied");
  await cmdReview(variedDir);
  if (process.exitCode !== 0) throw new Error("varied fixture should pass review");
}

function fsRecursiveRemove(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) fsRecursiveRemove(target);
      else unlinkSync(target);
    }
    rmdirSync(dir);
  } catch {
    // best-effort cleanup; temp dir only
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    await cmdList(rest[0]);
    return;
  }
  if (cmd === "check") {
    if (!rest[0]) {
      fail("usage: node scripts/desktop-custom-pet.mjs check <petDir>");
      return;
    }
    await cmdCheck(rest[0]);
    return;
  }
  if (cmd === "review") {
    if (!rest[0]) {
      fail("usage: node scripts/desktop-custom-pet.mjs review <petDir>");
      return;
    }
    await cmdReview(rest[0]);
    return;
  }
  if (cmd === "stitch") {
    const framesIndex = rest.indexOf("--frames");
    const framesDir = framesIndex >= 0 ? rest[framesIndex + 1] : null;
    const petDir = rest[0];
    const force = rest.includes("--force");
    if (!petDir || !framesDir) {
      fail("usage: node scripts/desktop-custom-pet.mjs stitch <petDir> --frames <framesDir> [--force]");
      return;
    }
    await cmdStitch(petDir, framesDir, force);
    return;
  }
  if (cmd === "selftest") {
    await cmdSelfTest();
    return;
  }
  console.log(
    [
      "desktop custom pet pack helper",
      "  node scripts/desktop-custom-pet.mjs list [root]",
      "  node scripts/desktop-custom-pet.mjs check <petDir>",
      "  node scripts/desktop-custom-pet.mjs review <petDir>",
      "  node scripts/desktop-custom-pet.mjs stitch <petDir> --frames <stripsDir> [--force]",
      "  node scripts/desktop-custom-pet.mjs selftest",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
