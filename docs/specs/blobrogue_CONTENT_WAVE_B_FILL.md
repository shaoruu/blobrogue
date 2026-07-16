# BlobRogue Content Wave B — Numeric Fill (Quill FINAL)

Status: **FINAL for build** (Ian+Anson playtest). Identities CANON (GD/Rook) — no redesign.
Authority: Quill owns numbers. Safety locks below are **do not reopen**.
Amended: adopts Rook Wave A locked baselines + GD-canonical `stackCategory` seeds (2026-07-16).

Sources: main PROTOCOL 34 / catalog1; #142 gate c32a460 PU measurements; `balance.ts` PU contract.
Wave A runtime note: `stackCategory` is **not yet a runtime field** on Wave A — GD labels below are the enforceables for A+B cap2 / combo tax until wired.

Baselines (Wave A, locked):
- Mooring **0.267 PU** · Sluice FLOOD 0.394 / DRAIN 0.628 / **avg 0.511** · Oddsmaker **0.495** · Pathmaker **0.220**
- Envelope: `PU_DPS=12.5`; specialist ≤**1.35 PU**; secondary first **0.60** / later **0.35**; sameTargetRepeat ≤**0.35**; proc ≤**4/s/player/target**; same-cat **cap 2**
- Identity blessing band: Lv1 +10–18% ST or +15–25% room/utility; Lv2 = 35–50% of Lv1 raw; Lv3 = 20–35% of Lv1 raw + qualitative
- Support/flat: Lv1 +5–8% → Lv3 +15–18% hard max, into raw caps never above
- Raw caps: dmg 2.25× / fire 1.80× / move 1.35× / maxHP +4 / blessing pierce +3 / elemental 50%
- Gun rarity ladder unchanged: C10 / R5 / L1; Wave A intentional **1C / 2R / 1L**

## Locked safety (global — apply to every Wave B item)

| Rule | Value |
|---|---|
| `stackCategory` | required; **same-cat cap = 2** (GD labels) |
| `sameTargetRepeat` | ≤ **0.35** of that system's realized DPS may re-hit the same target within 1.0s after first legal hit |
| Secondary scoring | first secondary body × **0.60**; later × **0.35** |
| Proc rate | ≤ **4 /s / player / target** (hard clamp; overflow discarded) |
| Safety-removing combo | any 2-system combo that removes a safety rail pays **40–60%** on the combined surplus above 1.00 PU |
| Trigger / pelletGroup | every shot uses a **logical trigger** + named `pelletGroup` |
| Program mix | **8 identity / 2 support** — Wave A support = Shared Rope; Wave B support = **Carry the Light only**; Remember Me is **identity** (sustain converter) |

## Wave A stackCategory (GD-canonical — for A+B audit)

| id | stackCategory |
|---|---|
| mooring_nail | `position` |
| sluicegate | `modeshift` |
| oddsmaker | `gamble` |
| pathmaker | `route` |
| hold_fast | `stability` |
| nothing_wasted | `reclaim` |
| second_breath_muddy | `dash_refund` |
| on_the_beat | `cadence` |
| shared_rope | `revive` |

## Combo gate (Wave A × Wave B)

**CONFIRM: no WaveA+WaveB 2-system combo exceeds 1.35 PU without a 40–60% tax.**

| Pair (A × B) | Peak specialist PU (untaxed model) | Gate |
|---|---:|---|
| Sluicegate × Resonant Fork | 1.18 | PASS |
| Oddsmaker × Margin Call | 1.52 | **TAX 50%** — COPY cannot store `gamble` payloads (rejected → stub) |
| Oddsmaker × Last Warm Round | 1.48 | **TAX 45%** on cycle-final bonus only |
| Tesla/Arcbolt/Cleaver/Skipper/Sluice-DRAIN × Crosscurrent | 1.62 | **TAX 55%** on Crosscurrent jump damage when pair >1.35 |
| Mooring × Sidewinder | 0.72 | PASS |
| Pathmaker × Known by Touch | 0.41 | PASS (utility) |
| Shared Rope × Carry the Light | n/a (support) | PASS — distinct cats (`revive` vs `objective_support`); Light never multiplies Rope channel authority |
| On the Beat × Last Warm Round | 1.29 | PASS (fire-rate raw cap 1.80 binds) |
| Nothing Wasted × Red Pen | 0.55 | PASS |
| Hold Fast × Red Pen | n/a | PASS |

Tax: multiply the *offending system's* bonus channel by `(1 − tax)` when the pair is live; do not silently lower base weapon DPS.

