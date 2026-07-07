# blobrogue — WEAPON SCHOOLS: RITE framework + THE GRUDGE + HIGH NOON (build-ready mechanics)
Game-designer mechanics spec off the CD's build brief (theme source: CREATIVE_VISION.md Part 2). Grounded in the REAL code — I verified every hook: combo/comboTimer (Rite meter source), the burn/chill/shock status system (CURSE = a stored variant, same stack/cap/tick pattern), the melee model (MeleeSpec arc/reach/swingDur + StrikeInfo already carries burn/chill/shock — CURSE slots in identically), crit/pierce on ShotSpec+Bullet, and weapons already stamping status onto bullets/swings. Build order: RITE → GRUDGE → HIGH NOON.

## What already exists (so specs match reality)
- **Combo/kill-chain:** `combo` (count) + `comboTimer` (drains, resets on lapse) + COMBO_TIERS, all per-local-player, NOT networked (game.ts ~L395). This is the Rite meter's charge source.
- **Status system:** Enemy has burn/burnDmg/chill/shock/statusTick; constants BURN_TICK 0.25, BURN_DMG_STACK 2, BURN_DMG_MAX 6, CHILL_MAX 4; SHOCK_DMG_MULT/FROZEN_DMG_MULT damage amps. Weapons stamp burn?/chill?/shock? onto bullets; the enemy-hit path applies them. CURSE = a new field on this exact system.
- **Weapons:** Weapon has optional melee?:MeleeSpec {arc,reach,swingDur,isThrust?}; melee weapons (sword/longsword/spear) go through startMeleeSwing→strikeEnemy(StrikeInfo). Bullets carry pierce/bounce/homing/chain/burn/chill/shock/fx. resolveShot folds in all mods. So new weapons = data + reuse.
- **Crit:** critChance/critMult on mods→ShotSpec/StrikeInfo; isCrit already drives brighter feedback + damage mult.
- **Overlays:** boss/Rite full-screen tints = fxTinted white masks composited in code (the "big mask" tech). Reuse for Rite overlays.

===============================================================
# PART 1 — THE RITE FRAMEWORK (build ONCE, every school rides it)
===============================================================
Generic system; the ONLY per-school code is a payload. Rides stepWorld (per-player, authoritative-server-ready).

## State (on PlayerSim — plain data, so it's server-ready)
```
riteMeter: number;   // 0..1
riteActive: number;  // seconds of active rite left (0 = inactive)
riteCd: number;      // cooldown after a rite ends (0 = ready to charge)
riteSchool: SchoolId | null; // which school's payload is active / which the equipped weapon belongs to
```
## Charge (off the EXISTING combo, no new source)
- Fill on clean kills: on killEnemy, `riteMeter = min(1, riteMeter + RITE_FILL_PER_KILL * comboMult())` — scaling by the combo tier means chaining fills faster (rewards the aggression the combo already tracks). Tune RITE_FILL_PER_KILL so a clean ~12-15 kill room ≈ one full meter.
- Drain on damage: on damagePlayer, `riteMeter = max(0, riteMeter - RITE_DRAIN_ON_HIT)` (e.g. 0.25 — a chunk, not a full reset; taking 4 hits from empty-of-progress wipes it). This is the "punishes turtling/mistakes" knob.
- No charge while riteActive>0 or riteCd>0.
## Activation
- Dedicated input (e.g. `Q` / a gamepad button), gated on `riteMeter>=1 && riteActive===0 && riteCd===0`. NOT auto. Bind in the input layer; the InputCmd (post-Stage-A) gains a `rite: boolean` edge flag so it's server-authoritative.
- On activate: set `riteActive = RITE_DURATION` (~4s), `riteMeter = 0`, `riteSchool = equipped weapon's school`. Emit a `riteStart` SimEvent {school, color} → client does the overlay + dilation + shake.
## The per-tick active loop (in stepWorld)
```
if (riteActive > 0) {
  riteActive -= dt;
  RITE_PAYLOAD[riteSchool](world, player, dt);   // <-- the ONLY per-school code
  if (riteActive <= 0) { riteCd = RITE_COOLDOWN; emit riteEnd; }
}
```
## Client presentation (event-driven, reuses shipped tech)
- `riteStart` → composite the school's full-screen tinted mask (fxTinted, school color) at high alpha, kick a time-dilation (scale the render/sim dt down ~0.6x for ~0.3s ease-in then hold light slow — note: for server-auth co-op, time-dilation is LOCAL-VISUAL only; the sim can't actually slow for other players, so dilation is a client feel effect layered over a normal-speed authoritative sim — flag for Stage C), big screen shake (addTrauma).
- Rite meter HUD: a ring/bar by the combo counter; glows when full ("press Q").
## New hooks needed: (1) the rite input edge + InputCmd.rite flag, (2) the SchoolId tag on each Weapon (so equipping sets riteSchool + weapon look), (3) RITE_PAYLOAD registry. Everything else reuses combo, killEnemy, damagePlayer, fxTinted, addTrauma. NO new architecture — this is the point.

