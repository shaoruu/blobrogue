// Companion pet render mapping: an equipped pet id (the wire label + equippedPet value) to
// the SpriteName the renderer draws it as. Kept in a tiny pure module (no DOM) so the sim +
// meta layer never learns about sprite keys, and so the mapping is unit-testable on its own.
//
// A pet's render key matches its pet id today, but this stays an EXPLICIT table so a new pet
// can point at any sprite and an UNKNOWN id (old client / future pet) resolves to null and
// renders nothing — never a crash.

import type { SpriteName } from "../sim/types.js";
import {
  DOGGIE_PET_ID, CAT_PET_ID, DRAGON_PET_ID, SLIME_PET_ID,
  EMBERFOX_PET_ID, OWLET_PET_ID, MOTHLING_PET_ID, ROLLY_PET_ID,
} from "../sim/camp_nodes.js";

const PET_SPRITES: Readonly<Record<string, SpriteName>> = {
  [DOGGIE_PET_ID]: "doggie",
  [CAT_PET_ID]: "cat",
  [DRAGON_PET_ID]: "dragon",
  // The slime companion renders as "slime_pet" — a key distinct from the "slime" ENEMY sprite.
  [SLIME_PET_ID]: "slime_pet",
  // Pack #2 — each renders under a render key matching its pet id (no enemy collision).
  [EMBERFOX_PET_ID]: "emberfox",
  [OWLET_PET_ID]: "owlet",
  [MOTHLING_PET_ID]: "mothling",
  [ROLLY_PET_ID]: "rolly",
};

// The sprite for an equipped pet id, or null for an unknown id (graceful: renders nothing).
export function petSpriteFor(petId: string): SpriteName | null {
  return PET_SPRITES[petId] ?? null;
}
