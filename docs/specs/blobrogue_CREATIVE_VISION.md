# blobrogue — CREATIVE VISION
**Creative Director's throughline.** Written to be reacted to, then built. Grounded in the real engine (weapons stamp status/behaviors, enemies telegraph, VFX = white masks tinted in code, biomes color-theme the world, Amber meta + walkable hub, combo/kill-chain multiplier, authoritative server incoming).

---

## PART 1 — WHAT BLOBROGUE *IS* (the soul)

blobrogue is not "a roguelike shooter." That's the genre, not the game. Here's the game:

> **A little amber blob with a cowboy's heart wanders a world that's slowly going wrong, and it fights back by learning forbidden ways to hold a weapon.**

Three pillars hold that up:

**1. The Blob is soft; the world is sharp.** The whole identity lives in the contrast. Our hero is a squishy, warm, googly-eyed drop of amber — the most harmless thing imaginable — and it walks into caves that want to unmake it. Everything reads at a glance because of this: soft round friendly amber vs. angular hostile everything-else. That contrast is our visual signature. It should be true of the UI, the enemies, the bosses, the VFX. When something is *dangerous* it gets *angular and cold*. When something is *yours* it's *round and warm*. This is the rule the art director can hang everything on.

**2. Power is a *style*, not a stat.** Other roguelikes give you "a bigger gun." We give you a **way of fighting** — a school. Picking up a weapon isn't "+3 damage," it's "oh, I’m fighting through Hollow amber now." The fantasy of blobrogue is that this innocent blob keeps *learning things it maybe shouldn't* — how to weaponize a fracture, how to conduct a storm, how to let a living weapon feed on it. Mastery = discovering which schools sing together. That's the "one more run" hook: not loot, **identity**.

**3. It's a place, not a menu.** (Per the open-world call.) You have a home — Blob Camp / the amber town — that grows as you play, and you descend through a *connected* world (Verdant Hollow → Sunless Caves → The Deep → Emberreach), not numbered flashcards. The blob has somewhere to come home to. That's what makes losing sting and returning feel good, and it's the emotional anchor when multiplayer lands: **your friends come to your town, then you go get in trouble together.**

**Tone:** *warm-dark whimsy.* Not grimdark, not cutesy. Think **Hades' confident style + Hollow Knight's melancholy world + a Saturday-morning-cartoon hero.** Funny in the writing, genuinely eerie in the deep biomes, always readable, always juicy. The blob smiles. The dark doesn't.

**The one-line pitch:** *"A soft amber gunslinger descends into a world losing its warmth — then brings what it learns home."*

---

## PART 2 — WEAPON SCHOOLS (the core new system)

### The framework (this is the buildable spine — designer + art please read)
A **School** is a themed family of 3–5 weapons that share:
- a **fantasy** (why it feels different to hold),
- a **playstyle** (a real, different way to survive a room),
- **signature techniques** (small mechanical hooks — most already supported: bounce/homing/chain/burn/pierce/charge),
- a **look** (one tint palette + one VFX mask vocabulary — cheap, since VFX is code-tinted),
- and a **RESONANCE** — the family’s charged signature technique (see below).

**The RESONANCE system (blobrogue’s universal charged signature technique).** This is the tentpole. Every school has one signature ultimate move. Mechanically it's ONE reusable system:
- A **Resonance meter** that fills from the **combo/kill-chain multiplier we already have** (killing without getting hit charges it — rewards aggression, punishes turtling).
- On release: a **full-screen tinted mask overlay** (we already composite tinted masks — a resonance field is just a big one) + a **few seconds of the school's signature behavior cranked to absurd**, + time-dilation/screen-shake juice.
- It reads as a "holy shit" moment but it's *one meter + one overlay + a per-school payload.* That's the whole trick. Build the Resonance framework once; each family supplies only a payload, authored presentation, and color accent. The meter, input, progression source, and rules remain universal.

Below: **the Hollow family + five other playstyle families.** Each is a different *way to play*. Starred (★) = build-first for maximum wow.

---

### ★ 1. THE HOLLOW — *amber drained of warmth* (dark-family flagship)
**Fantasy:** the blob learns to carry Hollow amber, and make its stored fractures snap back. These weapons run on *hollow amber* — you pay with your own vitality and the weapon pays you back tenfold. Dark, dramatic, ominous. This is the dark-family school.

**Playstyle:** high-risk, high-reward, melee-forward *revenant.* You get *stronger the more hurt you are / the more you've killed.* You dance on the edge of death on purpose.