## SchoolId + weapon tagging
Add `school?: SchoolId` to Weapon (SchoolId = "grudge"|"highnoon"|... ; undefined = the default pistol/basic guns, no rite). Equipping a school weapon sets which rite is armed. A run can carry weapons from multiple schools; the armed rite = the currently-held weapon's school (matches "your rite is the weapon in your hand").

===============================================================
# PART 2 — THE GRUDGE (flagship)
===============================================================
## NEW STATUS — CURSE (stored-value DoT on the existing status system)
Add to Enemy: `curse: number` (stored damage banked, NOT time). Add to Weapon/ShotSpec/Bullet/StrikeInfo: `curse?: number` (damage banked per application) — stamped exactly like burn?.
- **Apply:** on a hit carrying `curse`, `e.curse += curseAmount` (cap `CURSE_MAX`, e.g. 24 stored). Does NOT tick on its own (unlike burn — skip it in the statusTick loop).
- **Detonation — two triggers:**
  1. On DEATH: when killEnemy runs, if `e.curse>0` the stored damage is moot for that enemy (it's dying) BUT triggers a violet burst VFX + (design choice) SPLASH: deal `e.curse * CURSE_DEATH_SPLASH` (e.g. 0.5) to enemies within ~60px — "the grudge collapses outward." This makes curse a chain-clear tool, the school's fantasy.
  2. On RE-HIT: when a friendly hit lands on an already-cursed enemy, FIRST detonate: `e.hp -= e.curse` (full stored damage dumped), violet burst, `e.curse = 0`, THEN apply the incoming hit's own damage + any new curse it carries. So the loop is: stack curse with cone/shards, then a big hit detonates it. Re-hit detonates FULLY (cleaner feel + bigger numbers than partial; the cap keeps it balanced).
- **Numbers (LOCKED, CD):** CURSE_MAX 24 flat — keep it simple, do NOT scale for bosses (against a boss the answer is raw weapon damage + the Domain rite, not a bigger cap). Malevolent Reach hitting the cap in ~0.5s of hosing IS the intended "brief hose → big detonate" rhythm — that's a feature, not a nerf target. Per-application values set per weapon below; CURSE_DEATH_SPLASH 0.5; detonation = min(banked, CURSE_MAX); re-hit detonates FULLY (not partial — bigger numbers + cleaner feel, the cap balances it). Damage amps (shock/frozen) do NOT double-dip on detonation (it's already-stored raw).
- **VFX (AD):** crackle.png tinted #a24bff clinging spark while curse>0 + a dark aura overlay scaling with stored amount; detonation = violet gib/explosion burst (reuse spawnGibs tinted). 
- **Determinism:** all additive/deterministic (no RNG) → server-safe + golden-master-clean.

