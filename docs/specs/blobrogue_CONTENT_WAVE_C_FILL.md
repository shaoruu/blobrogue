# BlobRogue Content Wave C — Numeric Fill (Quill FINAL)

Status: **FINAL for build** (Ian+Anson playtest). Identities CANON (GD/Rook Wave C stamp) — no redesign.
Authority: Quill owns numbers. Safety locks below are **do not reopen**.
Scope: **guns only +4**; catalog **`3`**; **no new blessings**. Wave A+B program mix remains **8 identity / 2 support**.

Sources: Wave A+B closed (`blobrogue_CONTENT_WAVE_A.md`, `blobrogue_CONTENT_WAVE_B_FILL.md`); Rook Wave C identity stamp (roles / `stackCategory` locked); `balance.ts` PU contract (`PU_DPS = 12.5`).

Wave A+B runtime note: `stackCategory` is the GD enforceable for cap2 / combo tax (same as Wave B fill).

Baselines (Wave A+B, locked — for combo audit):
- Mooring **0.267 PU** · Sluice FLOOD 0.394 / DRAIN 0.628 / **avg 0.511** · Oddsmaker **0.495** · Pathmaker **0.220**
- Resonant Fork **~0.60 PU** · Red Pen **~0.65 PU** · Margin Call **≤1.10 PU** (taxed) · Sidewinder **~0.48 PU**
- Envelope: `PU_DPS=12.5`; specialist ≤**1.35 PU**; secondary first **0.60** / later **0.35**; sameTargetRepeat ≤**0.35** (Faultlink echoes **0.25**); proc ≤**4/s/player/target**; same-cat **cap 2**
- Raw caps unchanged: dmg 2.25× / fire 1.80× / move 1.35× / maxHP +4 / blessing pierce +3 / elemental 50%

## Locked safety (global — apply to every Wave C gun)

| Rule | Value |
|---|---|
| `stackCategory` | required; **same-cat cap = 2** (GD labels) |
| `sameTargetRepeat` | ≤ **0.35** of that system's realized DPS may re-hit the same target within 1.0s after first legal hit (Faultlink echo channel: **0.25**) |
| Secondary scoring | first secondary body × **0.60**; later × **0.35** |
| Proc rate | ≤ **4 /s / player / target** (hard clamp; overflow discarded) |
| Safety-removing combo | any 2-system combo that removes a safety rail pays **40–60%** on the combined surplus above 1.00 PU |
| Trigger / pelletGroup | every shot uses a **logical trigger** + named `pelletGroup` |
| Program mix | **8 identity / 2 support** — Wave C adds **no** blessings; only the four guns below |

## Wave C summary (rarities / primary PU)

| id | Verb | `stackCategory` | Rarity | Primary PU | Specialist PU (scored) |
|---|---|---|---|---:|---:|
| `hushiron` | ROOT / RAMP | `stance_ramp` | rare | **0.40** | **~0.52** |
| `backtalk` | PARRY / RETURN | `parry_active` | rare | **0.286** (stub) | **~0.45–0.70** (catch-dependent; ideal ≤1.10 w/ Margin tax) |
| `lamplighter` | RELIGHT | `light_edit` | common | **0.34** | **~0.40** |
| `faultlink` | LINK / SHARE | `link` | legendary | **0.978** | envelope: sustained ≤**1.15** / specialist ≤**1.35** / 3s burst ≤**1.60** |

Gun rarity ladder unchanged: C10 / R5 / L1. Wave C guns (Quill one-step adjust, Rook accepted): **1C / 2R / 1L** — Lamplighter common; Hushiron / Backtalk rare; Faultlink legendary.

---

## Combo gate (Wave A × Wave B × Wave C)

**CONFIRM: no 2-system combo exceeds 1.35 PU without a 40–60% tax** (extends Wave B gate).

Tax: multiply the *offending system's* bonus channel by `(1 − tax)` when the pair is live; do not silently lower base weapon DPS.

