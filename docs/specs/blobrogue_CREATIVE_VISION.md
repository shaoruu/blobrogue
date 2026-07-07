# blobrogue — CREATIVE VISION
**Creative Director's throughline.** Written to be reacted to, then built. Grounded in the real engine (weapons stamp status/behaviors, enemies telegraph, VFX = white masks tinted in code, biomes color-theme the world, Amber meta + walkable hub, combo/kill-chain multiplier, authoritative server incoming).

---

## PART 1 — WHAT BLOBROGUE *IS* (the soul)

blobrogue is not "a roguelike shooter." That's the genre, not the game. Here's the game:

> **A little amber blob with a cowboy's heart wanders a world that's slowly going wrong, and it fights back by learning forbidden ways to hold a weapon.**

Three pillars hold that up:

**1. The Blob is soft; the world is sharp.** The whole identity lives in the contrast. Our hero is a squishy, warm, googly-eyed drop of amber — the most harmless thing imaginable — and it walks into caves that want to unmake it. Everything reads at a glance because of this: soft round friendly amber vs. angular hostile everything-else. That contrast is our visual signature. It should be true of the UI, the enemies, the bosses, the VFX. When something is *dangerous* it gets *angular and cold*. When something is *yours* it's *round and warm*. This is the rule the art director can hang everything on.

**2. Power is a *style*, not a stat.** Other roguelikes give you "a bigger gun." We give you a **way of fighting** — a school. Picking up a weapon isn't "+3 damage," it's "oh, I'm playing the cursed way now." The fantasy of blobrogue is that this innocent blob keeps *learning things it maybe shouldn't* — how to channel a grudge, how to conduct a storm, how to let a living weapon feed on it. Mastery = discovering which schools sing together. That's the "one more run" hook: not loot, **identity**.

**3. It's a place, not a menu.** (Per the open-world call.) You have a home — Blob Camp / the amber town — that grows as you play, and you descend through a *connected* world (Verdant Hollow → Sunless Caves → The Deep → Emberreach), not numbered flashcards. The blob has somewhere to come home to. That's what makes losing sting and returning feel good, and it's the emotional anchor when multiplayer lands: **your friends come to your town, then you go get in trouble together.**

**Tone:** *warm-dark whimsy.* Not grimdark, not cutesy. Think **Hades' confident style + Hollow Knight's melancholy world + a Saturday-morning-cartoon hero.** Funny in the writing, genuinely eerie in the deep biomes, always readable, always juicy. The blob smiles. The dark doesn't.

**The one-line pitch:** *"Enter the Gungeon, if the gun could curse you back — and you had a home to come back to."*

---

## PART 2 — WEAPON SCHOOLS (the core new system)

### The framework (this is the buildable spine — designer + art please read)
A **School** is a themed family of 3–5 weapons that share:
- a **fantasy** (why it feels different to hold),
- a **playstyle** (a real, different way to survive a room),
- **signature techniques** (small mechanical hooks — most already supported: bounce/homing/chain/burn/pierce/charge),
- a **look** (one tint palette + one VFX mask vocabulary — cheap, since VFX is code-tinted),
- and a **RITE** — the school's ultimate (see below).

**The RITE system (our "Domain Expansion").** This is the tentpole. Every school has one signature ultimate move. Mechanically it's ONE reusable system:
- A **Rite meter** that fills from the **combo/kill-chain multiplier we already have** (killing without getting hit charges it — rewards aggression, punishes turtling).
- On release: a **full-screen tinted mask overlay** (we already composite tinted masks — a domain is just a big one) + a **few seconds of the school's signature behavior cranked to absurd**, + time-dilation/screen-shake juice.
- It reads as a "holy shit" moment but it's *one meter + one overlay + a per-school payload.* That's the whole trick. Build the Rite framework once; each school just supplies a payload and a color.

