# Wave C + deep-boss audio batches — coherence gate

Authored by Vale (audio director). **Generation stays blocked until this file says READY.**

## Paths
| Sheet | Path |
|---|---|
| Wave C guns (8 stems) | [`WAVE_C_GUN_AUDIO_PROMPTS.md`](./WAVE_C_GUN_AUDIO_PROMPTS.md) |
| Claimant F70 ALL THINGS OWED | [`CLAIMANT_F70_AUDIO_HOOKS.md`](./CLAIMANT_F70_AUDIO_HOOKS.md) |
| Wake F80 THE LAST PROCESSION | [`WAKE_F80_AUDIO_HOOKS.md`](./WAKE_F80_AUDIO_HOOKS.md) |

Handoff mirror (agent tools): `/Users/shaoruu/agent-tools/vale-audio/blobrogue_audio_manifest/`

## Batches
| Batch id | Rows | Coherent for gen? |
|---|---|---|
| `wave-c-guns-v1` | 8 gun stems (hushiron_fire … faultlink_link) | **YES** — prompts + waveSpec stems + gains aligned |
| `claimant-owed-v1` | 16 `claimant.owed*` hooks | **YES** — story names + timings + EL prompts; CROWNFALL retired |
| `wake-procession-v1` | 16 `wake.procession*` hooks | **YES** — story names + timings + EL prompts; NIGHTFALL_PROCESSION retired |

## Still not generation (code follow-ups, not Vale gen blockers)
- Helix: register Claimant/Wake `WAVE_SOUNDS` rows + swap `bestiaryAudio.ts` off choir.* placeholders.
- Art: Wave C gun held/pickup sprites (separate track).
- Selection manifests after gen (`takes: []` → selected take lists).

## Model / suffix (all batches)
`fal-ai/elevenlabs/sound-effects/v2` · influence 0.35 combat / 0.50 identity · suffix: `single isolated one-shot, dry, immediate readable transient, no music, no ambience, no long reverb, mono, dark-fantasy video game sound effect`.

**Vale call: batches are coherent for generation.** Gen may start on the three batch ids above; stop if helix wiring renames an event before selection.
