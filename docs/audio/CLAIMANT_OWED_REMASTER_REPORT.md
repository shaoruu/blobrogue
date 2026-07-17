# Claimant ALL THINGS OWED remaster + reselect (PR #175)

Story: **ALL THINGS OWED** (never CROWNFALL).

## Pipeline (every shipped `public/audio/boss/claimant_owed_*.ogg` + matching `.mp3`)

- `loudnorm=I=-14|-16|-18:TP=-1.5:LRA=11,alimiter=limit=0.89:level=disabled`
  - identity (entrance/phase/death): **-14 LUFS**
  - combat one-shots: **-16 LUFS**
  - quiet token family: **-18 LUFS** (token_drop remastered at -16 then makeup for readability)
- trim leading silence → **~5–15 ms** onset pad
- encode: libvorbis `-q:a 5` → libmp3lame `-q:a 4`
- gate: **max_volume ≤ -1.0 dB** on every stem

## Vale-required content swaps (from closed #170 `ian/claimant-owed-audio-f70` tip `90cede7fe899`)

| stem | ship take | notes |
| --- | --- | --- |
| `deposit` | **fal-regen denser** (`deposit_r3_v4`) | pool `deposit_v1` preferred over rejected `v2` (273 ms onset), but still thin (~72% silence) after remaster → denser fal regen ~0.5 s |
| `fail` | **`fail_v2`** | not v1 |
| `guard_chip` | **`guard_chip_v3`** | densest of v2/v3 (not v1) |
| `tell` | **`tell_v1`** | not v2 |
| `socket_light` | **`socket_light_v1`** | denser alt vs v2 |
| `token_pickup` | **`token_pickup_v1`** | already correct; kept |
| `lock` | **fal-regen denser latch** | reject prior thin take (141 ms / ~88% silence); new ≤0.35 s, onset ~10–16 ms |
| `overcommit` | **fal-regen denser** | reject prior (~93% silence) |
| `token_drop` | **fal-regen denser** | single-take pool was thin; new sil ~2% |

All other stems remastered in place from #170 pool canonical / best `_v1` takes.

Fal model: `fal-ai/elevenlabs/sound-effects/v2`, `duration_seconds ≥ 0.5` then trim, `prompt_influence` ~0.35–0.45.

## Peak / silence summary (after)

See commit message table. Target: all peaks ≤ -1.0 dB; lock/overcommit/deposit/token_drop materially denser than tip `3230c1fa`.
