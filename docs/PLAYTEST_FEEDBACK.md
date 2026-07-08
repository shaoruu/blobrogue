# blobrogue — canonical playtest feedback ledger

This is the source of truth for Ian's playtest feedback. Main runner updates it after every feedback burst and links specs/commits/tests. Status vocabulary: `NEW`, `DIAGNOSED`, `SPECCED`, `BUILDING`, `SHIPPED`, `BLOCKED (dependency)`.

## Hard priorities / governance
- `BUILDING` **Full authoritative multiplayer end-to-end is coding priority #1.** Server owns ALL gameplay state; no sim-heavy feature branches until Stage A/B/C production-green. Stage A merged PR #20; Stage B merged PR #21; Stage C PR #22 blocked/reworking TD findings. Slack updates: `#ian-brain`.
- `LOCKED` Server hosting: Vercel client + Hetzner authoritative Node server; PM2/nginx/WSS; admin.create.town safe control plane; no laptop dependency.
- `LOCKED` Technical Director owns daily architecture automation + every-major-PR PASS/BLOCK. Main runner routes fixes/final calls.
- `LOCKED` Main runner makes product/creative decisions; no approval widgets/babysitting.
- `LOCKED` Art rule: no generic circles/bubbles/rings/procedural-magic filler; authored silhouette/material/story.
- `LOCKED` Both floor-run mode and future open-world mode remain.

## Multiplayer / architecture / deployment
- `SHIPPED` Stage A pure deterministic sim (`src/sim`, LocalTransport); 6 goldens / 4,500 ticks deterministic. PR #20.
- `SHIPPED` Stage B authoritative WS transport/server/prediction/reconciliation/interpolation/security/harness. PR #21. Measured 100ms RTT+5% loss p90 ~179ms, drift 0px.
- `BUILDING` Stage C ALL-state authority: players/inventory/blessings/coins/combo/floor seed+dungeon/objective/exit/descend/enemies/bullets/hits/status/loot/props/chests. PR #22 repair loop. TD blockers tracked in `/workspace/blobrogue_TECH_AUDIT_stageBC.md`.
- `BUILDING` admin.create.town blobrogue panel cloud agent + blobrogue-control immutable release pipeline cloud agent.
- `READY` admin.create.town persistent browser session logged in.
- `BLOCKED` Actual Hetzner install: recreated box lacks town/Hetzner SSH key+host config; safe control plane is the preferred no-laptop solution.
- `DECIDED` Colyseus: adopt patterns/adapter seam; do not replace measured raw-WS stack mid-flight. Revisit at Stage D reconnect/multi-room/matchmaking/schema-delta/horizontal placement.

## Bugs / clarity / UI — current
- `SHIPPED` **Stuck white hit flash** root cause: Stage-A client cosmetic anim maps were never stepped; hit flash remained 1. Fix advances/cleans enemy, prop, pickup, chest anim maps in `tickCosmetics`. (pending commit/deploy at ledger creation)
- `NEW` **Wall weird-edge / anti-alias seams.** Suspected fractional camera tile draws + smoothing/transparent edge sampling. Fix: integer tile draw/snap + smoothing audit, verify autotile 1px leaks. Owner: main runner. `BLOCKED (multiplayer priority)` except low-risk visual patch.
- `SHIPPED` Boss health bar + tougher boss + boss-death music returns to dungeon.
- `SPECCED` Persistent floor objective: `CLEAR THE FLOOR · N ENEMIES LEFT`; `FLOOR CLEAR — EXIT OPEN`; boss objective; locked/open stair silhouette + GO DOWN prompt.
- `NEW` Current floor unclear (`FL 4`). Replace with persistent `BIOME · FLOOR N` + objective. Post-server HUD clarity pass.
- `SHIPPED` Creative Mode collapsible sections.
- `SHIPPED` Creative Mode weapon inspector (pickup+held art, dmg/rate/range/type).
- `SPECCED` Bottom-center loadout: 2 weapon + 2 addon slots; weapon-local charge/cylinder/heat; hover/focus signed comparisons. `docs/specs/blobrogue_POST_SERVER_LOADOUT_UX_spec.md`.
- `NEW` Opened chest looked odd. AD redesign pending.
- `SHIPPED` Chest open SFX volume raised; generated alternate creak+chime candidate held for A/B.
- `SHIPPED` Avatar replaced with authored amber cowboy-blob portrait.