---

## 1) Resonant Fork — TUNE (gun)

| Field | Value |
|---|---|
| `stackCategory` | **`link`** (GD) — one link / owner |
| Rarity | **rare** |
| Fire interval | **0.34 s** |
| Primary | dmg **2.0**, pellets **1**, speed **580**, life **0.95**, radius **5**, spread **0**, `pelletGroup: fork_primary` |
| Primary DPS coef | **0.47 PU** (= 2.0/0.34/12.5) |
| Link (secondary) | on primary hit → tune link to nearest other enemy in LOS within max range; **one link/owner** |
| Max range / LOS | **220 px**, **LOS both ends**; breaks on LOS loss |
| Duration | **2.4 s** |
| Tick rate | **0.20 s** (12 ticks) |
| Link tick damage | **0.55** (`pelletGroup: fork_link`) |
| Link DPS coef | raw **0.22 PU**; scored **0.132 PU** @ 0.60 first-secondary |
| Combined specialist | **~0.60 PU** |
| `sameTargetRepeat` | re-ticks on same target in 1s window at **0.35** after first |
| Secondary? | **YES** — link only |
| Boss coef | **0.70** |
| Proc | link ticks count toward ≤4/s/player/target |

---

## 2) Red Pen — SET / REWRITE (gun)

| Field | Value |
|---|---|
| `stackCategory` | **`mark_detonate`** (GD) |
| Rarity | **rare** |
| Base fire (ink) | dmg **1.6**, pellets **1**, speed **640**, life **1.05**, `fireCd` **0.22 s**, `pelletGroup: pen_ink` (marks on hit) |
| Mark duration | **3.0 s** (refresh on re-mark; one mark / target / owner) |
| WeaponSkill | **REWRITE SNAP** — consume mark on aimed target (logical trigger) |
| Snap coef | **2.8×** marked target's last `pen_ink` hit damage (~**4.5** from base 1.6) as `pelletGroup: pen_snap` |
| WeaponSkill CD | **5.5 s** (starts on **successful** snap only) |
| Miss / immune | fail-closed if: no mark, expired, dead, boss-phase immune / earned GUARDED, or no LOS → no damage, no CD, 0.15s input lock |
| Boss coef | snap **0.65**; ink **0.85** |
| Specialist PU | ink ~0.58 + snap avg ~0.07 → **~0.65 PU** |
| `sameTargetRepeat` | cannot snap same target more than once per mark instance |

---

## 3) Margin Call — COPY-ONE (gun)

| Field | Value |
|---|---|
| `stackCategory` | **`reflect_passive`** (GD; ≠ Backtalk `parry_active`) |
| Rarity | **legendary** |
| Category map (storeable) | `slug`, `spread`, `pierce`, `blast`, `seeker`, `status` — **exactly one** stored class |
| Store | next committed shot from **another owned weapon** writes category + damage + pelletCount + special flags; replaces prior |
| Store TTL | **8.0 s** from write; expires clean |
| Output coef vs original | **0.70×** damage, **min(originalPellets, 3)** pellets; specials copied only if category allows |
| Loaded cadence | store live: `fireCd` **0.55 s**, `pelletGroup: margin_copy` |
| Empty cadence | `fireCd` **0.40 s**, stub dmg **1.2**, `pelletGroup: margin_stub` |
| Category specials | `spread`: pellets≤3, spread≤0.55; `pierce`: pierce≤2; `blast`: radius×0.70; `seeker`: turnRate×0.60; `status`: duration×0.70 |
| Blocked | **`gamble` / Oddsmaker payloads NOT storeable** → stub |
| Boss coef | copy **0.60**; stub **0.90** |
| Combo tax | if source would remove a safety rail OR (blocked gamble attempt path), **50%** on copy surplus |
| Specialist PU | stub ~0.24; typical copy ~0.30–0.55 → **≤1.10 PU** with tax |

---

## 4) Sidewinder — ENCIRCLE / FLANK (gun)

