/**
 * Built-in sprite sheet bitmaps, inlined as data URLs by esbuild
 * (`loader: { ".png": "dataurl" }`). Imported only by the browser renderer —
 * never by the Node smoke, which stays DOM/image-free.
 */

import snailSpriteSheetRaw from "../assets/pets/snail-sprite/snail.png";

// Next's ambient `*.png` module type is `StaticImageData`, but esbuild compiles
// the renderer bundle with the `dataurl` loader so the runtime value is a plain
// `data:image/png;base64,...` string. The cast reflects that runtime contract.
const snailSpriteSheet = snailSpriteSheetRaw as unknown as string;

/** Builtin pet id → sprite sheet data URL. */
export const PET_SHEET_DATA_URLS: Readonly<Record<string, string>> = {
  "snail-sprite": snailSpriteSheet,
};
