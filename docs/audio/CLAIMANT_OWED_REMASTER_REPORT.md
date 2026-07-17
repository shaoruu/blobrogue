# Claimant ALL THINGS OWED denser reselect (PR #175)

Story: **ALL THINGS OWED** (never CROWNFALL).

## Pipeline

- `loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.89:level=disabled` on all 16 stems
- onset pad **5–15 ms**; peak ≤ **-1.0 dB**

## Vale swaps / denser fal

| stem | take |
| --- | --- |
| deposit | fal denser (pool deposit_v1 sil>70 after remaster) |
| fail | fail_v2 |
| guard_chip | guard_chip_v3 (denser of v2/v3) |
| tell | tell_v1 |
| token_pickup | token_pickup_v1 (kept) |
| lock | fal lock_r4_v2 + compress densify ≤0.35s |
| overcommit | fal overcommit_r2_v3 |
| token_drop | fal token_drop_r2_v2 |

Fal: `fal-ai/elevenlabs/sound-effects/v2`, dur≥0.5 trim, influence 0.35.

## Peak / onset / silence

| stem | dur | peak dB | onset ms | sil% |
| --- | ---: | ---: | ---: | ---: |
| `death` | 2.2 | -1.42 | 8.4 | 51.4 |
| `deposit` | 0.521 | -1.66 | 10.0 | 13.8 |
| `descent` | 0.597 | -1.3 | 7.6 | 28.8 |
| `entrance` | 1.4 | -1.81 | 7.5 | 14.7 |
| `fail` | 0.547 | -1.45 | 10.0 | 27.4 |
| `guard_chip` | 0.282 | -1.5 | 7.7 | 7.8 |
| `lock` | 0.34 | -1.36 | 10.0 | 22.7 |
| `overcommit` | 0.547 | -1.72 | 7.2 | 2.9 |
| `phase` | 1.2 | -2.52 | 9.4 | 10.7 |
| `punish` | 0.847 | -1.32 | 7.9 | 59.0 |
| `recover` | 0.697 | -1.49 | 10.0 | 65.8 |
| `socket_light` | 0.447 | -1.88 | 9.4 | 67.2 |
| `tell` | 1.4 | -1.3 | 9.5 | 51.2 |
| `token_drop` | 0.401 | -3.31 | 7.1 | 13.4 |
| `token_pass` | 0.422 | -1.11 | 7.1 | 38.2 |
| `token_pickup` | 0.347 | -1.71 | 8.5 | 9.8 |

Do **not** merge until Vale EAR passes.