**Signature weapons (map to real archetypes):**
- **"Widowbite"** (melee, extends the Claymore hit model) — a black-resin longsword with a chipped amber nerve. Each swing leaves a lingering **slash-rift** in the air that keeps dealing damage for 0.4s (reuses a decal + a small DoT hitbox). The more enemies it's killed this run, the longer the rift.
- **"Bleakseed"** (homing) — you fire pieces of your own shadow that seek. Costs a sliver of HP per burst; on kill, refunds it. Purple wisps (reuse homing "Wisp" + tint).
- **"Ruinbreath"** (a channeled cone, extends flamethrower model) — instead of fire, a cone of razor resin flakes that applies **FRACTURE** (see below).
- **"Black Lantern"** (charge weapon) — hold to summon; release to loose a heavy resin heart that cracks into homing splinters on impact.

**New status — FRACTURE (fits the burn/chill/shock system exactly):** hits bank material stress in Hollow amber instead of ticking damage. Re-hitting or killing the target snaps the stress and releases the stored damage. VFX: black-resin seams crawl across the enemy with a few dying-amber splinters visibly under tension; detonation snaps the seams and ejects unequal shards along the stress direction.

**THE RESONANCE — "THE LIGHT GOES OUT."** Warmth drains from the existing room into soot-black and cold blue; black-resin stress seams propagate through enemies and terrain, and for ~4s **every enemy builds FRACTURE and every hit guarantees a snap-detonation.** Time slows slightly. It's the room-delete fantasy — but you had to bleed and chain-kill to earn it. *This is the single coolest thing in the game and it should ship first.*

