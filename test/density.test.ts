// GATE 2 — the 4-player telegraph / effect-density controller (telegraphBudget.ts). Locks the
// HARD RULE (fairness cues are EXEMPT from culling; only ambient/cosmetic culls), the reserved
// visual registers (a teammate's weapon FX can never masquerade as an enemy tell), the priority
// order, and the overlap arbiter (no two lethal windups resolve same-tile-same-window;
// arbitration is deterministic + seeded, identical on every client).
//
// Run: npm run test:density

import {
  planBudget, classifyTelegraph, ambientSource, playerWeaponSource,
  arbitrateLethalWindups, hasLethalOverlap, LETHAL_WINDOW_S,
  TelegraphPriority, VisualRegister,
} from "../src/sim/telegraphBudget.js";
import type { TelegraphSource, LethalWindup } from "../src/sim/telegraphBudget.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

function fairnessCulledTests(): void {
  section("HARD RULE: fairness cues are never culled; only ambient/cosmetic culls");
  // A soup of enemy tells at every priority, plus overwhelming ambient, under a starvation budget.
  const tells: TelegraphSource[] = [
    classifyTelegraph({ id: 1, phase: "windup", move: "hopslam", isBoss: true }),
    classifyTelegraph({ id: 2, phase: "windup", move: "slam", isBoss: false, isGiantPhaseCue: true }),
    classifyTelegraph({ id: 3, phase: "windup", move: "lunge", isBoss: false, isElite: true }),
    classifyTelegraph({ id: 4, phase: "windup", move: "spit", isBoss: false }),
  ];
  const ambient = Array.from({ length: 50 }, (_, i) => ambientSource(`a${i}`));
  const weapon = [playerWeaponSource("w0"), playerWeaponSource("w1")];
  const plan = planBudget([...tells, ...ambient, ...weapon], 0);
  const renderedIds = new Set(plan.rendered.map((s) => s.id));
  check("every fairness cue renders under a zero budget", tells.every((t) => renderedIds.has(t.id)));
  check("every player-weapon FX renders (own feedback, never culled)", weapon.every((w) => renderedIds.has(w.id)));
  check("only ambient/cosmetic sources are ever culled", plan.culled.every((s) => !s.isFairnessCue && s.register === VisualRegister.ambient));
  check("with budget 0, all 50 ambient sources are culled", plan.culled.length === 50);

  // A budget of 10 with 4 exempt tells leaves 6 units of ambient headroom (fairness cues consume
  // the total budget but are never culled; ambient fills only the remainder).
  const plan2 = planBudget([...tells, ...ambient], 10);
  check("exempt tells consume the budget; ambient fills only the remaining headroom",
    plan2.rendered.filter((s) => s.register === VisualRegister.ambient).length === 6 && plan2.culled.length === 44 &&
    tells.every((t) => plan2.rendered.some((s) => s.id === t.id)));
}

function registerTests(): void {
  section("reserved visual registers: enemy tells vs the players' own weapon FX");
  const tell = classifyTelegraph({ id: 1, phase: "windup", move: "spit", isBoss: false });
  const weapon = playerWeaponSource("w");
  const amb = ambientSource("a");
  check("an enemy tell always lands in the enemyTell register + is a fairness cue",
    tell.register === VisualRegister.enemyTell && tell.isFairnessCue);
  check("a player's weapon FX is the playerWeapon register, never a fairness cue (cannot mask a tell)",
    weapon.register === VisualRegister.playerWeapon && !weapon.isFairnessCue);
  check("ambient cosmetics are the only cullable register", amb.register === VisualRegister.ambient && !amb.isFairnessCue);
  // classification never routes a player/ambient source into the enemyTell register.
  check("player + ambient sources never occupy the enemyTell register",
    weapon.register !== VisualRegister.enemyTell && amb.register !== VisualRegister.enemyTell);
}

