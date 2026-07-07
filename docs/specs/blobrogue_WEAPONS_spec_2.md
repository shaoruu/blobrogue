# blobrogue — WEAPONS SET 2 (build-ready)
Read against the CURRENT repo (weapons.ts now has 9 weapons + bounce/homing/chain/chainRange optional fields on Bullet + the `fx` render tag; updateBullets uses isolated per-field branches like steerHoming/bounceOffWall). These 5 new weapons follow the same pattern. REMINDER: every new WeaponId needs an entry in ALL 6 feel tables (SHOOT_SFX/FIRE_TRAUMA/FIRE_RECOIL/FIRE_KICK/FIRE_KNOCKBACK/WEAPON_KB) or it crashes on the Record lookup. Suggested values given per weapon.

Ordered cheapest→most effort.

---
# TIER A — pure data (no engine branch). Ship tonight.

## 1. Flak "Scattergun MkII" / Sawn-off "Boomstick" — point-blank devastation
```
sawnoff: { id:"sawnoff", name:"Boomstick", fireCd:0.62, speed:440, life:0.22,
           damage:2.4, pellets:8, spread:0.85, bulletRadius:5, color:"#ff7a3b", muzzle:8 }
```
Distinct from shotgun: WIDER (0.85), SHORTER range (life 0.22), MORE pellets (8), higher per-pellet dmg. A true room-sweeping close-range cannon — you must get in the enemy's face, huge reward. fx: reuse shotgun recipe. Tables: SFX shootShotgun, TRAUMA 0.6, RECOIL 1.6, KICK 11, KNOCKBACK 26 (big self-shove — feels like a jump-back), WEAPON_KB 10.

## 2. Marksman "Longshot" — the precision railslug (no new pierce code, uses existing pierce)
```
railgun: { id:"railgun", name:"Longshot", fireCd:0.85, speed:1400, life:1.6,
           damage:11, pellets:1, spread:0, bulletRadius:4, color:"#e8f0ff", muzzle:3, /* pierce via item only */ }
```
Feel: near-hitscan (speed 1400), thin, long, brutal single shot — a sniper. The high speed makes it read as an instant line. Pairs with Full Metal (pierce) to become a room-piercing lance. fx: a bright thin recipe (reuse tesla/rapid fx). Tables: SFX shootPistol (or a new crack), TRAUMA 0.4, RECOIL 1.5, KICK 6, KNOCKBACK 6, WEAPON_KB 12.
NOTE: if you want it to ALWAYS pierce (not just with the item), that's a 1-line tweak — stamp a base pierce on its bullets in fire() the way bounce/homing are stamped. I'd ship it item-dependent first (pure data), add innate pierce if it feels weak.

## 3. Scrap "Nailgun" — rapid mid, ricochet flavor (reuses bounce, so still ~data)
```
nailer: { id:"nailer", name:"Nailer", fireCd:0.12, speed:720, life:1.1,
          damage:1.4, pellets:1, spread:0.05, bulletRadius:3, color:"#d9d2c0", muzzle:1, bounce:1 }
```
Fast nails that ricochet ONCE — bouncy full-auto that pings around rooms. Reuses the shipped bounce branch (bounce:1), so zero new code. Distinct from rapid (bounce + heavier) and ricochet (faster, weaker, single bounce). fx: reuse ricochet recipe. Tables: SFX shootRapid, TRAUMA 0.06, RECOIL 0.6, KICK 1.2, KNOCKBACK 0, WEAPON_KB 3.

---
# TIER B — one small, isolated bullet/weapon hook each (same pattern as steerHoming).

## 4. Flamethrower "Dragon's Breath" — short-range cone spray + BURN (pairs with the status system below)
```
flamer: { id:"flamer", name:"Dragon", fireCd:0.045, speed:300, life:0.28,
          damage:0.6, pellets:1, spread:0.30, bulletRadius:7, color:"#ff9436", muzzle:2, burn?:2 }
```
Add optional `burn?: number` to Weapon+ShotSpec+Bullet (stamped like bounce). Mechanic: extremely fast tiny short-lived puffs at wide random spread = a continuous cone of overlapping flame particles. Each particle applies a BURN stack on hit (see STATUS spec). Low per-hit dmg, but melts anything you stand near + DoT.
Hook: (a) in the enemy-hit block, if `b.burn` apply status; (b) render each bullet as a fading flame puff (reuse spawnPuff visuals / a warm fx recipe) rather than a solid dot. ~15 lines + the status apply. fx: new "flame" recipe. Tables: SFX a looped low-gain shootRapid or new fire hiss, TRAUMA 0.03, RECOIL 0.3, KICK 0.4, KNOCKBACK 0, WEAPON_KB 1.
This is the weapon that makes the status system SING — build them together.

## 5. Charge Beam "Blaster" — hold-to-charge, release a big shot
```
charge: { id:"charge", name:"Blaster", fireCd:0.15, speed:820, life:1.2,
          damage:3, pellets:1, spread:0, bulletRadius:6, color:"#7cf6ff", muzzle:3, chargeMax?:1.0 }
```
The one real INPUT change. Add a `chargeT` accumulator on the game (like fireCd). Behavior: while fire held, chargeT ramps 0→chargeMax; on RELEASE, fire one shot whose damage + bulletRadius + speed scale with chargeT (e.g. dmg 3→14, radius 6→14, a min-charge tap still fires). Tapping = weak fast shots; holding = a fat slug.
Hooks: in updateShooting, branch for charge weapons — don't auto-fire on hold; accumulate chargeT, fire on mouseup (or when chargeT hits max). Add a charging visual (growing glow at the muzzle, reuse muzzle particle scaling) + a rising-pitch SFX. ~30-40 lines, isolated to the charge branch. Tables: SFX shootShotgun (or new charge-release), TRAUMA scales 0.1→0.55 with charge, RECOIL 1.4, KICK scales, KNOCKBACK scales, WEAPON_KB 12.
Great skill-expression weapon; the "hold→release" Ian floated. If overnight time is tight, ship #1-4 and do charge next round (it's the only one touching input).

