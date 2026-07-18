// PVP WAVE 2 · PILLAR A — Contested Hearth (PROTOCOL 47) sim suite.
//
// Proves the Quill FINAL levers for HOLD_THE_HEARTH @ the arena-center (9,9) hearth, all in the
// PURE sim + the wire:
//   - Favor accrues ONLY while a lone body stands UNCONTESTED in the ring; a 1.0s stand arms one
//     ember_edge charge (max 1; a refresh replaces).
//   - Contested (>= 2 living bodies) PAUSES Favor (C2).
//   - Leaving the ring decays unarmed progress (0.40s) and drops an armed charge (1.5s hold).
//   - ember_edge adds a flat +8 to the next 1 gun hit, then is spent (once) — no snowball (C3).
//   - Favor + charge NEVER persist across a pvp death (C3).
//   - Co-op is byte-inert: nothing accrues, and isPvpHearthContested is false (C1).
//   - The center tile is walkable — no body-block on (9,9) (C5).
//   - The public kill-switch stays OFF (C4).
//
// Run: npm run test:pvpwave2  (or: tsx test/pvp_wave2.test.ts)

import {
  createWorld, stepWorld, spawnPlayerInWorld, isPvp, isPvpHearthContested,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import {
  HEARTH, PVP, pvpHearthArmTicks, pvpHearthEmberWindowTicks, pvpHearthEmptyDecayTicks,
  pvpHearthArmedHoldTicks, pvpHearthFavorPips, pvpHearthFavorTickTicks,
} from "../src/sim/pvp.js";
import type { Vec2 } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";
import { buildSnapshot, jsonCodec, PROTOCOL_VERSION } from "../src/net/protocol.js";
import type { ServerMsg } from "../src/net/protocol.js";
import { PVP_PUBLIC_ENABLED } from "../src/net/pvpFlag.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " \u2014 " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " \u2014 " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " \u2014 " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const DT = 1 / 20;

function inp(over: Partial<InputCmd>): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, ...over };
}

function pvpWorld(seed: number, ids: string[]): WorldState {
  const w = createWorld(seed, 1, { mode: "pvp", isShared: true, skipLocalPlayer: true });
  for (const id of ids) spawnPlayerInWorld(w, id);
  return w;
}

function clearProtection(p: PlayerSim): void {
  p.invuln = 0;
  p.spawnGraceT = 0;
  p.spawnShieldT = 0;
  p.spawnProtectionStartedTick = 0;
  p.spawnHardGraceEndsAtTick = 0;
  p.spawnShieldEndsAtTick = 0;
  p.isSpawnOffenseLatched = false;
}

// Advance to the LIVE phase, then strip spawn protection so combat/positioning tests are clean.
function advanceToLive(w: WorldState): void {
  let guard = 0;
  while (w.match !== null && w.match.phase !== "live" && guard++ < 5000) stepWorld(w, new Map(), DT);
  for (const p of w.players.values()) clearProtection(p);
}

function hearthCenter(w: WorldState): Vec2 { return w.match!.hearthCenter; }

// A spot well OUTSIDE the hearth ring (a corner of the arena walkable interior).
function farSpot(): Vec2 { return { x: 456 + HEARTH.radius * 4, y: 456 }; }

// Step `n` ticks while pinning the named players to fixed positions each tick (idle inputs keep
// them put; re-pinning is bulletproof against any separation drift). This is scripted positioning,
// not mocked behavior — the sim itself resolves Favor/ember off the real authoritative positions.
function stepHolding(w: WorldState, n: number, holds: Array<[string, Vec2]>): void {
  for (let i = 0; i < n; i++) {
    for (const [id, pt] of holds) { const p = w.players.get(id); if (p !== undefined) { p.x = pt.x; p.y = pt.y; } }
    stepWorld(w, new Map(), DT);
  }
}

function snapOf(w: WorldState, selfPid: string): Extract<ServerMsg, { t: "snap" }> {
  return buildSnapshot(w, selfPid, 0, [], 0, true, { worldId: "arena-1", sseq: 1 }) as Extract<ServerMsg, { t: "snap" }>;
}

