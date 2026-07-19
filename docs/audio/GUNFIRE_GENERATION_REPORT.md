# Wave B/C silent gun-fire — Generation Report (Vale)

Playtest gap (Ian: Margin Call silent) → audit found a **cluster of 10 registered-but-silent events** (`takes: []`, no stem on disk, no fallback), plus 1 new proposed cue.

- **Model:** fal-ai/elevenlabs/sound-effects/v2 @ influence 0.35
- **Pipeline:** 0.55s gen → trim to target; loudnorm I=-16 + alimiter=.89 → peak-normalize to −2.5 dBTP; onsets trimmed to ~8–14ms; ogg (libvorbis q5) + mp3 (q4) mono 44100
- **Peaks:** all ≤ −2.0 dBTP (under 0.89 contract), verified 0 over −0.9 dB

## Shipped stems (identity-matched)
| stem | event | gun / role |
|---|---|---|
| mooring_nail_fire | shootMooringNail | anchor-nail pneumatic crack + cable snap |
| sluicegate_fire | shootSluicegate | pressurized water burst |
| oddsmaker_fire | shootOddsmaker | gilded gamble shot + dice rattle |
| pathmaker_fire | shootPathmaker | soft paving bead plip (fast cadence) |
| resonant_fork_fire | shootResonantFork | violet tuning-fork ping shot |
| red_pen_fire | shootRedPen | sharp red pen-click snap |
| margin_call_fire | shootMarginCall | gilded copy round + faint doubled echo tail |
| sidewinder_fire | shootSidewinder | curving green flank whoosh |
| red_pen_snap | red_pen.snap | rewrite mark-consume ink snap |
| resonant_fork_link | resonant_fork.link | sympathetic harmonic tune-in |
| margin_call_echo | margin_call.echo (NEW) | COPY-ONE stored-payload echo (distinct 2nd voice) |

## margin_call SPECIAL answer
COPY-ONE echo currently has **no cue**. It SHOULD — the echo/stub fire is a distinct mechanic beat and reads as silent-doubling without it. Shipped `margin_call_echo` as a candidate; needs a new `margin_call.echo` waveSpec row + trigger on the echo/stub fire path (Helix). If you'd rather the stub reuse `shootMarginCall`, drop the echo stem — but a distinct 2nd-voice sells COPY-ONE better.

## Notes
- Single variant per stem (playtest-fix speed). More variants later if wanted.
- cleaver/scrapper/skipper/arcbolt/cryobolt/firebomb/tracker/singularity were NOT silent (they have sample fallbacks) — left alone. Wave C 4 guns already shipped.
