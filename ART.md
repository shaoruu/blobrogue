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
banned**. Until the FAL-generated, AD-approved pet sprites land, the three companions
(Ember Pup, Lantern Wisp, Bonebird) render as a minimal tinted **silhouette placeholder**
(`src/game/petArt.ts`): a position/ownership marker, explicitly not final art, and the
pets PR does not merge as ready until the real sprites below are wired. The sprite hooks
are typed and live; dropping the art in requires **no code changes beyond registering the
files** in `src/game/assets.ts`.

**Pose contract** (`PetPose` in `assets.ts`): every frame the renderer derives
`clip: "idle" | "walk" | "action"` (`action` plays for ~0.3s after a nip/peck, driven by
the authoritative wire timer) and `facing: -1 | 1`. Author art **facing right**; the
renderer mirrors for left.

**Exact expected filenames** — one 64×64 base PNG per pet, plus optional horizontal strip
sheets (64×64 frames, count inferred from width) per clip:

| pet | base | walk | action |
|---|---|---|---|
| Ember Pup | `/sprites/pet_ember_pup.png` | `/sprites/pet_ember_pup_walk.png` | `/sprites/pet_ember_pup_action.png` |
| Lantern Wisp | `/sprites/pet_lantern_wisp.png` | `/sprites/pet_lantern_wisp_walk.png` | `/sprites/pet_lantern_wisp_action.png` |
| Bonebird | `/sprites/pet_bonebird.png` | `/sprites/pet_bonebird_walk.png` | `/sprites/pet_bonebird_action.png` |

**Enable** (mirrors `SHEETS` — registries are empty by default so nothing 404s):

```ts
export const PET_SOURCES: Partial<Record<PetKind, string>> = {
  ember_pup: "/sprites/pet_ember_pup.png",
};
export const PET_SHEETS: Partial<Record<`${PetKind}.${PetClip}`, SheetDef>> = {
  "ember_pup.walk": { src: "/sprites/pet_ember_pup_walk.png", fps: 10 },
};
```

Missing clips fall back `action -> walk -> base -> silhouette placeholder`, so partial
drops are fine. Pets draw at 30px (about half a hero); accent tints live in
`src/sim/pets.ts` (`PETS[kind].tint`).