// ---------------------------------------------------------------------------------------------
section("hearth geometry + kill-switch invariants");
{
  const w = pvpWorld(1, ["p1", "p2"]);
  check("PROTOCOL_VERSION is 47 (contested hearth)", PROTOCOL_VERSION === 47);
  check("the public PVP kill-switch stays OFF (C4)", PVP_PUBLIC_ENABLED === false);
  // C5: the center tile (9,9) is walkable floor — never a wall/pit, so no body-block on the hearth.
  const c = hearthCenter(w);
  const tx = Math.floor(c.x / 48), ty = Math.floor(c.y / 48);
  check("hearth center is the (9,9) center-pickup tile", tx === 9 && ty === 9);
  check("center tile is walkable floor (C5: no body-block on 9,9)", w.dungeon.tiles[ty * w.dungeon.w + tx] === 0);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  p1.x = c.x; p1.y = c.y;
  stepWorld(w, new Map(), DT);
  check("a living body rests on the hearth center unobstructed", p1.x === c.x && p1.y === c.y && p1.hp === PVP.maxHp);
}

// ---------------------------------------------------------------------------------------------
section("arm timing: 1.0s uncontested stand arms exactly one ember_edge (C3: max 1, refresh replaces)");
{
  const w = pvpWorld(2, ["p1", "p2"]);
  advanceToLive(w);
  const c = hearthCenter(w);
  const p1 = w.players.get("p1")!;
  const armTicks = pvpHearthArmTicks();
  check("arm window is 2 Favor ticks = 1.0s", armTicks === pvpHearthFavorTickTicks() * 2 && armTicks === 20);

  // A single Favor tick's worth of standing shows one pip and no charge yet.
  stepHolding(w, pvpHearthFavorTickTicks(), [["p1", c], ["p2", farSpot()]]);
  check("one Favor tick (0.50s) accrues one pip, no charge", pvpHearthFavorPips(p1.hearthFavorT) === 1 && p1.hearthEmberT === 0);

  // One tick short of the arm threshold: still no charge.
  stepHolding(w, armTicks - pvpHearthFavorTickTicks() - 1, [["p1", c], ["p2", farSpot()]]);
  check("one tick short of the arm threshold stays unarmed", p1.hearthEmberT === 0 && p1.hearthFavorT === armTicks - 1);

  // The arming tick: a full stand arms one charge, resets Favor, and opens the full window.
  stepHolding(w, 1, [["p1", c], ["p2", farSpot()]]);
  check("a full 1.0s stand arms an ember_edge charge with the full window",
    p1.hearthEmberT === pvpHearthEmberWindowTicks() && p1.hearthFavorT === 0);

  // Keep standing: a refresh REPLACES (bank never exceeds one window; never a second charge).
  let maxEmber = 0;
  for (let i = 0; i < armTicks * 3; i++) {
    stepHolding(w, 1, [["p1", c], ["p2", farSpot()]]);
    maxEmber = Math.max(maxEmber, p1.hearthEmberT);
  }
  check("continuous standing never banks past a single window (refresh replaces)",
    maxEmber === pvpHearthEmberWindowTicks() && p1.hearthEmberT > 0);
}

// ---------------------------------------------------------------------------------------------
section("C2: contested (>= 2 living bodies) pauses Favor");
{
  const w = pvpWorld(3, ["p1", "p2"]);
  advanceToLive(w);
  const c = hearthCenter(w);
  const p1 = w.players.get("p1")!, p2 = w.players.get("p2")!;
  // Both bodies inside the ring from the start: Favor never ticks and nothing ever arms.
  const nearCenter: Vec2 = { x: c.x + 24, y: c.y };
  stepHolding(w, pvpHearthArmTicks() * 2, [["p1", c], ["p2", nearCenter]]);
  check("two bodies in the ring is contested", isPvpHearthContested(w));
  check("contested accrues NO Favor for either body", p1.hearthFavorT === 0 && p2.hearthFavorT === 0);
  check("contested never arms an ember_edge", p1.hearthEmberT === 0 && p2.hearthEmberT === 0);

  // Favor HOLDS (neither accrues nor decays) while contested: accrue solo, then contest.
  stepHolding(w, pvpHearthFavorTickTicks(), [["p1", c], ["p2", farSpot()]]);
  const held = p1.hearthFavorT;
  check("solo accrual before the contest", held > 0);
  stepHolding(w, pvpHearthArmTicks() * 2, [["p1", c], ["p2", nearCenter]]);
  check("contested holds partial Favor (no accrual, no decay)", p1.hearthFavorT === held);
  // Resolving the contest (foe leaves) resumes accrual toward the arm.
  stepHolding(w, pvpHearthArmTicks(), [["p1", c], ["p2", farSpot()]]);
  check("Favor resumes and arms once the hearth is uncontested again", p1.hearthEmberT > 0);
}

