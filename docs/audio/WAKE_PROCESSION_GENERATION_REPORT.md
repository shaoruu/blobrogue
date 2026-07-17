# Wake F80 THE LAST PROCESSION — Audio Generation Report

- **Batch:** `wake-procession-v1`
- **Build:** `wake_procession_audio_generation_2026_07_16`
- **Story name:** THE LAST PROCESSION (NIGHTFALL_PROCESSION retired — never used)
- **Model:** `fal-ai/elevenlabs/sound-effects/v2`
- **Takes generated:** 25 across 16 events
- **Ship verdict:** PASS_V1_SHIP — all sheet stems selected (variant sets shipped in full)

## Duration policy
fal-ai/elevenlabs/sound-effects/v2 rejects `duration_seconds < 0.5`. Rows with sheet duration below that floor (`lock` 0.28, `bier_pulse` 0.40, `blocker_highlight` 0.45, `shelter` 0.40) were generated at 0.5s and hard-trimmed to the sheet target in normalize.

## Loudness
- boss identity (entrance/phase/death): -14 LUFS
- combat one-shots: -16 LUFS
- quiet bier/shelter: -18 LUFS
- true peak ≤ -2 dBTP, mono, highpass 35 Hz

## Selected stems → `public/audio/boss/`

| event | stem | variants | dur | gain | files |
| --- | --- | ---: | ---: | ---: | --- |
| `wake.processionEntrance` | `boss/wake_procession_entrance` | 1 | 1.50 | 0.9 | wake_procession_entrance.ogg |
| `wake.processionPhase` | `boss/wake_procession_phase` | 1 | 1.30 | 0.92 | wake_procession_phase.ogg |
| `wake.processionDeath` | `boss/wake_procession_death` | 1 | 2.40 | 1.0 | wake_procession_death.ogg |
| `wake.processionTell` | `boss/wake_procession_tell` | 2 | 1.50 | 0.88 | wake_procession_tell_v1.ogg, wake_procession_tell_v2.ogg |
| `wake.processionLock` | `boss/wake_procession_lock` | 1 | 0.28 | 1.0 | wake_procession_lock.ogg |
| `wake.processionFront` | `boss/wake_procession_front` | 3 | 0.85 | 0.90 | wake_procession_front_v1..v3.ogg |
| `wake.processionPunish` | `boss/wake_procession_punish` | 1 | 0.95 | 0.95 | wake_procession_punish.ogg |
| `wake.processionRecover` | `boss/wake_procession_recover` | 1 | 0.75 | 0.78 | wake_procession_recover.ogg |
| `wake.processionFail` | `boss/wake_procession_fail` | 2 | 0.55 | 0.84 | wake_procession_fail_v1.ogg, wake_procession_fail_v2.ogg |
| `wake.processionBierPulse` | `boss/wake_procession_bier_pulse` | 2 | 0.40 | 0.38 | wake_procession_bier_pulse_v1.ogg, wake_procession_bier_pulse_v2.ogg |
| `wake.processionBierAdvance` | `boss/wake_procession_bier_advance` | 2 | 0.55 | 0.52 | wake_procession_bier_advance_v1.ogg, wake_procession_bier_advance_v2.ogg |
| `wake.processionBlockerHighlight` | `boss/wake_procession_blocker_highlight` | 2 | 0.45 | 0.70 | wake_procession_blocker_highlight_v1.ogg, wake_procession_blocker_highlight_v2.ogg |
| `wake.processionBlockerBreak` | `boss/wake_procession_blocker_break` | 2 | 0.55 | 0.78 | wake_procession_blocker_break_v1.ogg, wake_procession_blocker_break_v2.ogg |
| `wake.processionThreshold` | `boss/wake_procession_threshold` | 1 | 0.65 | 0.80 | wake_procession_threshold.ogg |
| `wake.processionShelter` | `boss/wake_procession_shelter` | 1 | 0.40 | 0.55 | wake_procession_shelter.ogg |
| `wake.processionShadowWarn` | `boss/wake_procession_shadow_warn` | 2 | 0.70 | 0.74 | wake_procession_shadow_warn_v1.ogg, wake_procession_shadow_warn_v2.ogg |

## Wiring
- `WAVE_SOUNDS` rows for every `wake.procession*` event
- `bestiaryAudio.ts` wake / warm_bier / convoy_blocker / shadow_front off choir.* / weaver.* placeholders
- `WAVE_TELLS.wake.last_procession` + `WAVE_BOSS_{ENTRANCE,PHASE,DEATH}.wake`
- BierPulse is a **sparse one-shot**, not a loop (`loop` unset; never `isAuthoredSilence` bed)
- CHANGELOG + generated changelog.ts
- **Never** NIGHTFALL_PROCESSION / NIGHTFALL PROCESSION

## Raw + normalized
- raw: `/workspace/content-wake-procession-audio-gen/raw/boss`
- normalized: `/workspace/content-wake-procession-audio-gen/normalized/audio/boss`
- staging: `/workspace/content-wake-procession-audio-gen/staging/public/audio/boss`
