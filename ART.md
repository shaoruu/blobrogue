# blobrogue art & animation

## Sprites
Every sprite is a **64×64 transparent PNG** in `public/sprites/`
(`hero`, `slime`, `bat`, `skeleton`, `ghost`, `boss`, `heart`, `coin`, `gun`).
They are registered in `src/game/assets.ts` (`SOURCES`).

## Everything is animated (procedural, no extra art)
There are no static sprites in motion. Each character and pickup carries a tiny
`anim` state (`src/game/anim.ts`) that drives a squash/stretch + bob + lean transform
applied around the sprite at draw time:

- **Idle** — gentle vertical bob + subtle squash-and-stretch (blobs breathe).
- **Moving** — faster cadence, an upward hop, and a lean toward the movement direction.
- **Shoot** — a recoil scale-punch (the hero also nudges back against its aim) + a muzzle flash.
- **Hit** — a white flash overlay (cached silhouette) on the player and every enemy.
- **Death** — a quick scale-pop → squash + fade "corpse" plus the existing particle burst.
- **Pickups** — coins spin, hearts/guns shimmer-pulse, all float with a soft glow.
- **Boss** — heavier/slower breathing and a wind-up telegraph right before it spawns adds.

This is allocation-free in the hot path: `stepAnim` avoids closures and `characterXform`
writes into a shared scratch object.

## Optional frame-based spritesheets (drop-in, for later)
The draw path can play real frame animation from a **horizontal strip** spritesheet, and
falls back to the procedural animation above whenever a sheet is absent (the current case).

**Format**
- One PNG, a single horizontal row of **N square frames**, **64×64 per frame**
  (so a 4-frame sheet is `256×64`). Frame count is inferred as `width / height`.
- Suggested naming: `public/sprites/<name>_<clip>.png`, e.g. `hero_walk.png`.
- Clips are `idle` and `walk`. `walk` plays while the entity is moving; `idle` while still.
  If a clip's sheet is missing, that state falls back to the static PNG + procedural juice.

**Enable a sheet** (two steps, no other code changes):
1. Drop the strip into `public/sprites/`, e.g. `hero_walk.png`.
2. Add one line to `SHEETS` in `src/game/assets.ts`:
   ```ts
   export const SHEETS: Partial<Record<string, SheetDef>> = {
     "hero.walk": { src: "/sprites/hero_walk.png", fps: 10 },
   };
   ```

`SHEETS` is empty by default, so nothing extra is fetched (no 404s) until you opt in.

Note: the hit-flash overlay uses a cached white silhouette of the **static** sprite, so
for sheet-animated characters the flash is an approximation of the current frame.

## Companion pets (art contract — REAL SPRITES REQUIRED, none shipped yet)
Character art in blobrogue is **authored sprites only — procedural code-drawn bodies are
banned, placeholders included (no circles)**. Until the FAL-generated, AD-approved pet
strips land, a pet's body is simply **not drawn**: its neutral ground shadow (wisp: its
light pool) marks position, and the pets PR does not merge as ready until the real strips
below are wired. The typed contract lives in `src/game/petArt.ts`
(pose/facings/fallbacks, locked by `test/petart.test.ts`); dropping the art in requires
**no code changes beyond registering the files** in `src/game/assets.ts` `PET_SHEETS`.

**Pose contract** (`PetPose` in `petArt.ts`): every frame the renderer derives
- `clip`: `walk`, or the pet's ONE role action while its authoritative action timer runs
  (~0.3s after it acts): **Ember Pup `burn` · Lantern Wisp `collect` · Bonebird `mark`**
- `facing`: `down | up | side` (dominant motion axis, deadzoned) with `mirror` — **side is
  authored facing RIGHT** and the renderer mirrors it for left (the standard mirror
  contract heroes/enemies use)
- `isIdle`: a stationary pet holds **frame 0** of its resolved strip — there are **no idle
  strips and no base statics**; frame 0 IS the idle pose

**Fallback ladder** (like the enemy sheet ladder): `{clip}_{facing}` → `walk_{facing}` →
`walk_down` (the canonical minimum asset) → hidden. Partial drops are fine.

**Exact canonical filenames** — 18 horizontal strips, 64×64 square frames, count inferred
from width:

| pet | walk | role action |
|---|---|---|
| Ember Pup | `pet_ember_pup_walk_down.png` `pet_ember_pup_walk_up.png` `pet_ember_pup_walk_side.png` | `pet_ember_pup_burn_down.png` `pet_ember_pup_burn_up.png` `pet_ember_pup_burn_side.png` |
| Lantern Wisp | `pet_lantern_wisp_walk_down.png` `pet_lantern_wisp_walk_up.png` `pet_lantern_wisp_walk_side.png` | `pet_lantern_wisp_collect_down.png` `pet_lantern_wisp_collect_up.png` `pet_lantern_wisp_collect_side.png` |
| Bonebird | `pet_bonebird_walk_down.png` `pet_bonebird_walk_up.png` `pet_bonebird_walk_side.png` | `pet_bonebird_mark_down.png` `pet_bonebird_mark_up.png` `pet_bonebird_mark_side.png` |

All under `public/sprites/`.

**Enable** (mirrors `SHEETS` — the registry is empty by default so nothing 404s):

```ts
export const PET_SHEETS: Partial<Record<PetSheetKey, SheetDef>> = {
  "ember_pup.walk_down": { src: "/sprites/pet_ember_pup_walk_down.png", fps: 10 },
  "ember_pup.burn_side": { src: "/sprites/pet_ember_pup_burn_side.png", fps: 12 },
};
```

Pets draw at 30px (about half a hero); accent tints live in `src/sim/pets.ts`
(`PETS[kind].tint`). The companion panel's 64px preview plays the `walk_down` strip
(frame 0 idle) the moment it is registered.
