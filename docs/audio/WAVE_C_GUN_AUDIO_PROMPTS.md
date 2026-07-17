# Wave C gun audio prompt sheet (Hushiron / Backtalk / Lamplighter / Faultlink)

Status: **generation-ready prompt sheet** for the 8 silent `takes: []` hooks in `src/game/waveSpec.ts`.
Art for Wave C guns is in flight separately. **No generation until Vale marks batches coherent.**

Story names everywhere (Rule A). Wire IDs stay lowercase (`hushiron`, `backtalk`, …); display / stems / event labels use story names below.

## 0. Decisions
Model: `fal-ai/elevenlabs/sound-effects/v2`; output request `pcm_44100` where available, otherwise `mp3_44100_192`; final ship `.ogg` + `.mp3`.
Global gameplay suffix: `single isolated one-shot, dry, immediate readable transient, no music, no ambience, no long reverb, mono, dark-fantasy video game sound effect`.
Prompt influence: **0.35 combat** (all rows below are combat). Generate `variants` independent takes (EL has no seed).
Ship path: a stem `sfx/x` → `public/audio/sfx/x.ogg` + `.mp3` (`_v1.._vN` when variants > 1).
Contract: `isSynthForbidden` — authored stem → shipped-sample DERIVE fallback → **silence** (never oscillator). Authored playback jitter ≤ ±5%.
Generic `enemyHit` covers body impact; these 8 stems are the **identity** gaps only. No per-gun ult rows for Wave C (kit ults stay on the shared ult cue layer).

**Batch:** `wave-c-guns-v1` — all 8 rows. Coherent when every row has event + stem + dur + gain + duck + var + exact EL prompt, and stems match `waveSpec.ts`.

## 1. Sonic identities (keep separable blind)
| Gun | Story / verb | Material |
|---|---|---|
| **Hushiron** | ROOT / RAMP | rooted iron slug; dry suppress; stance tightens the shot (no dmg mult) |
| **Backtalk** | PARRY / RETURN | snappy catch window + thrown return; stub is thin, return is heavy |
| **Lamplighter** | RELIGHT | warm amber bead; patch is a soft light-plant, not an explosion |
| **Faultlink** | LINK / SHARE | conductive snap-link; primary is sharp, link is a taut wire latch |

Never share Lastlight's hungry surge, Breach's siege spring, Snapwire's tripwire, or Resonant Fork's fork chime. Faultlink must read **different** from Resonant Fork (Faultlink = brittle fault-line latch; Fork = resonant tine).

## 2. Prompt rows (the 8 silent stems)

|event|file|dur|gain|duck|var|decision + exact EL prompt|
|---|---|---:|---:|---|---:|---|
|`shootHushiron` each primary|`sfx/hushiron_fire`|0.42|.62|music:.85/.05/.2|3|NEW: `A rooted iron hush-slug fires from a grounded stance rifle, dry suppressed crack, short heavy body and tight air punch, readable as a planted accurate shot not a sniper boom, [suffix]`|
|`shootBacktalk` ready stub|`sfx/backtalk_fire`|0.36|.60|music:.85/.05/.2|3|NEW: `A thin sarcastic stub round snaps from a parry sidearm, light dry crack and short metallic spit, deliberately weaker than the return shot, [suffix]`|
|`backtalk.parry` catch window opens / successful catch|`sfx/backtalk_parry`|0.32|.72|music:.7/.08/.25|2|NEW: `A frontal parry window catches an incoming shot, sharp glass-metal latch and short reverse tick, clear successful catch cue, no explosion, [suffix]`|
|`backtalk.return` thrown return shot|`sfx/backtalk_return`|0.48|.70|music:.75/.08/.3|3|NEW: `A caught round is thrown straight back as a heavy return shot, doubled dry report with a bright reverse whip and short metallic ring, heavier than the stub, [suffix]`|
|`shootLamplighter` each primary|`sfx/lamplighter_fire`|0.38|.58|music:.85/.05/.2|3|NEW: `A warm amber lamplighter bead fires from a small relight gun, soft crystalline tick and short radiant hiss, cozy light bullet not electric, [suffix]`|
|`lamplighter.patch` warm light patch plants|`sfx/lamplighter_patch`|0.55|.50|—|2|NEW: `A warm amber light patch plants on stone, soft glowing bloom, tiny glass settle and gentle warmth pop, safe light puddle not a blast, [suffix]`|
|`shootFaultlink` each primary|`sfx/faultlink_fire`|0.34|.66|music:.85/.05/.2|3|NEW: `A legendary faultlink injector fires a sharp conductive slug, brittle crack and short voltage spit along a hairline fault, precise and dry, not a Tesla arc, [suffix]`|
|`faultlink.link` A↔B link latches|`sfx/faultlink_link`|0.45|.55|music:.8/.06/.25|2|NEW: `Two marked endpoints snap into a taut fault-line link, dry wire latch and short resonant fault ping, conductive connection cue, no continuous hum, [suffix]`|

## 3. waveSpec binding (already registered; `takes: []` today)
|event|stem|gain (waveSpec)|bus|notes|
|---|---|---:|---|---|
|`shootHushiron`|`sfx/hushiron_fire`|.62|sfx|WEAPON_AUDIO.release|
|`shootBacktalk`|`sfx/backtalk_fire`|.60|sfx|WEAPON_AUDIO.release (stub)|
|`backtalk.parry`|`sfx/backtalk_parry`|.72|sfx|impact priority|
|`backtalk.return`|`sfx/backtalk_return`|.70|sfx|weapon priority|
|`shootLamplighter`|`sfx/lamplighter_fire`|.58|sfx|WEAPON_AUDIO.release|
|`lamplighter.patch`|`sfx/lamplighter_patch`|.50|sfx|impact priority|
|`shootFaultlink`|`sfx/faultlink_fire`|.66|sfx|WEAPON_AUDIO.release|
|`faultlink.link`|`sfx/faultlink_link`|.55|sfx|impact priority|

## 4. Selection / mix notes
- Hushiron fireCd 0.36s → keep takes short; variants must not smear into buzz on stance-ramped fire.
- Backtalk stub vs return must be **blind-ID'able** (stub thin/high; return heavy/low-mid).
- Lamplighter patch is proximity-readable utility; never duck music hard.
- Faultlink fireCd 0.18s → shortest transient of the four; link is rarer (A→B latch) so can ring slightly longer.
- Do **not** author echo/impact/ult stems in this batch (echo rides silent damage; impact = shared enemyHit).

## 5. Retired / forbidden
- No CROWNFALL / NIGHTFALL naming bleed into gun stems.
- No Resonant Fork chime reuse for Faultlink.
- No Carry-the-Light blessing stem reuse for Lamplighter patch (patch is gun-authored).

Vale owns generation, selection, mastering, and approval. Ping blobrogue when `wave-c-guns-v1` is coherent for gen.
