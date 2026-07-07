# blobrogue — WEAPON FAMILIES: RESONANCE framework + THE HOLLOW + HIGH NOON (build-ready mechanics)
Game-designer mechanics spec off the CD's build brief (theme source: CREATIVE_VISION.md Part 2). Grounded in the REAL code — I verified every hook: combo/comboTimer (Resonance meter source), the burn/chill/shock status system (FRACTURE = a stored variant, same stack/cap/tick pattern), the melee model (MeleeSpec arc/reach/swingDur + StrikeInfo already carries burn/chill/shock — FRACTURE slots in identically), crit/pierce on ShotSpec+Bullet, and weapons already stamping status onto bullets/swings. Build order: RESONANCE → THE HOLLOW → HIGH NOON.

## What already exists (so specs match reality)
- **Combo/kill-chain:** `combo` (count) + `comboTimer` (drains, resets on lapse) + COMBO_TIERS, all per-local-player, NOT networked (game.ts ~L395). This is the Resonance meter's charge source.
- **Status system:** Enemy has burn/burnDmg/chill/shock/statusTick; constants BURN_TICK 0.25, BURN_DMG_STACK 2, BURN_DMG_MAX 6, CHILL_MAX 4; SHOCK_DMG_MULT/FROZEN_DMG_MULT damage amps. Weapons stamp burn?/chill?/shock? onto bullets; the enemy-hit path applies them. FRACTURE = a new field on this exact system.
- **Weapons:** Weapon has optional melee?:MeleeSpec {arc,reach,swingDur,isThrust?}; melee weapons (sword/longsword/spear) go through startMeleeSwing→strikeEnemy(StrikeInfo). Bullets carry pierce/bounce/homing/chain/burn/chill/shock/fx. resolveShot folds in all mods. So new weapons = data + reuse.
- **Crit:** critChance/critMult on mods→ShotSpec/StrikeInfo; isCrit already drives brighter feedback + damage mult.
- **Presentation pipeline:** boss overlays + fxTinted masks + scene tinting already exist. Resonance reuses this pipeline, but each family supplies an authored presentation recipe; the universal system does not force one generic overlay.

===============================================================
# PART 1 — THE RESONANCE FRAMEWORK (build ONCE, every family rides it)
===============================================================
Generic system; the ONLY per-family code is a payload. Rides stepWorld (per-player, authoritative-server-ready).

## State (on PlayerSim — plain data, so it's server-ready)
```
resonanceMeter: number;   // 0..1
resonanceActive: number;  // seconds of active resonance left (0 = inactive)
resonanceCd: number;      // cooldown after a resonance ends (0 = ready to charge)
resonanceFamily: FamilyId | null; // which family's payload is active / which the equipped weapon belongs to
```
## Charge (off the EXISTING combo, no new source)
- Fill on clean kills: on killEnemy, `resonanceMeter = min(1, resonanceMeter + RESONANCE_FILL_PER_KILL * comboMult())` — scaling by the combo tier means chaining fills faster (rewards the aggression the combo already tracks). Tune RESONANCE_FILL_PER_KILL so a clean ~12-15 kill room ≈ one full meter.
- Drain on damage: on damagePlayer, `resonanceMeter = max(0, resonanceMeter - RESONANCE_DRAIN_ON_HIT)` (e.g. 0.25 — a chunk, not a full reset; taking 4 hits from empty-of-progress wipes it). This is the "punishes turtling/mistakes" knob.
- No charge while resonanceActive>0 or resonanceCd>0.
## Activation
- Dedicated input (e.g. `Q` / a gamepad button), gated on `resonanceMeter>=1 && resonanceActive===0 && resonanceCd===0`. NOT auto. Bind in the input layer; the InputCmd (post-Stage-A) gains a `resonance: boolean` edge flag so it's server-authoritative.
- On activate: set `resonanceActive = RESONANCE_DURATION` (~4s), `resonanceMeter = 0`, `resonanceFamily = equipped weapon's family`. Emit a `resonanceStart` SimEvent {family, presentationId} → client runs that family’s authored presentation + dilation/shake.
## The per-tick active loop (in stepWorld)
```
if (resonanceActive > 0) {
  resonanceActive -= dt;
  RESONANCE_PAYLOAD[resonanceFamily](world, player, dt);   // <-- the ONLY per-family code
  if (resonanceActive <= 0) { resonanceCd = RESONANCE_COOLDOWN; emit resonanceEnd; }
}
```
## Client presentation (event-driven, reuses shipped tech)
- `resonanceStart` → run the family’s authored `presentationId` recipe (scene tint/desaturation/environment drain and optional fxTinted masks), then kick time-dilation (~0.6x visual easing for ~0.3s) + shake. In server co-op, dilation is LOCAL-VISUAL only; the authoritative sim remains normal speed.
- Resonance meter HUD: one cracked-amber tuning-shard/bar by the combo counter; glows at full with `RESONANCE READY` (no family-specific meter or ring).
## New hooks needed: (1) the resonance input edge + InputCmd.resonance flag, (2) the FamilyId tag on each Weapon (so equipping sets resonanceFamily + presentation/payload), (3) RESONANCE_PAYLOAD registry. Everything else reuses combo, killEnemy, damagePlayer, fxTinted, addTrauma. NO new architecture — this is the point.

