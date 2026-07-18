// PVP WAVE 2 · PILLAR C — Draft kit counters (brace / sight / rip) sim suite.
//
// Proves the Quill FINAL levers for the three uncommon DRAFT counters, all in the PURE sim:
//   - brace_band: bank one brace charge every 7.0s (max 1); the next incoming knockback is HALVED
//     (x0.50) and spends the charge — a soft anti-shove, never immunity; a post-hit pit-warning
//     pulse (presentation) fires when the braced body ends within 0.45s of a pit edge; cleared on
//     death; co-op inert.
//   - clear_eyes: a 7.0s-ICD pulse outlines the nearest foe within 180px AND clear LOS for 1.50s;
//     info only (no damage, no wallhack); co-op inert.
//   - rip_post: the next reload (shot) OR dash rips the post — clears tar under self (r40) and chips
//     ONE adjacent breakable cover by a single break tick — then goes on an 8.0s ICD; never player
//     damage, never demolition; co-op inert.
//   - K1..K5: the counters are in the pool, the blacklist is intact, the match opens at equal
//     footing (no counters), the public kill-switch stays OFF, and this stays PROTOCOL 48.
//
// Run: npm run test:pvpwave2kits  (or: tsx test/pvp_wave2_kits.test.ts)

import {
  createWorld, stepWorld, spawnPlayerInWorld, isPvp, devSpawnProp,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import {
  PVP, PIT_TILES, WEATHER, pvpBlessingBlacklist,
  KIT_COUNTERS, PVP_COUNTER_BRACE, PVP_COUNTER_SIGHT, PVP_COUNTER_RIP,
  pvpBraceRechargeTicks, pvpSightPulseIcdTicks, pvpRipIcdTicks,
} from "../src/sim/pvp.js";
import { isPvpBlessingId, itemById, createMods, recomputeMods } from "../src/sim/items.js";
import type { Vec2, Hazard } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";
import type { SimEvent } from "../src/sim/events.js";
import { PROTOCOL_VERSION } from "../src/net/protocol.js";
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
  p.dashInvuln = 0;
}

function advanceToLive(w: WorldState): void {
  let guard = 0;
  while (w.match !== null && w.match.phase !== "live" && guard++ < 5000) stepWorld(w, new Map(), DT);
  for (const p of w.players.values()) clearProtection(p);
}

// Pin players to fixed positions while stepping (scripted positioning — the sim still resolves the
// counters off the real authoritative state each tick).
function stepHolding(w: WorldState, n: number, holds: Array<[string, Vec2]>): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const [id, pt] of holds) { const p = w.players.get(id); if (p !== undefined) { p.x = pt.x; p.y = pt.y; } }
    out.push(...stepWorld(w, new Map(), DT));
  }
  return out;
}

function pushTar(w: WorldState, x: number, y: number): Hazard {
  const h: Hazard = { id: w.nextHazardId++, kind: "tar", x, y, radius: WEATHER.tarRadius, life: 5, maxLife: 5 };
  w.hazards.push(h);
  return h;
}

// ---------------------------------------------------------------------------------------------
section("K1..K5 acceptance: pool, blacklist, version, kill-switch, defs");
{
  check("PROTOCOL_VERSION stays 48 (blessing ids ride existing wire — no bump)", PROTOCOL_VERSION === 48);
  check("the public PVP kill-switch stays OFF (K4)", PVP_PUBLIC_ENABLED === false);
  check("all three counters are in the PVP draft pool (K1)",
    PVP.blessingPool.includes(PVP_COUNTER_BRACE)
    && PVP.blessingPool.includes(PVP_COUNTER_SIGHT)
    && PVP.blessingPool.includes(PVP_COUNTER_RIP));
  check("all three counters are legal PvP blessing ids", 
    isPvpBlessingId(PVP_COUNTER_BRACE) && isPvpBlessingId(PVP_COUNTER_SIGHT) && isPvpBlessingId(PVP_COUNTER_RIP));
  check("the counters are added as UNCOMMON",
    [PVP_COUNTER_BRACE, PVP_COUNTER_SIGHT, PVP_COUNTER_RIP].every((id) => itemById(id)?.rarity === "uncommon"));
  check("each counter is a single-tier draft (maxLevel 1) and pvp-only",
    [PVP_COUNTER_BRACE, PVP_COUNTER_SIGHT, PVP_COUNTER_RIP]
      .every((id) => itemById(id)?.maxLevel === 1 && itemById(id)?.isPvpOnly === true));
  check("the counters write NO stat mods (apply is inert — pvp pool-safety holds)",
    [PVP_COUNTER_BRACE, PVP_COUNTER_SIGHT, PVP_COUNTER_RIP].every((id) => {
      const mods = createMods();
      recomputeMods(mods, [id]);
      return JSON.stringify(mods) === JSON.stringify(createMods());
    }));
  const blacklist = pvpBlessingBlacklist as readonly string[];
  check("the locked blacklist is untouched — none of it is draftable, and no counter leaked in (K2)",
    blacklist.every((id) => !isPvpBlessingId(id))
    && ![PVP_COUNTER_BRACE, PVP_COUNTER_SIGHT, PVP_COUNTER_RIP].some((id) => blacklist.includes(id)));
}

