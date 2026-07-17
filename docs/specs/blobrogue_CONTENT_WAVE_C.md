# BlobRogue Content Wave C — Implementation Canon

Status: implemented on catalog version `3`, stacked on Wave B (`2`), Wave A (`1`), and legacy (`0`).
Numeric source of truth: `docs/specs/blobrogue_CONTENT_WAVE_C_FILL.md` (Quill FINAL, consumed via
PR #158 — Lamplighter COMMON, 1C / 2R / 1L). This document records HOW the fill was built; the
fill owns the numbers. Wave C is **guns-only (+4)**: no new blessings, program mix stays
**8 identity / 2 support**.

## Weapons (each a distinct room verb; one isolated field)

| Name | Verb | Field | Rarity | stackCategory | Boss coef |
|---|---|---|---|---|---|
| HUSHIRON | ROOT / RAMP | `stance` | rare | `stance_ramp` | 0.72 |
| BACKTALK | PARRY / RETURN | `parry` | rare | `parry_active` | 0.90 stub / 0.65 return |
| LAMPLIGHTER | RELIGHT | `relight` | **common** | `light_edit` | 0.65 |
| FAULTLINK | LINK / SHARE | `faultlink` | legendary | `link` (shares cap2 with Resonant Fork) | 0.70 |

- HUSHIRON: standing still ≥0.25s ramps 1 stance stack / 0.40s (max 5). Stacks tighten spread
  (`×(1 − 0.08×stacks)`, floored at 0), add pierce (`+floor(stacks/2)`, cap +2, shares
  `CAPS.pierce`), and grow bulletRadius (`+floor(stacks/3)` → +1px at 3+). There is **NO damage
  multiplier from stacks** (Quill hard rule). Moving >40px/s vents 1 stack / 0.15s; a dash clears
  all. Flusher vulnerability: a ramped (stacks ≥3) rooted owner takes a flat +1 from an enemy hit
  and the stance is flushed — a readable counter to camping the ramp.
- BACKTALK: holding fire while ready opens a frontal 90° catch window (0.20s hold → 0.35s open).
  A legal catch (an enemy bullet, damage ≥1; boss mechanic hazards are enemies/effects, never
  plain bullets, so they can never be caught, and ally shots are friendly and excluded) arms a
  RETURN for 3.0s and starts the 4.5s cooldown ON THE CATCH only. The next fire throws the caught
  shot back (`pelletGroup: backtalk_return`) at 1.15× the caught damage, clamped to [1.5, 6],
  speed 500 / life 0.90 / pierce 0. An empty ready trigger fires the feeble stub
  (`pelletGroup: backtalk_stub`, 0.286 PU); a missed/expired window input-locks 0.10s (no CD refund).
- LAMPLIGHTER: a shot that travels ≥40px through warm light (a live Carry-the-Light aura or an
  Undertow warm-pulse carry — the objective light source) latches +1 pierce (shares `CAPS.pierce`)
  and, on its first enemy hit or wall, plants a safe patch (r=22, life 1.2s). A patch shields a
  standing player from FLOOR-HAZARD damage (like a temporary Pathmaker pave) but NEVER deletes a
  hazard, boss tell, or pave. Max 3 live patches / owner; oldest despawns. Unlit shots are plain.
- FAULTLINK: a primary hit (`pelletGroup: fault_primary`, 0.978 PU) marks endpoint A (3.0s); a
  further primary hit on a distinct body forms a fixed 5.0s A↔B link (≤300px + LOS both ends,
  breaks on LOS loss / range / death). While linked, a primary hit on one endpoint echoes
  (`pelletGroup: fault_echo`) a fraction of its damage onto the other — room 0.25 / boss 0.15 —
  with no crit / status / proc / recurse, rate-clamped ≤4/s and same-target-repeat 0.25.

## Anti-degenerate safety (Quill locks)

`src/sim/antiDegenerate.ts` holds the GD-canonical `stackCategory` registry (now Wave A + B + C),
the same-category cap (2), and the shared runtime proc-window clamp (≤4/s/player/target, overflow
discarded). Faultlink echoes route through that clamp AND a tighter 0.25 same-target-repeat window
(`WAVE_C_FAULT_ECHO_REPEAT`). Faultlink shares the `link` category with Resonant Fork by design so
A+B+C can never triple-link the same endpoint (owner1 / party2 / endpoint1).

## Combo taxes (bonus channel only)

- Faultlink × Resonant Fork: both `link` (cap2 allows both owned); if both link the same endpoint,
  50% tax on the Faultlink echo channel (endpoint1 hard rule).
- Backtalk × Margin Call: `parry_active` × `reflect_passive` — 50% tax on the Backtalk return coef
  when combined return surplus >1.35.
- Lamplighter × Carry the Light: `light_edit` × `objective_support` — 40% tax on patch LIFE while
  both live (implemented: a lit patch under a Carry-the-Light aura burns 40% faster).
- Lamplighter × Pathmaker: `light_edit` × `route` — 45% tax on patch PLANT RATE when a plant would
  overlap pave at the patch cap (implemented: a deterministic 45% skip on an over-cap paved plant).
- Faultlink × Crosscurrent: 55% tax on Crosscurrent jumps that ride fault echoes (reconfirmed;
  Crosscurrent already routes its jump channel through the shared tax family).

## Authority / protocol

Catalog version is authoritative and immutable per run; browser/ticket cannot author it. Legacy
(`0`), Wave A (`1`), and Wave B (`2`) arrays are never edited. All four verbs are server-owned
TRANSIENT combat state (sub-10s, `playerSnapshot` ServerOnlyField), never reconciled on the wire —
a resume rebuilds them from live inputs. The wire SHAPE is unchanged; `PROTOCOL_VERSION` advances to
`44` only so a pre-v44 client gets a clean client-outdated rejection instead of decoding a `cat=3`
run. **Protocol race:** PROTOCOL 42 is reserved by Claimant F70 and 43 by Wake F80 — Wave C skips
both and takes 44. Merge must follow Claimant (42) + Wake (43); rebase onto that tip before undraft
if they land first.

PVP remains OFF: all four weapons are `pvpUnsupportedWeaponIds` (fail-closed on acquire/equip/fire).
Wave C adds no blessings, so the PvP draft pool is unchanged.

## Boss rewards (Wave C ship)

Permanent boss-clear reward leads routed with catalog `3` (`BOSS_SIGNATURE_WEAPON`): Jet → Oddsmaker,
Tithe → Sluicegate, Quorum → **Faultlink** (the new wiring), Gorge → Breach. No other reward remaps.

## Balance provisional (BALANCER_TODO)

Per-shot damage / cadence / boss coefficients are Quill FINAL. Implementation-detail geometry tuned
against the arsenal QA harness, left provisional for playtest:
- Hushiron / Backtalk declare non-floor-bound target profiles (`pack` / `control`) so the boss
  sustained-PU FLOOR (for single/anchor/lane generalists) does not misprice their low-DPS verbs —
  their power is accuracy/pierce and reactive return, priced by their boss coefficients.
- The Hushiron flusher vulnerability is scoped by the FILL to hits that DISPLACE ≥24px; the central
  damage funnel carries no displacement, so this pass applies the +1 flush to enemy-sourced hits
  while ramped and documents the approximation for the balancer gate.
- Lamplighter's lit-path source is any live Carry-the-Light aura or Undertow warm-pulse carry (a
  real, deterministic warm-light source). A generic "objective light" layer can widen this later.
- Backtalk uses a logical trigger (hold-fire opens the window; the next fire throws the return); no
  spare alt-fire input exists in the current scheme (mirrors Wave B's Red Pen refire trigger).

## What still blocks ship

- Art: held/pickup sprites for the four weapons (typed asset hooks only; no PNGs generated).
- Audio: authored takes for the new fire/parry/return/patch/link cues (typed silent hooks only).
- Human play approval (Ian + Anson playtest), and the external TD / GD / balancer gates.
