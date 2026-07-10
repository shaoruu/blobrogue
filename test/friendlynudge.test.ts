// Friendly-fire "playful bonk" suite (approved game-designer spec): a player's DIRECT
// projectile grazing a TEAMMATE deals ZERO damage and applies a gentle, deterministic,
// server-authoritative positional impulse ALONG the bullet vector — never scaled by the
// shooter's weapon KB, clamped to a dash-distance ceiling, gated by a per-ORDERED-pair
// cooldown, passing THROUGH the teammate, direct-projectiles-only, downed excluded, and
// byte-identical across runs. One FRIENDLY_NUDGE SimEvent drives every client's FX/SFX.
//
// Run: npx tsx test/friendlynudge.test.ts

import { createWorld, spawnPlayerInWorld, stepWorldPhase } from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { Bullet } from "../src/sim/types.js";
import type { SimEvent } from "../src/sim/events.js";
import { PLAYER } from "../src/sim/balance.js";
import { FRIENDLY_NUDGE_FRAC, FRIENDLY_NUDGE_REF_KB, FRIENDLY_NUDGE_DASH_FRAC, FRIENDLY_NUDGE_CD } from "../src/sim/constants.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const DT = 1 / 20;
// The expected impulse (px): ~30% of the reference enemy-hit knockback, clamped to <= 1/6 of
// a dash distance. Never scaled by the weapon's KB stat, so a shotgun grazes as gently as a
// pistol. With the shipped tuning the fraction wins (5.4px < the 16.5px dash-distance ceiling).
const EXPECTED_DIST = Math.min(
  FRIENDLY_NUDGE_FRAC * FRIENDLY_NUDGE_REF_KB,
  PLAYER.dashSpeed * PLAYER.dashActive * FRIENDLY_NUDGE_DASH_FRAC,
);

// Two players in the wide-open sandbox arena (no walls near the action), 60px apart on a row.
function twoPlayers(seed = 0xF00D): { w: WorldState; a: PlayerSim; b: PlayerSim } {
  const w = createWorld(seed, 1, { isSandbox: true, skipLocalPlayer: true });
  const a = spawnPlayerInWorld(w, "A");
  const b = spawnPlayerInWorld(w, "B");
  a.x = 700; a.y = 576;
  b.x = 760; b.y = 576;
  return { w, a, b };
}

// A DIRECT round from `owner`, placed so its swept segment this tick grazes (bx,by).
function directShot(w: WorldState, owner: string, fromX: number, y: number, extra: Partial<Bullet> = {}): Bullet {
  const bl: Bullet = {
    x: fromX, y, vx: 800, vy: 0, radius: 5, life: 1, friendly: true,
    owner, damage: 6, color: "#fff", pierce: 0, hitList: null, isCrit: false, ...extra,
  };
  w.bullets.push(bl);
  return bl;
}

function nudges(ev: SimEvent[]): Array<Extract<SimEvent, { t: "friendlyNudge" }>> {
  return ev.filter((e): e is Extract<SimEvent, { t: "friendlyNudge" }> => e.t === "friendlyNudge");
}

function damageAndKnockbackTests(): void {
  section("a direct shot grazing a teammate: 0 damage, a gentle impulse along the bullet vector");
  const { w, a, b } = twoPlayers();
  const b0x = b.x, b0y = b.y, b0hp = b.hp;
  const bullet = directShot(w, a.id, 720, 576);
  const ev: SimEvent[] = [];
  stepWorldPhase(w, DT, ev);
  const n = nudges(ev);
  check("exactly one friendlyNudge fired (A -> B)", n.length === 1 && n[0].shooterId === "A" && n[0].targetId === "B", JSON.stringify(n));
  check("ZERO damage — the teammate never loses HP", b.hp === b0hp, `hp=${b.hp}`);
  check("the impulse magnitude is the clamped ~30% reference, not the weapon's KB",
    Math.abs((b.x - b0x) - EXPECTED_DIST) < 1e-6 && Math.abs(b.y - b0y) < 1e-6, `dx=${(b.x - b0x).toFixed(3)} want=${EXPECTED_DIST.toFixed(3)}`);
  check("directed ALONG the bullet vector (+x here)", n[0].dirX === 1 && n[0].dirY === 0);
  check("passes THROUGH — the round is never consumed (still live after the graze)",
    w.bullets.length === 1 && w.bullets[0] === bullet && bullet.life > 0, `bullets=${w.bullets.length}`);
}

function shotgunClampTests(): void {
  section("KB is never scaled by the weapon: a shotgun (KB=8) grazes as gently as a pistol");
  const { w, a, b } = twoPlayers(0xBEEF);
  const b0x = b.x;
  a.weapon = "shotgun"; // the OWNER's weapon must not enter the friendly impulse at all
  directShot(w, a.id, 720, 576, { fx: "shotgun" });
  stepWorldPhase(w, DT, []);
  check("the shotgun graze moves the friend by exactly the clamped reference (no launch)",
    Math.abs((b.x - b0x) - EXPECTED_DIST) < 1e-6, `dx=${(b.x - b0x).toFixed(3)}`);
}

