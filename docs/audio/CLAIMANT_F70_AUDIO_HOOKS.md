# Claimant F70 audio hook manifest — ALL THINGS OWED

Status: **hook + prompt manifest** (code still on Choir/Weaver placeholder bank in `bestiaryAudio.ts`).
Story name everywhere: **ALL THINGS OWED**. **CROWNFALL is retired forever** — never revive that name in events, stems, docs, or display.

Floor pin: F70 Claimant. Verb: **PASS-THE-CLAIM**. Protocol 42 (`all_things_owed`).
Signature timings (authoritative @ TICK_HZ=20, ±1 tick): tell **1.4s** → aim lock at **0.84s** (0.6×tell) → descent **0.6s** → kneel punish **3.0s**.

Missing files resolve **silently** — no Choir, Weaver, Gilded, gold, or Gorge fallback once story hooks are wired. Until then, runtime may still reuse choir.* placeholders; this doc is the retirement path.

## 0. Decisions
Model: `fal-ai/elevenlabs/sound-effects/v2`; `pcm_44100` / `mp3_44100_192`; ship `.ogg` + `.mp3`.
Global suffix: `single isolated one-shot, dry, immediate readable transient, no music, no ambience, no long reverb, mono, dark-fantasy video game sound effect`.
Prompt influence: **0.35** combat tells/impacts; **0.50** entrance/phase/death identity.
Sonic identity: **gilded debt / angular crown-lane / claim-token relay** — warm amber-gold geometry under obligation, never Choir voices, never Weaver silk, never Pale cold.
Batch: `claimant-owed-v1`.

## 1. Required story hooks (`claimant.owed*`)

| Event | Required stem | Role in fight |
| --- | --- | --- |
| `claimant.owedEntrance` | `public/audio/boss/claimant_owed_entrance.ogg` | Arena load / Claimant appears guarded |
| `claimant.owedPhase` | `public/audio/boss/claimant_owed_phase.ogg` | 66% / 33% phase |
| `claimant.owedDeath` | `public/audio/boss/claimant_owed_death.ogg` | Claimant falls; token/sockets despawn |
| `claimant.owedTell` | `public/audio/boss/claimant_owed_tell.ogg` | ALL THINGS OWED 1.4s angular crown-lane tell starts |
| `claimant.owedLock` | `public/audio/boss/claimant_owed_lock.ogg` | Aim locks at 0.84s; exactly one socket lights after this |
| `claimant.owedDescent` | `public/audio/boss/claimant_owed_descent.ogg` | 0.6s crown descent / strike commit |
| `claimant.owedPunish` | `public/audio/boss/claimant_owed_punish.ogg` | Crown shatters on empty socket → 3.0s kneel window opens |
| `claimant.owedRecover` | `public/audio/boss/claimant_owed_recover.ogg` | Kneel ends / guard reseals (also soft fail recover) |
| `claimant.owedFail` | `public/audio/boss/claimant_owed_fail.ogg` | Capped carrier hit (never wipe) |
| `claimant.owedTokenPickup` | `public/audio/boss/claimant_owed_token_pickup.ogg` | Touch claim-token → become carrier |
| `claimant.owedTokenPass` | `public/audio/boss/claimant_owed_token_pass.ogg` | Deliberate pass to teammate (counts toward overcommit) |
| `claimant.owedTokenDrop` | `public/audio/boss/claimant_owed_token_drop.ogg` | Token becomes world-pickup (absent carrier grace) |
| `claimant.owedSocketLight` | `public/audio/boss/claimant_owed_socket_light.ogg` | Success socket lights (only after lock) |
| `claimant.owedDeposit` | `public/audio/boss/claimant_owed_deposit.ogg` | Carrier deposits into lit socket (solo / success path) |
| `claimant.owedGuardChip` | `public/audio/boss/claimant_owed_guard_chip.ogg` | Non-carrier chip through guard (rate-limit friendly) |
| `claimant.owedOvercommit` | `public/audio/boss/claimant_owed_overcommit.ogg` | 3rd correct pass/deposit baits the Owed cast |

Ship matching `.mp3` where the pipeline requires dual-format.

## 2. Prompt rows (generation)