---
## SHIP ORDER (cheapest-impactful first)
1. Boomstick (#1) + Longshot (#2) + Nailer (#3) — pure data / reuse, three more distinct feels tonight (14 weapons total).
2. Flamethrower (#4) — build WITH the status system (below); together they're the tentpole of this batch.
3. Charge Beam (#5) — the input-touching one, highest skill ceiling, do last / next round.

## Deferred weapon ideas + why (so you can say no with confidence)
- BEAM/LASER (persistent held ray): needs a whole non-Bullet hitscan-sweep entity + per-frame line collision. Cooler as its own thing later, NOT a cheap win tonight. The Flamethrower delivers 80% of the "spray a stream" feeling for 20% of the cost — do it instead for now.
- BOOMERANG/returning blade: needs a returnT + owner-tracking arc; doable (~25 lines) but the Nailer/ricochet already scratch the "bouncing projectile" itch. Lower marginal novelty this batch.
- MELEE/chain-whip: melee is a different hit model (arc sweep vs projectile) — worth its own spec if Ian wants a melee identity; I'd pair it with the dodge-roll mechanic. Flagging as a deliberate defer, not an oversight.

---
## PLAYTEST-LOCKED WEAPON / PICKUP CONTRACT (canonical override)
- **Thunderbolt benchmark:** keep damage9/fireCd0.72/speed520/life1.3/radius11. Add `basePierce:2` to Weapon/ShotSpec and resolve Thunderbolt as `pierce = min(4, (w.basePierce??0) + mods.pierce)`; base hits up to 3 enemies, Full Metal can extend it to 5 total hits. Lock hard enemy knockback to WEAPON_KB 18 before kbResist (up from14). Infinite reserve. This is the heavy-ranged benchmark: single clear slug, line pierce, hard shove, long recovery.
- **Charge family direction:** infinite reserve remains universal. Charge weapons use hold→release, tap remains viable, full charge changes damage/size/behavior. Charge is a local rhythm (`chargeT` on player/weapon), never ammo/currency.
- **Duplicate weapon floor pickup:** if `ownedWeapons.includes(id)`, do not collect, switch, equip, play sfx, or remove pickup; leave it physically on floor for teammate. Optional proximity label `OWNED`.
- **Melee discovery:** accounts without `discover:melee` get deterministic melee pickup on floor2, repeated floor3 if missed; Dealer guarantees a melee stock slot until first pickup sets the flag.
Canonical economy/levels/reset details live in `blobrogue_PROGRESSION_spec.md` §10.

---
## WISP + THUNDERBOLT — LOCKED BENCHMARK WEAPONS (blind-identifiable)
Both are infinite-reserve and define the quality bar: behavior must be identifiable with sprite, HUD label, and audio hidden. Distinction comes from movement/constraint/impact, never ammo scarcity.

### WISP benchmark — seeking / forgiving / curved pressure
Keep shipped base: fireCd0.16, speed420, life1.4, damage1.6, spread0.25, radius5, homing turn6rad/s.
- Constraint: acquires nearest living enemy only within260px; turn-rate capped6rad/s, speed constant, cannot U-turn instantly. If target dies/leaves range, continue current trajectory until another valid target enters acquisition; no snap teleport.
- Signature read: wide initial release then visible curved convergence. Cold light radius55 + short comet trail; slight orbit/steer motion before impact. Impact is modest (WEAPON_KB2), emphasizing guidance, not force.
- Strength: consistency/crowd cleanup and status delivery. Tradeoff: low DPS/slow projectile, weak vs isolated high-HP target and walls.
- Blessings interact through normal pellets/status/crit; extra pellets form a seeking fan, not one stacked bullet.
- Blind test: muted/simple-white projectile still identifiable by curved path/acquisition within1s.

### Thunderbolt benchmark — line breaker / commitment / force
Canonical stats/override: damage9, CD0.72, speed520, life1.3, radius11; `basePierce=2`, total pierce `min(4,base+mods)`; WEAPON_KB18 before resistance; heavy player kick/recoil remains. Infinite reserve.
- Constraint: slow cadence and long recovery; one clear slug, no homing/bounce/chain. Missing is costly in time, not ammo.
- Signature read: straight thick hot trail, sequential penetration, every enemy hard-shoved along travel direction. Warm impact flash; no generic explosion.
- Strength: opens a line through packs / creates breathing room. Tradeoff: poor correction/area coverage and lower sustained single-target output when aim misses.
- Blind test: muted/simple-white projectile identifiable by straight fat slug + line penetration + synchronized hard knockback within one shot.

### Universal weapon constraint
No universal ammo reserve/reload layer. Per-weapon local rhythms may include cooldown, charge, cylinder/reload, heat, HP cost, positioning, or recovery. Infinite reserve remains the foundation; never balance Wisp/Thunderbolt through ammo scarcity.
