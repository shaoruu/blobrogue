// Companion pet ART INTEGRATION CONTRACT (no rendering lives here — nothing in this module
// draws, per the hard no-procedural/no-circle art rule, placeholders included). This is the
// typed contract the AD's FAL-generated sprites drop into:
//
//   THREE FACINGS + MIRROR — every clip is authored down / up / side; `side` faces RIGHT
//   and the renderer mirrors it for left (the same mirror contract heroes/enemies use).
//
//   TWO CLIPS PER PET — `walk_{dir}` plus ONE role action per kind:
//     ember_pup -> burn, lantern_wisp -> collect, bonebird -> mark.
//
//   FRAME 0 IS IDLE — there are no idle strips or base statics; a stationary pet holds
//   frame 0 of its resolved strip.
//
//   FALLBACK LADDER (like the enemy sheet ladder) — `{clip}_{facing}` -> `walk_{facing}`
//   -> `walk_down` (the canonical minimum asset). Nothing resolved => the pet body is
//   HIDDEN — the ground shadow / wisp light remain as neutral non-character markers; there
//   is deliberately NO drawn placeholder body of any kind.
//
// The exact canonical filenames (18 files — locked by test/petart.test.ts):
//   /sprites/pet_ember_pup_walk_{down,up,side}.png     /sprites/pet_ember_pup_burn_{down,up,side}.png
//   /sprites/pet_lantern_wisp_walk_{down,up,side}.png  /sprites/pet_lantern_wisp_collect_{down,up,side}.png
//   /sprites/pet_bonebird_walk_{down,up,side}.png      /sprites/pet_bonebird_mark_{down,up,side}.png
// Horizontal strips, 64x64 square frames, count inferred from width (SHEETS format).

import type { PetKind } from "../sim/types.js";
import { PET_KINDS } from "../sim/pets.js";
import { frameIndex } from "./anim.js";

export type PetFacing = "down" | "up" | "side";
export const PET_FACINGS: readonly PetFacing[] = ["down", "up", "side"];

export type PetActionName = "burn" | "collect" | "mark";
export type PetClipName = "walk" | PetActionName;

// The ONE role action each companion broadcasts (its attackAnim window plays this clip).
export const PET_ACTION: Record<PetKind, PetActionName> = {
  ember_pup: "burn",
  lantern_wisp: "collect",
  bonebird: "mark",
};

// The renderer's per-frame pose: which strip, which authored facing, whether the side
// strip mirrors (logical Facing4 = down/up/right/left expressed as 3 facings + mirror),
// and whether to hold frame 0 (idle).
export interface PetPose {
  clip: PetClipName;
  facing: PetFacing;
  mirror: boolean; // meaningful only for "side": authored RIGHT, mirrored for left
  isIdle: boolean;
}

// Deadzoned dominant-axis facing from a motion delta; anything under the deadzone keeps
// the previous facing (no flicker while heeling). Ties go to "side" so lateral strips —
// the most-read facing in a side-scrolling brawl — win ambiguous diagonals.
export interface PetFacingState { facing: PetFacing; mirror: boolean }
export const PET_FACING_DEADZONE = 0.35;

export function petFacingFrom(dx: number, dy: number, prev: PetFacingState): PetFacingState {
  if (Math.hypot(dx, dy) < PET_FACING_DEADZONE) return prev;
  if (Math.abs(dx) >= Math.abs(dy)) return { facing: "side", mirror: dx < 0 };
  return { facing: dy > 0 ? "down" : "up", mirror: false };
}

// Registry keys + canonical filenames.
export type PetSheetKey = `${PetKind}.${PetClipName}_${PetFacing}`;

export function petSheetKey(kind: PetKind, clip: PetClipName, facing: PetFacing): PetSheetKey {
  return `${kind}.${clip}_${facing}`;
}

export function petSheetFile(kind: PetKind, clip: PetClipName, facing: PetFacing): string {
  return `/sprites/pet_${kind}_${clip}_${facing}.png`;
}

// The ordered fallback ladder for one pose (deduplicated when the facing is already down).
export function petSheetCandidates(kind: PetKind, clip: PetClipName, facing: PetFacing): PetSheetKey[] {
  const out: PetSheetKey[] = [petSheetKey(kind, clip, facing)];
  const walkFacing = petSheetKey(kind, "walk", facing);
  if (!out.includes(walkFacing)) out.push(walkFacing);
  const walkDown = petSheetKey(kind, "walk", "down");
  if (!out.includes(walkDown)) out.push(walkDown);
  return out;
}

// Frame selection under the frame0-idle rule: a stationary pet holds frame 0; a moving or
// acting one plays the strip at its authored fps.
export function petFrame(count: number, fps: number, clock: number, isIdle: boolean): number {
  if (isIdle) return 0;
  return frameIndex(count, fps, clock);
}

// Every canonical file the AD ships (per kind: walk + its ONE role action, three facings
// each — 18 total). The hook test locks these exact strings.
export function petCanonicalFiles(): string[] {
  const out: string[] = [];
  for (const kind of PET_KINDS) {
    for (const clip of ["walk", PET_ACTION[kind]] as const) {
      for (const facing of PET_FACINGS) out.push(petSheetFile(kind, clip, facing));
    }
  }
  return out;
}
