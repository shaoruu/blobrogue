# Multi-Boss Instrumented Health Gate — build spec

**Type:** test-infra only. Does NOT touch src/sim (the deterministic sim) or the client. Extends `test/scaling.test.ts` + the report JSON.
**Purpose:** a STANDING gate that auto-answers "did new content (guns/traits/tuning) drift ANY shipped boss out of its TTK band?" on every content wave — today it only covers Weaver@F20.
**Grounded in:** current `test/scaling.test.ts` (runPull, BUILDS, quantile, the report writer at ~L464), `isBossExposed`/`EARNED_WINDOWS`/mechanic-body kinds in `src/sim/world.ts`, per-boss floors in `src/sim/balance.ts`.

## 1. The mechanic-playing bot — how much generalizes

KEY FINDING (from code): the exposed-window machinery is ALREADY universal. `isBossExposed(e)` = `e.boss.exposed > 0`, and every earned boss opens its window through the shared `openBossWindow` / `EARNED_WINDOWS[kind]` bank system. So the bot's "deal damage to the boss while it's exposed, else attack the thing that OPENS the window" loop — exactly what runPull already does for Weaver — is 90% reusable. The ONLY per-boss part is TARGET SELECTION when the boss is NOT exposed: which body to shoot / what to do to earn the window.

So structure the bot as: a shared driver (aim, approach-to-range, fire, tally exposed-time/adds/hits/transitions — all already in runPull) + a per-boss `windowOpener(w, boss)` strategy that returns the current aim target (or a move intent). Only `windowOpener` is authored per boss.

Per-boss windowOpener (target the mechanic body already in code) + rough effort:
- **Weaver (F20):** DONE — shoot `sac` then `knot` (already in runPull). Reference impl. 0 effort.
- **Marrow (F15):** shoot the feeding slab body during its channel to force EXPOSED; between, aim boss. Slab is a mechanic body (`isMechanicBody` includes slab). ~0.5 day (find slab kind, aim it while armored).
- **Gilded (F25):** the plate chips to guardMult until the anvil/sweep EXPOSED recover — bot just keeps firing the boss (guard chip is nonzero) and the recover opens on the boss's own cadence; mostly the shared loop already handles it since the window is time-based, not a body. ~0.25 day (verify no body to target, just ride the recover).
- **Choir (F30):** silence the gathered voice `fragment` bodies to open the window; aim fragments when present, else boss. Fragment is a mechanic body. ~0.5 day.
- **Jet (F35):** window = post-parry spent-recover. The bot can't "parry" via aim alone — needs a scripted dash/dodge on the mirror-signature tell (read `boss.attack.move === "mirror"` windup, issue a dash). This is the ONE bot that needs a MOVE script, not just target selection. ~1 day.
- **Tithe (F40):** shoot the `slab` bodies (2-state destructible) to interrupt the feed → EXPOSED; aim slabs while armored (guardMult 0.0 so boss body is pointless until slab down). ~0.5 day.
- **Quorum (F45):** shoot husks in KILL-ORDER shield→heal→dmg (`quorum_shield`/`quorum_heal`/`quorum_dmg` kinds), then the exposed pool, then merge-form. Needs order logic (target lowest-priority-living-role first per the gate). ~1 day.
- **King (F5):** NO guard/window (tutorial boss) — bot just fires the boss; its band is the balance-suite median 35-50 / high-roll 20-25. ~0.1 day (no opener).

Total ~4 days for all 8; Jet + Quorum are the only real bot logic, the rest is target-selection reusing the shared loop.

## 2. Cells to instrument + pass/fail bands

Per boss, at ITS floor, run N=20+ seeds each for two cells:
- **solo/median** (BUILDS.median, R=1): assert wall TTK 38–55s AND exposed TTK 20–30s (King exempt from exposed — no guard; King wall band 35–50s).
- **4-strong** (4× a strong build, R clamps high): assert P10 wall ≥ the boss's min-legal floor (King/Marrow/Weaver/Choir 20s; Gilded/Jet/Tithe/Quorum 22s) AND P50 in the 42–58s party band.
- Report (not assert, for drift-watch): solo/highRoll + solo/god wall TTK, exposed-time, adds killed, maxLiveAdds.

Bands live in a per-boss table so a retune updates one place:
```
BOSS_BANDS = {   // exposedBand values are the SHIPPED balance.test.ts per-boss gates (NOT a uniform 20-30)
  boss:   { floor: 5,  soloWall: [35,50], exposed: null,    minLegal: 20 }, // King: no guard, no exposed gate
  marrow: { floor: 15, soloWall: [40,63], exposed: [8,20],  minLegal: 20 },
  weaver: { floor: 20, soloWall: [38,58], exposed: [16,30], minLegal: 20 },
  gilded: { floor: 25, soloWall: [40,58], exposed: [20,34], minLegal: 22 },
  choir:  { floor: 30, soloWall: [40,64], exposed: [12,26], minLegal: 22, party4P50: [46,62] }, // finale: longest wall, exposed gate is [12,26] as shipped
  jet:    { floor: 35, soloWall: [38,55], exposed: [16,30], minLegal: 22 }, // Wave-1: re-measure on build, placeholder mirrors weaver
  tithe:  { floor: 40, soloWall: [38,55], exposed: [16,30], minLegal: 22 }, // Wave-1: re-measure on build
  quorum: { floor: 45, soloWall: [40,58], exposed: [12,26], minLegal: 22 }, // Wave-1: re-measure on build
},
}
```
(Balancer owns these numbers; they mirror the per-boss gates already in balance.test.ts / the corrected gate §3.)

FAIL semantics: a cell out of band FAILS with the measured number (e.g. "marrow@F15 solo wall 61.2s > 55 band"). CRITICAL: a boss whose bot CAN'T open its window (exposed≈0 / NOKILL) must FAIL LOUD as "bot-can't-play-this-boss", NOT silently pass — that distinguishes a real regression from a broken bot. (This is exactly the false-positive class I hit with a generic bot; the per-boss windowOpener is what prevents it.)

## 3. Where it plugs in

- Add `runInstrumentedPull(seed, kind, floor, party)` = runPull + the per-boss `windowOpener` hook (refactor runPull's Weaver-specific `aimAt` fallback into `windowOpener[kind]`).
- Add a `multiBossReport()` section that loops BOSS_BANDS, runs both cells, checks bands, and writes each boss's cells into the report JSON.
- Report JSON: extend the existing shape from single `boss: "weaver@F20"` to `bosses: { [kind]: { floor, cells: {...}, bands, inBand: bool } }`. Keep the top-level `note`/`guards`. One file, `test/fixtures/scaling_report.json`.
- Gate: `npm run test:scaling` asserts every boss inBand; `npm run scaling:report` writes the full multi-boss JSON. CI runs the gated version.

## 4. Acceptance
- All 8 bosses measured in-band at solo/median + 4-strong on current main (they are, per balance.test.ts 223/223 — this gate just makes it CONTINUOUS + per-boss visible).
- A deliberately-buffed test weapon (temporarily over a boss ceiling) makes that boss's cell FAIL — proves the gate catches real drift.
- Bot-can't-open-window FAILS loud (never silent pass).
- Deterministic: same seed+loadouts → identical TTK to the tick (reuse the existing determinism check).

## 5. Sequencing
Test-infra only, so it can't collide with a player-facing boss build in the sim — BUT both edit the boss/test area, so land them sequentially (runner's call: player-facing surprise-layer build first if the GD audit names a target, this gate right after). This spec is stable regardless of which boss the GD flags.
