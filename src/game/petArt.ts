// The ONE procedural companion body per kind, shared by the in-game renderer
// (game.ts renderPets) and the companion panel's animated previews
// (src/ui/companionPanel.ts), so the pet a player equips is pixel-for-pixel the pet that
// follows them. Draws around the ORIGIN at the sim's native body scale (~26px across);
// callers own translate/scale/facing, so the same shapes serve the world (30px draw), the
// 64px panel preview, and any future Amber Camp station kiosk. Replaced per-kind by the
// authored sprites the moment they land in assets.ts PET_SOURCES (see ART.md).

import type { PetKind } from "../sim/types.js";

export function drawPetBody(ctx: CanvasRenderingContext2D, kind: PetKind, tint: string, clock: number): void {
  if (kind === "ember_pup") {
    ctx.fillStyle = tint;
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, 6.28); ctx.fill();          // body
    ctx.beginPath(); ctx.arc(7, -3, 5, 0, 6.28); ctx.fill();         // snout
    ctx.beginPath();                                                  // ear
    ctx.moveTo(-2, -7); ctx.lineTo(2, -13); ctx.lineTo(5, -6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#3a1c08";
    ctx.beginPath(); ctx.arc(8, -4, 1.4, 0, 6.28); ctx.fill();       // eye
    ctx.fillStyle = "#ffd27a";
    ctx.beginPath();                                                  // tail flame tip
    ctx.moveTo(-8, 1); ctx.lineTo(-13, -3); ctx.lineTo(-9, 5); ctx.closePath(); ctx.fill();
  } else if (kind === "bonebird") {
    ctx.fillStyle = tint;
    ctx.beginPath(); ctx.ellipse(0, 0, 8, 6.5, 0, 0, 6.28); ctx.fill();  // body
    ctx.beginPath(); ctx.arc(6, -5, 4.5, 0, 6.28); ctx.fill();           // head
    ctx.fillStyle = "#b9a24f";
    ctx.beginPath();                                                      // beak
    ctx.moveTo(9, -5); ctx.lineTo(15, -4); ctx.lineTo(9, -2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#2a2438";
    ctx.beginPath(); ctx.arc(7, -6, 1.3, 0, 6.28); ctx.fill();            // eye
    ctx.fillStyle = "#c9bfa8";
    const flap = Math.sin(clock * 10) * 3;
    ctx.beginPath(); ctx.ellipse(-2, -2, 5, 3, -0.5 + flap * 0.08, 0, 6.28); ctx.fill(); // wing
  } else {
    // Lantern wisp: a floating core inside a pulsing halo (in-game it also carries the
    // additive light pool — see game.ts renderWispLight).
    ctx.fillStyle = "#eafaff";
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, 6.28); ctx.fill();
    ctx.strokeStyle = tint;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, 7.5 + Math.sin(clock * 5) * 1.2, 0, 6.28); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
