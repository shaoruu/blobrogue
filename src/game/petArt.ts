// Companion pet PLACEHOLDER rendering — deliberately NOT art. blobrogue's art rule bans
// procedural code-drawn character bodies: every character is an authored sprite
// (FAL-generated, AD-approved — see ART.md for the pet filename/pose contract). Until those
// sprites are wired into assets.ts PET_SOURCES/PET_SHEETS, a pet renders as this minimal
// tinted SILHOUETTE — a soft round marker that shows position/ownership and nothing more,
// never claimed or readable as a final creature. The in-game renderer (game.ts renderPets)
// and the companion panel previews (src/ui/companionPanel.ts) share this one placeholder so
// neither can drift into inventing its own body art.

import type { PetKind } from "../sim/types.js";

// Drawn around the ORIGIN at the sim's native body scale (~20px across); callers own
// translate/scale/facing exactly as they will for the authored sprites.
export function drawPetPlaceholder(ctx: CanvasRenderingContext2D, _kind: PetKind, tint: string): void {
  ctx.save();
  // A dim body-mass silhouette…
  ctx.fillStyle = "rgba(10, 7, 20, 0.85)";
  ctx.beginPath();
  ctx.arc(0, 0, 9, 0, 6.28);
  ctx.fill();
  // …with a thin kind-tint rim so the three companions stay tellable apart at a glance.
  ctx.strokeStyle = tint;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, 9, 0, 6.28);
  ctx.stroke();
  ctx.restore();
}
