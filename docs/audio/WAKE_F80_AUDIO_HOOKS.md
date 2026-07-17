# Wake F80 audio hook manifest — THE LAST PROCESSION

Status: **hook + prompt manifest** (code still on Choir/Weaver placeholder bank in `bestiaryAudio.ts`).
Story name everywhere: **THE LAST PROCESSION**. **NIGHTFALL_PROCESSION / NIGHTFALL PROCESSION is retired forever** — never revive that name in events, stems, docs, or display.

Floor pin: F80 The Wake. Verb: **PROTECT / ADVANCE** (escort). Protocol 43 (`last_procession`).
Signature timings (authoritative @ TICK_HZ=20, ±1 tick): blackout tell **1.5s** → aim lock at **0.90s** (0.6×tell) → dark front follows convoy (cap **2.0s**) → light-bound punish **4.0s**.

Missing files resolve **silently** — no Choir, Weaver, Undertow, or Pale fallback once story hooks are wired. Until then, runtime may still reuse choir.* placeholders; this doc is the retirement path.

## 0. Decisions
Model: `fal-ai/elevenlabs/sound-effects/v2`; `pcm_44100` / `mp3_44100_192`; ship `.ogg` + `.mp3`.
Global suffix: `single isolated one-shot, dry, immediate readable transient, no music, no ambience, no long reverb, mono, dark-fantasy video game sound effect`.
Prompt influence: **0.35** combat tells/front; **0.50** entrance/phase/death / bier warmth identity.
Sonic identity: **dusk funeral convoy / last-light warmth corridor / closing dark front** — mournful but dry and readable; nonverbal; never Choir fused vowels as the identity, never Undertow flood water, never Claimant gilded debt.
Batch: `wake-procession-v1`.

## 1. Required story hooks (`wake.procession*`)

| Event | Required stem | Role in fight |
| --- | --- | --- |
| `wake.processionEntrance` | `public/audio/boss/wake_procession_entrance.ogg` | Wake / escort begins; bier present |
| `wake.processionPhase` | `public/audio/boss/wake_procession_phase.ogg` | 66% / 33% phase |
| `wake.processionDeath` | `public/audio/boss/wake_procession_death.ogg` | Wake falls; floor clear path |
| `wake.processionTell` | `public/audio/boss/wake_procession_tell.ogg` | THE LAST PROCESSION 1.5s blackout tell |
| `wake.processionLock` | `public/audio/boss/wake_procession_lock.ogg` | Aim / front commitment at 0.90s |
| `wake.processionFront` | `public/audio/boss/wake_procession_front.ogg` | Dark front advances along convoy path (moving-front) |
| `wake.processionPunish` | `public/audio/boss/wake_procession_punish.ogg` | Wake forced into light → 4.0s window |
| `wake.processionRecover` | `public/audio/boss/wake_procession_recover.ogg` | Window ends / guard reseals |
| `wake.processionFail` | `public/audio/boss/wake_procession_fail.ogg` | Bounded warmth loss + capped hit (never wipe) |
| `wake.processionBierPulse` | `public/audio/boss/wake_procession_bier_pulse.ogg` | Warm-bier corridor heartbeat (sparse; not a loop bed) |
| `wake.processionBierAdvance` | `public/audio/boss/wake_procession_bier_advance.ogg` | Convoy advances a segment |
| `wake.processionBlockerHighlight` | `public/audio/boss/wake_procession_blocker_highlight.ogg` | The one peel blocker lights before a threshold |
| `wake.processionBlockerBreak` | `public/audio/boss/wake_procession_blocker_break.ogg` | Highlighted convoy_blocker destroyed |
| `wake.processionThreshold` | `public/audio/boss/wake_procession_threshold.ogg` | Convoy crosses a cleared threshold |
| `wake.processionShelter` | `public/audio/boss/wake_procession_shelter.ogg` | Side shelter stall (survive, no window) |
| `wake.processionShadowWarn` | `public/audio/boss/wake_procession_shadow_warn.ogg` | shadow_front pressure from behind (readable) |

Ship matching `.mp3` where the pipeline requires dual-format.

## 2. Prompt rows (generation)