| Pair | Gate |
|---|---|
| Resonant Fork × Faultlink | both `link` — cap2 allows both owned; **endpoint1** hard rule (owner1 / party2 / endpoint1 — A+B+C cannot triple-link same endpoint). If both link same endpoint → **TAX 50%** on Faultlink **echo** channel |
| Backtalk × Margin Call | `parry_active` × `reflect_passive` — if both return channels live and combined return surplus **>1.35** → **TAX 50%** on Backtalk **return** coef |
| Lamplighter × Carry the Light | `light_edit` × `objective_support` → **TAX 40%** on Lamplighter **patch life** when both live |
| Lamplighter × Pathmaker | `light_edit` × `route` → **TAX 45%** on Lamplighter **patch plant rate** if **>3** patches would overlap pave denial |
| Hushiron × On the Beat | `stance_ramp` × `cadence` — **PASS** (fire-rate cap **1.80** binds; **no** dmg mult from stance) |
| Hushiron × Hold Fast | **PASS** (stability helps stance stacking) |
| Backtalk × Red Pen | **PASS** |
| Faultlink × Crosscurrent | **PASS** if **endpoint1** honored; **TAX 55%** on Crosscurrent jumps that ride Faultlink echoes |

Prior Wave B taxed pairs (Oddsmaker×Margin, Crosscurrent×pierce families, etc.) remain unchanged — not re-listed here.

---

## 1) Hushiron — ROOT / RAMP (gun)

| Field | Value |
|---|---|
| `stackCategory` | **`stance_ramp`** (GD) |
| Rarity | **rare** |
| Fire interval | **0.36 s** |
| Primary | dmg **1.8**, pellets **1**, speed **560**, life **0.95**, `bulletRadius` **5**, spread **0.04** base, `pelletGroup: hush_slug` |
| Primary DPS coef | **0.40 PU** (= 1.8/0.36/12.5) |
| Stance ramp | while standing still ≥**0.25 s**, gain **1** stack / **0.40 s**, max **5** stacks |
| Stack grants | spread × **(1 − 0.08×stacks)** floored at **0**; pierce += **floor(stacks/2)** capped **+2**; `bulletRadius` += **floor(stacks/3)** (**0→+1** at 3+ stacks) |
| Hard rule | **NO damage multiplier from stacks** |
| Move vent | any move **>40 px/s** clears **1** stack / **0.15 s** until **0**; dash clears **all** stacks instantly |
| Flusher vulnerability | at stacks **≥3**, owner takes **+1** from enemy blast/knockback hits that displace **≥24 px** (readable counter — not a soft HP tax on every hit) |
| `sameTargetRepeat` | **0.35** |
| Boss coef | **0.72** |
| Specialist PU | **~0.52** (pierce value in stance) |
| Secondary? | stance geometry only; no bonus dmg channel |

---

## 2) Backtalk — PARRY / RETURN (gun)

| Field | Value |
|---|---|
| `stackCategory` | **`parry_active`** (GD; ≠ Margin Call `reflect_passive`) |
| Rarity | **rare** |
| Ready stub | `fireCd` **0.42 s**, dmg **1.5**, pellets **1**, speed **520**, life **0.85**, `pelletGroup: backtalk_stub` → **0.286 PU** |
| Parry open | **weaponSkill** OR hold-fire **0.20 s** → frontal **90°** window **0.35 s** |
| Parry CD | **4.5 s** — starts **only** on successful catch |
| Legal catch | enemy bullets/shards with **damage ≥1**; **EXCLUDE** boss mechanic hazards (`flood_front`, choir sheets, pale seams as hazards, gorge rings as arena hazards), floor hazards, ally shots; **no** radial shield |
| Return shot | next fire within **3.0 s** → `pelletGroup: backtalk_return` at **1.15×** caught damage (**min 1.5**, **max 6**), speed **500**, life **0.90**, pierce **0**; then window closes |
| Miss / expire | no CD refund if window ends empty; input lock **0.10 s** |
| Boss coef | stub **0.90** / return **0.65** |
| Specialist PU | **~0.45–0.70** depending on catch rate; ideal **≤1.10** with Margin Call tax below |
| Combo tax | see Backtalk × Margin Call (**50%** on return coef when combined return surplus **>1.35**) |

