# blobrogue — authored audio asset inventory (playtest audio audit)

Status of every sound the runtime can reach, after the de-synthesis pass. This file is
the generation box's work order; the machine-readable source of truth is
`src/game/waveSpec.ts` (wave events) + `SAMPLES` in `src/game/audio.ts` (legacy library).
`npx tsx tools/waveAudioPaths.ts --missing` prints the live wave-file checklist.

## 0. The authored-only contract (enforced by test/waveaudio.test.ts)

- The runtime NEVER synthesizes sound: no OscillatorNodes, no generated noise buffers,
  no scheduled synth music. Acceptance test: every SfxName + every wave event played
  twice with all files 404 produces zero oscillators, zero programmatic buffers, zero
  started sources.
- A cue sounds through (1) its decoded authored file, else (2) its declared SAFE-REUSE
  fallback — an existing shipped sample through mild pitch/filter transforms, rate
  within **0.85–1.15** (±5% anti-repeat jitter on top) — else (3) silence. Anything
  that would need a stronger transform is a pending asset hook, not a runtime repitch.
- Variant counts advertise exactly what ships: a stem's variant set is all-present or
  all-pending (partially shipped takes are pinned to their explicit `_v1` stem until
  the full set lands — bump the spec when it does).
- Scheduling/LAYERING authored files is allowed (the burrow and Deep emitters below);
  waveform synthesis is not.
- Loops start only from a decoded authored buffer. A missing loop asset stays silent
  and starts cleanly on a later hold — never a synth pad, never a mid-loop swap.
- Preload contract: `preloadForFloor` decodes every cue a floor can reach (zone bed or
  Deep emitter categories, hazard kit, the boss actually present, every spawned
  archetype's tells, weapons/co-op set, and each cue's fallback sample) before it can
  trigger, so a first trigger never races its decode.

## 1. P0 asset hooks (legacy sample library, `SAMPLES` in audio.ts)

| file | event | interim safe reuse |
|---|---|---|
| `public/audio/sfx/revive.{ogg,mp3}` | revive sting (`sfx("revive")`, revive.complete) | authored `heart` chime @1.0 |
| `public/audio/sfx/uiClick.{ogg,mp3}` | UI click family (+ fallback for ui.* wave rows) | authored `coin` chime @1.1, mix .30 |

These were the two oscillator-only events; the square-wave recipes are deleted.

## 2. Superseded / rejected (do NOT generate or ship)

- `enemy/burrow_track` (continuous underground loop) — REJECTED. Replaced by the
  deterministic keyed positional burrow emitter (§3).
- `amb/deep_loop` (continuous Deep bed) — REJECTED. The Deep's continuous bed is
  authored SILENCE (`ambient.deep` is `isAuthoredSilence`); its ambience is the sparse
  positional emitter (§4).
- The procedural dungeon/boss oscillator scores in audio.ts — deleted. A music file
  that fails to load now yields silence, never MIDI-like synthesis.

## 3. Burrow underground emitter components (NEW, replaces the loop)

Deterministic keyed positional emitter (`stepBurrowEmitter` in waveAudio.ts), seeded by
entity id; runs only while a burrower tunnels; stops on eruption lock or despawn.

| file(s) | channel | cadence | gain |
|---|---|---|---|
| `enemy/burrow_dirt_v1..v3` | dirt grind | every 1.0–1.4s | .22 |
| `enemy/burrow_pebble_v1..v3` | pebble chatter | every 0.35–0.75s | .14 |
| `enemy/burrow_scrape_v1..v2` | shell scrape | every 1.3–2.0s | .18 |
| `enemy/burrow_thud` | underground thud | ONLY on direction-lock (once per commitment) | .28 |

Authoring: dry mono one-shots ≤0.5s, immediate transient, no tail — they overlap by
design. Variants deterministic, never the same take back-to-back.

## 4. The Deep's sparse ambience components (NEW, replaces the bed)

Deterministic scheduler (`stepDeepEmitter`): one authored event every 1.5–3.5s on a
140–380px ring around the listener; max 2 sounding together; suppressed ±250ms around
combat locks (enemy/boss lock tells, hazard warnings).

| file(s) | category | weight | gain |
|---|---|---|---|
| `amb/deep_resin_creak_v1..v2` | resin creak | 35% | .14 |
| `amb/deep_mineral_tick_v1..v3` | mineral tick | 35% | .12 |
| `amb/deep_arch_shift_v1..v2` | architecture shift | 15% | .16 |
| `amb/deep_resin_drip_v1..v2` | resin drip | 15% | .10 |

Authoring: mono, ≤1.2s, no melody, no reverb tail past the sample.

