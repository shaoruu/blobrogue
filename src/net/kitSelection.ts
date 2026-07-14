// The player's chosen KIT for the next run (KIT/XP spec §5): picked in the Amber Camp lobby,
// persisted locally, and read at ticket-mint time so it rides the SIGNED join ticket. The
// Convex mint validates the pick against the account's Mastery unlocks and the game server
// re-gates it — this module only remembers the intent; it is never authoritative.

import type { KitId } from "../sim/kits.js";
import { isKitId } from "../sim/kits.js";
import { CAMP_NODES } from "../sim/camp_nodes.js";

const KIT_KEY = "blobrogue.selectedKit";
const PET_KEY = "blobrogue.lastPetId";
const NO_PET_VALUE = "none";
// Gunner is unlocked by default (spec §4), so it is the safe fallback selection.
export type PlayableKitId = Exclude<KitId, "none">;
const DEFAULT_KIT: PlayableKitId = "gunner";

export interface RunLoadout {
  kitId: PlayableKitId;
  petId: string | null;
}

export interface RememberedPet {
  isRemembered: boolean;
  petId: string | null;
}

export function getSelectedKit(): PlayableKitId {
  try {
    const v = localStorage.getItem(KIT_KEY);
    return isKitId(v) && v !== "none" ? v : DEFAULT_KIT;
  } catch {
    return DEFAULT_KIT;
  }
}

export function setSelectedKit(kit: PlayableKitId): void {
  try {
    localStorage.setItem(KIT_KEY, kit);
  } catch {
    /* storage disabled — the mint falls back to the default */
  }
}

function isKnownPetId(petId: string): boolean {
  return CAMP_NODES.some((node) => node.pet === petId);
}

export function getRememberedPet(): RememberedPet {
  try {
    const value = localStorage.getItem(PET_KEY);
    if (value === null) return { isRemembered: false, petId: null };
    if (value === NO_PET_VALUE) return { isRemembered: true, petId: null };
    return isKnownPetId(value)
      ? { isRemembered: true, petId: value }
      : { isRemembered: false, petId: null };
  } catch {
    return { isRemembered: false, petId: null };
  }
}

export function rememberRunLoadout(loadout: RunLoadout): void {
  setSelectedKit(loadout.kitId);
  try {
    localStorage.setItem(PET_KEY, loadout.petId ?? NO_PET_VALUE);
  } catch {
    /* storage disabled — the next gate safely browses No Pet */
  }
}
