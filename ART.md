# blobrogue art & animation

## Sprites
Every sprite is a **64×64 transparent PNG** in `public/sprites/`
(`hero`, `slime`, `bat`, `skeleton`, `ghost`, `boss`, `heart`, `coin`, `gun`).

## Cosmetic layer assets (socket pipeline)
Generated cosmetic layers (see the art environment's `fal-art/COSMETIC_LAYER_SPEC.md`)
drop into `public/sprites/cosmetics/` as square transparent PNGs, one per orientation:
`<assetKey>_down.png`, `<assetKey>_up.png`, `<assetKey>_side.png` (side authored FACING
RIGHT; the renderer mirrors left). Register the key + socket + authored size in
`src/game/cosmeticSockets.ts` `COSMETIC_ASSET_SOURCES`, then point a catalog item at it via
`assetKey` (`convex/cosmeticsCore.ts`). Resolution is asset-first with graceful
degradation: absent/failed files fall back to the item's procedural painter (when it has
one), else render nothing — never a placeholder. Anchors come from the deterministic
socket tables in the same module (head/face/back, per orientation, per frame); cosmetics
inherit the body's bob/lean/squash only up to the readability caps and always draw BELOW
weapon, status, and name cues. The gated first pair is `cowboy_hat_classic` (plus the
layered bald base `hero_base_bald.png`) and `round_glasses` — broader content waits until
that pair passes the socket gate across facings/animations/biomes/weapons.
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
  `<stem>_attack_{down,up,side}.png`) for **marrow, burrower, weaver2_px, charger,
  orbiter, shielder**.
- **Gilded Warden — side profile BLOCKED** (failed twice; stop): approved DOWN+UP sets
  only (`gilded_{walk,attack}_{down,up}.png`) plus the generic `gilded_attack.png`
  catch-all. The ladder's **vertical hold** keeps its horizontal movement on the nearest
  approved down/up sheet (unmirrored) — no `gilded_*_side` file is registered or ever
  requested, and there is no fake side slide. Register partial facings via
  `facings: ["down", "up"]` on `registerDirectionalSet`.
- The stationary Hollow Choir: `choir_idle.png` (breathing loop, plays even while it
  drifts) + `choir_attack.png` (omni).
- Thumper pair: pickup `weapon_thumper.png`, held `held_thumper.png`.
- Beam pair: pickup `beam2_px.png`, held `held_beam2_px.png`, plus the `fx/beam_ray.png`
  pure-white alpha mask (code-tinted per shot; `trail_streak` fallback until it lands).


**Move-specific telegraphs (multi-move bosses).** A generic attack sheet cannot express
MARROW's charge vs its volley, or the Warden's quake vs its sweep — so any authored
move+phase sheet outranks the generic tiers. Convention:
`<stem>_<move>_<phase>[_<facing>].png` with phase ∈ windup/active/recover (recover means
authored punish poses — a crash-stun dizzy sheet — are first-class). Register per beat:
```ts
registerMoveSheet("marrow", "rush_windup", 12, { isDirectional: true });
registerMoveSheet("gilded", "slam_active", 10);
registerMoveSheet("weaver", "pounce_active", 12, { fileBase: "weaver2_px" });
```

Selection degrades one deliberate step at a time —
`<move>_<phase>_<facing>` → `<move>_<phase>` → `attack_<facing>` → `attack` →
`walk_<facing>` → legacy `walk`/`idle` → static PNG + procedural juice — so partial sets
ship safely: author only the beats that need bespoke poses and every other state keeps
resolving through the generic set. Every existing sprite keeps today's exact look until
its art lands. Contract locked by `npm run test:facing`.

Note: the hit-flash overlay uses a cached white silhouette of the **static** sprite, so
for sheet-animated characters the flash is an approximation of the current frame.

## Patch & the waystation (shop room) — ART GATE, hooks wired, art pending
**Patch** is the Dealer NPC (studio coherence gate: a *warm amber salvage-hauler* whose
fold-out cabinet is built from recovered doors/prop pieces). The shop ships behind an art
gate: every hook below is registered and typed, the renderer runs a clearly-placeholder
flat primitive per piece, and **no procedural character art stands in** — drop the
approved PNGs onto these exact names and each piece lights up with zero code changes.

Character (64×64 base + horizontal strips, like every sprite):
- `patch.png` — static base: stout hauler silhouette, patched amber coat, big salvage
  pack, standing behind a counter, facing DOWN (the stall faces into the room).
- `patch_idle.png` — breathing keeper loop (registered `patch.idle`, 6fps).
- `patch_handover.png` — one-shot handover pose, played over every purchase (registered
  `patch.attack`, 10fps — the attack slot repurposed; Patch never fights).

Stall & stations (PropSpriteName hooks in `assets.ts`):
- `patch_stall.png` — 96×64 fold-out salvage cabinet (recovered doors, counter front).
- `shop_pedestal.png` — 64×64 stone display pedestal (weapon + blessing pedestals).
- `shop_heart_station.png` — 64×64 heart-glass dispenser.
- `shop_reroll_post.png` — 64×64 salvage-tag signpost (the reroll control).
