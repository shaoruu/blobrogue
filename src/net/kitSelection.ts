// Local preselection convenience for the mandatory combined gate. These values never
// authorize a run; online tickets read the generation-bound room confirmation.

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

export interface RememberedKit {
  isRemembered: boolean;
  kitId: PlayableKitId;
}

export function getSelectedKitSelection(): RememberedKit {
  try {
    const v = localStorage.getItem(KIT_KEY);
    return isKitId(v) && v !== "none"
      ? { isRemembered: true, kitId: v }
      : { isRemembered: false, kitId: DEFAULT_KIT };
  } catch {
    return { isRemembered: false, kitId: DEFAULT_KIT };
  }
}

export function getSelectedKit(): PlayableKitId {
  return getSelectedKitSelection().kitId;
}

export function setSelectedKit(kit: PlayableKitId): void {
  try {
    localStorage.setItem(KIT_KEY, kit);
  } catch {}
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

export function rememberPet(petId: string | null): void {
  try {
    localStorage.setItem(PET_KEY, petId ?? NO_PET_VALUE);
  } catch {}
}

export function rememberRunLoadout(loadout: RunLoadout): void {
  setSelectedKit(loadout.kitId);
  rememberPet(loadout.petId);
}
