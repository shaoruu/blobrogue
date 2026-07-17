# Wave C Guns — Generation & Selection Report

**Batch:** `wave-c-guns-v1`  
**Model:** `fal-ai/elevenlabs/sound-effects/v2`  
**Prompt influence:** 0.35 (combat)  
**Source:** `WAVE_C_GUN_AUDIO_PROMPTS.md` (PR #166 tip c1024db)  
**Generated:** 2026-07-16 PT

## Summary
- Generated takes: 21 (all succeeded; 0 fal failures after duration clamp)
- Stems shipped: 8 / 8
- Loudness: normalize to **-16 LUFS**, TP ≤ -2 dBTP, mono, highpass 35 Hz
- API note: fal `duration_seconds` minimum is **0.5**; sheet targets <0.5 were requested at 0.5 then trimmed to sheet duration

## Selected takes

| stem | event | variants | selected source takes | ship files | score(s) |
|---|---|---:|---|---|---|
| `hushiron_fire` | `shootHushiron` | 3 | hushiron_fire_take_02, hushiron_fire_take_01, hushiron_fire_take_03 | hushiron_fire_v1.ogg/.mp3, hushiron_fire_v2.ogg/.mp3, hushiron_fire_v3.ogg/.mp3 | 49.43, 38.7, 35.53 |
| `backtalk_fire` | `shootBacktalk` | 2 | backtalk_fire_take_02, backtalk_fire_take_03 | backtalk_fire_v1.ogg/.mp3, backtalk_fire_v2.ogg/.mp3 | 62.58, 62.58 |
| `backtalk_parry` | `backtalk.parry` | 2 | backtalk_parry_take_01, backtalk_parry_take_02 | backtalk_parry_v1.ogg/.mp3, backtalk_parry_v2.ogg/.mp3 | 52.58, 50.86 |
| `backtalk_return` | `backtalk.return` | 3 | backtalk_return_take_03, backtalk_return_take_02, backtalk_return_take_01 | backtalk_return_v1.ogg/.mp3, backtalk_return_v2.ogg/.mp3, backtalk_return_v3.ogg/.mp3 | 46.3, 43.72, 40.57 |
| `lamplighter_fire` | `shootLamplighter` | 2 | lamplighter_fire_take_02, lamplighter_fire_take_03 | lamplighter_fire_v1.ogg/.mp3, lamplighter_fire_v2.ogg/.mp3 | 39.54, 25.53 |
| `lamplighter_patch` | `lamplighter.patch` | 2 | lamplighter_patch_take_01, lamplighter_patch_take_02 | lamplighter_patch_v1.ogg/.mp3, lamplighter_patch_v2.ogg/.mp3 | 29.58, 23.3 |
| `faultlink_fire` | `shootFaultlink` | 2 | faultlink_fire_take_01, faultlink_fire_take_02 | faultlink_fire_v1.ogg/.mp3, faultlink_fire_v2.ogg/.mp3 | 71.5, 56.25 |
| `faultlink_link` | `faultlink.link` | 1 | faultlink_link_take_02 | faultlink_link_v1.ogg/.mp3 | 28.93 |

## Per-stem notes
### `hushiron_fire` (`shootHushiron`)
Wanted: heavy dry suppress, early onset, low zc (not buzz), strong body
- **v1** ← `hushiron_fire_take_02` score=49.43 onset=54.6ms rms=-15.2dB bright=0.040 zc80=43
- **v2** ← `hushiron_fire_take_01` score=38.7 onset=5.0ms rms=-19.3dB bright=0.157 zc80=285
- **v3** ← `hushiron_fire_take_03` score=35.53 onset=5.0ms rms=-24.9dB bright=0.460 zc80=175

### `backtalk_fire` (`shootBacktalk`)
Wanted: thin/high stub, weaker than return, light crack
- **v1** ← `backtalk_fire_take_02` score=62.58 onset=5.0ms rms=-22.7dB bright=0.924 zc80=943
- **v2** ← `backtalk_fire_take_03` score=62.58 onset=5.0ms rms=-22.8dB bright=0.928 zc80=1282
Rejected:
- `backtalk_fire_take_01` score=47.19 — lower score / identity mismatch; near clip

### `backtalk_parry` (`backtalk.parry`)
Wanted: sharp glass-metal latch, clear catch, no boom
- **v1** ← `backtalk_parry_take_01` score=52.58 onset=5.1ms rms=-19.9dB bright=0.910 zc80=914
- **v2** ← `backtalk_parry_take_02` score=50.86 onset=5.0ms rms=-15.3dB bright=0.400 zc80=595

### `backtalk_return` (`backtalk.return`)
Wanted: heavy return, low-mid body, brighter whip than stub
- **v1** ← `backtalk_return_take_03` score=46.3 onset=4.9ms rms=-16.3dB bright=0.214 zc80=405
- **v2** ← `backtalk_return_take_02` score=43.72 onset=5.0ms rms=-16.5dB bright=0.343 zc80=326
- **v3** ← `backtalk_return_take_01` score=40.57 onset=5.1ms rms=-16.8dB bright=0.657 zc80=306

### `lamplighter_fire` (`shootLamplighter`)
Wanted: soft crystalline tick + short hiss, not electric harsh
- **v1** ← `lamplighter_fire_take_02` score=39.54 onset=5.0ms rms=-17.8dB bright=0.944 zc80=1419
- **v2** ← `lamplighter_fire_take_03` score=25.53 onset=5.0ms rms=-12.8dB bright=0.946 zc80=1485
Rejected:
- `lamplighter_fire_take_01` score=22.04 — lower score / identity mismatch; near clip

### `lamplighter_patch` (`lamplighter.patch`)
Wanted: soft bloom/warmth, not blast
- **v1** ← `lamplighter_patch_take_01` score=29.58 onset=5.0ms rms=-14.8dB bright=0.863 zc80=182
- **v2** ← `lamplighter_patch_take_02` score=23.3 onset=5.0ms rms=-16.0dB bright=0.802 zc80=111

### `faultlink_fire` (`shootFaultlink`)
Wanted: brittle sharp crack, short spit, early transient
- **v1** ← `faultlink_fire_take_01` score=71.5 onset=5.0ms rms=-27.6dB bright=0.926 zc80=893
- **v2** ← `faultlink_fire_take_02` score=56.25 onset=5.0ms rms=-19.9dB bright=0.736 zc80=909
Rejected:
- `faultlink_fire_take_03` score=32.91 — lower score / identity mismatch; near clip

### `faultlink_link` (`faultlink.link`)
Wanted: wire latch + short ping, no continuous hum
- **v1** ← `faultlink_link_take_02` score=28.93 onset=86.6ms rms=-26.2dB bright=0.935 zc80=1240
Rejected:
- `faultlink_link_take_01` score=-20.24 — lower score / identity mismatch; late onset, near clip, long hummy tail

## Failures
- None in final generation pass (initial pass failed when duration < 0.5; regenerated with clamp).

## Layout
```
content-wave-c-audio-gen/
  raw/*.mp3
  normalized/audio/sfx/*_take_0N.{ogg,mp3}
  public/audio/sfx/{stem}.ogg|.mp3  (=v1)
  public/audio/sfx/{stem}_vN.ogg|.mp3
  WAVE_C_GUNS_SELECTED_MANIFEST.json
  WAVE_C_GUNS_GENERATION_REPORT.md
```

## waveSpec wiring
For each stem with variants > 1: set `stem: "sfx/<stem>"`, `variants: N`, **remove** `takes: []` so `takeStemsOf` derives `_v1.._vN`.
For variants == 1: set `stem: "sfx/<stem>_v1"`, `variants: 1`, remove `takes: []`.