## GRUDGE LOW-HP BONUS (CD addition — the "death half" of the fantasy)
The Grudge is "stronger the more you've KILLED **and** the closer to DEATH you dance." Rift-scaling captures the kill half; this captures the death half.
- **Rule:** while the player is at/below `GRUDGE_LOWHP_THRESHOLD` (1/3 max HP), all `school:"grudge"` hits deal `GRUDGE_LOWHP_MULT` more damage. Start conservative: **+20% under 33% HP** (GRUDGE_LOWHP_MULT 1.2), let QA push it.
- **Why it's load-bearing:** it turns Chimera Shadow's self-bleed into a real CHOICE — bleed yourself toward the edge to hit harder — which is the revenant fantasy in one mechanic. Without it the Grudge is just "purple burn"; with it, it feels *cursed*.
- **Implementation (nearly free — reuses an existing pattern):** the code ALREADY has a low-HP damage scaler — `berserk` in PlayerMods + `lowHpFactor()` + `currentDamageMult()` (game.ts): `damageMult + berserk * lowHpFactor()`. Mirror that: gate a flat +mult on grudge-school hits when `hp/maxHp <= 1/3`. Apply it in the damage resolve path (resolveShot / strikeEnemy) ONLY for grudge-school weapons (check the equipped weapon's school). Plain-data, deterministic, server-safe. 
- **Scope note (CD):** if it bloats the Grudge build, DEFER it — but it's cheap (one gated mult reusing lowHpFactor) and it's the piece that makes the school feel cursed, so build it with the school if you can.

## The 4 Grudge weapons (school:"grudge"; blob eyes go hollow while equipped — a client tint swap)
1. **SUKUNA'S FANG** (melee — extends the longsword MeleeSpec). Stats ~ longsword (heavy, slow): damage 6, melee {arc 1.1, reach 56, swingDur 0.22}. HOOK — **slash-rift:** each swing spawns a lingering rift decal along the arc that re-damages enemies in it for 0.4s after the swing (reuse a decal + a short-life melee hitbox re-checked each tick during the 0.4s). Applies `curse: 4` per hit. OPTIONAL (nice): rift reach/duration scales with run kill-count (e.g. +0.02s per 10 kills, capped) — "the grudge grows." New-ish hook: a timed lingering-hitbox (small; reuse MeleeSwing's hitList pattern with an extended timer). SFX meleeHit, dark.
2. **CHIMERA SHADOW** (homing — reuses the Wisp homing hook). Stats: fireCd 0.2, 3 shards/burst, damage 1.6, homing 6, curse: 3, tint #a24bff. HOOK — **the risk knob:** costs `CHIMERA_HP_COST` (e.g. 0.5 HP, i.e. half a heart's worth on the 6-heart scale → use a fractional HP model or 1 HP per 2 bursts) per burst; on a kill by a Chimera shard, refund `CHIMERA_HP_REFUND` (e.g. 1 HP, capped at maxHp). LOCKED (CD): cost 1 HP per 3 bursts, refund 1 HP per kill — net positive if you're landing kills, bleeding if you're missing. **HARD FLOOR (CD, firm): Chimera can NEVER take your last HP — at hp===1 it fires FREE (skip the cost).** So it drains you toward the edge but can never suicide you; removes the only feel-bad (dying to your own gun) while keeping the dance-on-the-edge fantasy. New hook: weapon-fire HP cost (gated `if (player.hp > 1) hp -= cost`) + on-kill-by-this-weapon refund (small addition to the fire + killEnemy paths; tag bullets with their weapon/school for the refund attribution).
3. **MALEVOLENT REACH** (channeled cone — reuses the flamethrower model). Stats ~ flamer: fireCd 0.045, wide short puffs, damage 0.6, curse: 2 per puff (NOT burn — swap the stamped status). It's the CURSE STACKER: hose an enemy to pile curse fast, then detonate with Fang/Ten Shadows. Reuse flamethrower cone verbatim, swap burn→curse, dark violet VFX.
4. **TEN SHADOWS** (charge — reuses the charge weapon + on-hit spawn). Stats: charge 0→1.0s, release a fat cursed slug (damage 3→12 by charge, curse 6, radius scales). HOOK — **split:** on impact, spawn 3-5 homing shades (reuse Chimera's homing bullets) that seek nearby enemies and each apply curse 3. Reuses charge + the on-impact bullet-spawn pattern (like a mini Tesla-chain but spawning homing bullets). SFX charge whine → dark boom.

## THE RITE — "DOMAIN: ENDLESS GRUDGE" (polish hardest — the trailer clip)
- Overlay: black-violet full-screen mask (fxTinted white mask, #1a0022→#a24bff), high alpha, a jagged sigil decal under the blob.
- Payload (per tick, ~4s): (a) every living enemy on screen gets `curse += DOMAIN_CURSE_PER_TICK` each tick (auto-curse, ramps their banked damage fast); (b) EVERY friendly hit this duration is a guaranteed FULL detonation (set a `domainActive` flag the hit-path reads → always detonate curse before damage). Net: hosing/hitting anything during the domain chain-detonates the whole room. (c) slight time-slow (client-visual per the Rite note).
- Feel: time-dilation in, heartbeat + detuned drone, violet everything, the blob's hollow eyes. Emit riteStart{school:"grudge"} for the client.
- Balance: it's earned (a full clean-kill meter) and ~4s; the auto-curse+guaranteed-detonation makes it a room-delete but only pays off if there are enemies + you keep hitting — rewards diving into a pack. 

===============================================================
# PART 3 — HIGH NOON (second — cheap, mostly reskins + 2 hooks)
===============================================================
The blob's earned home style; the honest opposite of the Grudge. Warm, rhythmic, precision.

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

## The 4 High Noon weapons (school:"highnoon"; warm/brass VFX)
1. **AMBER PEACEMAKER** (revolver — cannon/railgun stats). damage 8, fireCd 0.5, speed 900, accurate (spread 0). cylinderSize 6, reloadTime 1.1s. 6th round = gold Deadeye (crit+pierce 3). The precision backbone. SFX heavy revolver crack.
2. **FAN-THE-HAMMER** (rapid/burst). Dumps the cylinder FAST: fireCd 0.09, damage 2, cylinderSize 6, reloadTime 1.4s (a longer, real reload beat you must survive after fanning). No Deadeye (or a weak one) — it trades the precision payoff for burst. SFX fast fanning cracks.
3. **RICOCHET IRON** (the shipped ricochet "Rebound", reskinned). Stats ~ ricochet: bounce 2, damage 2.4, cylinderSize 6, reloadTime 1.0s. HOOK — **ricochet refund:** a kill by a bullet that has already bounced ≥1 refunds a round to the cylinder (skill flex: trick-shots keep you loaded). Small addition: tag bullets with bounceCount; on killEnemy by a bounced bullet, `cylinder = min(cylinderSize, cylinder+1)`. SFX ricochet ping.
4. **COACH GUN** (the shipped Boomstick sawn-off, reskinned). Stats ~ sawnoff: 8 pellets, wide, short range, big knockback. cylinderSize 2 (double-barrel!), reloadTime 0.9s. The get-off-me. SFX double-barrel boom.

## THE RITE — "HIGH NOON" (cheap + iconic)
- Overlay: full-screen SEPIA desaturation mask (fxTinted, warm brown — dead cheap, instantly reads as a western).
- Payload: (a) time nearly stops (client-visual dilation, strong — near-freeze); (b) an auto-paint pass marks every enemy on screen with a reticle (a `duelPaint` SimEvent listing enemy ids → client draws reticles); (c) on the duration's release (or auto after the paint), the blob fires one guaranteed-crit shot at each painted enemy in sequence, bang-bang-bang (server applies the damage sequence authoritatively; client plays the rapid crack + reticle pops). 
- Simplest authoritative implementation: on activate, snapshot the painted enemy list; over the ~2-3s payload, resolve one crit hit per enemy on a fast timer (e.g. every 0.08s), each a guaranteed crit (reuse the crit path) — reads as the RDR deadeye volley. 
- Feel: sepia, a single held harmonica note, hammer click, spur jingle; the world holds its breath then the volley. 

===============================================================
# NEW HOOKS NEEDED (the honest "what's genuinely new" list)
===============================================================
Almost everything reuses shipped systems. Genuinely new, small hooks:
1. **Rite framework:** the meter/charge/drain (off combo), the rite input edge (+ InputCmd.rite), the payload registry, the full-screen overlay compositing (reuses fxTinted), the SchoolId weapon tag. ONE system, ~a few hundred lines, shared by all future schools.
2. **CURSE status:** one new field (curse) on the status system + the two-trigger detonation in the hit + killEnemy paths. Mirrors burn. **+ Grudge low-HP bonus:** a gated damage mult on grudge-school hits under 1/3 HP — reuses the existing lowHpFactor()/berserk pattern, near-free.
3. **Chimera HP-cost/refund:** weapon-fire HP cost + on-kill-by-weapon refund (tag bullets with school for attribution).
4. **Slash-rift (Sukuna's Fang):** a lingering timed melee hitbox (reuses MeleeSwing hitList + an extended timer).
5. **Ten Shadows split:** spawn homing bullets on charge-slug impact (reuses charge + bullet-spawn).
6. **Cylinder + reload:** a per-weapon ammo counter + reload timer + last-round Deadeye (reuses crit/pierce).
7. **Duel:** a still-timer + a forced-crit next shot + the player-side aim-line (reuses the enemy aim-line render).
Everything else — homing, charge, bounce, pierce, melee arcs, flamethrower cone, status apply, crit, decals, gibs, tinted overlays — is ALREADY SHIPPED. Flag: none of these need new engine architecture; they're fields + handlers on existing systems, and all are plain-data/deterministic so they ride stepWorld (server-auth-ready).

## Server/co-op note (post-Stage-A)
All new state (riteMeter/riteActive, curse, cylinder, stillTimer) lives on PlayerSim/Enemy plain data → server-authoritative for free once the authoritative server lands. The ONLY client-visual-only pieces are the time-dilation and the overlay/reticle rendering (a rite slows YOUR view, not the shared sim — layer it locally over a normal-speed authoritative world; flag for Stage C tuning). CURSE/cylinder/duel are pure sim → identical in solo + co-op.

## BUILD ORDER (matches the brief)
1. **RITE framework** (generic; test with a trivial placeholder payload). 
2. **THE GRUDGE:** CURSE status → the 4 weapons (Malevolent Reach + Sukuna's Fang first, they're the curse-stack + detonate core loop) → the Domain rite payload. Polish the Domain hardest (trailer clip).
3. **HIGH NOON:** cylinder + duel hooks → the 4 weapons (mostly reskins) → the sepia rite. Cheap, on-brand, ships fast.
Every school after these is: SchoolId tag + weapon data + (maybe) one new status/hook + a rite payload. The framework is what makes them cheap — exactly the CD's intent.