**Look/feel:** black + violet + a sickly amber (the blob's own color, corrupted). Angular, dripping, wrong. Audio: low detuned drones, a heartbeat, reversed reverb tails. The blob's eyes go from googly to *hollow* while Hollow weapons are equipped — tiny detail, huge vibe.

---

### ★ 2. HIGH NOON — *the gunslinger's frontier* (the blob's true identity)
**Fantasy:** our hero is a **cowboy-blob.** Lean all the way in. High Noon is the school of the honest revolver, the reload ritual, the duel at ten paces. Where the Hollow is dangerous, this is *earned.* It's the blob's home style — quintessentially blobrogue.

**Playstyle:** precision, rhythm, and *reload-timing.* Low fire rate, huge per-shot payoff, and a **cylinder mechanic** — your shots count down; the **last bullet in the chamber ("the Deadeye round") is a guaranteed crit / pierces.** Reward for managing your rhythm instead of spraying.

**Signature weapons:**
- **"Amber Peacemaker"** (revolver, uses cannon/railgun stats) — 6 heavy accurate shots, the 6th is gold and pierces + crits.
- **"Fan-the-Hammer"** (rapid burst) — dumps the whole cylinder in a fast fan, then a real reload beat you have to survive.
- **"Ricochet Iron"** (the ricochet/Rebound weapon, reskinned as a trick-shot pistol) — bank shots off walls; a killed enemy from a ricochet refunds a bullet. Skill flex.
- **"Coach Gun"** (the Boomstick sawn-off) — the get-off-me double-barrel.

**Signature technique — DUEL:** stand still for 0.6s and a High Noon weapon enters *aim* (a thin sightline appears); the next shot is a crippling crit. Rewards the stationary-recovery windows enemies give you. Pure risk/reward positioning.

**THE RESONANCE — "HIGH NOON."** Screen desaturates to sepia (tint overlay — dead cheap and *iconic*), time nearly stops, and a **targeting reticle auto-paints every enemy on screen.** On release the blob fires one shot at each, in sequence, bang-bang-bang, every one a crit. The Nuclear-Throne-meets-RDR power fantasy. Sepia + a single held harmonica note + the click of a hammer.

**Look/feel:** warm browns, brass, dusty gold, gunsmoke. Round and warm (it's *the blob's own* school). Audio: heavy revolver cracks, spur jingles, a lonesome twang. This school is the game's **home base** flavor — the weapons you find in the amber town.

---

### 3. THE CHOIR — *storms you conduct* (elemental, but with a soul)
**Fantasy:** not "a lightning gun." A **choir** — you don't shoot, you *conduct.* Each shot adds a voice; hold the ensemble and the sky answers. This is our shock/tempest school, reframed so it's about *building a crescendo,* not just zapping.

**Playstyle:** **build-up and payoff.** Individually weak, but every hit stacks a **CHARGE** on the target/room; at max charge, the next hit triggers a **discharge** — a chain-lightning nova. Rewards sustained fire and target-focus. The crowd-control king (co-op MVP).

**Signature weapons:**
- **"Stormcaller"** (the Tesla) — chain lightning, the backbone.
- **"Conductor's Baton"** (charge weapon) — hold to raise the ensemble; release calls a **lightning strike** from above onto the cursor (a telegraphed ground marker, reusing the boss hop-slam shadow-ring tech in reverse).
- **"Choir SMG"** (homing SMG "Wisp") — singing bolts that seek and add charge.
- **"Thunderclap"** (cannon) — a slow, fat sound-wave slug that knocks back and shocks.

**Signature technique — CRESCENDO:** enemies at max CHARGE are marked with a halo; killing a charged enemy chains the discharge to everyone near it. Fights become a set-up-then-detonate puzzle.

**THE RESONANCE — "THE STORM BREAKS."** Screen flashes white-blue, and for ~4s **lightning auto-strikes a random enemy every 0.3s** while everything you touch is permanently max-charged. Rolling thunder, a choir swell, strobing cyan. Loud, bright, cathartic.

**Look/feel:** cyan → white → deep storm-blue. Sharp, jagged, electric. Audio: layered vocal "aahs" under the zaps (the "choir"), thunder, rising pitch as charge builds. Reuses crackle/arc_chain masks entirely — cheapest school to build, biggest crowd spectacle.

---

### 4. THE MOLT — *living weapons that feed on you* (beast/primal)
**Fantasy:** the blob finds weapons that are *alive* — parasitic, hungry, growing. They start weak and **evolve mid-run as they eat.** You're not wielding a weapon; you're raising one, and it's raising you. Body-horror-cute.

**Playstyle:** **snowball / lifesteal aggression.** Get in close, feed the weapon kills, watch it mutate. Sustain through lifesteal instead of dodging. The "I am become the monster" run.

**Signature weapons:**
- **"Maw"** (melee, the Cutlass/spear model) — a toothed living blade; every 10 kills it grows a stage (bigger hitbox, an extra tooth-projectile on swing). Persists its growth for the run.
- **"Spore-Spitter"** (the Spitter enemy's own weapon, turned friendly) — lobs a glob that **sprouts** on the ground into a damaging thorn-patch (reuses a decal + area DoT).
- **"Tick"** (homing) — you throw a parasite that latches to an enemy and drains HP *to you* (lifesteal made literal).
- **"Bloom"** (charge) — hold to grow a fleshy bulb, release a spray of homing spores that burrow (burn-style DoT, green).

**New status — ROT (green burn variant):** a DoT that *spreads* to adjacent enemies on death. Fantasy: infection. Turns a packed room into a chain-collapse. VFX: green ember/spore flecks (reuse ember.png tinted).

**THE RESONANCE — "APEX MOLT."** The blob itself *transforms* for ~5s — grows spines, gets bigger, gains massive lifesteal and a contact-damage aura, and all your living weapons hit their max evolution instantly. You become the boss. Wet, pulsing, green-red, a low animal roar.

**Look/feel:** sickly greens, fleshy pinks, chitin browns. Organic, asymmetric, *breathing.* Audio: squelches, wet chittering, a heartbeat that speeds up as weapons feed. The most unsettling school — save it for The Deep biome's loot.

---

### 5. GOLDWORK — *amber rites & sacred order* (relic/holy, ties to our currency + hero)
**Fantasy:** the ancient, orderly opposite of the Hollow. **Amber** isn't just our currency and our hero's body — it's a *sacred material,* and the old blobs learned to shape it into holy geometry: crystalline turrets, binding glyphs, fossilized light. Where the Hollow is risk and stored strain, Goldwork is *control and permanence.*

**Playstyle:** **zoning and placement.** You don't chase; you *build a killbox.* Drop crystal turrets, lay glyph-traps, crystallize enemies in place. The tactician / defensive run. Shines in co-op (one player zones, others push).

**Signature weapons:**
- **"Amber Lance"** (the Longshot railgun) — a beam of solid light; enemies it kills **crystallize into a temporary amber statue** that blocks bullets (a placeable cover!).
- **"Glyph Caster"** (a lobbed weapon) — throws a rune onto the floor that detonates when an enemy crosses it (a player-placed telegraph — reuse the enemy-telegraph ring tech).
- **"Prism Turret"** (a *deployable* — small new entity) — set down a little amber crystal that auto-fires at enemies for 8s. The signature Goldwork toy.
- **"Sunspear"** (the Pike) — a golden thrust that pins/crystallizes (chill-variant "SET" status: fully stopped, +damage taken — reuses freeze_shell tech, gold-tinted).

**New status — SET (chill/freeze reskin, gold):** enemies encased in amber, held in place, take bonus damage. Reuses the entire freeze system, gold palette.

**THE RESONANCE — "GOLDEN VOW."** A vast amber sigil crystallizes across the whole floor; for ~4s **every enemy is periodically SET (frozen in amber)** and your turrets/glyphs fire at 3x, and any enemy that dies leaves a bullet-blocking crystal. You turn the room into a cathedral of glass and light. Warm gold, humming resonance, shafts of light.

**Look/feel:** honey gold, warm white, geometric and clean (the *only* angular thing that's friendly — because it's made of the blob's own amber). Audio: crystalline chimes, a resonant hum, glass shattering. This is the school that most literally connects to our hero and our meta economy — thematically the richest.

---

### 6. SCRAPWORKS — *jury-rigged, overclocked, unstable* (tech/experimental) [stretch school]
**Fantasy:** the blob is a tinkerer who builds guns out of junk that were *never meant to fire that fast.* Everything rattles, overheats, and occasionally blows up in your face. The gremlin school.

**Playstyle:** **sustained aggression with a heat gauge.** Fire to build HEAT; at max heat you deal huge bonus damage but risk a self-damaging **overload** if you don't vent (stop firing) in time. Push-your-luck DPS.

**Signature weapons:** the **Nailer** (rapid ricochet), **Blaster** (charge/overcharge), **Dragon** flamethrower (reflavored as a busted fuel-leak), and a new **"Overclock SMG"** whose fire rate *ramps* the longer you hold the trigger.

**New mechanic — HEAT:** a per-weapon gauge; a real risk/reward knob. Overload = a screen-shaking self-detonation that also nukes nearby enemies (weaponize the malfunction).

**THE RESONANCE — "MELTDOWN."** All heat limits removed for ~4s — infinite fire rate, escalating damage, the blob glowing red-hot and venting steam — then a big cathartic explosion at the end. Industrial, clanking, alarm-bells, red warning strobes.

**Look/feel:** rust, brass, warning-orange, electric sparks. Cobbled-together and asymmetric. Audio: rattles, steam hisses, rising whine, klaxons. Lower priority (introduces the HEAT system) — a great *2nd wave* school once the framework's proven.

---

### Build order (my call, ranked)
1. **Build the RESONANCE framework + THE HOLLOW + its FRACTURE status first.** This is Ian's spark and the single biggest "holy shit." One new status (stored-DoT), one new ultimate system, mostly-existing weapon hooks.
2. **HIGH NOON second.** It's the blob's *identity,* nearly all pure-data reskins of existing guns + one "cylinder/last-round" hook + the sepia Resonance overlay. Cheap and deeply on-brand.
3. **THE CHOIR third.** Reuses the entire Tesla/chain/charge stack + shock VFX. Almost free, maximum co-op spectacle.
4. **GOLDWORK fourth.** Introduces deployables (turret entity) + reuses freeze — richest theme, ties to Amber. A bit more engine work.
5. **THE MOLT / SCRAPWORKS** as the second wave (ROT spread + HEAT are each one new system).

Every school reuses the existing bullet hooks (bounce/homing/chain/burn/pierce/charge) + the tinted-mask VFX pipeline. **No school needs new engine architecture except its one signature status/mechanic — and Resonance is one shared system.** That's the point: maximum identity, minimum new code.

---

## PART 3 — STANDOUT "WOW" HERO IDEAS (the trailer moments)

**1. THE LIGHT GOES OUT (the flagship).** Covered above. Black-violet screen, the amber blob's eyes go hollow, every enemy fractured, every hit a detonation. *This* is the clip that sells the game. It should exist before anything else in this doc.

**2. THE MIRROR BLOB — a boss that IS you.** A hostile blob of black amber that has learned the *same schools you have,* and uses the RESONANCE against you. It fires *your* weapon types, casts a *corrupted* Resonance, and telegraphs like you do. The thematic climax: the innocent blob's dark reflection. (Buildable: it's a reskinned player entity running enemy AI + the telegraph system + a scripted Resonance. Genuinely eerie and it *means* something — the "power has a cost" theme, embodied.) Put it at the bottom of The Deep.

**3. "THE HOLLOW CHOIR" — the Emberreach world-boss.** A colossal being made of hundreds of dead blobs fused together, half-sunk in the lava biome, that *sings* (the Choir school, weaponized against you): telegraphed lightning-strike rain, a charge-and-discharge floor mechanic, and adds that swarm out of its body. Multi-phase, screen-filling, the co-op raid moment when multiplayer lands. Warm-dark whimsy at max volume: it's tragic *and* terrifying.

**4. THE AMBER HEART (home-base wow).** In Blob Camp, a giant dormant amber heart at the town center. As you pour Amber into the town, it visibly beats stronger and the town lights up around it — the physical, growing proof of progress (the Terraria/Minecraft "this place is becoming mine" dopamine, per the open-world call). When friends join in multiplayer, *their* blobs gather around it. It's the emotional home the whole game orbits.

**5. SCHOOL FUSION (the depth ceiling).** Late-run, if you're carrying weapons from two schools, you can discover a **cross-Resonance** — e.g. Hollow + Choir = "Blackstorm" (a resonance field of black lightning). A handful of hand-authored fusion Resonances become the mastery chase and the theorycrafting the community obsesses over. This is our version of Hades' boon-duo delight — it's what gives blobrogue *legs* past launch.

---

## PART 4 — HOW IT ALL COHERES (the throughline)
- **The blob learns forbidden styles** → weapon schools are the core fantasy and the core content engine.
- **Power costs something** → the Hollow bleeds you, the Molt eats you, Scrapworks burns you; earning it back through skill is the loop.
- **You have a home that grows** → Blob Camp + the Amber Heart give persistence and a reason to return; the world is connected biomes, not stages.
- **Friends come home, then get in trouble** → multiplayer = gather at the Heart, dive together, combine schools, face world-bosses.
- **Warm soft hero, sharp cold world; power warms and corrupts** → the visual + tonal rule that makes every art and design call obvious.

That's blobrogue: **a soft little thing learning dangerous ways to be strong, with a home worth protecting.** Everything we build should make that sentence more true.

---
## CREATIVE GOVERNANCE + HARD ART RULES (locked)

**Decision routing:** The Creative Director brings bold, specific recommendations and buildable specs to the main blobrogue project runner. The project runner owns final calls, sequencing, and routing. Ian may react whenever he wants, but creative work must never stall behind an approval widget or ask him to babysit the pipeline.

**NO LOW-EFFORT CIRCLE ART.** Generic bubbles, floating circles, rings, and procedural-looking magic geometry read as cheap placeholder art and are banned as visual shorthand across Resonances, statuses, bosses, weapons, and world overlays. Every shape must earn its place through an authored silhouette, material, motif, or story function.

For Hollow visuals specifically, use **dead amber, black-resin fracture planes, drained warmth, chipped amber nerves, stressed material seams, and deliberate asymmetry.** A Resonance changes the existing room through its material rule; it never transports the player into borrowed ritual iconography.

**The Light Goes Out:** warmth drains from the real biome. Black-resin fractures follow actual floors and walls; sparse dead-amber slabs intrude from authored angles; the hero remains readable in a jagged terrain-shaped island of surviving warmth. No shrine, seals, runes, circles, or imported magical architecture.


---
## COHERENCE + PROGRESSION (locked)

External references are inspiration for boldness, staging, and commitment — never terminology, lore, or direct concept transfer. blobrogue must feel authored from its own amber-blob world.

**Variety on top, one foundation underneath.** Every weapon family plugs into the same universal status, combo, blessing, gear, inventory, and Resonance systems. Families change playstyle through payloads and interactions, not separate meters, currencies, or lore mini-games.

**Progression:**
- In-run: weapons + inventory + stacking blessings/synergies/status/combo. A strong run ends roughly 4–6x more capable through expressive mechanics, not raw damage inflation.
- Permanent: bosses unlock horizontal options, weapon families, and regions first. Amber grows the home and supplies a bounded ~20–30% permanent-stat ceiling. Open-world gear is sidegrade/specialization, not an infinite ladder. Bosses gate progression.
- Endgame: deep arsenal/system mastery. Bosses remain dangerous through new techniques and patterns, never HP-sponge or level-999 scaling.

### The coherence test (every future concept must pass)
1. **Foundation:** Which existing universal rule does it build on (status, combo, blessing, gear, inventory, Resonance)? If none, why is a new rule essential?
2. **World:** Where does it live or come from in the amber-blob world? Which biome, boss, home upgrade, or material makes it belong?
3. **Progression:** Is it an in-run expression, a horizontal permanent unlock, bounded home growth, or a sidegrade? No unbounded stat ladders.
4. **Playstyle:** What new decision does it create moment to moment? A reskin or raw-number bump fails.
5. **Readability:** Can its danger, ownership, and function be read at gameplay scale using authored silhouettes/materials, not generic particles or circles?
6. **Economy:** What existing content/system does it reuse, and what is the single genuinely new hook? Reject parallel mini-games.
7. **Identity:** If the external inspiration were removed, would the concept still unmistakably belong to blobrogue? If not, rewrite it.
