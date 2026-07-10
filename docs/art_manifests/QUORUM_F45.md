# QUORUM (F45 boss) — art manifest

**Status: AD-APPROVED & LOCKED (2026-07-10).** Three role-husks (shield/heal/dmg) × down/up/side + merge-form.
All bone-white bleached-bone family, 0% teal, cohesion-gated (read as one four-of-a-kind).

## Identity & mechanics
Three lean hollow bone husks sharing ONE HP pool + ONE telegraph. Husk ROLES are load-bearing so kill-order
matters: SHIELD (hunches behind bone plating), HEAL (channels, exposed amber marrow-heart + purple robe),
DMG (aggressive lunge, bone-blade claws). A code-drawn taut amber TETHER links husk-to-husk (visible shared
HP; snaps + yanks on a husk's death; next-to-act husk leans hardest on it). Telegraphed 1.2s NON-invuln merge
→ the MERGE-FORM (3 bodies fused wrong) gets its own earned-window with widened >=0.45s recover.

## Files (in public/sprites/, 80×80 husks / merge, art-bible bone palette)
- `quorum_shield_walk_{down,up,side}.png` — shield husk (side authored facing RIGHT, renderer mirrors).
- `quorum_heal_walk_{down,up,side}.png` — heal husk (amber marrow-heart + purple robe tells in every view).
- `quorum_dmg_walk_{down,up,side}.png` — dmg husk (side is a legit lunge, wider ratio by design).
- `quorum_merge.png` — the fused-wrong merge-form. Intentionally darker VALUE than the husks (same bone HUE)
  = the "three fused into something worse" horror contrast. Do NOT lift it (AD call).

## Wiring (build agent)
1. Add the 3 husk sprite names to SPRITES + `registerDirectionalSet` each ("quorum_shield"/"quorum_heal"/
   "quorum_dmg", facings ["down","up","side"]). Merge = a single sprite swapped in on the merge transition.
2. The TETHER is CODE-DRAWN, not a sprite: a taut amber line husk-to-husk (art-bible amber #c77320/#ffb43b),
   thickness/tautness = shared-HP tell, snaps + recoils on a husk death, next-to-act husk pulls hardest.
   AD wants an in-engine shot of the drawn tether for a final look (does it read as the shared-HP tell?).
3. Shared HP pool + shared telegraph are SIM-side; roles (shield/heal/dmg) drive kill-order. Merge at the
   1.2s non-invuln transition → swap 3 husks for quorum_merge, give the merge-form its own window.

## Note
Side facings are ~subtly dimmer than downs (turned-from-light read, AD confirmed non-blocking; a light bone-
lift was applied). Single-frame sheets today; multi-frame walk/attack can be added later under same names.
