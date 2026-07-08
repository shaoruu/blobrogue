# blobrogue — DESTRUCTIBLE PROPS SPEC (build-ready)
Grounded in real code (Bullet collision loop, spawnParticles/spawnPuff/spawnSparks, Pickup spawning, killEnemy AoE patterns, ENEMY_ARCHETYPES). Props = cheap interactivity + juice that reuses combat systems.

## The Prop struct (new, lightweight — mirrors Enemy's collision shape)
```
type PropKind = "crate" | "barrel" | "pot" | "brazier";
interface Prop { kind:PropKind; x:number; y:number; radius:number; hp:number; dead:boolean; anim:Anim; }
```
Add `props: Prop[]` on the game; populate per floor in loadFloor() via seeded Rng (place 2-5 per room, avoid spawn/exit centers). Render like a static sprite with the existing bob/flash anim.

## Damage integration (reuses the bullet loop)
In updateBullets / the friendly-bullet collision (game.ts ~line 719), after the enemy loop add a prop loop:
- friendly bullet vs prop: if within radius → prop.hp -= b.damage, triggerFlash(prop.anim), spawnPuff, consume bullet (unless pierce). On hp<=0 → destroyProp(prop).
- Player can also break props by DASHING through (optional, feels great) — check in the dash move step.
Props are also destructible by ENEMY fire and explosions (barrels chain!) — see barrel below.

## Per-prop behavior
### CRATE (wood) — the loot pinata
hp 4. destroyProp → spawn gib particles (kind "gib") + 60% a coin, 15% a heart (reuse makePickup). The "break everything" dopamine. Cheap, satisfying, teaches players props are interactive.

### POT (clay) — fast, chaff loot
hp 1 (pops in one hit). Spawns a puff + often nothing / a coin. Ubiquitous, breakable while running through a fight — pure tactile juice (Zelda pots). Great for filling rooms cheaply.

### BARREL (explosive) — the tactical one
hp 3. destroyProp → EXPLOSION: reuse the boss hop-slam shockwave pattern — deal damage (e.g. 6) to ALL enemies AND props within radius ~70 (chain-detonates other barrels!), big trauma/freeze, orange gib + spark burst, sfx crunch. 
- Enemies can be LURED next to barrels and popped — real tactics, and it makes the environment a weapon. 
- Also damages the PLAYER if within radius (respect i-frames) — risk/reward. 
- This reuses the existing AoE-damage + knockback helpers already written for the boss/thorns. ~20 lines.

### BRAZIER / TORCH (already half-exists!) — light + minor hazard
placeTorches() already mounts wall torches. Extend to free-standing braziers:
- Non-destructible (or hp high). Emits a light glow (render) + optional: standing in the flame or shooting through it does nothing by default; ADVANCED (skip v1): a knocked/exploded brazier spreads a brief fire patch (hazard tile). For v1 keep braziers as ATMOSPHERE + a destructible that scatters sparks. The lighting sells the biome mood (ties to MAP biome reskin).

## Co-op determinism
Prop placement uses seeded Rng (same `(seed ^ const) + floor*prime` pattern) so all clients share prop layout. Prop DESTRUCTION is driven by bullets/explosions which already resolve per-client on shared floor state — same model as enemies. Flag: if prop-break loot must match across clients, spawn loot deterministically (seed the drop roll by prop index), else treat like the existing local particle juice.

## Synergy hooks (why this is more than decoration)
- Explosive barrels + the new Tesla/cannon weapons = satisfying chain clears.
- Barrels next to a treasure room = risk (might destroy... nothing, they don't hurt chests) — or use a barrel to blow open a SECRET cracked wall (ties to MAP Layer 4).
- Props give the "interactable world" feeling Ian wants for cheap, and every break reuses the juice pipeline (flash/gib/puff/freeze/trauma) already built.

## Build order
1. Crate + Pot (loot pinatas, one-hit juice) — trivial, immediate interactivity.
2. Barrel (explosive, reuses AoE) — the tactical highlight.
3. Brazier lighting polish + (later) secret-wall integration.

---
## CANONICAL FUTURE PROP ADDITIONS (design only; after authoritative Stage C)
### GAS TANK — toxic fog / shared environmental risk
Distinct from explosive barrel; no fifth poison status (coherence budget remains burn/chill/shock/Fracture).
- hp3, radius15, clearly corroded tank + hissing valve silhouette. On destruction: **rupture**, not immediate explosion.
- Tell: 0.45s directional hiss + narrow green-grey jet from damaged valve, then fog expands to radius105 over0.6s. Fog persists5.0s, thins final1.0s. Boundary reads through layered material wisps/ground pooling, never a clean circle.
- After expansion grace, each player/enemy inside takes **1 damage per 1.0s exposure tick**. Same authoritative source damages mobs AND players; respects post-hit i-frames; trivial summons do not create rewards from gas kills. No allegiance immunity.
- Counter/use: leave the cloud, shoot tank near mobs, or ignite it. Fire/explosion hitting active fog consumes remaining cloud and triggers ONE radius115 burst for4 damage to enemies +1 to players, with strong tell/flash; cannot chain repeatedly. This is environmental combo, not a new status.
- Fog blocks/softens sight for visuals but never hides telegraphs/objectives; smart AI may route around/prefer fog only with an authored trait.

### Explosive barrel — locked shared damage
Explosive barrel damage is authoritative and affects enemies, props, AND players. No “friendly explosion” immunity. Locked behavior: radius~70, enemy/prop6 damage, player1 (respect i-frames), chain detonates other explosive barrels once. Player can deliberately weaponize it but accepts risk.

### Melee future purpose (design only)
Props/chests interaction is shipped. Future combat utility, after server sync:
- Wide melee arcs can clear/destroy hostile projectiles tagged `clearable` (never boss signature/unclear projectiles); each weapon has an authored clear arc/cooldown.
- Front-armored enemies block/reduce frontal bullets; melee side/back hits or heavy committed melee breaks/staggers armor. Tell through shield/material orientation, not hidden resistance.
- Melee excels at crowd control/space (arc stagger, shove, prop/environment interaction), not universal higher DPS.
These are shared sim rules, not client-only hit effects; do not build before Stage C.
