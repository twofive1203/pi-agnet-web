import path from "node:path";
import * as esbuild from "esbuild";

/** Load the browser-safe TypeScript validator in Node without executing renderer code. */
export async function loadDesktopPetAssetValidator(root) {
  const bundle = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "desktop", "renderer", "pet-assets.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  const source = bundle.outputFiles[0]?.text;
  if (!source) throw new Error("failed to compile pet asset validator");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