| Field | Value |
|---|---|
| `stackCategory` | **`flank_arc`** (GD) |
| Rarity | **common** |
| Fire interval | **0.48 s** |
| Per-arc coef | **1.35** damage per arc (rebalanced for **2-arc** authored volley) |
| Arc timing / geometry | **2 arcs** (GD: authored 2-arc; **no pellet multiply**), launched at **t=0 / 0.08 s**; each arc 110° curve, radius **90→130 px**, life **0.55 s**, speed equiv **420**; `pelletGroup: side_arc` index 0..1 |
| Aim | arcs bias to flank the aim point (left/right relative to aim), not straight line |
| Boss rear-vuln exclusion | **NO rear vulnerability vs boss-grade / captains / giants** — rear mult = **0** on those kinds |
| Room flank bonus | vs non-boss: +**25%** if impact angle within 50° of target rear |
| `sameTargetRepeat` | second arc into same target in same volley at **0.35** after first |
| Boss coef | **0.55** |
| Specialist PU | paper ~0.56; scored ~**0.48 PU** |
| Secondary? | second arc counts secondary for budgeting |
| Modifiers | rate/damage/size/status apply; **extraPellets must NOT add arcs** (authored 2 only) |

---

## 5) Crosscurrent — chain / pierce (blessing B2)

| Level | Chain jumps | Pierce add | Jump range | Jump dmg vs prior |
|---|---:|---:|---:|---:|
| Lv1 | **+1** | **+0** | **140 px** | **0.55×** |
| Lv2 | **+1** | **+1** | **160 px** | **0.60×** |
| Lv3 | **+2** | **+1** | **180 px** | **0.65×**; prefer a *new* target |

| Field | Value |
|---|---|
| `stackCategory` | **`chain_boost`** (GD) — logical trigger; jumps require **2 distinct enemies** |
| Rarity | **rare** |
| Pierce-cap | pierce add shares `CAPS.pierce` (**+3**). Excess jumps discarded (no damage). |
| Combo tax | with Tesla / Arcbolt / Cleaver / Skipper / Sluice DRAIN: if combined pierce+chain specialist PU > **1.35** → **55%** tax on jump damage only |
| Proc | each jump = 1 proc toward ≤4/s/player/target |
| `sameTargetRepeat` | cannot chain back to a target already hit by this projectile's pelletGroup |
| Identity band | Lv1 ~+16% room; Lv2 ~+45% of Lv1 raw + consistency; Lv3 qualitative prefer-new |

---

## 6) Last Warm Round — cycle-final signature (blessing B2)

| Field | Value |
|---|---|
| `stackCategory` | **`cycle_finale`** (GD) — **blocked until shared cycle** exists on the weapon |
| Rarity | **uncommon** |
| Signature | damage multiplier on the **final shot of a weapon's fire cycle** |
| Magnitude | Lv1 **+16%**, Lv2 **+24%**, Lv3 **+32%** (identity band; multiplicative on that shot only) |

### "Final shot in cycle" per family

| Family | Cycle | Final shot |
|---|---|---|
| `simple` | no shared cycle → **blocked** (blessing inert) until a cycle provider exists | — |
| `modeShift` (Sluicegate) | FLOOD→DRAIN | **DRAIN** |
| `gamble` (Oddsmaker) | single committed roll | that shot only if outcome ∈ {`pierce`,`blast`} |
| `charge` | charge release | release volley |
| `volley` (Hive etc.) | full volley | last pelletGroup |
| `weaponSkill` (Red Pen snap) | skill press | skill hit counts as final |
| `beam/hose` | 1.0 s hose window | last tick in each 1.0 s window |
| `melee` | each swing | swing hit |
| Fork / Sidewinder / Margin | authored as simple unless a cycle provider is added | **inert** (no free +% on every shot) |

| Combo tax | Oddsmaker / Sluicegate: if cycle-final bonus pushes pair >1.35 PU → **45%** tax on Warm Round bonus only |
| Proc | n/a |

---

## 7) Known by Touch — reveal (blessing B2)

| Level | Reveal dur | Radius | ICD |
|---|---:|---:|---:|
| Lv1 | **1.6 s** | **90 px** | **4.0 s** |
| Lv2 | **2.2 s** | **120 px** | **3.4 s** |
| Lv3 | **3.0 s** | **150 px** | **2.8 s** |

| Field | Value |
|---|---|
| `stackCategory` | **`reveal`** (GD) |
| Rarity | **common** |
| Kinds | stealthed enemies, stealthed hazards, hidden destructible props, boss-add spawn telegraphs (not boss HP/phases) |
| Trigger | dash end OR melee/weaponSkill hit; shared ICD |
| Combat PU | **0** direct |
| Support band | utility-only; no ST% |

---

## 8) Remember Me — lethal-save / sustain converter (blessing B2) [IDENTITY]