Below: **the Cursed school (Ian's spark) + 5 originals.** Each is a different *way to play*. Starred (★) = build-first for maximum wow.

---

### ★ 1. THE GRUDGE — *cursed energy* (Ian's spark, the flagship)
**Fantasy:** the blob learns to hold a grudge, and the grudge holds back. These weapons run on *cursed energy* — you pay with your own vitality and the weapon pays you back tenfold. Dark, dramatic, ominous. This is the JJK school.

**Playstyle:** high-risk, high-reward, melee-forward *revenant.* You get *stronger the more hurt you are / the more you've killed.* You dance on the edge of death on purpose.

**Signature weapons (map to real archetypes):**
- **"Sukuna's Fang"** (melee, extends the Claymore hit model) — a black longsword of cursed bone. Each swing leaves a lingering **slash-rift** in the air that keeps dealing damage for 0.4s (reuses a decal + a small DoT hitbox). The more enemies it's killed this run, the longer the rift.
- **"Chimera Shadow"** (homing) — you fire pieces of your own shadow that seek. Costs a sliver of HP per burst; on kill, refunds it. Purple wisps (reuse homing "Wisp" + tint).
- **"Malevolent Shrine reach"** (a channeled cone, extends flamethrower model) — instead of fire, a cone of *cursed slashes* that applies a new **CURSE** stack (see below).
- **"Ten Shadows"** (charge weapon) — hold to summon; release to loose a fat cursed slug that splits into homing shades on impact.

**New status — CURSE (fits the burn/chill/shock system exactly):** a purple stacking DoT that *doesn't tick on its own* — it detonates when the cursed enemy dies or when you hit it again, dumping all stored damage at once. Fantasy: the grudge collects, then collapses. Mechanically it's a stored-value variant of burn. VFX: purple crackle (reuse crackle.png tinted #a24bff) + a dark aura overlay.

**THE RITE — "DOMAIN: Endless Grudge."** The screen goes black-violet (full-screen tinted mask), a jagged cursed sigil blooms under the blob, and for ~4s **every enemy on screen is auto-cursed and every hit you land is a guaranteed detonation.** Time slows slightly. It's the room-delete fantasy — but you had to bleed and chain-kill to earn it. *This is the single coolest thing in the game and it should ship first.*

**Look/feel:** black + violet + a sickly amber (the blob's own color, corrupted). Angular, dripping, wrong. Audio: low detuned drones, a heartbeat, reversed reverb tails. The blob's eyes go from googly to *hollow* while Grudge weapons are equipped — tiny detail, huge vibe.

---

### ★ 2. HIGH NOON — *the gunslinger's frontier* (the blob's true identity)
**Fantasy:** our hero is a **cowboy-blob.** Lean all the way in. High Noon is the school of the honest revolver, the reload ritual, the duel at ten paces. Where the Grudge is forbidden, this is *earned.* It's the blob's home style — quintessentially blobrogue.

**Playstyle:** precision, rhythm, and *reload-timing.* Low fire rate, huge per-shot payoff, and a **cylinder mechanic** — your shots count down; the **last bullet in the chamber ("the Deadeye round") is a guaranteed crit / pierces.** Reward for managing your rhythm instead of spraying.

**Signature weapons:**
- **"Amber Peacemaker"** (revolver, uses cannon/railgun stats) — 6 heavy accurate shots, the 6th is gold and pierces + crits.
- **"Fan-the-Hammer"** (rapid burst) — dumps the whole cylinder in a fast fan, then a real reload beat you have to survive.
- **"Ricochet Iron"** (the ricochet/Rebound weapon, reskinned as a trick-shot pistol) — bank shots off walls; a killed enemy from a ricochet refunds a bullet. Skill flex.
- **"Coach Gun"** (the Boomstick sawn-off) — the get-off-me double-barrel.

**Signature technique — DUEL:** stand still for 0.6s and a High Noon weapon enters *aim* (a thin sightline appears); the next shot is a crippling crit. Rewards the stationary-recovery windows enemies give you. Pure risk/reward positioning.

**THE RITE — "HIGH NOON."** Screen desaturates to sepia (tint overlay — dead cheap and *iconic*), time nearly stops, and a **targeting reticle auto-paints every enemy on screen.** On release the blob fires one shot at each, in sequence, bang-bang-bang, every one a crit. The Nuclear-Throne-meets-RDR power fantasy. Sepia + a single held harmonica note + the click of a hammer.

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

**THE RITE — "THE STORM BREAKS."** Screen flashes white-blue, and for ~4s **lightning auto-strikes a random enemy every 0.3s** while everything you touch is permanently max-charged. Rolling thunder, a choir swell, strobing cyan. Loud, bright, cathartic.

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

**THE RITE — "APEX MOLT."** The blob itself *transforms* for ~5s — grows spines, gets bigger, gains massive lifesteal and a contact-damage aura, and all your living weapons hit their max evolution instantly. You become the boss. Wet, pulsing, green-red, a low animal roar.

**Look/feel:** sickly greens, fleshy pinks, chitin browns. Organic, asymmetric, *breathing.* Audio: squelches, wet chittering, a heartbeat that speeds up as weapons feed. The most unsettling school — save it for The Deep biome's loot.

---

### 5. GOLDWORK — *amber rites & sacred order* (relic/holy, ties to our currency + hero)
**Fantasy:** the ancient, orderly opposite of the Grudge. **Amber** isn't just our currency and our hero's body — it's a *sacred material,* and the old blobs learned to shape it into holy geometry: crystalline turrets, binding glyphs, fossilized light. Where the Grudge is chaos and cost, Goldwork is *control and permanence.*

**Playstyle:** **zoning and placement.** You don't chase; you *build a killbox.* Drop crystal turrets, lay glyph-traps, crystallize enemies in place. The tactician / defensive run. Shines in co-op (one player zones, others push).

**Signature weapons:**
- **"Amber Lance"** (the Longshot railgun) — a beam of solid light; enemies it kills **crystallize into a temporary amber statue** that blocks bullets (a placeable cover!).
- **"Glyph Caster"** (a lobbed weapon) — throws a rune onto the floor that detonates when an enemy crosses it (a player-placed telegraph — reuse the enemy-telegraph ring tech).
- **"Prism Turret"** (a *deployable* — small new entity) — set down a little amber crystal that auto-fires at enemies for 8s. The signature Goldwork toy.
- **"Sunspear"** (the Pike) — a golden thrust that pins/crystallizes (chill-variant "SET" status: fully stopped, +damage taken — reuses freeze_shell tech, gold-tinted).

**New status — SET (chill/freeze reskin, gold):** enemies encased in amber, held in place, take bonus damage. Reuses the entire freeze system, gold palette.

**THE RITE — "GOLDEN VOW."** A vast amber sigil crystallizes across the whole floor; for ~4s **every enemy is periodically SET (frozen in amber)** and your turrets/glyphs fire at 3x, and any enemy that dies leaves a bullet-blocking crystal. You turn the room into a cathedral of glass and light. Warm gold, humming resonance, shafts of light.

**Look/feel:** honey gold, warm white, geometric and clean (the *only* angular thing that's friendly — because it's made of the blob's own amber). Audio: crystalline chimes, a resonant hum, glass shattering. This is the school that most literally connects to our hero and our meta economy — thematically the richest.

---

### 6. SCRAPWORKS — *jury-rigged, overclocked, unstable* (tech/experimental) [stretch school]
**Fantasy:** the blob is a tinkerer who builds guns out of junk that were *never meant to fire that fast.* Everything rattles, overheats, and occasionally blows up in your face. The gremlin school.

**Playstyle:** **sustained aggression with a heat gauge.** Fire to build HEAT; at max heat you deal huge bonus damage but risk a self-damaging **overload** if you don't vent (stop firing) in time. Push-your-luck DPS.

**Signature weapons:** the **Nailer** (rapid ricochet), **Blaster** (charge/overcharge), **Dragon** flamethrower (reflavored as a busted fuel-leak), and a new **"Overclock SMG"** whose fire rate *ramps* the longer you hold the trigger.

**New mechanic — HEAT:** a per-weapon gauge; a real risk/reward knob. Overload = a screen-shaking self-detonation that also nukes nearby enemies (weaponize the malfunction).

**THE RITE — "MELTDOWN."** All heat limits removed for ~4s — infinite fire rate, escalating damage, the blob glowing red-hot and venting steam — then a big cathartic explosion at the end. Industrial, clanking, alarm-bells, red warning strobes.

**Look/feel:** rust, brass, warning-orange, electric sparks. Cobbled-together and asymmetric. Audio: rattles, steam hisses, rising whine, klaxons. Lower priority (introduces the HEAT system) — a great *2nd wave* school once the framework's proven.

---

### Build order (my call, ranked)
1. **Build the RITE framework + THE GRUDGE + its CURSE status first.** This is Ian's spark and the single biggest "holy shit." One new status (stored-DoT), one new ultimate system, mostly-existing weapon hooks.
2. **HIGH NOON second.** It's the blob's *identity,* nearly all pure-data reskins of existing guns + one "cylinder/last-round" hook + the sepia Rite overlay. Cheap and deeply on-brand.
3. **THE CHOIR third.** Reuses the entire Tesla/chain/charge stack + shock VFX. Almost free, maximum co-op spectacle.
4. **GOLDWORK fourth.** Introduces deployables (turret entity) + reuses freeze — richest theme, ties to Amber. A bit more engine work.
5. **THE MOLT / SCRAPWORKS** as the second wave (ROT spread + HEAT are each one new system).

Every school reuses the existing bullet hooks (bounce/homing/chain/burn/pierce/charge) + the tinted-mask VFX pipeline. **No school needs new engine architecture except its one signature status/mechanic — and the Rite is one shared system.** That's the point: maximum identity, minimum new code.

---

## PART 3 — STANDOUT "WOW" HERO IDEAS (the trailer moments)

**1. DOMAIN: ENDLESS GRUDGE (the flagship).** Covered above. Black-violet screen, the amber blob's eyes go hollow, every enemy cursed, every hit a detonation. *This* is the clip that sells the game. It should exist before anything else in this doc.

**2. THE MIRROR BLOB — a boss that IS you.** A hostile blob of black amber that has learned the *same schools you have,* and uses the RITE against you. It fires *your* weapon types, casts a *corrupted* Domain, and telegraphs like you do. The thematic climax: the innocent blob's dark reflection. (Buildable: it's a reskinned player entity running enemy AI + the telegraph system + a scripted Rite. Genuinely eerie and it *means* something — the "power has a cost" theme, embodied.) Put it at the bottom of The Deep.

**3. "THE HOLLOW CHOIR" — the Emberreach world-boss.** A colossal being made of hundreds of dead blobs fused together, half-sunk in the lava biome, that *sings* (the Choir school, weaponized against you): telegraphed lightning-strike rain, a charge-and-discharge floor mechanic, and adds that swarm out of its body. Multi-phase, screen-filling, the co-op raid moment when multiplayer lands. Warm-dark whimsy at max volume: it's tragic *and* terrifying.

**4. THE AMBER HEART (home-base wow).** In Blob Camp, a giant dormant amber heart at the town center. As you pour Amber into the town, it visibly beats stronger and the town lights up around it — the physical, growing proof of progress (the Terraria/Minecraft "this place is becoming mine" dopamine, per the open-world call). When friends join in multiplayer, *their* blobs gather around it. It's the emotional home the whole game orbits.

**5. SCHOOL FUSION (the depth ceiling).** Late-run, if you're carrying weapons from two schools, you can discover a **cross-Rite** — e.g. Grudge + Choir = "Cursed Storm" (a domain of black lightning). A handful of hand-authored fusion Rites become the mastery chase and the theorycrafting the community obsesses over. This is our version of Hades' boon-duo delight — it's what gives blobrogue *legs* past launch.

---

## PART 4 — HOW IT ALL COHERES (the throughline)
- **The blob learns forbidden styles** → weapon schools are the core fantasy and the core content engine.
- **Power costs something** → the Grudge bleeds you, the Molt eats you, Scrapworks burns you; earning it back through skill is the loop.
- **You have a home that grows** → Blob Camp + the Amber Heart give persistence and a reason to return; the world is connected biomes, not stages.
- **Friends come home, then get in trouble** → multiplayer = gather at the Heart, dive together, combine schools, face world-bosses.
- **Warm soft hero, sharp cold world; power warms and corrupts** → the visual + tonal rule that makes every art and design call obvious.

That's blobrogue: **a soft little thing learning dangerous ways to be strong, with a home worth protecting.** Everything we build should make that sentence more true.

---
## CREATIVE GOVERNANCE + HARD ART RULES (locked)

**Decision routing:** The Creative Director brings bold, specific recommendations and buildable specs to the main blobrogue project runner. The project runner owns final calls, sequencing, and routing. Ian may react whenever he wants, but creative work must never stall behind an approval widget or ask him to babysit the pipeline.

**NO LOW-EFFORT CIRCLE ART.** Generic bubbles, floating circles, rings, and procedural-looking magic geometry read as cheap placeholder art and are banned as visual shorthand across Rites, statuses, bosses, weapons, and world overlays. Every shape must earn its place through an authored silhouette, material, motif, or story function.

For cursed/Grudge visuals specifically, use **sharp cursed calligraphy, torn ink, hooked teeth, thorns, severed brush-strokes, shrine architecture, bone slats, binding script, and asymmetric intentional forms.** A Rite should feel like a place or force with a specific visual thesis swallowing the room, not particles or circles laid over gameplay.

**Domain: Endless Grudge correction:** remove all generic circular/ring/bubble motifs. The Domain is an asymmetric ruined shrine made of black-violet torn calligraphy and inward-pointing bone/teeth architecture. Cursed script should appear hand-authored and incomplete, like a vow violently crossed out. The frame closes through hooked shrine beams, thorned ink, and blade-like strokes; the hero remains in a readable negative-space pocket shaped like a torn wound, not a clean circle. Bright violet is reserved for intentional script cuts and curse seams against a near-black field.