|event|file|dur|gain|duck|var|decision + exact EL prompt|
|---|---|---:|---:|---|---:|---|
|`wake.processionEntrance`|`boss/wake_procession_entrance`|1.50|.90|music:.3/.45/1.0|1|NEW: `A dusk funeral wake gathers around a warm last-light bier, low mournful pressure and a soft amber corridor settling into stone, nonverbal dark escort entrance, no speech`|
|`wake.processionPhase`|`boss/wake_procession_phase`|1.30|.92|music:.3/.4/.9|1|NEW: `The last procession hardens, dusk pressure deepens and the warmth corridor thins, nonverbal boss phase transition, no choir words`|
|`wake.processionDeath`|`boss/wake_procession_death`|2.40|1.0|music:.2/1.0/1.4|1|NEW: `A funeral wake dissolves at the exit threshold, the dark front unravels, last-light bier exhales into quiet amber fade then silence, no music`|
|`wake.processionTell`|`boss/wake_procession_tell`|1.50|.88|music:.4/.3/.7|2|NEW: `A 1.5 second blackout tell for the last procession, lights suck toward a warm bier while a dark front gathers behind, urgent escort warning, no impact yet, [suffix]`|
|`wake.processionLock`|`boss/wake_procession_lock`|0.28|1.0|music:.35/.12/.4|1|NEW: `A hard dusk lock commits the dark front to the convoy path, single low latch and short extinguished-candle tick, unmistakable, [suffix]`|
|`wake.processionFront`|`boss/wake_procession_front`|0.85|.90|music:.45/.2/.55|3|NEW: `A moving dark front rushes along a convoy lane toward a threshold, heavy shadow whoosh and cold stone pressure, readable directional advance, [suffix]`|
|`wake.processionPunish`|`boss/wake_procession_punish`|0.95|.95|music:.25/.4/1.0|1|NEW: `The Wake is forced into the last light, dark shell cracks in a warm amber breach and a punish window opens, satisfying exposure, [suffix]`|
|`wake.processionRecover`|`boss/wake_procession_recover`|0.75|.78|music:.55/.15/.45|1|NEW: `Dusk closes back over the Wake, warmth pulls inward and the guard reseals, recovery without a monster roar, [suffix]`|
|`wake.processionFail`|`boss/wake_procession_fail`|0.55|.84|music:.55/.12/.35|2|NEW: `Players caught in the dark-front lane take a capped warmth-sting hit, cold shadow knock and brief amber drain, painful but not a wipe, [suffix]`|
|`wake.processionBierPulse`|`boss/wake_procession_bier_pulse`|0.40|.38|—|2|NEW: `A warm last-light bier pulses once inside its corridor, soft amber heartbeat tick, restrained escort cue, [suffix]`|
|`wake.processionBierAdvance`|`boss/wake_procession_bier_advance`|0.55|.52|—|2|NEW: `An autonomous funeral bier advances one segment of a warmth corridor, low wooden roll and soft amber scrape forward, [suffix]`|
|`wake.processionBlockerHighlight`|`boss/wake_procession_blocker_highlight`|0.45|.70|music:.7/.1/.3|2|NEW: `One convoy blocker highlights before a threshold, bright dusk marker ping and hard readable peel-target tick, [suffix]`|
|`wake.processionBlockerBreak`|`boss/wake_procession_blocker_break`|0.55|.78|music:.65/.1/.35|2|NEW: `A highlighted convoy blocker shatters, brittle dusk stone break and short path-clearing crack, [suffix]`|
|`wake.processionThreshold`|`boss/wake_procession_threshold`|0.65|.80|music:.5/.15/.45|1|NEW: `The last-light convoy crosses a cleared threshold, warm corridor seals forward with a firm amber gate latch, progress cue, [suffix]`|
|`wake.processionShelter`|`boss/wake_procession_shelter`|0.40|.55|—|1|NEW: `A side shelter off the procession path stalls the convoy safely, muted stone alcove knock and soft warmth hush, survival not success, [suffix]`|
|`wake.processionShadowWarn`|`boss/wake_procession_shadow_warn`|0.70|.74|music:.6/.15/.4|2|NEW: `A shadow front presses from behind the escort, cold dusk inhale and rising dark pressure warning, directional from the rear, [suffix]`|

## 3. Wiring notes (for helix / waveSpec follow-up)
Replace Choir/Weaver placeholder map in `bestiaryAudio.ts`:
- wake windup→`processionTell`, lock→`processionLock`, active→`processionFront`, impact→`processionFail` / success path `processionPunish`, recover→`processionRecover`, entrance/phase/special/death→ processionEntrance/Phase/Punish/Death.
- warm_bier fuse/toll → bier pulse / advance.
- convoy_blocker fuse/toll → blocker highlight / break.
- shadow_front fuse/toll → shadow warn / front family.
- Register matching `WAVE_SOUNDS` rows with `takes: []` until selection lands.
- BierPulse is a **sparse one-shot**, not a continuous bed (Deep-style authored silence for any loop temptation).
- **Never** name anything NIGHTFALL_PROCESSION / NIGHTFALL PROCESSION.

## 4. Retired
**NIGHTFALL_PROCESSION** (and "NIGHTFALL PROCESSION") — retired forever. Display, build IDs, event IDs, stems, manifests, docs: **THE LAST PROCESSION** / `wake.procession*` only.

Vale owns generation, selection, mastering, and approval.
