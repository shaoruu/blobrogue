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

## Directional facing + attack sheets (the mob/boss render contract)
Every mob/boss carries persistent **4-way facing** (down / up / side; side authored facing
RIGHT and mirrored for left) derived from its movement with a deadzone + axis hysteresis,
and an **aimed attack overrides facing** while the move telegraphs (the body turns onto its
locked angle). The pose — facing, motion, move, phase, 0..1 windup, aim — is a typed hook
(`EnemyPose` in `src/game/facing.ts`) the draw pass and dev tools both consume.

**Directional set convention** (all optional, per sprite):
- `<name>_walk_down.png`, `<name>_walk_up.png`, `<name>_walk_side.png` — walk strips;
  **frame 0 doubles as that facing's idle pose** (held while standing).
- `<name>_attack.png` — omni windup/strike strip, or `<name>_attack_{down,up,side}.png`
  for full directional attacks.

**Enable a whole set with one line** in `src/game/assets.ts` (once the filenames are
approved); `fileBase` covers AD-versioned finals whose stem differs from the sprite name:
```ts
registerDirectionalSet("charger", { walkFps: 10, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("weaver", { walkFps: 12, attackFps: 12, isDirectionalAttack: true, fileBase: "weaver2_px" });
```

**Approved finals already wired (drop the files in, no code changes):**
- Directional walk + attack sets (`<stem>_walk_{down,up,side}.png` +
  `<stem>_attack_{down,up,side}.png`) for **marrow, burrower, weaver2_px, gilded,
  charger, orbiter**.
- The stationary Hollow Choir: `choir_idle.png` (breathing loop, plays even while it
  drifts) + `choir_attack.png` (omni).
- Thumper pair: pickup `weapon_thumper.png`, held `held_thumper.png`.
- Beam pair: pickup `beam2_px.png`, held `held_beam2_px.png`, plus the `fx/beam_ray.png`
  pure-white alpha mask (code-tinted per shot; `trail_streak` fallback until it lands).
- Pending gates keep their fallbacks: Undertow pair and the shielder set are deliberately
  unregistered until the AD's final call.

Selection degrades one deliberate step at a time — `attack_<facing>` → `attack` →
`walk_<facing>` → legacy `walk`/`idle` → static PNG + procedural juice — so partial sets
ship safely and every existing sprite keeps today's exact look until its directional art
lands. Contract locked by `npm run test:facing`.

Note: the hit-flash overlay uses a cached white silhouette of the **static** sprite, so
for sheet-animated characters the flash is an approximation of the current frame.
