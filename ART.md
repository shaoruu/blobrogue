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

**Bestiary-wave hooks (registered, awaiting generated art — the tinted-disc fallback
carries each identity color until the base PNGs land, and the ladder holds every body on
its best available tier).** Generate via the locked FAL flux/dev → birefnet → pixelize
pipeline (`tools/gen-sprites.mjs`) and drop the cutouts on these exact stems:
- Base 64×64 PNGs: `rootward.png`, `echojack.png`, `seamcutter.png`, `caskbellows.png`,
  `sinderling.png`, `fragment.png`, `echo.png`, `knell.png`, `marshal.png`, `toll.png`.
- Directional walk + attack sets (`<stem>_walk_{down,up,side}.png` +
  `<stem>_attack_{down,up,side}.png`) for **echojack, seamcutter, caskbellows,
  sinderling, marshal**.
- **rootward** — walk triplet only (`rootward_walk_{down,up,side}.png`): a walking wall
  has no attack strip; its guard arc is a code overlay off the authoritative angle.
- Drifting masses (the Choir's contract — idle loop + omni attack, no walk triplet):
  `fragment_idle.png` + `fragment_attack.png`, `toll_idle.png` + `toll_attack.png`.
- Decoys (idle loop only): `echo_idle.png`, `knell_idle.png`.
- The LEGACY roster's directional sets are also pre-registered off their own stems
  (`slime`, `bat`, `skeleton`, `ghost`, `spitter` — walk triplets; skeleton/spitter also
  directional attacks). Their current single-strip walks stay registered and keep
  playing until the new sheets actually load — approved directional finals become pure
  file drops with zero code changes, and today's look is preserved byte-for-byte.
- Sim-side visual state the art can key on: `EnemyWire.aux` carries the sinderling's
  armed flag (stoked glow), the echo/knell fuse (fade / blink-out), the fragment's
  tether source (the line render), and a bulwark elite's plate HP.

**Effect-wave hooks wired, art pending (generation owner: main agent / FAL pipeline —
this branch ships NO binary art).** Exact drop-in filenames, all pre-registered in
`src/game/assets.ts`; until each file lands it 404s visibly in dev and the game falls
back to the same safe non-shipping placeholders every unregistered weapon uses (generic
`gun` pickup sprite, held-weapon fallback, primitive-drawn effects):
- Weapon pairs (`weapon_<id>.png` pickup + `held_<id>.png` held, 64px/40px as above) for
  **lastlight, breach, snapwire, frostline, halo, sentry, crook**.
- Effect masks under `public/sprites/fx/` — pure white, alpha-carried shape, code-tinted:
  `frost_zone.png` (painted chill disc), `wire_post.png` (snapwire anchor),
  `halo_blade.png` (orbit blade, authored pointing +Y), `sentry_core.png` (turret body),
  `chain_link.png` (tether link). Each renderer keeps a readable primitive fallback
  (circles/lines/diamonds) until its mask lands — dev is never blind, production never
  blocks on art.


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

## Ecology-wave worker hooks (constructions + the mason)

The topology workers raise real destructible props; each prop kind ships as a 64px
horizontal sheet, frame 0 = intact, frames 1-2 = breaking (the crate contract):

- `/sprites/root_wall_break.png` — the Forkroot Bailiff's woven root-wall segment
  (mossy green, living bark; tint `#86c06c` carries the fallback block until it lands).
- `/sprites/silt_mound_break.png` — the Silt Keel's plowed berm mound (wet grey-brown
  silt ridge; tint `#b8a888`).
- `/sprites/clinker_brick_break.png` — the Clinker Mason's ember-brick stack (dark
  clinker with glowing mortar seams; tint `#c9743f`).

New body: `mason` (`/sprites/mason.png` + the full directional walk/attack set —
`mason_walk_*` / `mason_attack_*`, where the attack sheets are the RAISE: trowel hands
up, bricks rising). The bailiff (`rootward`) now also declares directional ATTACK hooks
(`rootward_attack_*` = the divider raise, arms up, roots surging). FAL recipes for both
live in `tools/gen-sprites.mjs`; the missing-asset ladder (tinted block/disc fallback)
covers every hook until approved art lands.

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
