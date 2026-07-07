# blobrogue — BUILD BRIEF: The RESONANCE framework + THE HOLLOW + HIGH NOON
Creative Director handoff. Routed by the main project runner. Source of truth for theme/soul = blobrogue_CREATIVE_VISION.md (Part 2). This brief pulls the two flagship schools out for the game designer (mechanics) + art director (look) to spec build-ready. **Build order: Resonance framework → Hollow → High Noon.**

## The one shared system to build FIRST — THE RESONANCE (do this once)
Every school's ultimate rides this. Build it generic; each school just supplies { color, payload, duration }.
- **Resonance meter:** a 0..1 gauge on the player. Charges from the EXISTING combo/kill-chain multiplier — killing without taking a hit fills it; taking a hit drains/soft-resets a chunk (rewards aggression, punishes turtling). Tune fill so a clean room ≈ one Resonance activation. Show it as a small cracked-amber tuning-shard gauge beside the combo HUD.
- **Activation:** a dedicated input (key/button) when meter is full. Not auto.
- **On activate:** (a) draw the school's **full-screen tinted-mask overlay** (SAME tech as boss overlays — a big fxTinted mask, school-colored), (b) a brief time-dilation + screen-shake juice hit, (c) run the school's **payload** for `duration` (~4s), (d) drain meter to 0, (e) a recover/cooldown so it's not spammable.
- **Payload = a per-school function** that modifies weapon behavior / spawns effects for the duration. That's the only per-school code. Everything else (meter, overlay compositing, dilation, HUD) is shared.
- Server note: the meter + active-Resonance state ride stepWorld so it's authoritative-server-ready for co-op (each player has their own meter/Resonance).

---
## SCHOOL 1 — THE HOLLOW (flagship, build first)
**Fantasy:** the soft amber blob wields amber that has been robbed of warmth and memory; hollow amber that costs vitality and returns banked hurt violently. Dark, dramatic, ominous. Risk/reward revenant — stronger the more you've killed / the closer to death you dance.

**New status to spec — FRACTURE** (variant of the existing burn/chill/shock status system):
- A banked material-stress status that does NOT tick on its own. It stores damage and snaps all at once when: (a) the fractured enemy dies, or (b) you hit it again. Fantasy: Hollow amber holds strain until its seams fail.
- Mechanically = a stored-value burn. GD to spec stack cap, per-stack stored damage, detonation math, and whether re-hit detonates fully or partially.
- VFX (AD): black-resin seams crawling across the enemy + 2–3 dying-amber splinters under tension. On detonation, seams snap and eject unequal shards along the stored stress direction.

**Weapons (4) — map to existing archetypes so they're mostly data + small hooks:**
- **Widowbite** (melee, extends the Claymore/longsword hit model) — black-resin longsword with a chipped amber nerve; each swing leaves a lingering slash-rift decal that damages for ~0.4s after (reuse a decal + a short-life hitbox). GD: does rift length scale with run kill-count? (nice, optional).
- **Bleakseed** (homing) — fires seeking shadow-shards; costs a sliver of player HP per burst, refunds it on kill. Reuse the homing "Wisp" hook, tint violet. GD to spec HP-cost/refund numbers (this is the school's signature risk knob).
- **Ruinbreath** (channeled cone, extends the flamethrower model) — a cone of razor resin flakes that applies FRACTURE. Reuse the flamethrower puff-cone, swap burn→fracture apply, dark VFX.
- **Black Lantern** (charge weapon) — hold to summon, release a heavy resin heart that cracks into homing splinters on impact (reuse charge + on-hit spawn of homing bullets).

**THE RESONANCE — "THE LIGHT GOES OUT":** overlay = black-violet full-screen mask. Payload for ~4s: every enemy on screen builds FRACTURE each tick, and every hit you land is a guaranteed full detonation. Slight time-slow. The room-delete earned by chaining kills. This is THE flagship "holy shit" — polish it hardest.

**Feel/audio (AD + audio):** soot-black + cold blue + dying amber. Fractured, material, drained. Low detuned drones, heartbeat, reversed reverb tails. Detail: while any Hollow weapon is equipped, the blob's googly eyes go **hollow** (small sprite/tint swap, huge vibe).

---
## SCHOOL 2 — HIGH NOON (build second — cheap, deeply on-brand)
**Fantasy:** the cowboy-blob's true, earned style (the honest opposite of the forbidden Hollow). The revolver, the reload ritual, the duel at ten paces. This is the blob's HOME style — the guns you find in the amber town.

**Signature mechanic to spec — the CYLINDER:** High Noon guns have a small ammo cylinder that counts down per shot. The LAST round ("the Deadeye round") is gold and is a guaranteed crit + pierce. After it fires, a short reload beat you must survive before firing again. GD: cylinder size per gun, reload duration, whether reload is auto or on-input. Rewards rhythm/management over spray.

**Signature technique — DUEL:** stand still ~0.6s and a High Noon gun enters "aim" (a thin sightline appears); the next shot is a heavy crit. Rewards using the stationary recover windows enemies give you. (Reuse the enemy aim-line tell tech, player-side.)

**Weapons (4) — mostly reskins of shipped guns + the cylinder/duel hooks:**
- **Amber Peacemaker** (revolver; cannon/railgun stats) — 6 heavy accurate shots, 6th is the gold Deadeye round (crit + pierce).
- **Fan-the-Hammer** (rapid/burst) — dumps the cylinder fast in a fan, then a real reload beat.
- **Ricochet Iron** (the shipped ricochet "Rebound", reskinned) — trick-shot pistol; a kill off a ricochet refunds a bullet.
- **Coach Gun** (the shipped Boomstick sawn-off) — the get-off-me double-barrel.

**THE RESONANCE — "HIGH NOON":** overlay = screen desaturates to SEPIA (cheap + iconic). Payload: time nearly stops, a reticle auto-paints every enemy on screen, then on release the blob fires one crit shot at each in sequence (bang-bang-bang). The RDR/Nuclear-Throne fantasy.

**Feel/audio:** warm browns, brass, dusty gold, gunsmoke. Round + warm (it's the blob's OWN school). Heavy revolver cracks, spur jingles, a lonesome twang; the Resonance = a single held harmonica note + hammer click.

---
## What each specialist gets
- **Game designer (mechanics):** the Resonance framework spec (meter/charge/overlay/payload contract), the FRACTURE status spec, per-weapon stats + hooks for all 8 weapons, the cylinder + duel mechanics, the two Resonance payloads. Reuse existing bullet hooks (homing/charge/bounce/pierce/melee-arc) + the status system — flag anything needing a genuinely new hook.
- **Art director (look):** weapon sprites (pickup + held) for all 8, the two full-screen Resonance presentation masks (black-violet + sepia — white masks, code tints), the FRACTURE status VFX (black-resin seams + tense amber splinters + directional shard snap, all fxTinted white-mask pipeline), the Hollow "hollow eyes" hero variant, and the Deadeye gold-round + Duel sightline tells.

**Guardrail:** keep the pistol as the always-owned default; schools are pickups/chest drops. Keep Resonance ONE framework — schools differ only by color + payload. That's what makes every future school cheap.


## Creative correction (locked)
External references guide boldness only, never naming or lore. Use the original blobrogue thesis in `/workspace/blobrogue_DARK_FAMILY_RETHESIS.md`. Hold all shrine/paper-seal/calligraphy art. The Hollow presentation is dead amber losing warmth: black-resin fractures, cold desaturation, dying amber seams, terrain-following cracks, no circles/rings and no overt Japanese ritual language.
