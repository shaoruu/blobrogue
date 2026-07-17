# Wake THE LAST PROCESSION — Selected+Remaster Generation Report

- build_id: `wake_procession_selected_remaster_2026_07_16`
- batch: `wake-procession-v1-selected`
- story: **THE LAST PROCESSION**
- verdict: `SHIP_SELECTED_REMASTER_V1`
- supersedes: PR #171 (candidate dump with `_vN`)

## Mix contract
- `highpass=f=35,loudnorm=I={-14|-16|-18}:TP=-2.5:LRA=11,alimiter=limit=0.85` (+ hard scale if needed)
- Peak must be **< 0.89** (not digital clip 1.00)
- Canonical filenames without `_vN`

## Rejected
- `front_v3` — DROP
- `fail_v1` — DROP (84% silence); ship `fail_v2`
- sparse `lock` — regen denser v6 ≤0.35s

## Selected takes (`selected_takes`)

| Event | Shipped | Take | Dur | Peak | Silence | Onset |
| --- | --- | --- | --- | --- | --- | --- |
| wake.processionEntrance | `wake_procession_entrance.ogg` | entrance (sole) | 1.500s | 0.748 | 28.8% | 9.0ms |
| wake.processionPhase | `wake_procession_phase.ogg` | phase (sole) | 1.300s | 0.738 | 46.8% | 9.0ms |
| wake.processionDeath | `wake_procession_death.ogg` | death (sole) + onset trim | 2.400s | 0.766 | 21.6% | 9.0ms |
| wake.processionTell | `wake_procession_tell.ogg` | tell_v2 (rej v1) | 1.500s | 0.742 | 41.9% | 9.0ms |
| wake.processionLock | `wake_procession_lock.ogg` | lock_regen_v6 denser ≤0.35s (rej sparse lock) | 0.355s | 0.716 | 49.4% | 12.0ms |
| wake.processionFront | `wake_procession_front.ogg` | front_v1 (DROP front_v3) + onset trim | 0.849s | 0.742 | 54.6% | 9.0ms |
| wake.processionPunish | `wake_procession_punish.ogg` | punish (sole) + onset trim | 0.878s | 0.722 | 65.8% | 15.0ms |
| wake.processionRecover | `wake_procession_recover.ogg` | recover (sole) | 0.754s | 0.736 | 43.8% | 9.0ms |
| wake.processionFail | `wake_procession_fail.ogg` | fail_v2 (DROP fail_v1) | 0.549s | 0.743 | 32.5% | 9.0ms |
| wake.processionBierPulse | `wake_procession_bier_pulse.ogg` | bier_pulse_v1 | 0.399s | 0.742 | 11.9% | 9.0ms |
| wake.processionBierAdvance | `wake_procession_bier_advance.ogg` | bier_advance_v1 | 0.549s | 0.575 | 25.4% | 9.0ms |
| wake.processionBlockerHighlight | `wake_procession_blocker_highlight.ogg` | blocker_highlight_v1 + onset trim | 0.367s | 0.708 | 51.7% | 15.0ms |
| wake.processionBlockerBreak | `wake_procession_blocker_break.ogg` | blocker_break_v2 denser | 0.549s | 0.745 | 48.4% | 9.0ms |
| wake.processionThreshold | `wake_procession_threshold.ogg` | threshold (sole) | 0.649s | 0.766 | 32.6% | 9.0ms |
| wake.processionShelter | `wake_procession_shelter.ogg` | shelter (sole) | 0.399s | 0.740 | 50.0% | 15.0ms |
| wake.processionShadowWarn | `wake_procession_shadow_warn.ogg` | shadow_warn_v1 | 0.704s | 0.734 | 19.3% | 9.0ms |

## Notes
- BierPulse is a sparse one-shot, never a loop bed.
- **NIGHTFALL_PROCESSION** stays retired forever.
