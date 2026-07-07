# blobrogue — BUILD BRIEF: The RITE framework + THE GRUDGE + HIGH NOON
Creative Director handoff. Greenlit by Ian. Source of truth for theme/soul = blobrogue_CREATIVE_VISION.md (Part 2). This brief pulls the two flagship schools out for the game designer (mechanics) + art director (look) to spec build-ready. **Build order: Rite framework → Grudge → High Noon.**

## The one shared system to build FIRST — THE RITE (do this once)
Every school's ultimate rides this. Build it generic; each school just supplies { color, payload, duration }.
- **Rite meter:** a 0..1 gauge on the player. Charges from the EXISTING combo/kill-chain multiplier — killing without taking a hit fills it; taking a hit drains/soft-resets a chunk (rewards aggression, punishes turtling). Tune fill so a clean room ≈ one Rite. Show it as a ring/bar near the combo HUD.
- **Activation:** a dedicated input (key/button) when meter is full. Not auto.
- **On activate:** (a) draw the school's **full-screen tinted-mask overlay** (SAME tech as boss overlays — a big fxTinted mask, school-colored), (b) a brief time-dilation + screen-shake juice hit, (c) run the school's **payload** for `duration` (~4s), (d) drain meter to 0, (e) a recover/cooldown so it's not spammable.
- **Payload = a per-school function** that modifies weapon behavior / spawns effects for the duration. That's the only per-school code. Everything else (meter, overlay compositing, dilation, HUD) is shared.
- Server note: the meter + active-rite state ride stepWorld so it's authoritative-server-ready for co-op (each player has their own meter/rite).

---
## SCHOOL 1 — THE GRUDGE (flagship, build first)
**Fantasy:** the soft amber blob learns to hold a grudge; cursed energy that costs your vitality and pays back tenfold. Dark, dramatic, ominous. Risk/reward revenant — stronger the more you've killed / the closer to death you dance.

**New status to spec — CURSE** (variant of the existing burn/chill/shock status system):
- A purple stacking DoT that does NOT tick on its own. It STORES damage. It detonates all at once when: (a) the cursed enemy dies, or (b) you hit it again. Fantasy: the grudge collects, then collapses.
- Mechanically = a stored-value burn. GD to spec stack cap, per-stack stored damage, detonation math, and whether re-hit detonates fully or partially.
- VFX (AD): reuse crackle.png tinted violet (#a24bff) as a clinging spark + a dark aura overlay on the cursed enemy. On detonation, a violet burst (reuse gib/explosion tinted).

**Weapons (4) — map to existing archetypes so they're mostly data + small hooks:**
- **Sukuna's Fang** (melee, extends the Claymore/longsword hit model) — black cursed-bone longsword; each swing leaves a lingering slash-rift decal that damages for ~0.4s after (reuse a decal + a short-life hitbox). GD: does rift length scale with run kill-count? (nice, optional).
- **Chimera Shadow** (homing) — fires seeking shadow-shards; costs a sliver of player HP per burst, refunds it on kill. Reuse the homing "Wisp" hook, tint violet. GD to spec HP-cost/refund numbers (this is the school's signature risk knob).
- **Malevolent Reach** (channeled cone, extends the flamethrower model) — a cone of cursed slashes (not fire) that applies CURSE stacks. Reuse the flamethrower puff-cone, swap burn→curse apply, dark VFX.
- **Ten Shadows** (charge weapon) — hold to summon, release a fat cursed slug that splits into homing shades on impact (reuse charge + on-hit spawn of homing bullets).

**THE RITE — "DOMAIN: ENDLESS GRUDGE":** overlay = black-violet full-screen mask. Payload for ~4s: every enemy on screen is auto-CURSED each tick, and every hit you land is a guaranteed full detonation. Slight time-slow. The room-delete earned by chaining kills. This is THE flagship "holy shit" — polish it hardest.

**Feel/audio (AD + audio):** black + violet + corrupted-amber. Angular, dripping, wrong. Low detuned drones, heartbeat, reversed reverb tails. Detail: while any Grudge weapon is equipped, the blob's googly eyes go **hollow** (small sprite/tint swap, huge vibe).

---
## SCHOOL 2 — HIGH NOON (build second — cheap, deeply on-brand)
**Fantasy:** the cowboy-blob's true, earned style (the honest opposite of the forbidden Grudge). The revolver, the reload ritual, the duel at ten paces. This is the blob's HOME style — the guns you find in the amber town.

**Signature mechanic to spec — the CYLINDER:** High Noon guns have a small ammo cylinder that counts down per shot. The LAST round ("the Deadeye round") is gold and is a guaranteed crit + pierce. After it fires, a short reload beat you must survive before firing again. GD: cylinder size per gun, reload duration, whether reload is auto or on-input. Rewards rhythm/management over spray.

**Signature technique — DUEL:** stand still ~0.6s and a High Noon gun enters "aim" (a thin sightline appears); the next shot is a heavy crit. Rewards using the stationary recover windows enemies give you. (Reuse the enemy aim-line tell tech, player-side.)

**Weapons (4) — mostly reskins of shipped guns + the cylinder/duel hooks:**
- **Amber Peacemaker** (revolver; cannon/railgun stats) — 6 heavy accurate shots, 6th is the gold Deadeye round (crit + pierce).
- **Fan-the-Hammer** (rapid/burst) — dumps the cylinder fast in a fan, then a real reload beat.
- **Ricochet Iron** (the shipped ricochet "Rebound", reskinned) — trick-shot pistol; a kill off a ricochet refunds a bullet.
- **Coach Gun** (the shipped Boomstick sawn-off) — the get-off-me double-barrel.

**THE RITE — "HIGH NOON":** overlay = screen desaturates to SEPIA (cheap + iconic). Payload: time nearly stops, a reticle auto-paints every enemy on screen, then on release the blob fires one crit shot at each in sequence (bang-bang-bang). The RDR/Nuclear-Throne fantasy.

**Feel/audio:** warm browns, brass, dusty gold, gunsmoke. Round + warm (it's the blob's OWN school). Heavy revolver cracks, spur jingles, a lonesome twang; the Rite = a single held harmonica note + hammer click.

---
## What each specialist gets
- **Game designer (mechanics):** the Rite framework spec (meter/charge/overlay/payload contract), the CURSE status spec, per-weapon stats + hooks for all 8 weapons, the cylinder + duel mechanics, the two Rite payloads. Reuse existing bullet hooks (homing/charge/bounce/pierce/melee-arc) + the status system — flag anything needing a genuinely new hook.
- **Art director (look):** weapon sprites (pickup + held) for all 8, the two full-screen Rite overlay masks (black-violet + sepia — white masks, code tints), the CURSE status VFX (violet crackle + aura + detonation burst, all fxTinted white-mask pipeline), the Grudge "hollow eyes" hero variant, and the Deadeye gold-round + Duel sightline tells.

**Guardrail:** keep the pistol as the always-owned default; schools are pickups/chest drops. Keep the Rite ONE framework — schools differ only by color + payload. That's what makes every future school cheap.