## 5. Pending wave-manifest files (asset hooks already wired + preloaded)

Run `npx tsx tools/waveAudioPaths.ts --missing` for the authoritative list (128 files
at time of writing). Summary by group, with the interim behavior:

- **Marrow kit** (`boss/marrow_lock`, `marrow_wall_v1..3`, `marrow_stomp_warn`,
  `marrow_stomp_v1..2`, `marrow_phase`, `marrow_death`): lock/impacts carry safe-reuse
  fallbacks (meleeHit @.85, cannon @.85); phase/death/growls are silent until files
  land (the old bossSpawn/enemyDeath extreme repitches were removed — the manifest bans
  the generic roar beyond entrances).
- **Choir kit** (`choir_strike_lock`, `choir_strike_v1..3`, `choir_swell_v1..2`,
  `choir_floor_warn`, `choir_floor_blast`, `choir_phase_v1..2`, `choir_death`): lock and
  strike fall back to tesla @1.15; swell warn to enemyAttack @.85; the rest silent.
- **Weaver kit** (`weaver_blink_warn_v1..3`, `weaver_blink_out_v1..2`,
  `weaver_strike_v1..3`, `weaver_lattice_v1..2`, `weaver_feint`, `weaver_phase`,
  `weaver_death`): blink tell parry @1.15, strike meleeHit @1.15, lattice fire
  meleeSwing @1.15, death enemyDeath @.85; blink-out (was a reversed-dash runtime
  transform) and feint/phase are silent until files land.
- **Warden kit** (`warden_turret_*`, `warden_glyph_*`, `warden_phase`, `warden_death`):
  bell/lock rows fall back to coin/blessing/parry inside the band; phase/death silent.
- **Archetype cues** (`enemy/charger_lock`, `enemy/charger_crash`, `enemy/burrow_lock`,
  `enemy/orbiter_acquire_v1..2`, `enemy/orbiter_dive_warn_v1..3`,
  `enemy/shield_block_v1..3`): all carry in-band fallbacks.
- **Partial variant sets pinned to `_v1`** (bump spec when the full set ships):
  `boss/marrow_listen`, `boss/marrow_charge`, `boss/choir_strike_warn`,
  `enemy/charger_warn`, `enemy/burrow_down`, `enemy/burrow_erupt`,
  `enemy/shield_raise`, `sfx/thumper_fire`, `sfx/thumper_impact` (target 2–3 takes each).
- **Sunlance** (`sfx/sunlance_start_v1..2`, `sunlance_loop`, `sunlance_stop`,
  `sunlance_hit_v1..2`): start/hit fall back in-band; the held loop is silent until its
  file lands (loops never synth).
- **Ambient beds** (`amb/verdant_loop`, `sunless_loop`, `ember_loop`, `fracture_loop`,
  `null_loop`): silent until shipped. The Deep intentionally has NO bed (§4).
- **Hazard kit** (`hazard/spikes_warn_v1..2`, `spikes_fire_v1..3`, `toxic_enter`,
  `toxic_loop`, `vent_warn_v1..2`, `vent_blast_v1..2`, `rift_warn_v1..2`,
  `rift_open_v1..2`): in-band fallbacks except the rift warning (needs its dedicated
  reversed-groan asset; silent until then).
- **Pets, co-op, UI** (`pet/*`, `coop/*`, `ui/*`): as listed by the tool; most carry
  in-band fallbacks, pet attack/hurt/idle are silent until files land.

## 6. Remaining repitch reuse on the LEGACY sim-cue channel (documented, needs assets)

These play through authored samples (never oscillators) but at rates outside the safe
band, driven by sim events whose rates are golden-pinned. Each needs a dedicated asset
+ a wave-manifest row in a follow-up wave; they are unchanged in this pass:

- Spitter/orbiter bolt fire: `spitMuzzle` -> shootRapid @0.55.
- Slime King kit (grandfathered — "keeps its existing audio" per the manifest):
  bossSlam enemyDeath @0.5, radialBurst shootShotgun @0.6, add-spawn enemyHit @0.6.
- Sim windup `cue` events (enemyHit/dash repitches 0.35–1.8 for skeleton/charger/
  burrower/shielder/ghost/spitter tells and the King/gauntlet beats). Note the wave
  layer already sounds the marrow/choir/weaver/gilded/charger/burrower edges with
  proper events; the duplicated legacy client one-shots for chargeCrash / burrowDive /
  burrowErupt / bossVolley / webPlaced were removed in this pass.
- Weapon sample sharing: railgun -> cannon @1.35, sawnoff -> shotgun @0.9 (in-band),
  nailer/flamer -> shootRapid — distinct weapon identities per the weapons spec need
  their own takes.
