// The player's chosen KIT for the next run (KIT/XP spec §5): picked in the Amber Camp lobby,
// persisted locally, and read at ticket-mint time so it rides the SIGNED join ticket. The
// Convex mint validates the pick against the account's Mastery unlocks and the game server
// re-gates it — this module only remembers the intent; it is never authoritative.

import type { KitId } from "../sim/kits.js";
import { isKitId } from "../sim/kits.js";

const KIT_KEY = "blobrogue.selectedKit";
// Gunner is unlocked by default (spec §4), so it is the safe fallback selection.
const DEFAULT_KIT: KitId = "gunner";

export function getSelectedKit(): KitId {
  try {
    const v = localStorage.getItem(KIT_KEY);
    return isKitId(v) && v !== "none" ? v : DEFAULT_KIT;
  } catch {
    return DEFAULT_KIT;
  }
}

export function setSelectedKit(kit: KitId): void {
  try {
    localStorage.setItem(KIT_KEY, kit);
  } catch {
    /* storage disabled — the mint falls back to the default */
  }
}
