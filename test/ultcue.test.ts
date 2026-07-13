// The CLIENT-SIDE ult cue deriver (src/game/ultCue.ts): charge MOTES coalesced off the
// already-authoritative ultCharge delta, the LOUD ready crossing, and the cast spend — all
// derived locally so none of it rides the wire (no protocol bump) and none of it can disagree
// with the meter. Pure logic, so this pins the coalescing + edges directly.
//
// Run: npx tsx test/ultcue.test.ts

import { UltCueTracker, ULT_MOTES_PER_SEC, isFlyingMoteSource, isPassiveMeterPulse, PASSIVE_PULSE_INTERVAL } from "../src/game/ultCue.js";
import type { UltCue, UltMoteOrigin } from "../src/game/ultCue.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const KILL: UltMoteOrigin = { x: 100, y: 200, source: "kill" };
const BOSS: UltMoteOrigin = { x: 50, y: 60, source: "boss" };
const SELF: UltMoteOrigin = { x: 0, y: 0, source: "dmg" };

function motes(cues: UltCue[]): Extract<UltCue, { t: "ultMote" }>[] {
  return cues.filter((c): c is Extract<UltCue, { t: "ultMote" }> => c.t === "ultMote");
}
function has(cues: UltCue[], t: UltCue["t"]): boolean { return cues.some((c) => c.t === t); }

function primingTests(): void {
  section("priming: a fresh baseline / reconnect jump never sprays motes");
  const t = new UltCueTracker();
  // The very first feed adopts the charge WITHOUT emitting (a big initial value is a baseline,
  // not combat) — the classic reconnect-resync guard.
  const first = t.feed({ charge: 5000, isReady: false, isCasting: false, origin: SELF, dt: 0.05 });
  check("first-ever feed emits nothing (adopts the baseline)", first.length === 0, JSON.stringify(first));
  // A later reset() re-adopts a snapped charge silently too.
  t.reset(9000);
  const afterReset = t.feed({ charge: 9000, isReady: false, isCasting: false, origin: SELF, dt: 0.05 });
  check("no delta after a reset -> no mote", motes(afterReset).length === 0);
}

function moteTests(): void {
  section("charge MOTES ride the authoritative delta (never disagree with the meter)");
  const t = new UltCueTracker();
  t.reset(0);
  const c1 = t.feed({ charge: 150, isReady: false, isCasting: false, origin: KILL, dt: 0.05 });
  const m1 = motes(c1);
  check("a kill charge accrual flushes one mote", m1.length === 1);
  check("the mote carries the summed amount (the exact charge delta)", m1[0].amount === 150, String(m1[0]?.amount));
  check("the mote flies FROM the combat origin, tagged by source", m1[0].x === 100 && m1[0].y === 200 && m1[0].source === "kill");

  section("single-tick crowd: a shotgun's many hits arrive as ONE charge delta -> ONE orb");
  const tc = new UltCueTracker();
  tc.reset(0);
  const crowd = motes(tc.feed({ charge: 900, isReady: false, isCasting: false, origin: KILL, dt: 0.05 }));
  check("40 pellets summed by the sim into one delta mint exactly one mote", crowd.length === 1);
  check("that one mote carries the whole summed charge (never 40 orbs)", crowd[0].amount === 900);

  section("coalescing: after the instant first ping, a burst within one window sums into ONE orb");
  const t2 = new UltCueTracker();
  t2.reset(0);
  // The first accrual pings instantly (responsiveness); it also zeroes the coalescing clock.
  let charge = 20;
  check("the first accrual after a lull pings immediately", motes(t2.feed({ charge, isReady: false, isCasting: false, origin: KILL, dt: 0.01 })).length === 1);
  // Now five quick accruals inside one <0.125s window: pending sums, no flush yet.
  let burst: UltCue[] = [];
  for (let i = 0; i < 5; i++) { charge += 20; burst = burst.concat(t2.feed({ charge, isReady: false, isCasting: false, origin: KILL, dt: 0.02 })); }
  check("nothing flushes mid-window (0.10s < the 0.125s mote interval)", motes(burst).length === 0);
  // A feed that crosses the interval flushes exactly ONE mote carrying the whole window sum.
  charge += 20;
  const flush = t2.feed({ charge, isReady: false, isCasting: false, origin: KILL, dt: 0.05 });
  const fm = motes(flush);
  check("crossing the interval flushes exactly one coalesced mote", fm.length === 1, String(fm.length));
  check("the coalesced mote carries the full summed window charge", fm[0].amount === 120, String(fm[0]?.amount));

  section(`rate cap: <= ${ULT_MOTES_PER_SEC} motes/sec, and total minted == total charge (conserved)`);
  const t3 = new UltCueTracker();
  t3.reset(0);
  let cur = 0, count = 0, minted = 0;
  const step = 1 / 60; // a 60fps client feeding a boss's steady drip
  for (let i = 0; i < 60; i++) { // ~1 second
    cur += 10;
    const cues = t3.feed({ charge: cur, isReady: false, isCasting: false, origin: BOSS, dt: step });
    for (const m of motes(cues)) { count++; minted += m.amount; }
  }
  // One final feed past the interval drains any trailing pending so the conservation check is exact.
  const tail = t3.feed({ charge: cur, isReady: false, isCasting: false, origin: BOSS, dt: 0.2 });
  for (const m of motes(tail)) { count++; minted += m.amount; }
  check(`the second's motes stay bounded (<= ${ULT_MOTES_PER_SEC + 1})`, count <= ULT_MOTES_PER_SEC + 1, `count=${count}`);
  check("every charge unit is accounted for across the motes (no lie, no loss)", minted === cur, `minted=${minted} total=${cur}`);
}

