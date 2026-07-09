// Client face of the canonical cosmetics catalog (convex/cosmeticsCore.ts — the single
// definition shared by the backend validators, the ticket minter, and this renderer/UI).
// Everything here is VISUAL-ONLY: src/sim never imports this module (locked by
// test/cosmetics.test.ts), and no gameplay code branches on an equipped cosmetic.
//
// Party color vs body palette: players.colorIndex is the NETWORK identity color (name
// label, minimap dot, lobby roster) and stays the fallback body tint; the loadout's body
// item is the cosmetic body palette. The closet keeps them in step at launch, but every
// render path resolves body tint through bodyPaletteIndex so they can diverge later
// (party-assigned colors) without touching this layer.

export {
  COSMETICS,
  COSMETIC_SLOTS,
  EMPTY_LOADOUT,
  cosmeticById,
  cosmeticsForSlot,
  isCosmeticOwned,
  sanitizeEquip,
  earnedCosmeticsFor,
  isCosmeticIdFormat,
  bodyItemForPaletteIndex,
  bodyPaletteIndex,
} from "../../convex/cosmeticsCore.js";
export type { CosmeticSlot, CosmeticDef, CosmeticSlotDef, CosmeticLoadout } from "../../convex/cosmeticsCore.js";