---

## 3) Lamplighter — RELIGHT (gun)

| Field | Value |
|---|---|
| `stackCategory` | **`light_edit`** (GD) |
| Rarity | **common** |
| Fire interval | **0.40 s** |
| Primary | dmg **1.7**, pellets **1**, speed **500**, life **1.0**, `bulletRadius` **5**, `pelletGroup: lamp_shot` → **0.34 PU** |
| Lit path | if shot travels **≥40 px** through warm light / Carry-the-Light radius / objective light → gain pierce **+1** (shares `CAPS.pierce`) **AND** on first enemy hit or wall, plant safe patch **r=22**, life **1.2 s** |
| Patch cap | max **3** live patches / owner; oldest despawns; patches **NEVER** delete required hazards, boss tells, or Pathmaker pave (may overlap visually only) |
| Unlit shots | no pierce bonus, no patch |
| Boss coef | **0.65** |
| Specialist PU | **~0.40**; utility via patches |
| Combo tax | Carry the Light (**40%** patch life); Pathmaker (**45%** patch plant rate when pave overlap would exceed 3) |

---

## 4) Faultlink — LINK / SHARE (gun)

**REUSE / RECONFIRM prior balance pass — do not reinvent.**

| Field | Value |
|---|---|
| `stackCategory` | **`link`** (GD; shares cap2 with Resonant Fork) |
| Rarity | **legendary** |
| Fire interval | **0.18 s** |
| Primary | dmg **2.2**, pellets **1**, speed **600**, life **1.0**, `bulletRadius` **5**, `pelletGroup: fault_primary` |
| Primary DPS coef | **0.978 PU** (= 2.2/0.18/12.5) |
| Mark A | duration **3.0 s** on hit |
| Link | marked **A** links to marked **B** for fixed **5.0 s** |
| Link range / LOS | ≤**300 px** + **LOS both ends**; breaks on LOS loss |
| Echo damage | room **0.25** / boss **0.15** of primary hit (`pelletGroup: fault_echo`) |
| Echo rules | no crit / status / proc / recurse on echoes |
| Echo rate | ≤**4/s** (aligns global proc clamp) |
| `sameTargetRepeat` | **0.25** on echoes |
| PU envelope | sustained ≤**1.15** / specialist ≤**1.35** / 3s burst ≤**1.60** |
| Cap2 w/ Resonant Fork | enforce **owner1 / party2 / endpoint1** so A+B+C cannot triple-link the same endpoint |
| Boss coef | **0.70** |
| Combo tax | Fork × Faultlink (**50%** echo if same endpoint); Crosscurrent (**55%** on jumps riding fault echoes) |

---

## stackCategory registry (Wave C — GD seeds)

| Item | stackCategory | Cap |
|---|---|---|
| Hushiron | `stance_ramp` | 2 |
| Backtalk | `parry_active` | 2 |
| Lamplighter | `light_edit` | 2 |
| Faultlink | `link` | 2 |

## Build IDs

```
hushiron, backtalk, lamplighter, faultlink
```

Catalog: Wave C = catalog **`3`** (Wave A = `1`, Wave B = `2`; legacy `0` unchanged). Do not mutate prior catalog arrays.

## Boss rewards (Wave C ship)

Permanent boss-clear reward leads routed with catalog **`3`**. **Do not invent other reward remaps** in this wave.

| Boss | Reward lead |
|---|---|
| Jet | Oddsmaker (`oddsmaker`) |
| Tithe | Sluicegate (`sluicegate`) |
| Quorum | Faultlink (`faultlink`) |
| Gorge | Breach (`breach`) |

## Sign-off

Quill FINAL numbers for Ian+Anson playtest Wave C fill (CC blobrogue + Rook).
**No new blessings.** Guns-only +4; program mix **8 identity / 2 support** unchanged.
Safety locks honored; A×B×C combo gate reconfirmed (taxed pairs listed above).
Wave C cloud / implementation may consume this table as numeric source of truth.