// ---------------------------------------------------------------------------------------------
section("K3 equal footing: a fresh live match has no counters and zero counter state");
{
  const w = pvpWorld(1, ["p1", "p2"]);
  advanceToLive(w);
  const clean = [...w.players.values()].every((p) =>
    p.ownedItemIds.length === 0
    && p.pvpBraceCharge === 0 && p.pvpBraceRegenT === 0
    && p.pvpSightIcdT === 0 && p.pvpRipIcdT === 0);
  check("every player opens the match with no drafted counters and zeroed timers", clean);
}

// ---------------------------------------------------------------------------------------------
section("brace_band: bank one charge every 7.0s (max 1)");
{
  const w = pvpWorld(2, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  p1.ownedItemIds = [PVP_COUNTER_BRACE];
  const regen = pvpBraceRechargeTicks();
  check("brace recharge is 7.0s = 140 ticks", regen === 140);
  stepHolding(w, regen - 1, []);
  check("one tick short of the cadence stays unbanked", p1.pvpBraceCharge === 0 && p1.pvpBraceRegenT === regen - 1);
  stepHolding(w, 1, []);
  check("a full 7.0s banks exactly one charge and resets the regen", p1.pvpBraceCharge === 1 && p1.pvpBraceRegenT === 0);
  stepHolding(w, regen * 2, []);
  check("continuous standing never banks past one charge (max 1)", p1.pvpBraceCharge === 1);
}

// ---------------------------------------------------------------------------------------------
section("brace_band: the next incoming KB is HALVED and spends the charge (never immunity)");
{
  // Two identical face-offs on the clear lane; the only difference is one victim holds a charge.
  function firstHitKb(isBraced: boolean): { moved: number; chargeAfter: number } {
    const w = pvpWorld(5, ["p1", "p2"]);
    advanceToLive(w);
    const victim = w.players.get("p1")!, shooter = w.players.get("p2")!;
    shooter.x = 300; shooter.y = 216; clearProtection(shooter);
    victim.x = 340; victim.y = 216; clearProtection(victim);
    shooter.weapon = "pistol"; shooter.ownedWeapons = ["pistol"];
    if (isBraced) { victim.ownedItemIds = [PVP_COUNTER_BRACE]; victim.pvpBraceCharge = 1; }
    let guard = 0, moved = 0, chargeAfter = victim.pvpBraceCharge;
    while (guard++ < 40) {
      const beforeHp = victim.hp, beforeX = victim.x;
      stepWorld(w, new Map([["p2", inp({ firing: true, aim: 0 })]]), DT);
      if (victim.hp < beforeHp) { moved = victim.x - beforeX; chargeAfter = victim.pvpBraceCharge; break; }
    }
    return { moved, chargeAfter };
  }
  const control = firstHitKb(false);
  const braced = firstHitKb(true);
  check("an unbraced pistol hit shoves the victim", control.moved > 0, `moved=${control.moved.toFixed(3)}`);
  check("a braced hit still MOVES the victim (halved, never immunity)", braced.moved > 0, `moved=${braced.moved.toFixed(3)}`);
  check("brace halves that one hit's knockback to x0.50",
    Math.abs(braced.moved / control.moved - KIT_COUNTERS.braceKbScalar) < 0.02,
    `ctrl=${control.moved.toFixed(3)} braced=${braced.moved.toFixed(3)}`);
  check("the braced hit spends the charge (bank back to 0)", braced.chargeAfter === 0);
}

// ---------------------------------------------------------------------------------------------
section("brace_band: post-hit pit-warning pulse (presentation) fires only near a pit edge");
{
  // A braced hit near the top pit pocket vs. one at the open center. The pulse is presentation-only.
  function bracedHitEvents(spot: Vec2, shooterSpot: Vec2): SimEvent[] {
    const w = pvpWorld(6, ["p1", "p2"]);
    advanceToLive(w);
    const victim = w.players.get("p1")!, shooter = w.players.get("p2")!;
    victim.x = spot.x; victim.y = spot.y; clearProtection(victim);
    shooter.x = shooterSpot.x; shooter.y = shooterSpot.y; clearProtection(shooter);
    shooter.weapon = "pistol"; shooter.ownedWeapons = ["pistol"];
    victim.ownedItemIds = [PVP_COUNTER_BRACE]; victim.pvpBraceCharge = 1;
    const out: SimEvent[] = [];
    let guard = 0;
    while (guard++ < 40) {
      const beforeHp = victim.hp;
      out.push(...stepWorld(w, new Map([["p2", inp({ firing: true, aim: 0 })]]), DT));
      if (victim.hp < beforeHp) break;
    }
    return out;
  }
  const isPitWarn = (evs: SimEvent[]): boolean =>
    evs.some((e) => e.t === "blessingProc" && e.item === PVP_COUNTER_BRACE && e.phase === "pitwarn");
  const isBraceGuard = (evs: SimEvent[]): boolean =>
    evs.some((e) => e.t === "blessingProc" && e.item === PVP_COUNTER_BRACE && e.phase === "brace");
  // (6,4) tile-center sits one tile below the (6,3)/(6,2) pit pocket — within the 0.45s ETA band.
  const nearPit = bracedHitEvents({ x: 6 * 48 + 24, y: 4 * 48 + 24 }, { x: 5 * 48 + 24, y: 4 * 48 + 24 });
  const atCenter = bracedHitEvents({ x: 456, y: 456 }, { x: 416, y: 456 });
  check("the braced hit emits its guard proc in both cases", isBraceGuard(nearPit) && isBraceGuard(atCenter));
  check("a braced hit next to a pit fires the pit-warning pulse", isPitWarn(nearPit));
  check("a braced hit at the open center fires NO pit-warning pulse", !isPitWarn(atCenter));
}

// ---------------------------------------------------------------------------------------------
section("brace_band: charge never survives a death; co-op is inert");
{
  const w = pvpWorld(7, ["p1", "p2"]);
  advanceToLive(w);
  const victim = w.players.get("p1")!, killer = w.players.get("p2")!;
  killer.x = 300; killer.y = 216; clearProtection(killer);
  victim.x = 340; victim.y = 216; clearProtection(victim);
  killer.weapon = "pistol"; killer.ownedWeapons = ["pistol"];
  victim.ownedItemIds = [PVP_COUNTER_BRACE]; victim.pvpBraceCharge = 1; victim.hp = 4;
  let guard = 0;
  while (victim.respawnT === 0 && guard++ < 20) stepWorld(w, new Map([["p2", inp({ firing: true, aim: 0 })]]), DT);
  check("the lethal hit scheduled a respawn", victim.respawnT > 0);
  check("death clears the brace charge and regen (no carry across death)",
    victim.pvpBraceCharge === 0 && victim.pvpBraceRegenT === 0);

  const coop = createWorld(70, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(coop, "c1"); spawnPlayerInWorld(coop, "c2");
  const c1 = coop.players.get("c1")!;
  c1.ownedItemIds = [PVP_COUNTER_BRACE];
  for (let i = 0; i < pvpBraceRechargeTicks() * 2; i++) stepWorld(coop, new Map(), DT);
  check("co-op never banks a brace charge (Pillar C is inert off the pvp path)",
    !isPvp(coop) && c1.pvpBraceCharge === 0 && c1.pvpBraceRegenT === 0);
}

// ---------------------------------------------------------------------------------------------
section("clear_eyes: 7.0s-ICD pulse outlines the nearest foe in radius + LOS (info only)");
{
  const w = pvpWorld(8, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!, p2 = w.players.get("p2")!;
  p1.ownedItemIds = [PVP_COUNTER_SIGHT];
  check("sight pulse ICD is 7.0s = 140 ticks", pvpSightPulseIcdTicks() === 140);
  const isMark = (evs: SimEvent[]): boolean =>
    evs.some((e) => e.t === "blessingProc" && e.item === PVP_COUNTER_SIGHT && e.phase === "mark");

  // A foe within 180px + clear LOS: the pulse marks it and arms the 7.0s ICD.
  const marked = stepHolding(w, 1, [["p1", { x: 300, y: 300 }], ["p2", { x: 450, y: 300 }]]);
  check("a foe within 180px + LOS is marked on the first pulse", isMark(marked));
  check("the mark arms the 7.0s ICD", p1.pvpSightIcdT === pvpSightPulseIcdTicks());
  check("info only — the marked foe takes no damage", p2.hp === PVP.maxHp);

  // Inside the ICD window: no second mark until it elapses.
  const cooling = stepHolding(w, pvpSightPulseIcdTicks() - 1, [["p1", { x: 300, y: 300 }], ["p2", { x: 450, y: 300 }]]);
  check("no re-mark inside the ICD window", !isMark(cooling));
  const rearmed = stepHolding(w, 1, [["p1", { x: 300, y: 300 }], ["p2", { x: 450, y: 300 }]]);
  check("the pulse re-marks exactly when the ICD elapses", isMark(rearmed));
}

// ---------------------------------------------------------------------------------------------
section("clear_eyes: radius 180 gate + LOS gate (no wallhack)");
{
  // Radius gate: a foe beyond 180px is never marked (ICD stays armed at 0).
  const wr = pvpWorld(9, ["p1", "p2"]);
  advanceToLive(wr);
  const rp1 = wr.players.get("p1")!;
  rp1.ownedItemIds = [PVP_COUNTER_SIGHT];
  const isMark = (evs: SimEvent[]): boolean =>
    evs.some((e) => e.t === "blessingProc" && e.item === PVP_COUNTER_SIGHT && e.phase === "mark");
  const farField = stepHolding(wr, 40, [["p1", { x: 300, y: 300 }], ["p2", { x: 300 + KIT_COUNTERS.sightRadius + 40, y: 300 }]]);
  check("a foe beyond 180px is never marked (radius gate)", !isMark(farField) && rp1.pvpSightIcdT === 0);

  // LOS gate: a foe within 180px but behind a wall is not marked. A wall tile is dropped between
  // them (real scene scripting — the sim's LOS check reads the live tile), then restored.
  const wl = pvpWorld(10, ["p1", "p2"]);
  advanceToLive(wl);
  const lp1 = wl.players.get("p1")!;
  lp1.ownedItemIds = [PVP_COUNTER_SIGHT];
  const midTx = Math.floor(375 / 48), midTy = Math.floor(300 / 48); // midpoint of (300,300)-(450,300)
  const idx = midTy * wl.dungeon.w + midTx;
  const restore = wl.dungeon.tiles[idx];
  wl.dungeon.tiles[idx] = 1; // a wall on the sight line
  const blocked = stepHolding(wl, 20, [["p1", { x: 300, y: 300 }], ["p2", { x: 450, y: 300 }]]);
  check("a foe behind a wall is NOT marked (LOS required — no wallhack)", !isMark(blocked) && lp1.pvpSightIcdT === 0);
  wl.dungeon.tiles[idx] = restore;
  const clear = stepHolding(wl, 1, [["p1", { x: 300, y: 300 }], ["p2", { x: 450, y: 300 }]]);
  check("with the wall gone the same foe is marked", isMark(clear));
}

// ---------------------------------------------------------------------------------------------
section("rip_post: a reload (shot) OR dash rips tar under self (r40) + chips one adjacent cover");
{
  const isRip = (evs: SimEvent[]): boolean =>
    evs.some((e) => e.t === "blessingProc" && e.item === PVP_COUNTER_RIP && e.phase === "rip");

  // Trigger on a SHOT (the arena's "reload" beat). Stationary, so the tar stays under the body.
  {
    const w = pvpWorld(11, ["p1", "p2"]);
    advanceToLive(w);
    const p1 = w.players.get("p1")!, p2 = w.players.get("p2")!;
    p1.x = 300; p1.y = 216; clearProtection(p1); p1.fireCd = 0;
    p2.x = 700; p2.y = 700; clearProtection(p2); // parked far, out of the shot's line
    p1.ownedItemIds = [PVP_COUNTER_RIP]; p1.weapon = "pistol"; p1.ownedWeapons = ["pistol"];
    w.hazards = w.hazards.filter((h) => h.kind !== "tar" && h.kind !== "spark");
    const under = pushTar(w, p1.x, p1.y);
    const far = pushTar(w, p1.x + 200, p1.y);
    const crate = devSpawnProp(w, "crate", p1.x, p1.y + 40);
    const crateHp = crate.hp;
    check("rip ICD is 8.0s = 160 ticks", pvpRipIcdTicks() === 160);
    const evs = stepWorld(w, new Map([["p1", inp({ firing: true, aim: 0 })]]), DT);
    check("a shot rips the post", isRip(evs));
    check("tar under self (r40) is cleared", !w.hazards.some((h) => h.id === under.id));
    check("tar outside r40 is left alone", w.hazards.some((h) => h.id === far.id));
    check("one adjacent breakable cover is chipped by a single break tick (not destroyed)",
      crate.hp === crateHp - KIT_COUNTERS.ripCoverChipDamage && crate.hp > 0 && !crate.dead);
    check("the rip arms the 8.0s ICD", p1.pvpRipIcdT === pvpRipIcdTicks());
    check("rip deals no player damage (a parked foe is untouched)", p2.hp === PVP.maxHp);
  }

  // Trigger on a DASH.
  {
    const w = pvpWorld(12, ["p1", "p2"]);
    advanceToLive(w);
    const p1 = w.players.get("p1")!;
    p1.x = 300; p1.y = 216; clearProtection(p1); p1.dashCd = 0; p1.dashTime = 0;
    p1.ownedItemIds = [PVP_COUNTER_RIP];
    w.hazards = w.hazards.filter((h) => h.kind !== "tar" && h.kind !== "spark");
    const under = pushTar(w, p1.x, p1.y);
    const evs = stepWorld(w, new Map([["p1", inp({ dash: true, moveX: 1, moveY: 0 })]]), DT);
    check("a dash rips the post", isRip(evs));
    check("the dash-rip clears the tar under self", !w.hazards.some((h) => h.id === under.id));
    check("the dash-rip arms the 8.0s ICD", p1.pvpRipIcdT === pvpRipIcdTicks());
  }
}

// ---------------------------------------------------------------------------------------------
section("rip_post: the 8.0s ICD gates re-triggers; co-op is inert");
{
  const w = pvpWorld(13, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  p1.x = 300; p1.y = 216; clearProtection(p1); p1.fireCd = 0;
  p1.ownedItemIds = [PVP_COUNTER_RIP]; p1.weapon = "pistol"; p1.ownedWeapons = ["pistol"];
  w.hazards = w.hazards.filter((h) => h.kind !== "tar" && h.kind !== "spark");
  pushTar(w, p1.x, p1.y);
  stepWorld(w, new Map([["p1", inp({ firing: true, aim: 0 })]]), DT); // first rip (armed)
  check("the first rip fired (tar gone, ICD armed)", !w.hazards.some((h) => h.kind === "tar") && p1.pvpRipIcdT > 0);
  const midIcd = pushTar(w, p1.x, p1.y);
  p1.fireCd = 0;
  stepWorld(w, new Map([["p1", inp({ firing: true, aim: 0 })]]), DT); // still on ICD
  check("a shot inside the ICD does NOT re-rip (tar survives)", w.hazards.some((h) => h.id === midIcd.id));
  let guard = 0;
  while (p1.pvpRipIcdT > 0 && guard++ < 400) { p1.x = 300; p1.y = 216; stepWorld(w, new Map(), DT); }
  p1.fireCd = 0;
  stepWorld(w, new Map([["p1", inp({ firing: true, aim: 0 })]]), DT);
  check("once the ICD elapses the next shot rips again", !w.hazards.some((h) => h.id === midIcd.id));

  const coop = createWorld(130, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(coop, "c1"); spawnPlayerInWorld(coop, "c2");
  const c1 = coop.players.get("c1")!;
  c1.x = coop.dungeon.spawn.x * 48 + 24; c1.y = coop.dungeon.spawn.y * 48 + 24;
  c1.ownedItemIds = [PVP_COUNTER_RIP]; c1.dashCd = 0; c1.dashTime = 0;
  const coopTar = pushTar(coop, c1.x, c1.y);
  stepWorld(coop, new Map([["c1", inp({ dash: true, moveX: 1, moveY: 0 })]]), DT);
  check("co-op never rips the post (tar under a co-op dasher survives)",
    !isPvp(coop) && coop.hazards.some((h) => h.id === coopTar.id) && c1.pvpRipIcdT === 0);
}

// ---------------------------------------------------------------------------------------------
process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("\nAll PVP Wave 2 draft-counter assertions passed.\n");
