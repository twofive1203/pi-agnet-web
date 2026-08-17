/**
 * Node-only re-export entry for scripts/desktop-custom-pet.mjs.
 *
 * Lets the pack helper validate with the exact runtime contract (the same
 * modules the Electron main process bundles) instead of re-implementing it.
 * Bundled by esbuild at runtime; never imported by app code or tests directly.
 */

export {
  CUSTOM_PET_MAX_COUNT,
  resolveCustomPetsRoot,
  scanCustomPets,
  type CustomPetAsset,
  type CustomPetsIo,
  type CustomPetScanError,
  type CustomPetScanResult,
} from "../desktop/main/custom-pets";
export {
  PET_ASSET_LIMITS,
  PET_MANIFEST_VERSION,
  PET_REQUIRED_STATES,
  validatePetManifestDocument,
} from "../desktop/renderer/pet-assets";