|event|file|dur|gain|duck|var|decision + exact EL prompt|
|---|---|---:|---:|---|---:|---|
|`claimant.owedEntrance`|`boss/claimant_owed_entrance`|1.40|.90|music:.3/.4/.9|1|NEW: `A gilded debt collector steps into a compact arena, heavy amber seals lock around its body, orderly golden geometry settles into a guarded stance, no speech, dark boss entrance`|
|`claimant.owedPhase`|`boss/claimant_owed_phase`|1.20|.92|music:.3/.35/.85|1|NEW: `A gilded claimant tightens its obligation, amber seals re-bind, angular gold harmonics darken into a harder debt chord, nonverbal boss phase transition`|
|`claimant.owedDeath`|`boss/claimant_owed_death`|2.20|1.0|music:.2/.9/1.3|1|NEW: `A gilded debt collector collapses, amber seals shatter and claim-tokens clatter away, final heavy golden core break then silence, no music`|
|`claimant.owedTell`|`boss/claimant_owed_tell`|1.40|.88|music:.45/.25/.55|2|NEW: `An angular gilded crown-lane blooms toward a marked carrier, warm gold geometry elongates into a readable debt beam warning, building obligation, no impact yet, [suffix]`|
|`claimant.owedLock`|`boss/claimant_owed_lock`|0.28|1.0|music:.35/.12/.4|1|NEW: `A sharp amber aim-lock snaps the crown-lane onto its carrier, two precise golden latch ticks, unmistakable commitment cue, [suffix]`|
|`claimant.owedDescent`|`boss/claimant_owed_descent`|0.60|.95|music:.4/.15/.5|2|NEW: `A gilded crown-lane descends as a hard debt strike, angular gold beam slamming forward along an elongated lane, dry powerful commit, [suffix]`|
|`claimant.owedPunish`|`boss/claimant_owed_punish`|0.85|.95|music:.25/.35/.9|1|NEW: `A gilded crown shatters against an empty claim-socket, bright amber fracture and the collector kneels into an exposed punish window, satisfying break, [suffix]`|
|`claimant.owedRecover`|`boss/claimant_owed_recover`|0.70|.78|music:.55/.15/.4|1|NEW: `Amber seals re-close around a kneeling claimant, orderly gold plates lock back into a guarded stance, recovery not a roar, [suffix]`|
|`claimant.owedFail`|`boss/claimant_owed_fail`|0.55|.86|music:.55/.12/.35|2|NEW: `A capped debt strike clips the carrier, hard gold knock and short amber sting, painful but not a kill, [suffix]`|
|`claimant.owedTokenPickup`|`boss/claimant_owed_token_pickup`|0.35|.55|—|2|NEW: `A claim-token is lifted into a carrier's grip, small heavy gold coin latch and brief obligation chime, [suffix]`|
|`claimant.owedTokenPass`|`boss/claimant_owed_token_pass`|0.40|.58|—|2|NEW: `A claim-token is deliberately passed between allies, short gold handoff click and soft relay chime, cooperative, [suffix]`|
|`claimant.owedTokenDrop`|`boss/claimant_owed_token_drop`|0.40|.48|—|1|NEW: `A claim-token drops to stone as a world pickup, dense gold clack and short settle, [suffix]`|
|`claimant.owedSocketLight`|`boss/claimant_owed_socket_light`|0.45|.72|music:.7/.1/.3|2|NEW: `Exactly one claim-socket ignites after an aim lock, bright amber socket bloom and rising debt ping, clear deposit target, [suffix]`|
|`claimant.owedDeposit`|`boss/claimant_owed_deposit`|0.50|.80|music:.55/.12/.4|2|NEW: `A claim-token seats into a lit socket, firm gold deposit latch and short satisfying seal, [suffix]`|
|`claimant.owedGuardChip`|`boss/claimant_owed_guard_chip`|0.28|.42|—|3|NEW: `A guarded gilded shell takes a chip hit, muted amber plate tick, restrained, [suffix]`|
|`claimant.owedOvercommit`|`boss/claimant_owed_overcommit`|0.55|.84|music:.5/.15/.45|1|NEW: `Three claim passes complete and bait an overcommit, rising golden pressure snap into the owed cast readiness, urgent, [suffix]`|

## 3. Wiring notes (for helix / waveSpec follow-up)
Replace Choir/Weaver placeholder map in `bestiaryAudio.ts`:
- claimant windup→`owedTell`, lock→`owedLock`, active→`owedDescent`, impact→`owedFail` (miss) / punish path uses `owedPunish`, recover→`owedRecover`, entrance/phase/special/death→ owedEntrance/Phase/Punish-or-Overcommit/Death as appropriate.
- claim_token fuse/toll → token pickup / pass family (not choir.strikeWarn).
- claim_socket fuse/toll → socket light / deposit.
- Register matching `WAVE_SOUNDS` rows with `takes: []` until selection lands.
- **Never** name anything CROWNFALL.

## 4. Retired
**CROWNFALL** — retired forever. Display, build IDs, event IDs, stems, manifests, docs: **ALL THINGS OWED** / `claimant.owed*` only.

Vale owns generation, selection, mastering, and approval.
