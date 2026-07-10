# blobrogue — canonical playtest feedback ledger

This is the source of truth for Ian's playtest feedback. Main runner updates it after every feedback burst and links specs/commits/tests. Status vocabulary: `NEW`, `DIAGNOSED`, `SPECCED`, `BUILDING`, `SHIPPED`, `BLOCKED (dependency)`.

## Hard priorities / governance
- `SHIPPED` **Full authoritative multiplayer end-to-end (coding priority #1) — LIVE.** Server owns ALL gameplay state. Stage A #20, Stage B #21, Stage C SHIPPED via #24 (supersedes #22, now closed); lobby/rooms/identity #26; control plane #23; juice #27. TD daily gate: PASS, main production-green. Playable at blobrogue-shaoruuu.vercel.app (Play Online → room code). Slack updates: `#ian-brain`.
- `LOCKED` Server hosting: Vercel client + Hetzner authoritative Node server; PM2/nginx/WSS; admin.create.town safe control plane; no laptop dependency.
- `LOCKED` Technical Director owns daily architecture automation + every-major-PR PASS/BLOCK. Main runner routes fixes/final calls.
- `LOCKED` Main runner makes product/creative decisions; no approval widgets/babysitting.
- `LOCKED` Art rule: no generic circles/bubbles/rings/procedural-magic filler; authored silhouette/material/story.
- `LOCKED` Both floor-run mode and future open-world mode remain.

## Multiplayer / architecture / deployment
- `SHIPPED` Stage A pure deterministic sim (`src/sim`, LocalTransport); 6 goldens / 4,500 ticks deterministic. PR #20.
- `SHIPPED` Stage B authoritative WS transport/server/prediction/reconciliation/interpolation/security/harness. PR #21. Measured 100ms RTT+5% loss p90 ~179ms, drift 0px.
- `SHIPPED` Stage C ALL-state authority: players/inventory/blessings/coins/combo/floor seed+dungeon/objective/exit/descend/enemies/bullets/hits/status/loot/props/chests. SHIPPED via #24 (all TD blockers resolved; #22 superseded+closed). Deployed live (protocol v3, gs.create.town). Room-scoped worlds via #26. TD gate PASS.
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
- `SHIPPED` **Audio de-synthesis (playtest audit):** all runtime oscillator/MIDI-like/procedural audio removed (synth SFX recipes, synth music fallback, wave synth voices/pads). Authored files or safe-reuse fallbacks (rate 0.85–1.15) only; missing assets fail quietly behind explicit hooks. Hazard cues rewired to the wave manifest (spikes telegraph no longer uiClick@1.6). revive/uiClick got asset hooks + authored reuse. Burrow underground = deterministic component emitter (no loop); the Deep = silent bed + near-silent per-channel emitter. Take arrays are SELECTION-DRIVEN (`SELECTED_BURROW_TAKES`/`SELECTED_DEEP_TAKES` mirror the audio-gen selection manifests; rejected/retired takes registry-tested absent). Deep FINAL P0 selection wired (mineral v1/v2, drip r4 v1–v3, `deep.resinStress` = resin_creak_r4_v3, architecture r4 v1/v2; weighted 1.5–3.2s diegetic scheduler on wall cells, per-floor deterministic RNG) — closes P0 material selection (Burrow 6 + Deep 8); binaries land after Ian's human spot-check. Pending-generation inventory: `docs/audio/AUDIO_ASSET_INVENTORY.md`.
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
- `SHIPPED` **Dealer = Patch's authored shop room** (owner rejected loose walk-over stock + floating tags outright). Dedicated safe `shop` RoomKind on 3/6/9…; 2 shared weapon pedestals (FIRST BUY CLAIMS) + 1 personal blessing on 12/18/24, per-player heart station (6c, +1 HP), shared reroll post (8c ×2); explicit E-interact panel with BUY — touch never purchases; protocol v8 `shopBuy` (authoritative, idempotent, one winner on races). Patch/stall art gated behind typed hooks (ART.md).
- `LOCKED` Progression: ~4–6× temporary expressive capability; permanent raw-stat ceiling ~20–30%; horizontal boss unlocks; sidegrade gear; mastery/fusion, no level-999 deletion.

## Enemies / bosses / difficulty
- `SHIPPED` Enemy prop/chest avoidance + stronger anti-stuck.
- `SHIPPED` Skeleton original cool look restored + real stride (no vibrate/dancing redraw).
- `NEW` Ghost flickers / half frames face opposite. Diagnose sheet direction vs renderer flip; normalize authored direction. Owner: main runner/art. `BLOCKED (multiplayer priority)`.
- `SPECCED` Movement grammar: HUNT/ORBIT/BURROW/ANCHOR/FLOCK/FLEE-BAIT. First trio Rootkite, Knellbat, Seamwalker. Smart low-HP flee/reposition with tell/counter; no input cheating.
- `SPECCED` Visible threat ladder: normal→large/brute→elite→miniboss, mechanical size/mass/attacks/loot; no HP sponge.
- `SHIPPED` **Durability pass (playtest: enemy toughness uniformly low):** swarm/standard untouched (fodder still melts, early-melt gates hold); brute 2.4×→3.8× HP (F4 starter-pistol focused ~3.2s), elite 2.0×→2.6× (F6 median ~2.8s, aggro→death ~3.6s); threat costs repriced (brute 2.2→2.8, elite 2.8→3.0) so floors buy fewer tough bodies instead of inflating total HP. Ladder gate: swarm << standard < elite < brute. Boss pacing + co-op scaling gates unchanged.
- `SHIPPED` Slime King current boss bar/stat buff, but `FAILED PLAYTEST`: still killed in ~3s.
- `SHIPPED` Balance reset (#25, live): Slime King F5 900 HP, measured ~20-45s TTK (was ~3s), phase floors enforced, threat-budget floors w/ swarm/brute/elite tiers, heart economy halved, leveled blessings w/ raw caps, co-op scaling. `docs/specs/blobrogue_BALANCE_FINAL_impl.md`.
- `SHIPPED` Boss roster (#31, weaver has a golden): Slime King (F5), Marrow blind charger (F15), Weaver (F20), Gilded Warden (F25), Hollow Choir (F30) implemented in `src/sim/enemies.ts`. `SPECCED` remaining: Jet (later adaptive endgame boss).
- `SPECCED` Arena floors: rare sealed center; boss+lieutenant first, duo, gauntlet, survival; overlap scheduler/fairness budget.
- `LOCKED` Mobs/boss difficulty via techniques/movement/room pressure/scarcity, not only HP.

## Floors / world / ambience / lobby
- `SHIPPED` Biome hue grading + named floors; deeper visuals still too monotonic.
- `SPECCED` Depth must change materials/ecology/room grammar/movement, survive grayscale: Verdant roots/life; Sunless shale/bone/sound; Deep resin/fracture/wrong geometry; Emberreach clinker/vents/pressure.
- `SPECCED` Floor purpose cadence F1–F10: establish/discover/dealer/synthesize/boss/recover/adapt/risk/prepare/master; no filler.
- `BUILDING` Real lighting post-server: client presentation half is in review — baked contact AO from dungeon geometry, wall-occluded torch/brazier/hazard light pools with per-biome grammar, hero-glow readability floor, light-aware entity shadows, emissive restraint (real sources only), accessibility (high contrast/reduced motion/flash level), `test:lighting` visual-metrics gate, dev sandbox A/B toggle + light-ms readout. Server-side deterministic `lightAt` exposure field (AI dark-behavior queries) remains future work per `docs/specs/blobrogue_POST_SERVER_LIGHTING_spec.md` §1.
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