## FamilyId + weapon tagging
Add `family?: FamilyId` to Weapon (FamilyId = "hollow"|"highnoon"|... ; undefined = the default pistol/basic guns, no resonance). Equipping a family weapon sets which resonance is armed. A run can carry weapons from multiple families; the armed resonance = the currently-held weapon's family (matches "your resonance is the weapon in your hand").

===============================================================
# PART 2 — THE HOLLOW (flagship)
===============================================================
## NEW STATUS — FRACTURE (stored-value material stress on the existing status system)
Add to Enemy: `fracture: number` (stored damage banked, NOT time). Add to Weapon/ShotSpec/Bullet/StrikeInfo: `fracture?: number` (damage banked per application) — stamped exactly like burn?.
- **Apply:** on a hit carrying `fracture`, `e.fracture += fractureAmount` (cap `FRACTURE_MAX`, e.g. 24 stored). Does NOT tick on its own (unlike burn — skip it in the statusTick loop).
- **Snap — two triggers, one consistent death-splash rule:**
  1. On RE-HIT: capture `snapped = e.fracture`, clear the bank, apply the FULL `snapped` damage, then apply the incoming hit + any new Fracture. So the loop is: stack with cone/splinters, then a big hit snaps it.
  2. On DEATH: splash **50% of the bank that caused/preceded the death** to enemies within ~60px. If a re-hit snap caused the death, splash `snapped * 0.5` (preserve `snapped` through the death check even though `e.fracture` was cleared). If the enemy died from another source while still banked, splash `e.fracture * 0.5`. Then clear it. Emit exactly ONE black-resin snap VFX/splash — never double-trigger.
This ordering is mechanically important: the locked contract says death splashes 50%, including when the full re-hit snap is what kills the target.
- **Numbers (LOCKED, CD):** FRACTURE_MAX 24 flat — keep it simple, do NOT scale for bosses (against a boss the answer is raw weapon damage + The Light Goes Out, not a bigger cap). Ruinbreath hitting the cap in ~0.5s of hosing IS the intended "brief hose → big detonate" rhythm — that's a feature, not a nerf target. Per-application values set per weapon below; FRACTURE_DEATH_SPLASH 0.5; detonation = min(banked, FRACTURE_MAX); re-hit detonates FULLY (not partial — bigger numbers + cleaner feel, the cap balances it). Damage amps (shock/frozen) do NOT double-dip on detonation (it's already-stored raw).
- **VFX (AD):** black-resin seams crawl across the enemy sprite with 2–3 dying-amber splinters under tension; detonation snaps those seams and ejects unequal resin shards along the stored stress direction. Use tintable seam/shard masks; no halo or radial burst. 
- **Determinism:** all additive/deterministic (no RNG) → server-safe + golden-master-clean.