function ownProjectileTests(): void {
  section("own projectiles never nudge you");
  const { w, a } = twoPlayers(0xC0DE);
  const a0x = a.x;
  directShot(w, a.id, a.x - 10, a.y); // A's own round sweeps over A
  const ev: SimEvent[] = [];
  stepWorldPhase(w, DT, ev);
  check("no nudge targets the shooter themselves", nudges(ev).every((n) => n.targetId !== "A"));
  check("the shooter is not displaced by their own round", a.x === a0x, `dx=${a.x - a0x}`);
}

function downedExcludedTests(): void {
  section("downed / dead teammates are never nudged");
  const { w, a, b } = twoPlayers(0xDEAD);
  b.isDown = true; b.hp = 0;
  const b0x = b.x;
  const ev: SimEvent[] = [];
  directShot(w, a.id, 720, 576);
  stepWorldPhase(w, DT, ev);
  check("a downed teammate raises no nudge", nudges(ev).length === 0);
  check("a downed teammate is not displaced", b.x === b0x);
}

function directOnlyTests(): void {
  section("DIRECT projectiles only — area / persistent / sticky payloads never bonk");
  const excluded: Array<[string, Partial<Bullet>]> = [
    ["mortar (area blast)", { blast: 40 }],
    ["vortex (implosion)", { implode: 40 }],
    ["sentry bolt (persistent)", { isPersistent: true }],
    ["frostline (sticky paint)", { paintSpacing: 10, paintDist: 0 }],
    ["the Weaver's silk (enemy sticky)", { isSilk: true }],
  ];
  for (const [label, extra] of excluded) {
    const { w, b } = twoPlayers(0x5EED);
    const b0x = b.x;
    directShot(w, "A", 720, 576, extra);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, DT, ev);
    check(`${label} does NOT nudge a teammate`, nudges(ev).length === 0 && b.x === b0x);
  }
  // A plain direct round in the SAME setup DOES nudge — proves the exclusion is specific.
  const { w, b } = twoPlayers(0x5EED);
  directShot(w, "A", 720, 576);
  const ev: SimEvent[] = [];
  stepWorldPhase(w, DT, ev);
  check("a plain direct round DOES nudge (the exclusion is specific)", nudges(ev).length === 1 && b.x > 760);
}

function pairCooldownTests(): void {
  section("per-ORDERED-pair cooldown: one bonk per window; A->B independent of B->A");
  const { w, a, b } = twoPlayers(0xAB12);
  directShot(w, a.id, 720, 576);
  const ev1: SimEvent[] = [];
  stepWorldPhase(w, DT, ev1);
  check("first A->B graze bonks", nudges(ev1).length === 1);

  // A second A->B graze immediately after is swallowed by the pair cooldown.
  directShot(w, a.id, 720, 576);
  const ev2: SimEvent[] = [];
  stepWorldPhase(w, DT, ev2);
  check("a second A->B graze inside the cooldown does NOT re-bonk", nudges(ev2).length === 0);

  // ...but B->A is a DIFFERENT ordered pair and fires on its own. B is at ~765 now; aim a
  // round from B back over A (to A's left).
  directShot(w, b.id, a.x + 12, a.y, { vx: -800 });
  const ev3: SimEvent[] = [];
  stepWorldPhase(w, DT, ev3);
  const n3 = nudges(ev3);
  check("B->A fires despite A->B being on cooldown (ordered pairs are independent)",
    n3.length === 1 && n3[0].shooterId === "B" && n3[0].targetId === "A", JSON.stringify(n3));

  // After the cooldown elapses, A->B is available again.
  const steps = Math.ceil(FRIENDLY_NUDGE_CD / DT) + 1;
  for (let i = 0; i < steps; i++) stepWorldPhase(w, DT, []);
  directShot(w, a.id, b.x - 40, b.y);
  const ev4: SimEvent[] = [];
  stepWorldPhase(w, DT, ev4);
  check("A->B bonks again once the cooldown expires", nudges(ev4).length === 1);
}

function determinismTests(): void {
  section("determinism: identical setups produce byte-identical events + positions");
  const run = (): { ev: SimEvent[]; bx: number; by: number } => {
    const { w, a, b } = twoPlayers(0x1234);
    directShot(w, a.id, 720, 576);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, DT, ev);
    return { ev: nudges(ev), bx: b.x, by: b.y };
  };
  const r1 = run(), r2 = run();
  check("nudge events are identical across runs", JSON.stringify(r1.ev) === JSON.stringify(r2.ev));
  check("the nudged position is identical across runs", r1.bx === r2.bx && r1.by === r2.by);
}

function main(): void {
  damageAndKnockbackTests();
  shotgunClampTests();
  ownProjectileTests();
  downedExcludedTests();
  directOnlyTests();
  pairCooldownTests();
  determinismTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll friendly-nudge assertions passed.\n");
}

main();