function readyTests(): void {
  section("LOUD ready: one cue per rising edge, silent through the lockout");
  const t = new UltCueTracker();
  t.reset(0);
  check("charging (not ready) -> no ready cue", !has(t.feed({ charge: 500, isReady: false, isCasting: false, origin: SELF, dt: 0.05 }), "ultReady"));
  const crossed = t.feed({ charge: 10000, isReady: true, isCasting: false, origin: SELF, dt: 0.05 });
  check("full AND off-lockout fires exactly one ultReady", crossed.filter((c) => c.t === "ultReady").length === 1);
  check("staying ready does not re-fire", !has(t.feed({ charge: 10000, isReady: true, isCasting: false, origin: SELF, dt: 0.05 }), "ultReady"));
  check("dropping out of ready is silent", !has(t.feed({ charge: 0, isReady: false, isCasting: false, origin: SELF, dt: 0.05 }), "ultReady"));
  const reCross = t.feed({ charge: 10000, isReady: true, isCasting: false, origin: SELF, dt: 0.05 });
  check("a re-charge after a cast re-fires ready", reCross.filter((c) => c.t === "ultReady").length === 1);
}

function castTests(): void {
  section("cast: the spend emits ultCast and drops the stale drip");
  const t = new UltCueTracker();
  t.reset(0);
  t.feed({ charge: 80, isReady: false, isCasting: false, origin: KILL, dt: 0.01 }); // pending 80, not flushed yet
  const cast = t.feed({ charge: 0, isReady: false, isCasting: true, origin: SELF, dt: 0.2 });
  check("the cast emits exactly one ultCast", cast.filter((c) => c.t === "ultCast").length === 1);
  check("the meter emptying to 0 mints NO mote (that charge was spent, not un-charged)", motes(cast).length === 0);
  // Charging resumes cleanly after the cast.
  const resume = t.feed({ charge: 120, isReady: false, isCasting: false, origin: KILL, dt: 0.2 });
  check("charging after a cast mints motes again", motes(resume).length === 1 && motes(resume)[0].amount === 120);
}

