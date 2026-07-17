# Claimant ALL THINGS OWED remaster + denser reselect (PR #175)

Story: **ALL THINGS OWED** (never CROWNFALL).

Follow-up denser remaster for Vale ear-hold on deposit/lock/overcommit/token_drop.

## Pipeline

- `loudnorm=I=-14|-16|-18:TP=-1.5:LRA=11,alimiter=limit=0.89:level=disabled`
- onset align **5–15 ms**; active-body crop on fal-regen combat cues
- encode: libvorbis `-q:a 5` + libmp3lame `-b:a 192k`
- gate: **peak ≤ -1.0 dB**; combat silence preferably **<70%**

## Selection

| stem | source |
| --- | --- |
| `entrance` | pool entrance |
| `phase` | pool phase |
| `death` | pool death |
| `tell` | swap tell_v1 (#170) |
| `lock` | fal-regen denser latch (r5_v4 cropped≤0.35s) |
| `descent` | pool descent_v1 |
| `punish` | pool punish |
| `recover` | pool recover |
| `fail` | swap fail_v2 (#170) |
| `token_pickup` | keep token_pickup_v1 |
| `token_pass` | pool token_pass_v1 |
| `token_drop` | fal-regen denser (r2_v2) |
| `socket_light` | swap socket_light_v1 denser |
| `deposit` | fal-regen denser (pool deposit_v1 still >70% sil) |
| `guard_chip` | swap guard_chip_v3 densest |
| `overcommit` | fal-regen denser (r2_v3; reject ~93% sil) |

## Metrics

| stem | peak_dB | onset_ms | sil% | dur_s |
| --- | ---: | ---: | ---: | ---: |
| `entrance` | -1.8 | 7.5 | 14.7 | 1.4 |
| `phase` | -2.6 | 7.9 | 10.8 | 1.2 |
| `death` | -1.5 | 7.9 | 51.4 | 2.2 |
| `tell` | -1.3 | 8.0 | 51.2 | 1.4 |
| `lock` | -1.6 | 10.0 | 22.9 | 0.34 |
| `descent` | -1.3 | 7.6 | 28.6 | 0.597 |
| `punish` | -1.2 | 7.8 | 59.1 | 0.847 |
| `recover` | -1.5 | 10.0 | 65.9 | 0.697 |
| `fail` | -1.4 | 10.0 | 27.4 | 0.547 |
| `token_pickup` | -2.4 | 8.0 | 9.6 | 0.347 |
| `token_pass` | -1.1 | 7.1 | 38.1 | 0.422 |
| `token_drop` | -2.7 | 7.0 | 12.9 | 0.401 |
| `socket_light` | -1.7 | 9.3 | 67.3 | 0.447 |
| `deposit` | -1.7 | 10.0 | 13.9 | 0.521 |
| `guard_chip` | -1.5 | 7.5 | 7.6 | 0.282 |
| `overcommit` | -1.8 | 7.2 | 2.9 | 0.547 |

Notes:

- `deposit`: pool `deposit_v1` still thin after remaster → fal-regen denser.
- `lock` ≤0.35 s denser latch; onset in 5–15 ms band.
- `overcommit` fal-regen densest (reject prior ~93% silence).
- `token_drop` fal-regen denser body.
- `fail` ← `#170` `fail_v2`; `tell` ← `tell_v1`; `guard_chip` ← densest `v3`; `socket_light` ← denser `v1`; `token_pickup` kept v1.

**Do not merge** until Vale ear-pass.