## HOLLOW LOW-HP BONUS (CD addition — the "death half" of the fantasy)
The Hollow is "stronger the more you've KILLED **and** the closer to DEATH you dance." Rift-scaling captures the kill half; this captures the death half.
- **Rule:** while the player is at/below `HOLLOW_LOWHP_THRESHOLD` (1/3 max HP), all `family:"hollow"` hits deal `HOLLOW_LOWHP_MULT` more damage. Start conservative: **+20% under 33% HP** (HOLLOW_LOWHP_MULT 1.2), let QA push it.
- **Why it's load-bearing:** it turns Bleakseed's self-bleed into a real CHOICE — bleed yourself toward the edge to hit harder — which is the revenant fantasy in one mechanic. Without it the Hollow is just "a black status effect"; with it, it feels *fractured*.
- **Implementation (nearly free — reuses an existing pattern):** the code ALREADY has a low-HP damage scaler — `berserk` in PlayerMods + `lowHpFactor()` + `currentDamageMult()` (game.ts): `damageMult + berserk * lowHpFactor()`. Mirror that: gate a flat +mult on Hollow-family hits when `hp/maxHp <= 1/3`. Apply it in the damage resolve path (resolveShot / strikeEnemy) ONLY for hollow-family weapons (check the equipped weapon's family). Plain-data, deterministic, server-safe. 
- **Scope note (CD):** if it bloats the Hollow build, DEFER it — but it's cheap (one gated mult reusing lowHpFactor) and it's the piece that makes The Hollow feel dangerous, so build it with the family if you can.

## The 4 Hollow weapons (family:"hollow"; blob eyes go hollow while equipped — a client sprite/tint swap)
1. **WIDOWBITE** (melee — extends the longsword MeleeSpec). Stats ~ longsword (heavy, slow): damage 6, melee {arc 1.1, reach 56, swingDur 0.22}. HOOK — **slash-rift:** each swing spawns a lingering rift decal along the arc that re-damages enemies in it for 0.4s after the swing (reuse a decal + a short-life melee hitbox re-checked each tick during the 0.4s). Applies `fracture: 4` per hit. OPTIONAL (nice): rift reach/duration scales with run kill-count (e.g. +0.02s per 10 kills, capped) — "the hollow grows." New-ish hook: a timed lingering-hitbox (small; reuse MeleeSwing's hitList pattern with an extended timer). SFX meleeHit, dark.
2. **BLEAKSEED** (homing — reuses the Wisp homing hook). Stats: fireCd 0.2, 3 shards/burst, damage 1.6, homing 6, fracture: 3, tint #c77320 (dying amber over soot-black sprite/VFX). HOOK — **the risk knob:** tracks `bleakseedBursts`; every third burst attempts to cost exactly 1 HP, and a kill by a Bleakseed splinter refunds exactly 1 HP (capped at maxHp). LOCKED (CD): cost 1 HP per 3 bursts, refund 1 HP per kill — net positive if you're landing kills, bleeding if you're missing. **HARD FLOOR (CD, firm): Bleakseed can NEVER take your last HP — at hp===1 it fires FREE (skip the cost).** So it drains you toward the edge but can never suicide you; removes the only feel-bad (dying to your own gun) while keeping the dance-on-the-edge fantasy. New hook: weapon-fire HP cost (gated `if (player.hp > 1) hp -= cost`) + on-kill-by-this-weapon refund (small addition to the fire + killEnemy paths; tag bullets with their weapon/family for refund attribution).
3. **RUINBREATH** (channeled cone — reuses the flamethrower model). Stats ~ flamer: fireCd 0.045, wide short puffs, damage 0.6, fracture: 2 per puff (NOT burn — swap the stamped status). It's the FRACTURE STACKER: hose an enemy to pile fracture fast, then detonate with Widowbite/Black Lantern. Reuse flamethrower cone verbatim, swap burn→fracture, black-resin flakes / dying-amber seams.
4. **BLACK LANTERN** (charge — reuses the charge weapon + on-hit spawn). Stats: charge 0→1.0s, release a heavy black-resin heart (damage 3→12 by charge, fracture 6, radius scales). HOOK — **split:** on impact, spawn 3-5 homing splinters (reuse Bleakseed's homing bullets) that seek nearby enemies and each apply fracture 3. Reuses charge + the on-impact bullet-spawn pattern (by spawning homing bullets). SFX falling amber hum → brittle resin crack.

## THE RESONANCE — "THE LIGHT GOES OUT" (polish hardest — the trailer clip)
- **Authoritative payload (~4s, mechanics unchanged):** every living enemy in the player’s active combat interest builds `fracture += RESONANCE_FRACTURE_PER_TICK`; EVERY friendly hit during the window guarantees a FULL snap-detonation before applying the new hit. Net: Ruinbreath/Widowbite/Black Lantern chain-snap the room. Slight time-slow is client presentation only in server co-op.
- **Canonical presentation (locked): the EXISTING environment loses warmth — no transported arena, “domain,” shrine, rune, or magic-ring language.** Warm light gutters inward from the hero; room/floor/wall colors desaturate toward soot-black and cold blue; black-resin fracture planes propagate along existing tile seams; a few authored dead-amber slabs intrude from edges. The hero remains readable through scarce surviving amber warmth, not a clean circular pocket.
- Palette: soot black, desaturated cold blue, dead-resin brown, scarce dying amber (#c77320). Optional faint violet only inside stress-crack cores for damage readability — violet is not the identity.
- Audio: room ambience low-passes; weapon sounds dry out; one amber glass-hum falls in pitch; snap-detonations answer with brittle resin cracks.
- Emit `resonanceStart{family:"hollow"}`; client drives the environmental drain while stepWorld owns the payload.
- Balance: earned by a full clean-kill meter; auto-Fracture + guaranteed snap makes it a room-delete only if the player keeps landing hits. This remains the flagship trailer clip.
===============================================================
# PART 3 — HIGH NOON (second — cheap, mostly reskins + 2 hooks)
===============================================================
The blob's earned home style; the honest opposite of the Hollow. Warm, rhythmic, precision.

## SIGNATURE MECHANIC — THE CYLINDER
High Noon guns carry a small ammo cylinder that counts DOWN per shot; the last round is the gold "Deadeye" (guaranteed crit + pierce); then a short reload beat.
- State (on PlayerSim or per-weapon-instance): `cylinder: number` (rounds left), plus `reloadTimer: number`.
- Add to Weapon: `cylinderSize?: number` + `reloadTime?: number` (present = High Noon cylinder behavior).
- Firing: each shot decrements cylinder. When `cylinder === 1` the NEXT shot is the DEADEYE: force `isCrit = true` + `pierce = max(pierce, DEADEYE_PIERCE)` (e.g. 3) + gold bullet color. After it fires, cylinder = 0 → enter reload: `reloadTimer = reloadTime`, can't fire until it elapses (auto-reload — simpler + better feel than a manual reload input for a twin-stick; you survive the beat by dodging). On reload complete, cylinder = cylinderSize.
- This reuses the existing crit + pierce fields entirely — the Deadeye is just a forced crit+pierce shot. Only NEW state is the cylinder counter + reload timer + the "is this the last round" check in the fire path.
- HUD: show the cylinder (N pips, the last one gold) by the weapon name; a reload sweep during the beat.

## SIGNATURE TECHNIQUE — DUEL
Stand still ~0.6s → the gun enters "aim" (a thin sightline appears, reusing the ENEMY aim-line telegraph tech, drawn player-side) → the next shot is a heavy crit (e.g. damage x2.5).
- State: `stillTimer: number` (accumulates while the player's move input ≈ 0 AND not dashing), `dueled: boolean`.
- When `stillTimer >= DUEL_CHARGE` (0.6s): set `dueled = true`, show the sightline (a `duelReady` SimEvent → client draws the aim-line from player along aimAngle). The next shot consumes `dueled`: force isCrit + a DUEL_MULT (2.5) damage bump, then reset. Moving resets stillTimer to 0 (and hides the sightline). 
- Rewards using the stationary recover windows enemies telegraph (ties beautifully to the boss/enemy telegraph fights — you duel during their recover). Reuses the aim-line render (already built for enemies) player-side; new state is just the still-timer.

## The 4 High Noon weapons (family:"highnoon"; warm/brass VFX)
1. **AMBER PEACEMAKER** (revolver — cannon/railgun stats). damage 8, fireCd 0.5, speed 900, accurate (spread 0). cylinderSize 6, reloadTime 1.1s. 6th round = gold Deadeye (crit+pierce 3). The precision backbone. SFX heavy revolver crack.
2. **FAN-THE-HAMMER** (rapid/burst). Dumps the cylinder FAST: fireCd 0.09, damage 2, cylinderSize 6, reloadTime 1.4s (a longer, real reload beat you must survive after fanning). No Deadeye (or a weak one) — it trades the precision payoff for burst. SFX fast fanning cracks.
3. **RICOCHET IRON** (the shipped ricochet "Rebound", reskinned). Stats ~ ricochet: bounce 2, damage 2.4, cylinderSize 6, reloadTime 1.0s. HOOK — **ricochet refund:** a kill by a bullet that has already bounced ≥1 refunds a round to the cylinder (skill flex: trick-shots keep you loaded). Small addition: tag bullets with bounceCount; on killEnemy by a bounced bullet, `cylinder = min(cylinderSize, cylinder+1)`. SFX ricochet ping.
4. **COACH GUN** (the shipped Boomstick sawn-off, reskinned). Stats ~ sawnoff: 8 pellets, wide, short range, big knockback. cylinderSize 2 (double-barrel!), reloadTime 0.9s. The get-off-me. SFX double-barrel boom.

## THE RESONANCE — "HIGH NOON" (cheap + iconic)
- Overlay: full-screen SEPIA desaturation mask (fxTinted, warm brown — dead cheap, instantly reads as a western).
- Payload: (a) time nearly stops (client-visual dilation, strong — near-freeze); (b) an auto-paint pass marks every enemy on screen with a reticle (a `duelPaint` SimEvent listing enemy ids → client draws reticles); (c) on the duration's release (or auto after the paint), the blob fires one guaranteed-crit shot at each painted enemy in sequence, bang-bang-bang (server applies the damage sequence authoritatively; client plays the rapid crack + reticle pops). 
- Simplest authoritative implementation: on activate, snapshot the painted enemy list; over the ~2-3s payload, resolve one crit hit per enemy on a fast timer (e.g. every 0.08s), each a guaranteed crit (reuse the crit path) — reads as the RDR deadeye volley. 
- Feel: sepia, a single held harmonica note, hammer click, spur jingle; the world holds its breath then the volley. 

===============================================================
# NEW HOOKS NEEDED (the honest "what's genuinely new" list)
===============================================================
Almost everything reuses shipped systems. Genuinely new, small hooks:
1. **Resonance framework:** the meter/charge/drain (off combo), the resonance input edge (+ InputCmd.resonance), the payload registry, the environmental presentation compositing (reuses fxTinted), the FamilyId weapon tag. ONE system, ~a few hundred lines, shared by all future families.
2. **FRACTURE status:** one new field (fracture) on the status system + the two-trigger detonation in the hit + killEnemy paths. Mirrors burn. **+ Hollow low-HP bonus:** a gated damage mult on Hollow-family hits under 1/3 HP — reuses the existing lowHpFactor()/berserk pattern, near-free.
3. **Bleakseed HP-cost/refund:** weapon-fire HP cost + on-kill-by-weapon refund (tag bullets with family for attribution).
4. **Slash-rift (Widowbite):** a lingering timed melee hitbox (reuses MeleeSwing hitList + an extended timer).
5. **Black Lantern split:** spawn homing bullets on charge-slug impact (reuses charge + bullet-spawn).
6. **Cylinder + reload:** a per-weapon ammo counter + reload timer + last-round Deadeye (reuses crit/pierce).
7. **Duel:** a still-timer + a forced-crit next shot + the player-side aim-line (reuses the enemy aim-line render).
Everything else — homing, charge, bounce, pierce, melee arcs, flamethrower cone, status apply, crit, decals, gibs, tinted overlays — is ALREADY SHIPPED. Flag: none of these need new engine architecture; they're fields + handlers on existing systems, and all are plain-data/deterministic so they ride stepWorld (server-auth-ready).

## Server/co-op note (post-Stage-A)
All new state (resonanceMeter/resonanceActive, fracture, cylinder, stillTimer) lives on PlayerSim/Enemy plain data → server-authoritative for free once the authoritative server lands. The ONLY client-visual-only pieces are the time-dilation and the environment-drain/reticle rendering (a resonance slows YOUR view, not the shared sim — layer it locally over a normal-speed authoritative world; flag for Stage C tuning). FRACTURE/cylinder/duel are pure sim → identical in solo + co-op.

## BUILD ORDER (matches the brief)
1. **RESONANCE framework** (generic; test with a trivial placeholder payload). 
2. **THE HOLLOW:** FRACTURE status → the 4 weapons (Ruinbreath + Widowbite first, they're the fracture-stack + detonate core loop) → The Light Goes Out payload. Polish The Light Goes Out hardest (trailer clip).
3. **HIGH NOON:** cylinder + duel hooks → the 4 weapons (mostly reskins) → the sepia resonance. Cheap, on-brand, ships fast.
Every family after these is: FamilyId tag + weapon data + (maybe) one new status/hook + a resonance payload. The framework is what makes them cheap — exactly the CD's intent.