// ---------------------------------------------------------------------------------------------
section("leave decay: 0.40s clears unarmed progress; an armed charge holds 1.5s then drops");
{
  const w = pvpWorld(4, ["p1", "p2"]);
  advanceToLive(w);
  const c = hearthCenter(w);
  const p1 = w.players.get("p1")!;
  const far = farSpot();

  // Partial (unarmed) Favor clears after exactly emptyDecay ticks away, not before.
  stepHolding(w, pvpHearthFavorTickTicks(), [["p1", c], ["p2", far]]);
  check("partial unarmed Favor accrued", p1.hearthFavorT > 0);
  stepHolding(w, pvpHearthEmptyDecayTicks() - 1, [["p1", far], ["p2", far]]);
  check("unarmed Favor survives the sub-0.40s grace", p1.hearthFavorT > 0);
  stepHolding(w, 1, [["p1", far], ["p2", far]]);
  check("unarmed Favor clears exactly at the 0.40s empty decay", p1.hearthFavorT === 0);

  // An ARMED charge holds for armedHold ticks after leaving, then drops.
  stepHolding(w, pvpHearthArmTicks(), [["p1", c], ["p2", far]]);
  check("re-armed an ember_edge charge", p1.hearthEmberT > 0);
  stepHolding(w, pvpHearthArmedHoldTicks() - 1, [["p1", far], ["p2", far]]);
  check("armed charge survives the sub-1.5s hold after leaving", p1.hearthEmberT > 0);
  stepHolding(w, 1, [["p1", far], ["p2", far]]);
  check("armed charge drops exactly at the 1.5s leave hold", p1.hearthEmberT === 0);
}

// ---------------------------------------------------------------------------------------------
section("C3: ember_edge adds a flat +8 to ONE gun hit, then is spent (no snowball)");
{
  // Two identical face-offs on a clear lane; the only difference is one shooter holds a charge.
  function firstHitDelta(isArmed: boolean): { delta: number; emberAfter: number } {
    const w = pvpWorld(5, ["p1", "p2"]);
    advanceToLive(w);
    const shooter = w.players.get("p1")!, victim = w.players.get("p2")!;
    shooter.x = 300; shooter.y = 216; clearProtection(shooter);
    victim.x = 340; victim.y = 216; clearProtection(victim);
    shooter.weapon = "pistol"; shooter.ownedWeapons = ["pistol"];
    if (isArmed) shooter.hearthEmberT = pvpHearthEmberWindowTicks();
    const before = victim.hp;
    let guard = 0;
    while (victim.hp === before && guard++ < 40) stepWorld(w, new Map([["p1", inp({ firing: true, aim: 0 })]]), DT);
    return { delta: before - victim.hp, emberAfter: shooter.hearthEmberT };
  }
  const control = firstHitDelta(false);
  const armed = firstHitDelta(true);
  check("an unarmed pistol hit lands damage", control.delta > 0, `delta=${control.delta}`);
  check("ember_edge adds a flat +8 PVP damage to that hit",
    Math.abs(armed.delta - control.delta - HEARTH.emberBonusDamage) < 1e-9, `ctrl=${control.delta} armed=${armed.delta}`);
  check("ember_edge is spent by that one hit (bank never > 1)", armed.emberAfter === 0);
}