## Weapons / melee / blessings / economy
- `SHIPPED` Weapon inventory/switching: carry/dedupe; 1–9/Q/scroll; HUD inventory.
- `SHIPPED` Owned duplicate pickup stays on floor and does not force-switch.
- `SHIPPED` Base arsenal art differentiation: six missing generic fallbacks fixed; all 13 distinct silhouette+behavior color.
- `SHIPPED` Thunderbolt line pierce: basePierce2 = 3 hits, max5 w/ Full Metal; hard shove/recovery. Quality benchmark.
- `LOCKED` Wisp + Thunderbolt quality benchmarks: blind-identifiable ROOM VERBS. Infinite reserve; local constraints only.
- `SPECCED` Every base weapon gets one primary room verb; no colored-bullet-only variants. `docs/specs/blobrogue_WEAPONS_spec_2.md`.
- `SPECCED` Charge weapon: hold/release, tap viable, full charge changes size/dmg/behavior; no universal ammo scarcity.
- `SHIPPED` Melee Cutlass/Claymore/Pike mechanics, audio, wind VFX, real sprites.
- `SHIPPED` Melee can damage/break props; bullets/melee remotely open chests.
- `NEW` Melee swing visual under-polished/fake: Pike streak moves instead of actual weapon, aim mismatch. Contract: weapon sprite follows grip-pivot authored pose; hitbox matches pose; VFX supports, never replaces. `BLOCKED (multiplayer priority)`.
- `SPECCED` Melee purpose: projectile clear, front-armor flank/break, crowd space/stagger, props — not blanket DPS.
- `SPECCED` Guaranteed melee discovery floor2/floor3 retry + dealer melee until discovered.
- `SPECCED` Blessing duplicate = explicit LV2/LV3 max3, exact delta; max leaves pool. Coin Magnet L1/L2/L3 meaningful radius/pull acceleration. Current duplicate chooser UX is wrong.
- `SPECCED` Coins = temporary dealer currency; Amber = persistent. Dealers floors 3/6/9; trade/sell/reroll/heal/blessing/weapons; rarity = authored sidegrades, not huge raw damage.
- `LOCKED` Progression: ~4–6× temporary expressive capability; permanent raw-stat ceiling ~20–30%; horizontal boss unlocks; sidegrade gear; mastery/fusion, no level-999 deletion.

## Enemies / bosses / difficulty
- `SHIPPED` Enemy prop/chest avoidance + stronger anti-stuck.
- `SHIPPED` Skeleton original cool look restored + real stride (no vibrate/dancing redraw).
- `NEW` Ghost flickers / half frames face opposite. Diagnose sheet direction vs renderer flip; normalize authored direction. Owner: main runner/art. `BLOCKED (multiplayer priority)`.
- `SPECCED` Movement grammar: HUNT/ORBIT/BURROW/ANCHOR/FLOCK/FLEE-BAIT. First trio Rootkite, Knellbat, Seamwalker. Smart low-HP flee/reposition with tell/counter; no input cheating.
- `SPECCED` Visible threat ladder: normal→large/brute→elite→miniboss, mechanical size/mass/attacks/loot; no HP sponge.
- `SHIPPED` Slime King current boss bar/stat buff, but `FAILED PLAYTEST`: still killed in ~3s.
- `SPECCED` Balance reset: Slime King initial F5 900 HP/formula-calibrated ~35–50s normal / 20–25s high-roll, phase pressure/carryover; healing rates cut ~half; co-op scaling Stage C only. `docs/specs/blobrogue_BALANCE_RESET_spec.md`.
- `SPECCED` Boss roster: Slime King, Marrow blind charger, Hollow Choir, Weaver, Jet, Gilded Warden. Only Slime King currently implemented.
- `SPECCED` Arena floors: rare sealed center; boss+lieutenant first, duo, gauntlet, survival; overlap scheduler/fairness budget.
- `LOCKED` Mobs/boss difficulty via techniques/movement/room pressure/scarcity, not only HP.

## Floors / world / ambience / lobby
- `SHIPPED` Biome hue grading + named floors; deeper visuals still too monotonic.
- `SPECCED` Depth must change materials/ecology/room grammar/movement, survive grayscale: Verdant roots/life; Sunless shale/bone/sound; Deep resin/fracture/wrong geometry; Emberreach clinker/vents/pressure.
- `SPECCED` Floor purpose cadence F1–F10: establish/discover/dealer/synthesize/boss/recover/adapt/risk/prepare/master; no filler.
- `SPECCED` Real lighting post-server: deterministic coarse server `lightAt`; authored client masks/occlusion/bloom; torch/projectile/explosion sources; readability floor; biome light grammars.
- `SPECCED` Ambience: biome loops + reactive vegetation/dust/drips/heat; calm→pressure→boss→release.
- `SPECCED` Shared walkable Amber Camp lobby, no startup menu: players/collected characters/NPC stations/Amber Heart/physical Descent+Wilds gates/party staging. Post Stage C.
- `SPECCED` Gas tank: directional hiss→toxic fog (players+mobs), fire consumes into one burst; no fifth poison status.

## Creative direction
- `LOCKED` Identity: soft warm amber blob/home vs sharp cold corrupted world; variety on one coherent foundation.
- `LOCKED` Original framework: RESONANCE; dark family THE HOLLOW; FRACTURE; Widowbite/Bleakseed/Ruinbreath/Black Lantern; signature `THE LIGHT GOES OUT`. JJK-native Domain/curse/shrine terms retired (inspiration only, no copying).
- `HELD` Hollow art awaiting original dead-amber/warmth-loss redo; shrine assets retired. High Noon warm-gold art locked.
- `LOCKED` Every future concept passes foundation/world/progression/playstyle/readability/economy/identity coherence test.

## Feedback operations
- Main runner updates this ledger after every Ian feedback burst.
- Technical Director owns daily architecture gate + every-major-PR PASS/BLOCK.
- Game Balancer owns numeric balance audits.
- Creative Director owns coherent vision recommendations; main runner decides/routes.
