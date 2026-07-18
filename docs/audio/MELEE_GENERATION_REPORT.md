# Melee juice + verbs — Generation Report (Vale)

- **Batch:** `melee-juice-verbs-v1` (13 stems)
- **Model:** fal-ai/elevenlabs/sound-effects/v2 @ influence 0.35
- **Gen:** 0.55s floor → trim to sheet dur; loudnorm I=-16 + alimiter=.89, then peak-normalize to −2.5 dB true-peak; leading silence trimmed to ~11–15ms onset; ogg (libvorbis q5) + mp3 (q4), mono 44100
- **Peaks:** all ≤ −2.3 dB true-peak (well under 0.89 contract) — verified 0/29 over −0.9 dB
- **Selection:** best take per stem by onset + body(RMS); late-onset picks (cleave/stagger/finisher/momentum_payoff) re-trimmed to ~12ms

## Shipped (canonical, story-names)
| event | stem | dur | role |
|---|---|---|---|
| melee.cutlassSwing | melee_cutlass_swing | 0.21 | sword swing |
| melee.claymoreSwing | melee_claymore_swing | 0.31 | longsword swing |
| melee.pikeThrust | melee_pike_thrust | 0.21 | spear thrust |
| melee.cutlassHit | melee_cutlass_hit | 0.21 | sword impact |
| melee.claymoreHit | melee_claymore_hit | 0.29 | longsword impact (meaty low-freq) |
| melee.pikeHit | melee_pike_hit | 0.21 | spear skewer pop |
| melee.cleaveShock | melee_cleave_shock | 0.47 | coalesced heavy shockwave |
| melee.crit | melee_crit | 0.24 | crit sing layer |
| melee.staggerPulse | melee_stagger_pulse | 0.44 | stagger_pulse ring |
| melee.bladeWard | melee_blade_ward | 0.50 | blade_ward self-cue |
| melee.momentumReady | melee_momentum_ready | 0.34 | momentum banked tell |
| melee.momentumPayoff | melee_momentum_payoff | 0.34 | momentum lunge hit |
| melee.finisher | melee_finisher_execute | 0.57 | finisher execute stinger |

Durations run slightly over sheet targets (min trim + 8ms pad); all still short one-shots, no long tails.

## Notes
- cleave_crit ships NO new stem — reuses melee_crit + melee_cleave_shock per packet.
- finisher rides blessingProc{item:"finisher",phase:"execute"} (kill-gated).
- Single variant shipped per stem (identity pass); more variants can follow if playtest wants.