// ---------------------------------------------------------------------------------------------
section("C3: Favor + armed ember_edge never persist across a pvp death");
{
  const w = pvpWorld(6, ["p1", "p2"]);
  advanceToLive(w);
  const victim = w.players.get("p1")!, killer = w.players.get("p2")!;
  killer.x = 300; killer.y = 216; clearProtection(killer);
  victim.x = 340; victim.y = 216; clearProtection(victim);
  killer.weapon = "pistol"; killer.ownedWeapons = ["pistol"];
  // Arm the victim's hearth state, then take a lethal hit before the leave-hold could drop it.
  victim.hearthFavorT = pvpHearthArmTicks() - 1;
  victim.hearthEmberT = pvpHearthEmberWindowTicks();
  victim.hp = 4; // one pistol hit is lethal
  let guard = 0;
  while (victim.respawnT === 0 && guard++ < 20) stepWorld(w, new Map([["p2", inp({ firing: true, aim: 0 })]]), DT);
  check("the lethal hit scheduled a respawn (a death, not a graze)", victim.respawnT > 0);
  check("death clears Favor AND the armed ember_edge (no carry across death)",
    victim.hearthFavorT === 0 && victim.hearthEmberT === 0);
}

// ---------------------------------------------------------------------------------------------
section("C1: co-op is byte-inert — the hearth never runs off the pvp path");
{
  const coop = createWorld(7, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(coop, "c1"); spawnPlayerInWorld(coop, "c2");
  check("co-op has no match state", coop.match === null && !isPvp(coop));
  const c1 = coop.players.get("c1")!, c2 = coop.players.get("c2")!;
  // Pin both to the co-op dungeon center for a while: co-op never accrues Favor or contests.
  const center: Vec2 = { x: coop.dungeon.spawn.x * 48 + 24, y: coop.dungeon.spawn.y * 48 + 24 };
  for (let i = 0; i < pvpHearthArmTicks() * 2; i++) {
    c1.x = center.x; c1.y = center.y; c2.x = center.x; c2.y = center.y;
    stepWorld(coop, new Map(), DT);
  }
  check("co-op accrues no Favor and arms no ember_edge (C1)",
    c1.hearthFavorT === 0 && c1.hearthEmberT === 0 && c2.hearthFavorT === 0 && c2.hearthEmberT === 0);
  check("co-op is never contested", !isPvpHearthContested(coop));
}

// ---------------------------------------------------------------------------------------------
section("wire: SelfWire Favor/ember + MatchWire contested project + round-trip (v47)");
{
  const w = pvpWorld(8, ["p1", "p2"]);
  advanceToLive(w);
  const c = hearthCenter(w);
  const p1 = w.players.get("p1")!;
  // Arm p1 solo, then decode a full snapshot and assert the self hearth readouts survive.
  stepHolding(w, pvpHearthArmTicks(), [["p1", c], ["p2", farSpot()]]);
  const armedSnap = jsonCodec.decodeServer(jsonCodec.encodeServer(snapOf(w, "p1"))) as Extract<ServerMsg, { t: "snap" }>;
  check("SelfWire carries the accrued Favor + armed ember window",
    armedSnap.self !== null && armedSnap.self.he === p1.hearthEmberT && armedSnap.self.hf === p1.hearthFavorT);
  check("an armed match block is NOT contested with a lone body", armedSnap.match !== null && armedSnap.match.hc === false);

  // Now contest the hearth and assert MatchWire.hc flips true.
  stepHolding(w, 2, [["p1", c], ["p2", { x: c.x + 24, y: c.y }]]);
  const contestedSnap = jsonCodec.decodeServer(jsonCodec.encodeServer(snapOf(w, "p1"))) as Extract<ServerMsg, { t: "snap" }>;
  check("MatchWire projects the contested bool for the HUD VFX", contestedSnap.match !== null && contestedSnap.match.hc === true);
}

// ---------------------------------------------------------------------------------------------
process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("\nAll PVP Wave 2 contested-hearth assertions passed.\n");