function priorityTests(): void {
  section("priority order governs which cullable ambient survives a tight budget");
  check("priority ranks boss > giant > elite > hazard/mutator > ambient",
    TelegraphPriority.bossWindup > TelegraphPriority.giantPhase &&
    TelegraphPriority.giantPhase > TelegraphPriority.eliteAffix &&
    TelegraphPriority.eliteAffix > TelegraphPriority.hazardMutator &&
    TelegraphPriority.hazardMutator > TelegraphPriority.ambient);
  check("classification tiers by source (boss / giant / elite / plain)",
    classifyTelegraph({ id: 1, phase: "windup", move: "hopslam", isBoss: true }).priority === TelegraphPriority.bossWindup &&
    classifyTelegraph({ id: 2, phase: "windup", move: "slam", isBoss: false, isGiantPhaseCue: true }).priority === TelegraphPriority.giantPhase &&
    classifyTelegraph({ id: 3, phase: "windup", move: "lunge", isBoss: false, isElite: true }).priority === TelegraphPriority.eliteAffix &&
    classifyTelegraph({ id: 4, phase: "windup", move: "spit", isBoss: false }).priority === TelegraphPriority.hazardMutator);
  // Two cullable ambient sources, budget for one: the higher-priority one survives (stable).
  const hi: TelegraphSource = { id: "hi", priority: TelegraphPriority.hazardMutator, register: VisualRegister.ambient, isFairnessCue: false, cost: 1 };
  const lo: TelegraphSource = { id: "lo", priority: TelegraphPriority.ambient, register: VisualRegister.ambient, isFairnessCue: false, cost: 1 };
  const plan = planBudget([lo, hi], 1);
  check("under a 1-slot budget the higher-priority cullable survives", plan.rendered.some((s) => s.id === "hi") && plan.culled.some((s) => s.id === "lo"));
}

function arbitrationTests(): void {
  section("overlap arbitration: no two lethal windups resolve same-tile-same-window");
  // Three windups stacked on the SAME tile, resolving within the window — a lethal pincer.
  const stacked: LethalWindup[] = [
    { id: 1, tileX: 5, tileY: 5, resolveAt: 0.10 },
    { id: 2, tileX: 5, tileY: 5, resolveAt: 0.12 },
    { id: 3, tileX: 5, tileY: 5, resolveAt: 0.14 },
  ];
  const out = arbitrateLethalWindups(stacked, 0xABCDEF, 40);
  check("the arbitrated set has NO same-tile lethal overlap inside the window", !hasLethalOverlap(out));
  check("every windup still resolves (none dropped)", out.length === stacked.length);
  check("collisions are staggered or relocated (not left as keep)", out.filter((w) => w.action !== "keep").length >= 2);

  // A non-colliding set is left untouched.
  const spread: LethalWindup[] = [
    { id: 1, tileX: 1, tileY: 1, resolveAt: 0.1 },
    { id: 2, tileX: 9, tileY: 9, resolveAt: 0.1 },
    { id: 3, tileX: 1, tileY: 1, resolveAt: 0.1 + LETHAL_WINDOW_S + 0.05 },
  ];
  const out2 = arbitrateLethalWindups(spread, 0xABCDEF, 40);
  check("non-colliding windups are kept as-is", out2.every((w) => w.action === "keep") && !hasLethalOverlap(out2));

  // Deterministic + authoritative: two independent "clients" arbitrate identically.
  const clientA = arbitrateLethalWindups(stacked, 0x1234, 55);
  const clientB = arbitrateLethalWindups(stacked, 0x1234, 55);
  check("arbitration is deterministic across clients (same seed+floor => identical)",
    JSON.stringify(clientA) === JSON.stringify(clientB));

  // A larger seeded stress: many overlapping windups always resolve to a fair set.
  let allFair = true;
  for (let seed = 1; seed <= 100; seed++) {
    const windups: LethalWindup[] = [];
    for (let i = 0; i < 12; i++) windups.push({ id: i, tileX: (i * 7) % 3, tileY: (i * 5) % 3, resolveAt: (i % 4) * 0.05 });
    if (hasLethalOverlap(arbitrateLethalWindups(windups, seed, 60))) allFair = false;
  }
  check("a dense overlapping cluster always arbitrates to a fair set (100 seeds)", allFair);
}

function main(): void {
  fairnessCulledTests();
  registerTests();
  priorityTests();
  arbitrationTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nGate 2 (4-player telegraph/effect-density controller) holds.\n");
}

main();
