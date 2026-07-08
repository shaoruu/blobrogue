# blobrogue — POST-SERVER REAL LIGHTING + DARKNESS GRAMMAR (design-only)
**Gate:** no implementation before authoritative multiplayer Stage A→B→C is production-green. This is a World-system extension, not a client-only filter. Server owns gameplay-relevant light state; client owns authored rendering. Hue lanes remain supportive but are superseded as the sole biome-depth mechanism.

## 1. Two-layer lighting contract
### Authoritative gameplay layer (server / stepWorld)
A coarse deterministic light field (tile/chunk grid, 0..1) derived from server-owned sources. It answers only gameplay questions (`lightAt(x,y)` / `isDark`) and is identical in solo LocalTransport + dedicated server.
- Static sources: torches/braziers/camp lamps/biome fixtures.
- Dynamic sources: hero amber glow, projectiles, fire/status, explosions, bosses, authored hazards.
- Sources have plain data `{id,x,y,radius,intensity,falloff,life,kind,owner}`. Recompute dirty local cells only; do not raycast every pixel/server tick.
- Occlusion is coarse tile LOS / room connectivity (walls block or strongly attenuate). Server never renders shadows.

### Client presentation layer
Canvas offscreen darkness/light composite with authored radial/cone/textured masks, wall occlusion, bloom, color, and transient flashes. Interpolate light-source movement from snapshots. Client visuals may be richer than server grid but cannot change gameplay state.

## 2. Readability floor (non-negotiable)
Darkness may obscure environment detail, NEVER essential information:
- Local player silhouette/face, crosshair, HUD, objective text, stairs/gates, interact prompts stay readable at all light levels.
- Enemy committed telegraphs, locked destinations, boss HP, damaging projectiles/hazards have a minimum contrast/luminance treatment independent of ambient darkness.
- Hostile body may fade in deep dark, but collision footprint / attack tell cannot disappear. No unavoidable contact from invisible mobs.
- Accessibility slider raises ambient floor/telegraph contrast without changing authoritative AI behavior.

## 3. Authored light sources (benchmark values for design)
- **Hero amber glow:** radius ~110px, low steady intensity; identity/readability, not a flashlight. Never fully off.
- **Torch/brazier:** radius 170–220px, warm stable core + subtle flicker presentation; static authoritative intensity (flicker visual only, avoids AI thrash).
- **Normal projectile:** radius 25–50px, brief trail; no major AI effect unless weapon explicitly tagged `reveals`/elemental.
- **Wisp projectile:** radius 55px cold glow following its curved path; makes seeking behavior readable blind.
- **Thunderbolt slug:** radius 70px hot flash/trail; wall/enemy impact flash radius100 for ~0.12s. Identifies heavy line through darkness.
- **Explosion:** radius180–240px, full pulse ≤0.18s then fast falloff; gameplay exposure may last0.35s if design tags it.
- **Boss/signature:** authored, capped so repeated flashes don’t wash out tells.

## 4. Darkness changes pressure / mob context, not raw stats
Universal AI may query coarse light context at low frequency (4–6Hz), never pixels/input.
- Darkness does NOT grant blanket HP/damage/speed bonuses.
- It changes movement/decision confidence through authored traits: prefers dark approach lane, retreats from light, hunts revealed targets, anchors near/away from fixtures, or becomes targetable only after a visible tell.
- Every dark behavior has counterplay: carry/activate light, ignite fixture, shoot glowing projectile, lure into lit ground, or read material tell.
- AI transition hysteresis: enter-dark threshold ≤0.30, exit-dark ≥0.42 (example) + min state duration0.5s, so torch edges don’t cause jitter.
- Players are always detectable inside their hero glow; no binary stealth system in v1. Darkness alters approach/pressure, not "enemy loses aggro forever."

## 5. Biome light grammar
**Verdant Hollow — filtered life:** dappled green daylight / warm sap and campfire pockets. Broad soft pools, leaf occlusion, low contrast danger. Darkness teaches safely; flock mobs silhouette against openings.

**Sunless Caves — sparse sound beacons:** warm torches against cold shale; long dark gaps. Falling dust/hearing flares/material seams remain readable. Eyeless creatures use vibration/sound context, not sight cheating. Player can relight/activate fixtures later.

**The Deep — swallowed warmth:** cold mineral seams and dead-amber glints; light breaks along fracture geometry. Sources feel thin/directional; The Hollow Resonance visibly drains remaining warmth from EXISTING light sources. Wrong geometry, not purple darkness alone.

**Emberreach — pressure pulses:** vents/lava/embers are strong localized sources that brighten before pressure events and cool afterward. Safe-space information comes from vent glow/heat seams. Frequent warm sources offset heavier ambient shadow.

**Amber Camp — home:** warm layered pools radiating from the Amber Heart + inhabited stations. Camp growth physically increases lit area/detail. No combat-readability tax at home.

## 6. Darkness encounter rules
- Room has authored ambient floor + fixture set; no random "pitch-black" roll.
- At least one readable route/anchor in every combat room; no objective or exit isolated in unreadable dark.
- Max one darkness-dependent complex archetype in a small room until readability passes testing.
- Arena overlap scheduler treats full-room blackout/reveal as arena-wide denial; max one and preserves telegraphs.

## 7. Data / integration shape (future)
- Add `LightSource` plain data + `LightTrait` on archetype/weapon/effect definitions.
- Server World owns static fixture state + dynamic gameplay sources; interest snapshots send nearby sources only.
- Client `LightingRenderer` consumes sources + biome grammar, independent of sim.
- SimEvents create transient presentation sources (`shotLight`, `impactLight`, `explosionLight`); authoritative tagged exposure source exists only where AI/gameplay needs duration.
- Do not bake lighting behavior into each mob. Movement modules receive `lightAt` context; each archetype declares one light preference/response max.

## 8. Acceptance
- Grayscale/low-brightness playtest: player, objective, exit, attack locks, hazards recognizable in every biome.
- 100 seeded rooms: no damaging commitment begins/lands without ≥locked telegraph visibility target.
- Wisp/Thunderbolt identifiable from light trail + motion/impact alone with sprites/audio hidden.
- AI does not state-flap at source boundaries; deterministic same seed/input.
- Lighting client stays within render budget at target dynamic-source count; server light-grid update within tick budget.

## Bottom line
Real lighting is a post-server world system: server owns a cheap deterministic exposure field, client renders rich authored light. Darkness changes routes and mob decisions, never hides required tells or adds blanket stats. Each biome gets a distinct light ecology; Wisp and Thunderbolt become benchmark light/motion weapons. No code before A/B/C.
