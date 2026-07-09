// Client face of the canonical cosmetics catalog (convex/cosmeticsCore.ts — the single
// definition shared by the backend validators, the ticket minter, and this renderer/UI).
// Everything here is VISUAL-ONLY: src/sim never imports this module (locked by
// test/cosmetics.test.ts), and no gameplay code branches on an equipped cosmetic.

export {
  COSMETICS,
  cosmeticById,
  cosmeticsForSlot,
  isCosmeticOwned,
  sanitizeEquip,
  earnedCosmeticsFor,
  isCosmeticIdFormat,
} from "../../convex/cosmeticsCore.js";
export type { CosmeticSlot, CosmeticDef } from "../../convex/cosmeticsCore.js";

// The equipped-cosmetics shape carried through StartOptions and the session. null slots
// render the natural blob (and the classic baked-in cowboy hat).
export interface EquippedCosmetics {
  hat: string | null;
  glasses: string | null;
}

export const NO_COSMETICS: EquippedCosmetics = { hat: null, glasses: null };