| Field | Value |
|---|---|
| `stackCategory` | **`lethal_save`** (GD; exclusive sustain converter) |
| Rarity | **rare** |
| On lethal-save | disable owner's highest-rarity **non-support** blessing for `disableDur` (Rare>Uncommon>Common; skip support; skip self; tie → lowest id) |
| Disable dur | Lv1 **6 s**, Lv2 **5 s**, Lv3 **4 s** (shorter = stronger) |
| Lethal-save exclusions | no save vs: boss execute/delete, pit/OOB, PvP, self-damage/thorns, already-downed, zero eligible blessings to disable |
| Reconnect | **once / floor**: if save consumed and reconnect within resume window → HP **1**, keep disable timer; **cannot re-arm** that floor |
| Save effect | HP → **1**, **0.80 s** post-hit invuln, start disable |
| Combat PU | **0** direct (identity sustain converter — once/floor exclusive vs other lethal saves) |
| Program role | **identity** (not support). Counts toward the 8-identity mix with Crosscurrent / Last Warm Round / Known by Touch. |

---

## 9) Carry the Light — objective / revive support (blessing B2) [SUPPORT — sole Wave B support]

| Level | Revive radius Δ | Revive channel rate Δ | Reload / swap ready Δ | Light radius |
|---|---:|---:|---:|---:|
| Lv1 | **+10 px** | **+12%** | swap CD remaining **−10%** on ally revive start | **70 px** |
| Lv2 | **+18 px** | **+20%** | **−18%** | **100 px** |
| Lv3 | **+26 px** | **+30%** | **−25%** + qualitative: **one free magazine-ready** (fireCd→0) for reviver on revive complete | **130 px** |

| Field | Value |
|---|---|
| `stackCategory` | **`objective_support`** (GD; ≠ Shared Rope `revive`) |
| Rarity | **uncommon** |
| Light | allies in light: **+8% move** (under move cap 1.35); downed in light: bleed-out **15% slower** |
| Solo fallback | `partySize==1`: no revive deltas; on dash restore **8%/12%/16%** of max weapon fireCd readiness (ICD **5 s**) + self light move buff |
| Combat PU | **0** direct |
| Support band | flat/support ceilings honored (revive rate +12→+30% is co-op utility, not ST%) |

---

## stackCategory registry (Wave B — GD seeds)

| Item | stackCategory | Cap |
|---|---|---|
| Resonant Fork | `link` | 2 |
| Red Pen | `mark_detonate` | 2 |
| Margin Call | `reflect_passive` | 2 |
| Sidewinder | `flank_arc` | 2 |
| Crosscurrent | `chain_boost` | 2 |
| Last Warm Round | `cycle_finale` | 2 |
| Known by Touch | `reveal` | 2 |
| Remember Me | `lethal_save` | 2 |
| Carry the Light | `objective_support` | 2 |

## Build IDs

```
resonant_fork, red_pen, margin_call, sidewinder,
crosscurrent, last_warm_round, known_by_touch, remember_me, carry_the_light
```

Catalog: Wave B = catalog **`2`** (Wave A remains `1`; legacy `0`). Do not mutate catalog `1` arrays.

## Diff vs prior Quill draft (this amend)

- **Remember Me reclassified → identity** (sustain converter). Wave B support = **Carry the Light only**. Mix: Wave A 4 identity + Shared Rope support; Wave B 4 identity (incl. Remember Me) + Carry the Light support → **8 identity / 2 support**.
- Adopted GD `stackCategory` seeds exactly (`link`, `mark_detonate`, `reflect_passive`, `flank_arc`, `chain_boost`, `cycle_finale`, `reveal`, `lethal_save`, `objective_support`).
- Sidewinder → **2 arcs** (was 3); per-arc dmg 1.15→**1.35**; no pellet-multiply.
- Last Warm Round: **inert on simple guns** until shared cycle (was ×0.55 on every simple shot); mag **+16/+24/+32%** (identity band).
- Wave A category table swapped to Rook GD labels (`position`/`modeshift`/`gamble`/`route`/…).
- PU baselines cited from #142 gate (Mooring 0.267 / Sluice avg 0.511 / Odds 0.495 / Path 0.220); godBuild measured **46.953**.

## Sign-off

Quill FINAL numbers for Ian+Anson playtest Wave B fill.
Remember Me = **identity**; Carry the Light = sole Wave B support. Mix 8/2 holds.
Safety locks honored; combo gate reconfirmed unchanged (3 taxed pairs).
Batch0 / Sever may proceed; Wave B cloud consumes this table as numeric source of truth.
