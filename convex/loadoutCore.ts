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

export type LoadoutMode = "coop" | "pvp";

export type LoadoutRejectReason =
  | "kit_choice_required"
  | "pet_choice_required"
  | "unknown_kit"
  | "kit_locked"
  | "pet_unowned";

export type LoadoutValidation =
  | { ok: true; kitId: ConfirmedKitId; petId: string | null }
  | { ok: false; reason: LoadoutRejectReason };

export type KitDraftValidation =
  | { ok: true; kitId: ConfirmedKitId }
  | { ok: false; reason: "unknown_kit" | "kit_locked" };

export type PetDraftValidation =
  | { ok: true; petId: string | null }
  | { ok: false; reason: "pet_unowned" };

export function validateKitDraft(
  authority: LoadoutAuthority,
  kitId: string,
): KitDraftValidation {
  if (!isKitId(kitId) || kitId === "none") return { ok: false, reason: "unknown_kit" };
  const level = masteryLevelForXp(authority.masteryXp ?? 0);
  if (!isKitUnlocked(kitId, level)) return { ok: false, reason: "kit_locked" };
  return { ok: true, kitId };
}

export function validatePetDraft(
  authority: LoadoutAuthority,
  petId: string | null,
  mode: LoadoutMode = "coop",
): PetDraftValidation {
  if (mode === "coop" && petId !== null && !isPetOwned(petId, authority.unlocks)) {
    return { ok: false, reason: "pet_unowned" };
  }
  return { ok: true, petId };
}

export function validateCombinedLoadout(
  authority: LoadoutAuthority,
  input: CombinedLoadoutInput,
  mode: LoadoutMode = "coop",
): LoadoutValidation {
  if (!input.isKitChoiceMade) return { ok: false, reason: "kit_choice_required" };
  if (!input.isPetChoiceMade) return { ok: false, reason: "pet_choice_required" };
  const kit = validateKitDraft(authority, input.kitId);
  if (!kit.ok) return kit;
  const pet = validatePetDraft(authority, input.petId, mode);
  if (!pet.ok) return pet;
  return { ok: true, kitId: kit.kitId, petId: pet.petId };
}