function roundTripTests(): void {
  section("cue objects are plain serializable data (round-trip stable)");
  const t = new UltCueTracker();
  t.reset(0);
  const cues = t.feed({ charge: 10000, isReady: true, isCasting: false, origin: BOSS, dt: 0.05 });
  for (const c of cues) {
    check(`${c.t} round-trips through JSON unchanged`, JSON.stringify(JSON.parse(JSON.stringify(c))) === JSON.stringify(c), c.t);
  }
  // The three cue variants all appear across a full charge->ready->cast lifecycle.
  const t2 = new UltCueTracker();
  t2.reset(0);
  const all: UltCue[] = [];
  all.push(...t2.feed({ charge: 200, isReady: false, isCasting: false, origin: KILL, dt: 0.05 }));   // mote
  all.push(...t2.feed({ charge: 10000, isReady: true, isCasting: false, origin: KILL, dt: 0.2 }));   // mote + ready
  all.push(...t2.feed({ charge: 0, isReady: false, isCasting: true, origin: SELF, dt: 0.2 }));       // cast
  check("all three cue types (ultMote / ultReady / ultCast) are produced across a lifecycle",
    has(all, "ultMote") && has(all, "ultReady") && has(all, "ultCast"));
}

function sourceGateTests(): void {
  section("combat-source gate: only kill/boss fly a mote; self-sourced 'dmg' does not (no pee stream)");
  // The tracker itself is unchanged — it still coalesces one ultMote per accrual carrying its
  // source; the gate that decides whether that cue becomes a FLYING projectile is source-scoped.
  const t = new UltCueTracker();
  t.reset(0);
  const dmg = motes(t.feed({ charge: 300, isReady: false, isCasting: false, origin: SELF, dt: 0.05 }));
  check("a self-sourced (heal/dash/trickle) accrual still emits a tracker mote cue", dmg.length === 1 && dmg[0].source === "dmg");
  check("but the flying-mote gate DROPS the self-sourced cue (Mender's continuous heal-charge)", !isFlyingMoteSource(dmg[0].source));

  const tk = new UltCueTracker();
  tk.reset(0);
  const kill = motes(tk.feed({ charge: 300, isReady: false, isCasting: false, origin: KILL, dt: 0.05 }));
  check("a kill accrual passes the flying-mote gate (fires from the enemy)", kill.length === 1 && isFlyingMoteSource(kill[0].source));
  const tb = new UltCueTracker();
  tb.reset(0);
  const boss = motes(tb.feed({ charge: 300, isReady: false, isCasting: false, origin: BOSS, dt: 0.05 }));
  check("a boss-hit accrual passes the flying-mote gate", boss.length === 1 && isFlyingMoteSource(boss[0].source));
  check("the gate is exactly {kill, boss}", isFlyingMoteSource("kill") && isFlyingMoteSource("boss") && !isFlyingMoteSource("dmg"));
}

function passivePulseTests(): void {
  section("passive meter pulse: self-sourced charge still nudges the bar, throttled, never doubled");
  const beyond = PASSIVE_PULSE_INTERVAL + 0.001;
  check("a charge INCREASE past the throttle window pulses the meter (no projectile)",
    isPassiveMeterPulse(50, beyond, false, false));
  check("no increase (flat / decreasing charge) never pulses",
    !isPassiveMeterPulse(0, beyond, false, false) && !isPassiveMeterPulse(-10, beyond, false, false));
  check("within the throttle window it stays quiet (>= ~1 pulse / 0.15s)",
    !isPassiveMeterPulse(50, PASSIVE_PULSE_INTERVAL - 0.01, false, false));
  check("a combat mote landing the same step suppresses the passive pulse (no double-ping)",
    !isPassiveMeterPulse(50, beyond, true, false));
  check("the lockout refill suppresses it (the bar shows cooldown, not charge)",
    !isPassiveMeterPulse(50, beyond, false, true));
}

function main(): void {
  primingTests();
  moteTests();
  sourceGateTests();
  passivePulseTests();
  readyTests();
  castTests();
  roundTripTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll ult-cue assertions passed.\n");
}

main();
