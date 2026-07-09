# blobrogue — BOSS ROSTER (build-ready, data-driven on the existing framework)
Five approved first-clear bosses + Jet as later endgame,, each a DATA-DRIVEN set of telegraphed techniques on the shipped enemy attack-state system (windup → aim-lock → active → recover) + the 3-phase BossState. No two share a fight pattern. Grounded in the REAL code (exact current boss stats + move timings below) AND aligned to the Creative Director's vision (approved first-clear regions Amberwild → Rootbound Warrens → Sunless Caves → The Deep → Gilded Archive → Emberreach; Jet + Hollow Choir hero-bosses are specced here). Mechanics are primary; themes match the CD doc so nothing blocks — retheme freely, the movesets stand.

## The framework we're extending (from the real code)
- **AttackMove** union today: "none"|"lunge"|"spit"|"hopslam"|"radial"|"roar". Each new boss technique = a new AttackMove enum value + a handler in the boss update, following the EXACT pattern the Slime King already uses (windup ramps 0..1 driving the telegraph tint/marker; aim locks partway; active fires; recover is the punish window).
- **BossState** today: { phase 1..3, minionTimer, isNextRadial, burstParity }. Extend per-boss with the few scratch fields each needs (noted per boss). Keep it a plain-data struct (server-authoritative-ready — it rides stepWorld).
- **Current boss (Slime King) real stats** = the baseline to tune against: baseHp 90 (+16/floor), speed 40, touchDamage 3, radius 34, kbResist 6. Slam radius 90, radial 8 bolts, minion cap 14. Timings: roar 0.8s, hop-slam windup 0.6 / lock 0.3 / air 0.5 / recover 0.7; radial windup 0.8 / recover 0.6; attack CD per phase [3.5, 2.8, 2.2]s; minion drip 3.4s. **Every new boss reuses these as the sanity baseline** — windups ≥0.5s, a real recover window, telegraphs on every committed move (the fairness budget from the enemy-combat spec).
- **Fairness rule (non-negotiable, applies to all):** every attack is dodgeable by WALKING (player speed 200 vs these bosses' 34-150), has a ≥0.5s readable wind-up (ground marker for AoE, body tell for melee, aim-line for projectiles), locks aim PARTWAY (not at release, so skilled players juke), and leaves a stationary recover = the DPS window. Bosses are a dance, not a stat check.

## Shared boss scaffolding (build once, all bosses use)
- A `BossDef` table (parallel to ENEMY_ARCHETYPES) keyed by boss id: { name, biome, baseHp, hpPerFloor, speed, radius, touchDamage, drawSize, tint, phases: PhaseDef[], moveset: AttackMove[] }. Picking which boss spawns = biome/floor lookup instead of the hardcoded Slime King. This is the ONE new piece of structure; every boss below is then just data + its move handlers.
- Phase transitions reuse the existing 0.8s roar (inflate + flash + telegraph, NOT invuln) at HP thresholds (66% / 33%). Each boss's phases ADD moves + tighten cooldowns, exactly like the Slime King does today.
- Boss HP bar (just shipped) + post-boss music calm (just shipped) apply to all.

===============================================================
# BOSS 1 — THE SLIME KING (existing) → keep as the "summoner" archetype, Amberwild
===============================================================
Already built. Reclassify it as the SUMMONER archetype and the first-biome boss (the tutorial boss — teaches telegraph-reading). No rework; it's the baseline. Its identity in the roster: adds + AoE zoning. Leave it; the roster grows AROUND it.

===============================================================
# BOSS 2 — MARROW  (CHARGER / RUSHER, the BLIND boss)  · Sunless Caves
===============================================================
**Identity/fantasy:** MARROW — a massive angular brute of fused rock and exposed bone that can't be out-traded up close, so it CHARGES. The "don't get cornered, bait the rush" fight. (Name/hook from the CD.) **THE HOOK — Marrow is BLIND:** eyeless from an age in the Sunless Caves, it charges at SOUND, not sight. This gives narrative MEANING to the aim-lock timing and upgrades the fight: Marrow commits to where it HEARD you, not where you are.
**Blindness mechanic (fold into the charge below):** the aim-lock at 0.4s = the moment it "hears" and commits; the last 0.3s un-tracked = it's now deaf to your movement, so you sidestep the locked line. Design payoffs: (a) standing STILL during its windup makes it lose your position (it can't lock a silent target — implement as: if the player's move input is ~0 at lock-time, it locks on your LAST-moving position / a random nearby offset, so holding still genuinely juke-breaks the charge); (b) baiting it into a wall = dazed (the existing 1.0s embed-recover, reflavored as "ran full-speed into the dark"). The blindness IS the fight and it makes the existing timings feel intentional.
**Profile:** hp ~110 (+18/fl), speed 60 (fast for a boss), radius 38, touchDamage 3, kbResist high (you can't stagger it).
**BossState extra:** { chargeChain: number } (consecutive charges this combo).
**Signature moves:**
- **GORE-CHARGE** (new AttackMove "charge"): WINDUP 0.7s — Marrow plants, lowers its head, empty sockets FLARE RED (it's "listening"), and a RED CHARGE-LINE telegraph extends toward the player's current sound (reuse the skeleton lunge aim-line tech, longer). Aim LOCKS at 0.4s = the instant it commits to where it HEARD you; last 0.3s un-tracked = now deaf, so sidestep the locked line. If the player is holding STILL at lock-time, it fails to pin you (locks on your last-moving pos / a random offset) — silence breaks the charge. ACTIVE 0.6s: barrels along the locked line at ~520px/s until it hits a wall, then EMBEDS (stuck) for a RECOVER of 1.0s (the big punish window — bait it into a wall). Contact during charge = touchDamage + heavy knockback. Wall-impact spawns a small debris AoE (reuse explosion FX, no chain).
- **BONEBREAK STOMP** (reuse internal hop-slam radius90): close-range punish. Windup0.6s; shale/bone stress fractures point outward and debris lifts along the coming footprint. No visible ring; internal radius remains90.
- **Phase 2 (66%):** charges come in pairs (chargeChain up to 2) — a feint then a real one; the telegraph flickers on the feint. Reads as a juke war.
- **Phase 3 (33%):** speed +20%, charge leaves a lingering RUBBLE hazard along its path (reuse a decal + area DoT) so the arena shrinks — forces movement.
**Art/VFX brief:** a big angular quadruped/bull silhouette (contrast the round blob), rocky-bone texture, EMPTY EYE-SOCKETS that flare red ONLY mid-charge windup as it "listens" (it's blind). VFX: red charge-line (reuse aim-line mask tinted #ff5a5a), dust plume on charge start (reuse smoke_puff), debris gibs on wall-impact (reuse gibs), rubble decal (Phase 3). Drawsize ~110.

===============================================================
# BOSS 3 — THE HOLLOW CHOIR  (ZONER / ARTILLERY)  · Emberreach world-boss
===============================================================
**Identity/fantasy:** the CD’s named Emberreach world-boss — a colossal fused mass of dead blobs, half-sunk in lava, that SINGS death from range. The "keep moving, the floor is lava" artillery fight; screen-filling, multi-phase, the co-op raid moment. Weaponizes the Choir (storm) school against you.
**Profile:** hp ~140 (+22/fl) — a raid boss, mostly STATIONARY (speed ~15, it's half-sunk), radius 48 (huge), touchDamage 3. It zones instead of chasing.
**BossState extra:** { strikeTimer: number, chargeField: number }.
**Signature moves:**
- **STRIKE RAIN** (new AttackMove "strikerain"): 3–5 fulgurite cracks fork toward player positions; stress cores brighten directionally over WINDUP0.9s and LOCK0.5s, then lightning follows the authored cracks. No circles/rings. Co-op assigns distinct crack paths per player with overlap arbitration.
- **CHOIR SWELL** (reuses radial projectile logic, not radial art): uneven sung pressure wedges open from different mouths; visible mouth sequence gives gaps. 8→12 bolts in asymmetric authored fans, alternating orientation; windup0.8s.
- **VITRIFY FLOOR** (new AttackMove "chargefloor"): cyan-white stress cores spread through existing heat seams over1.2s; seams vitrify outward while the quiet material pocket beside the Choir remains safe. The actual floor geometry communicates the safe approach—no full-screen pulse/ring.
- **VOICE FRAGMENTS:** a few song-linked fragile fragments answer specific mouths/attacks; killing one silences/removes its linked pressure lane briefly. No generic swarm/minion drip.
- **Phases:** P1 strike rain + voice fragments. P2 (66%) adds choir swell + faster strikes. P3 (33%) charge-floor enters the rotation + strike rain doubles. A real endurance/positioning test.
**Art/VFX brief:** a massive, tragic, screen-edge silhouette of fused sad-eyed blobs (warm-dark whimsy: tragic AND terrifying), half-submerged, glowing cyan mouths when it sings. VFX: fulgurite crack masks + bolts, uneven sung pressure wedges, vitrifying heat seams, glowing cyan mouths, ember/slag ambiance. Big bespoke art piece — the trailer boss. Drawsize ~200 (multi-tile).

===============================================================
# BOSS 4 — THE WEAVER  (MOBILE DUELIST / DODGER)  · The Deep
===============================================================
**Identity/fantasy:** a lithe, fast, angular arachnid-blob that WON'T sit still — it blinks around the arena and duels you with precise strikes. The skill-check fight: pure read-and-react, few adds, all about landing your hits on a slippery target. (The Deep: eerie, precise, cold.)
**Profile:** hp ~95 (+15/fl) but EVASIVE — speed 120 (very mobile), radius 26 (small, hard to hit), touchDamage 2. Lower HP because it's hard to pin.
**BossState extra:** { blinkTimer: number, comboStep: number }.
**Signature moves:**
- **BLINK-STRIKE** (new AttackMove "blinkstrike"): teleports (short blink with an afterimage telegraph — a 0.35s shimmer at the DESTINATION before it arrives, so you can pre-dodge) then immediately does a fast lunge. Reuses lunge + a pre-spawn destination tell. The core duel move.
- **THREAD LATTICE** (new AttackMove "lattice"): fires 3 slow crossing projectile-lines that linger briefly as damaging threads (reuse bullets with long life + a decal), carving the arena into safe gaps — a bullet-pattern to thread. Windup 0.7s.
- **DASH-COUNTER (mechanic):** if you're too passive, it punishes; if you crowd it, it blinks away — so it actively teaches spacing. Its recover after a blink-strike combo (comboStep hits 3 → 0.8s recover) is your ONLY reliable DPS window. Precision incarnate.
- **Phases:** P2 (66%) blink-strike becomes a 2-hit combo. P3 (33%) adds a "mirror" feint — blinks to two afterimages, only one is real (the tell: the real one flickers brighter). The mind-game climax.
**Art/VFX brief:** a sleek angular multi-limbed blob-spider, cold indigo/black, glinting eyes. VFX: blink shimmer (reuse afterimage + a tinted flash at destination), thread-lines (reuse bullet + comet_trail mask, indigo), feint after-images (reuse the dash afterimage system). Drawsize ~80. Fast, readable, deadly.

===============================================================
# BOSS 5 — JET  (ADAPTIVE / YOU — the Mirror Blob)  · LATER ENDGAME
===============================================================
**Identity/fantasy:** JET (the CD's flagship, now named) — jet is BLACK FOSSIL RESIN, the dark cousin of amber: the hero is amber, its reflection is jet, the same material gone cold and hollow. A hostile blob that has learned the SAME schools you have and turns them against you — what the blob BECOMES if it takes every forbidden school and ignores the cost. The "power corrupts" thesis given a body; the eeriest, most meaningful fight. Intro card (CD voice): "You've come this far. Look what it costs."
**Profile:** hp ~120 (+18/fl), speed 100 (matches the player's read/feel), radius 30 (player-sized), touchDamage 2. It plays like a PLAYER, not a monster.
**Build note (from the CD, confirmed feasible):** it's a reskinned PLAYER entity running enemy AI + the telegraph system + a scripted Resonance. Mechanically: it "equips" weapon archetypes you've built and fires them at you with telegraphs.
**BossState extra:** { equippedSchool: number, ResonanceCharge: number }.
**Signature moves:**
- **MIRRORED FIRE** (new AttackMove "mirrorfire"): it shoots YOUR weapon types at you — cycles through 2-3 of the schools. (CD stretch idea, only if cheap: mirror the schools the player is ACTUALLY carrying that run — fighting your own build. The fixed 2-3 cycle is the shippable default.) (e.g. a Hollow Fracture volley, a High Noon aimed crit-shot with the duel sightline tell, a Choir chain-bolt). Each uses that weapon's real telegraph, so you're dodging your own arsenal. Reuses the actual weapon fire() + a windup wrapper.
- **CORRUPT DASH** (reuse the player dash + lunge): it dashes with i-frames exactly like you can — so you can't just spam into it; you have to catch its recover.
- **THE RESONANCE — "LIGHT WITHOUT WARMTH"** (P3 scripted signature): at 33% Jet resonates and drains the EXISTING room toward soot-black and cold blue (reuse the Resonance environment-drain tech). For ~4s, black-resin Fracture paths telegraph across the actual floor as a readable bullet-pattern survival check. Survive it → Jet is exhausted (long recover) → burst window. The climax of the whole game's telegraph language turned against you.
- **Phases:** P1 mirrored fire (1 school). P2 (66%) 2 schools + corrupt dash. P3 (33%) all schools + the Corrupted Resonance Resonance.
**Art/VFX brief:** a near-exact copy of the hero blob but BLACK AMBER with hollow eyes (the CD's "eyes go hollow" detail), violet cursed aura. VFX: reuse the player's own weapon VFX (tinted soot/cold blue/dead amber) + the Resonance overlay mask. Cheapest bespoke art (it's a recolored hero) for the highest thematic payoff. Drawsize ~64 (player-sized). Audio: the CD's dry black-resin / falling amber-hum palette.

===============================================================
# BOSS 6 — THE GILDED WARDEN  (ZONER / TRAP-SETTER)  · GILDED ARCHIVE
===============================================================
**Identity/fantasy:** an ancient amber construct of rigid geometry—order and preservation turned into imprisonment. It is the Gilded Archive’s mandatory gate and tests killbox dismantling. It doesn't chase; it BUILDS a killbox around you: crystal turrets, binding glyphs, encasing you in amber. The tactician boss — control the space or die. (Goldwork theme; the only angular-but-warm boss, per the CD rule that amber is friendly-angular.)
**Profile:** hp ~130 (+20/fl), speed 25 (stately), radius 40, touchDamage 3. Stationary-ish; it wins by zoning.
**BossState extra:** { turretTimer, glyphTimer }.
**Signature moves:**
- **CRYSTAL SENTRY** (AttackMove "turret"): unfolds 1–2 embedded relic silhouettes from fossil shelving; each points a material firing lane before slow bolts. Destroy or redirect via Dead Prism.
- **ARCHIVE LOCK** (AttackMove "glyph" internally): interlocking fossil shelves rise along visible resin seams after windup; being caught between them briefly SETs/roots. Boundary is shelf silhouette/seam direction, never glyph/ring.
- **AMBER PRISON WALLS** (P3): two unequal fossil shelf fronts close along authored seams, leaving a readable offset escape lane; the room becomes a rigid archive. No shrinking ring/prison iconography.
- **Phases:** P1 sentries. P2 + shelf locks. P3 + filing walls, turrets fire faster.
**Art/VFX brief:** a rigid fossilized amber officer, dead honey/tarnished brass/cold mineral; embedded relic silhouettes and interlocking shelves. Reuse SET mechanics but materialize through fossil plates/resin seams, never glyph/ring art. Defeat unlocks Emberreach + Goldwork family/Camp construction cosmetics/functions. Drawsize ~100. Build LAST — it leans on the Goldwork school's deployable/crystallize tech, so it's cheapest AFTER that school ships.

===============================================================
# ROSTER SUMMARY — genuinely distinct fight patterns
===============================================================
| Boss | Archetype | The fight is about | Biome | New AttackMoves | Art cost |
|------|-----------|--------------------|-------|-----------------|----------|
| Slime King | Summoner | adds + AoE zoning | Amberwild | (exists) | none |
| Marrow (blind) | Charger | bait the rush; go silent to juke | Sunless Caves | charge (sound-commit) (+stomp reuse) | med (eyeless brute) |
| Hollow Choir | Artillery/zoner | read cracks/wedges, approach quiet grief | Emberreach | strikerain, chargefloor | HIGH (raid boss) |
| Weaver | Mobile duelist | read blinks, catch recover | The Deep | blinkstrike, lattice | med (spider-blob) |
| Jet (Mirror Blob) | Adaptive (you) | dodge/master your own arsenal | Later endgame | mirrorfire (+reuse dash/Resonance) | LOW (recolored hero) |
| Gilded Warden | Trap-setter | dismantle rigid amber killbox | Gilded Archive | turret, glyph, prison | med (reuses Goldwork VFX) |

Approved first-clear bosses cover summon / charge / duel / zone / artillery; F10 Gauntlet breaks cadence. Jet adds mirror/adaptive endgame later. None is a reskin.

## Content order (after authoritative multiplayer green / Sev-0 close)
1. Slime King baseline / BossDef scaffolding.
2. Marrow (F15 Sunless sound/charge).
3. Weaver (F20 Deep seam-duelist).
4. Gilded Warden (F25 Archive armor/zone).
5. Hollow Choir (F30 Ember raid/artillery).
6. Jet later endgame after approved first-clear chain and weapon families/Resonance exist.
## Coordination note (CD alignment)
The creative-vision doc HAD landed, so I themed the roster to it directly (biomes + the Mirror Blob & Hollow Choir are the CD's own named ideas, specced here mechanically). Mechanics are the contract; themes match the CD and can be re-skinned without touching the movesets. NAMES NOW LOCKED with the CD: Marrow (Gore-Hulk), Jet (Mirror Blob); The Slime King / The Weaver / The Hollow Choir / The Gilded Warden remain approved. Naming logic (CD): single haunting nouns (Marrow, Jet) = intimate/eerie/personal fights; "The ___" titles = grand/mythic ones. Intro/death-card lines live in blobrogue_BOSS_NAMES_flavor.md. The fight designs are unchanged; Marrow's blindness is the one mechanic ADD (it enriches, doesn't alter, the timings). Every boss reuses the shipped telegraph system + existing FX masks (tinted per palette), so — like the CD said of the schools — no boss needs new engine architecture beyond its one signature AttackMove handler. All ride stepWorld, so they're authoritative-server-ready for co-op boss fights from day one.

---
## POST-SERVER ARENA-FLOOR USE (canonical pointer)
Boss roster techniques may be reused in rare sealed Arena floors only through the authoritative overlap-arbitration contract in `blobrogue_POST_SERVER_WORLD_UX_spec.md`:
- Duo bosses are miniboss-scaled complementary roles, max two committed patterns and one arena-wide denial; no random full boss pairing.
- Boss+Lieutenant is the recommended first arena event; lieutenant death changes/removes a support pattern, not just HP.
- Survivor escalation is one authored move, never blanket rage HP/damage.
- Boss death/arena clear drives canonical objective + premium reward through server state.
No arena-floor implementation before authoritative combat Stage C is production-green.
