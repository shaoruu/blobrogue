# BlobRogue Content Wave B — Implementation Canon

Status: implemented on catalog version `2`, stacked on Wave A (`1`) and legacy (`0`).
Numeric source of truth: `docs/specs/blobrogue_CONTENT_WAVE_B_FILL.md` (Quill FINAL). This
document records HOW the fill was built; the fill owns the numbers.

## Weapons (each a distinct room verb; one isolated field)

| Name | Verb | Field | Rarity |
|---|---|---|---|
| RESONANT FORK | TUNE | `resonate` | rare |
| RED PEN | SET / REWRITE | `rewrite` | rare |
| MARGIN CALL | COPY-ONE | `margin` | legendary |
| SIDEWINDER | ENCIRCLE / FLANK | `sidewinder` | common |

- RESONANT FORK: a primary hit tunes ONE resonant link from the struck body to a nearest
  neighbour in LOS (range 220, both ends). The link ticks 0.55 into the neighbour every
  0.20s for 2.4s. One link per owner (a fresh hit retargets it); it breaks on LOS loss,
  death, or range. Ticks route through the shared ≤4/s/player/target proc clamp.
- RED PEN: ink rounds mark the body they hit (3.0s, one mark/target/owner). Firing at a
  marked, cooldown-ready target is the logical REWRITE trigger: it consumes the mark for a
  2.8× burst off the mark's last ink hit, then starts a 5.5s skill cooldown — on a
  SUCCESSFUL snap only. A snap that cannot land (no mark, dead, no LOS, boss-guarded) fails
  closed: no damage, no cooldown, a 0.15s input lock.
- MARGIN CALL: stores exactly one payload CLASS (`slug`/`spread`/`pierce`/`blast`/`seeker`/
  `status`) off the owner's previous committed shot from another weapon (TTL 8s), then
  echoes it at 0.70× damage, min(originalPellets, 3) pellets, with the class's capped
  specials. Empty, it fires a feeble stub (1.2 dmg). The Oddsmaker's `gamble` payload is
  NEVER storeable → the copy falls back to the stub (the Odds×Margin combo tax).
- SIDEWINDER: a fixed authored TWO-arc volley (t=0 / 0.08s) of curving rounds that sweep to
  the flank. Extra-pellet mods never add arcs. A rear-flank hit on a NON-boss body earns
  +25%; boss-grade / captains / giants get NO rear vulnerability. The second arc into the
  same body in a volley lands at the 0.35 same-target-repeat share.

## Blessings (8 identity / 2 support, with Wave A's Shared Rope)

| Name | Role | stackCategory |
|---|---|---|
| CROSSCURRENT | identity — chain/pierce | `chain_boost` |
| LAST WARM ROUND | identity — cycle-final signature | `cycle_finale` |
| KNOWN BY TOUCH | identity — reveal | `reveal` |
| REMEMBER ME | identity — lethal-save / sustain converter | `lethal_save` |
| CARRY THE LIGHT | support (sole Wave B support) | `objective_support` |

- CROSSCURRENT: adds chain jumps + pierce to every round the player fires (jump damage vs
  the prior hit). The pierce/chain specialists (Tesla, Arcbolt, Cleaver, Skipper, and the
  Sluicegate DRAIN lance) pay a 55% tax on the JUMP channel only.
- LAST WARM ROUND: +16/24/32% on the cycle-FINAL shot of a weapon (Sluice DRAIN, Oddsmaker
  pierce/blast, charge release, melee swing, Red Pen snap). Inert on simple guns until a
  cycle provider exists. The Oddsmaker/Sluicegate pair pays a 45% tax on the bonus.
- KNOWN BY TOUCH: a dash end or a melee/weaponSkill hit reveals hidden bodies within radius
  (a diving burrower, a faded choir, a blinking weaver become hittable), on a shared ICD.
- REMEMBER ME: survives one lethal hit per floor — HP to 1, 0.80s invuln — by disabling the
  owner's highest-rarity non-support blessing for 6/5/4s. Re-arms each floor. IDENTITY (a
  sustain converter), never support.
- CARRY THE LIGHT: the sole Wave B support. +revive radius / +channel rate (distinct from
  Shared Rope's channel), an ally-revive fire-cooldown cut, a Lv3 free reload on revive, and
  a solo dash fire-readiness restore.

## Anti-degenerate safety (Quill locks)

`src/sim/antiDegenerate.ts` holds the GD-canonical `stackCategory` registry (Wave A + B),
the same-category cap (2), and the runtime proc-window clamp (≤4/s/player/target, overflow
discarded). Sidewinder's same-target-repeat (0.35) is enforced by a 1-capacity window.
Secondary scoring (0.60 first / 0.35 later) and sameTargetRepeat are the PU-budget envelope.

## Combo taxes (bonus channel only)

- Oddsmaker × Margin Call: `gamble` is not storeable → Margin Call stubs (50% intent).
- Oddsmaker × Last Warm Round: 45% tax on the cycle-final bonus.
- pierce/chain specialists × Crosscurrent: 55% tax on the jump channel.

## Authority / protocol

Catalog version is authoritative and immutable per run; browser/ticket cannot author it.
Legacy (`0`) and Wave A (`1`) arrays are never edited. All four verbs and five blessings are
server-owned TRANSIENT combat state (sub-8s), never reconciled on the wire — a resume rebuilds
them from live inputs. The wire SHAPE is unchanged; PROTOCOL_VERSION advances to `36` only so a
pre-v36 client gets a clean client-outdated rejection instead of decoding a `cat=2` run.

PVP remains OFF: all four weapons are `pvpUnsupportedWeaponIds` (fail-closed on
acquire/equip/fire) and all five blessings are on the PvP blessing blacklist.

## Balance provisional (BALANCER_TODO)

Per-shot damage / cadence / boss coefficients are Quill FINAL. Implementation-detail geometry
tuned against the arsenal QA harness (proof engine), left provisional for playtest:
- Sidewinder arc launch offset (0.12 rad), turn (1.1 rad/s), bullet radius (9), basePierce (3):
  chosen so the two arcs reliably connect in the aim-straight QA rooms while preserving the
  encircle/flank identity. FILL fixes arcs=2, per-arc dmg 1.35, life 0.55, speed 420.
- Red Pen REWRITE uses a logical trigger (refire at a marked, cooldown-ready target). An
  explicit alt-fire input was not added (no spare input in the current scheme).
- Margin Call's arsenal room proof uses a companion weapon in the QA harness (the verb needs a
  second weapon to store off), mirroring the two-weapon `secondlane` proof.

## What still blocks ship

- Art: held/pickup sprites for the four weapons (typed asset hooks only; no PNGs generated).
- Audio: authored takes for the new fire/skill/blessing cues (typed silent hooks only;
  runtime oscillators / generated placeholder binaries remain banned).
- Human play approval (Ian + Anson playtest), H2 handshake, and the external QA gates.
