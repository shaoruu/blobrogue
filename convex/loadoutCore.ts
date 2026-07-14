import { isPetOwned } from "../src/sim/camp_nodes.js";
import { isKitId, isKitUnlocked, masteryLevelForXp } from "./masteryCore";

export type ConfirmedKitId = "gunner" | "mender" | "bulwark" | "phantom";

export interface CombinedLoadoutInput {
  kitId: string;
  petId: string | null;
  isKitChoiceMade: boolean;
  isPetChoiceMade: boolean;
}

export interface LoadoutAuthority {
  masteryXp?: number;
  unlocks: readonly string[];
}

export type LoadoutRejectReason =
  | "kit_choice_required"
  | "pet_choice_required"
  | "unknown_kit"
  | "kit_locked"
  | "pet_unowned";

export type LoadoutValidation =
  | { ok: true; kitId: ConfirmedKitId; petId: string | null }
  | { ok: false; reason: LoadoutRejectReason };

export function validateCombinedLoadout(
  authority: LoadoutAuthority,
  input: CombinedLoadoutInput,
): LoadoutValidation {
  if (!input.isKitChoiceMade) return { ok: false, reason: "kit_choice_required" };
  if (!input.isPetChoiceMade) return { ok: false, reason: "pet_choice_required" };
  if (!isKitId(input.kitId) || input.kitId === "none") return { ok: false, reason: "unknown_kit" };
  const level = masteryLevelForXp(authority.masteryXp ?? 0);
  if (!isKitUnlocked(input.kitId, level)) return { ok: false, reason: "kit_locked" };
  if (input.petId !== null && !isPetOwned(input.petId, authority.unlocks)) {
    return { ok: false, reason: "pet_unowned" };
  }
  return { ok: true, kitId: input.kitId, petId: input.petId };
}
