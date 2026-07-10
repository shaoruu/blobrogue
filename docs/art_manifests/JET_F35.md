# JET (F35 boss) — art manifest

**Status: AD-APPROVED & LOCKED (2026-07-10).** Down + up + side + all 3 phases, identity-consistent,
cold indigo, contrast-verified against the real Sump floor (#16131a). Clear to wire in the Wave 1 build.

## Identity
JET is "the corrupted YOU" — a RECOLOR of the hero (same rounded-blob silhouette), remapped to a cold
jet ramp so it reads as the player's dark twin. All facings + phases were AUTHORED from the locked
down sprite's pixels (NOT AI-derived) to hold identity — reuse this approach for any hero-derived art.

## Files (in public/sprites/, 64×64, art-bible palette)
- `jet_walk_down.png` — down facing (LOCKED base). Single frame; frame 0 = idle.
- `jet_walk_up.png` — up/back facing (face painted out, identical silhouette).
- `jet_walk_side.png` — side profile, authored FACING RIGHT (renderer mirrors for left).
- `jet_phase1.png` — P1 "uncanny" (= locked base, down).
- `jet_phase2.png` — P2 "out-of-sync canon" (desaturated, colder, dimmed body).
- `jet_phase3.png` — P3 "inverted/room-drain" ENRAGE (amber veins flared HOT — the escalation reads on the body).

## Wiring (build agent)
1. Add `jet: "/sprites/jet_walk_down.png"` to the SPRITES map in `src/game/assets.ts` (boss roster hooks block).
2. `registerDirectionalSet("jet", { walkFps: <n>, facings: ["down","up","side"] })` — resolves
   `jet.walk_{down,up,side}` → `/sprites/jet_walk_{facing}.png`. Side is facing-right; the renderer mirrors.
3. Phase sprites: swap the boss's active sprite by fight phase (P1→jet_phase1, P2→jet_phase2, P3→jet_phase3),
   or register as move/telegraph sheets per the multi-move boss contract. P3 is the enrage tell.
4. These are single-frame sheets today (no walk cycle) — the facing.ts ladder + frame-0-as-idle handles that
   fine; a later pass can add multi-frame walk/attack sheets under the same names.

## Audio (separate, audio director owns)
Amber motif hollowed: P1 uncanny → P2 out-of-sync canon → P3 inverted over room-drain → dead note.
Literal quotation of amber_motif.mid; per-phase stems.
