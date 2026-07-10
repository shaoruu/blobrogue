// The ARSENAL QA GATES: every weapon is held to the manifest contract in
// src/sim/arsenal.ts. Sections are labeled with the review severity they enforce:
//
//   [HOLD]   authority exploits, unbounded loops/entities, invisible damage,
//            room+boss dominance, cross-client divergence — ship blockers;
//   [MAJOR]  generic/duplicate role, damage/rate/color-only variants, tooltip
//            mismatch vs canonical runtime, missing authored identity;
//   [REVIEW] balance review triggers — >25% clear-time advantage over the room
//            median across most rooms, or winning swarm + single-target + safety
//            at once.
//
// The room harness is the proof engine: one deterministic bot runs every weapon
// through the same authored rooms; each weapon must CLEAR its manifest excelRoom
// under the cap and measurably fail/degrade in its weakRoom. Run with --matrix to
// print the full measurement table.
//
// Run: npm run test:arsenal

import "./harness/domShim.js";
import { domCanvas, domMinimap, domOverlay } from "./harness/domShim.js";
import { Game } from "../src/game/game.js";
import { Hud } from "../src/game/hud.js";
import { Minimap } from "../src/game/minimap.js";
import {
  createWorld, stepWorld, stepWorldPhase, stepPlayerPhase, spawnPlayerInWorld,
  removePlayerFromWorld, setPlayerAbsence, devSpawnEnemy, devSpawnProp,
  acquireWeaponInWorld, switchWeaponInWorld, applyItemToWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Enemy, EnemyKind, WeaponId, Effect } from "../src/sim/types.js";
import { WEAPONS, PICKUP_WEAPONS, MAX_WIRES, MAX_WIRES_PARTY, MAX_ORBIT_BLADES } from "../src/sim/weapons.js";
import type { Weapon } from "../src/sim/weapons.js";
import { ARSENAL } from "../src/sim/arsenal.js";
import type { RoomId, AuthorityChannel } from "../src/sim/arsenal.js";
import { weaponDisplayStats, lowHpFrac } from "../src/sim/weaponStats.js";
import { ITEMS, createMods, recomputeMods } from "../src/sim/items.js";
import type { PlayerMods } from "../src/sim/items.js";
import * as C from "../src/sim/constants.js";
import { PU_DPS, PERSISTENT_BOSS_DPS_FRAC, BOSS_VULN_CAP, BOSS_NATIVE_PELLET_COEF, WEAPON_BOSS_COEF } from "../src/sim/balance.js";
import { jsonCodec, buildSnapshot, ProtocolError } from "../src/net/protocol.js";
import { WAVE_SOUNDS, WEAPON_AUDIO, STATUS_AUDIO } from "../src/game/waveSpec.js";

const DT = 1 / 60;
const ALL_WEAPONS = Object.keys(WEAPONS) as WeaponId[];

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

// ---- the room harness ----------------------------------------------------------------

const ROOM_CAP_TICKS = 12 * 60; // 12s: a room a weapon cannot clear in 12s is a failed job

interface RoomResult {
  clearTicks: number;  // ROOM_CAP_TICKS when uncleared
  isCleared: boolean;
  hpLost: number;      // player hearts lost during the attempt (6 = died)
  frozenTicks: number; // enemy-ticks spent frozen solid (the control archetype's metric)
}

function parked(w: WorldState, kind: EnemyKind, x: number, y: number, hp: number): Enemy {
  const e = devSpawnEnemy(w, kind, x, y);
  e.spawnTimer = 0;
  e.speed = 0;
  e.kbResist = 1e9;
  e.hp = e.maxHp = hp;
  return e;
}

function mover(w: WorldState, kind: EnemyKind, x: number, y: number, hp: number): Enemy {
  const e = devSpawnEnemy(w, kind, x, y);
  e.spawnTimer = 0;
  e.hp = e.maxHp = hp;
  return e;
}

// The authored QA rooms. Every weapon faces the identical setup (same seed, same
// bodies); the bot is the same stationary pulse-trigger gunner for all of them, so a
// weapon's number is its mechanics, never its script. A room without isDone clears when
// every body dies; a task room (cover) declares its own victory.
interface RoomDef {
  setup(w: WorldState, p: PlayerSim): void;
  isDone?(w: WorldState): boolean;
  onTick?(w: WorldState, p: PlayerSim, t: number): void;
}

const ROOMS: Record<RoomId, RoomDef> = {
  // A soft crowd converging from a ring: sustained-clear rooms.
  swarm: {
    setup: (w, p) => {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        mover(w, "slime", p.x + Math.cos(a) * 200, p.y + Math.sin(a) * 200, 5);
      }
    },
  },
  // One tough body parked at range: the single-target/reach room.
  anchor: { setup: (w, p) => { parked(w, "skeleton", p.x + 300, p.y, 60); } },
  // Five standard bodies parked at handshake distance: the point-blank room.
  brawl: {
    setup: (w, p) => {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        parked(w, "skeleton", p.x + Math.cos(a) * 70, p.y + Math.sin(a) * 70, 12);
      }
    },
  },
  // A single-file column: the pierce/line room.
  lane: {
    setup: (w, p) => {
      for (let i = 0; i < 5; i++) parked(w, "slime", p.x + 120 + i * 45, p.y, 10);
    },
  },
  // ERASE THE ANCHOR: a tanky living picket screens the back-line target; direct fire
  // eats the screen first, artillery sails over it. Victory = the ANCHOR dies (a task
  // room, not a clear room).
  cover: {
    setup: (w, p) => {
      for (const dy of [-36, -12, 12, 36]) parked(w, "slime", p.x + 140, p.y + dy, 200);
      parked(w, "slime", p.x + 280, p.y, 50);
    },
    isDone: (w) => !w.enemies.some((e) => e.maxHp === 50 && !e.dead),
  },
  // Fast erratic movers closing from far out: the tracking room. The bot's aim WOBBLES
  // here (deterministic sinusoid) — kite measures how a weapon forgives imperfect aim
  // against fast bodies, which is the seeker/cone family's actual job.
  kite: {
    setup: (w, p) => {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        mover(w, "bat", p.x + Math.cos(a) * 420, p.y + Math.sin(a) * 420, 6);
      }
    },
  },
  // The trap-verb room: a free 2s SETUP BEAT with nothing on the floor, then a
  // converging wave. Placement weapons convert the beat into pre-laid answers; direct
  // fire can only wait it out. isDone guards the pre-wave phase.
  ambush: {
    setup: () => {},
    onTick: (w, p, t) => {
      if (t !== 120) return;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        mover(w, "slime", p.x + Math.cos(a) * 260, p.y + Math.sin(a) * 260, 5);
      }
    },
    isDone: (w) => w.tick > 130 && w.enemies.length === 0,
  },
  // THE CHOKEPOINT: a crate wall with one gap funnels the whole wave across a single
  // line. Trap/zone verbs pre-lay the door; direct fire pays the wall tax (crates eat
  // bullets) or waits at the mouth.
  door: {
    setup: (w, p) => {
      for (let dy = -182; dy <= 182; dy += 26) {
        if (Math.abs(dy) < 26) continue; // the doorway
        devSpawnProp(w, "crate", p.x + 120, p.y + dy);
      }
      for (let i = 0; i < 8; i++) {
        mover(w, "slime", p.x + 330 + (i % 4) * 42, p.y + Math.floor(i / 4) * 64 - 32, 5);
      }
    },
  },
  // Two lanes at once: plant/deploy east through the setup phase, then fight the west
  // stream yourself with the pistol. The gate compares against the pistol-only baseline
  // — a second-lane tool must beat fighting both lanes with the sidearm alone.
  secondlane: {
    setup: (w, p) => {
      for (let i = 0; i < 4; i++) mover(w, "slime", p.x + 200 + i * 45, p.y + (i % 2) * 40 - 20, 8);
      for (let i = 0; i < 3; i++) mover(w, "slime", p.x - 200 - i * 50, p.y + (i - 1) * 30, 8);
    },
  },
};
const ROOM_IDS = Object.keys(ROOMS) as RoomId[];

function nearestEnemy(w: WorldState, p: PlayerSim, filter?: (e: Enemy) => boolean): Enemy | null {
  let best: Enemy | null = null;
  let bestD = Infinity;
  for (const e of w.enemies) {
    if (e.dead || (filter && !filter(e))) continue;
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function nearestEnemyAngle(w: WorldState, p: PlayerSim, filter?: (e: Enemy) => boolean): number {
  const best = nearestEnemy(w, p, filter);
  return best ? Math.atan2(best.y - p.y, best.x - p.x) : 0;
}

// Charge weapons aim like a human reads the landing marker: at the FARTHEST body (the
// nearest may sit inside the minimum-charge dead zone — that dead zone is the weapon's
// authored weakness, not the bot's).
function farthestEnemy(w: WorldState, p: PlayerSim): Enemy | null {
  let best: Enemy | null = null;
  let bestD = -1;
  for (const e of w.enemies) {
    if (e.dead) continue;
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d > bestD) { bestD = d; best = e; }
  }
  return best;
}

function botAim(w: WorldState, p: PlayerSim): number {
  const target = WEAPONS[p.weapon].charge ? farthestEnemy(w, p) : nearestEnemy(w, p);
  return target ? Math.atan2(target.y - p.y, target.x - p.x) : 0;
}

// The bot's trigger: a plain pulse for every weapon, except charge weapons, where the
// bot does what the on-screen landing marker teaches a human — hold until the charged
// distance reaches the target, then release.
function botFiring(w: WorldState, p: PlayerSim, t: number): boolean {
  const spec = WEAPONS[p.weapon].charge;
  if (!spec) return t % 48 < 39;
  const target = farthestEnemy(w, p);
  if (!target) return false;
  const dist = Math.hypot(target.x - p.x, target.y - p.y);
  // Inside the minimum-charge landing there is nothing to charge FOR: tap and let the
  // blast radius do the work (or miss — the dead zone is the weapon's authored cost).
  if (dist <= spec.minDist * p.mods.bulletLifeMult + 20) return t % 48 < 2; // a TAP, not a hold
  const charged = (spec.minDist + (spec.maxDist - spec.minDist) * (p.chargeT / spec.time)) * p.mods.bulletLifeMult;
  return charged < Math.min(dist, spec.maxDist * p.mods.bulletLifeMult) - 12;
}

// One deterministic bot: stationary, aims at the nearest living body, and PULSES the
// trigger (0.65s hold / 0.15s release) so hold-release and latch/sweep archetypes all
// execute their full loops. The secondlane room runs the authored two-lane script.
// The second-lane setup phase: long enough for a full placement rotation (three wire
// plants at the Snapwire's cadence) before the bot turns to fight the west lane itself.
const SECONDLANE_SETUP_TICKS = 84;

// riskHp: risk-resource weapons (the Lastlight) have their declared metrics measured
// with the cost PAID — god mode holds the bar at the authored risk point, so the curve
// (not the bot's tanking) is what the room measures. purse: coin-fed weapons (the Midas)
// measure their declared metrics with the purse STOCKED, the same paid-ceiling contract.
function measureRoom(weapon: WeaponId, room: RoomId, opts: { riskHp?: number; purse?: number } = {}): RoomResult {
  const w = createWorld(0xA25E7 + ROOM_IDS.indexOf(room), 1, { isSandbox: true });
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  p.x = 17 * 48; p.y = 12 * 48;
  if (opts.riskHp !== undefined) {
    w.isGodMode = true;
    p.hp = opts.riskHp;
  }
  if (opts.purse !== undefined) p.coins = opts.purse;
  ROOMS[room].setup(w, p);
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  const isSecondLane = room === "secondlane";
  if (isSecondLane) acquireWeaponInWorld(w, LOCAL_ID, "pistol"), switchWeaponInWorld(w, LOCAL_ID, weapon);
  const isDone = ROOMS[room].isDone ?? ((world: WorldState) => world.enemies.length === 0);
  let clearTick = ROOM_CAP_TICKS;
  let frozenTicks = 0;
  for (let t = 0; t < ROOM_CAP_TICKS; t++) {
    let aim: number;
    if (isSecondLane) {
      // Setup phase: face the EAST lane with the tested weapon (plant/deploy/paint).
      // Then switch to the pistol and fight the WEST lane; the tested weapon's authored
      // output holds the east on its own (or doesn't — that's the measure).
      if (t === SECONDLANE_SETUP_TICKS) switchWeaponInWorld(w, LOCAL_ID, "pistol");
      aim = t < SECONDLANE_SETUP_TICKS ? 0 : nearestEnemyAngle(w, p, (e) => p.weapon === "pistol" ? true : e.x < p.x);
    } else if (room === "cover") {
      // The cover room is a TASK: erase the screened anchor. The bot aims at the task
      // target; whether the weapon can reach past the living screen IS the measurement.
      const anchor = w.enemies.find((e) => e.maxHp === 50 && !e.dead);
      aim = anchor ? Math.atan2(anchor.y - p.y, anchor.x - p.x) : botAim(w, p);
    } else {
      aim = botAim(w, p);
      // Kite: deterministic aim wobble — the room measures aim forgiveness.
      if (room === "kite") aim += 0.35 * Math.sin(t * 0.22);
      // Nothing alive yet (the ambush setup beat): sweep the aim so placement weapons
      // lay their answers in a circle — what a human does with a free beat.
      if (!w.enemies.some((e) => !e.dead)) aim = t * 0.09;
    }
    ROOMS[room].onTick?.(w, p, t);
    const cmd: InputCmd = { seq: t + 1, moveX: 0, moveY: 0, aim, firing: botFiring(w, p, t), dash: false };
    stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
    for (const e of w.enemies) if (!e.dead && e.chill >= C.FREEZE_AT) frozenTicks++;
    if (isDone(w)) { clearTick = t + 1; break; }
    if (w.isRunOver) break; // died: uncleared at full hp loss
  }
  return {
    clearTicks: clearTick,
    isCleared: clearTick < ROOM_CAP_TICKS && !w.isRunOver,
    hpLost: Math.max(0, p.maxHp - Math.max(0, p.hp)),
    frozenTicks,
  };
}

// Boss cell (dominance gate): damage dealt to the Slime King in an 8s god-mode window.
function measureBossDamage(weapon: WeaponId): number {
  const w = createWorld(0xB055, 5, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.x = 17 * 48; p.y = 12 * 48;
  const boss = devSpawnEnemy(w, "boss", p.x + 250, p.y);
  boss.spawnTimer = 0;
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  for (let t = 0; t < 8 * 60; t++) {
    const aim = Math.atan2(boss.y - p.y, boss.x - p.x);
    stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim, firing: botFiring(w, p, t), dash: false }]]), DT);
    if (boss.dead) break;
  }
  return boss.maxHp - Math.max(0, boss.hp);
}

interface Matrix {
  rooms: Map<WeaponId, Record<RoomId, RoomResult>>;
  boss: Map<WeaponId, number>;
}

// ---- declared metrics (balancer envelope) ----
// Every metric is a scalar per weapon; dir says which direction is better. Uncleared
// rooms count at the cap, so clearing a room most of the arsenal fails IS the edge.
type MetricDir = "low" | "high";
const METRIC_DIR: Record<string, MetricDir> = { safety: "low", control: "high", boss: "high" };

function metricValue(m: Matrix, id: WeaponId, metric: string): number {
  if (metric === "safety") {
    return ROOM_IDS.reduce((s2, r) => s2 + m.rooms.get(id)![r].hpLost, 0);
  }
  if (metric === "control") {
    return ROOM_IDS.reduce((s2, r) => s2 + m.rooms.get(id)![r].frozenTicks, 0);
  }
  if (metric === "boss") return m.boss.get(id)!;
  return m.rooms.get(id)![metric as RoomId].clearTicks;
}

function metricMedian(m: Matrix, metric: string): number {
  const vals = ALL_WEAPONS.map((id) => metricValue(m, id, metric)).sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

// Whether `id` beats the arsenal median on `metric` by >=15%.
function beatsMedian(m: Matrix, id: WeaponId, metric: string): boolean {
  const v = metricValue(m, id, metric);
  const med = metricMedian(m, metric);
  const dir = METRIC_DIR[metric] ?? "low";
  return dir === "low" ? v <= med * 0.85 : v >= med * 1.15 && v > 0;
}

function printMetricDiagnostics(m: Matrix): void {
  const metrics = [...ROOM_IDS.filter((r) => r !== "secondlane"), "safety", "control", "boss"];
  process.stdout.write("\ndeclarable metrics (beats median by >=15%):\n");
  for (const id of ALL_WEAPONS) {
    const ok = metrics.filter((mt) => beatsMedian(m, id, mt));
    process.stdout.write(`  ${id.padEnd(10)} ${ok.join(", ") || "(none)"}\n`);
  }
}

function measureMatrix(): Matrix {
  const rooms = new Map<WeaponId, Record<RoomId, RoomResult>>();
  const boss = new Map<WeaponId, number>();
  for (const id of ALL_WEAPONS) {
    const row = {} as Record<RoomId, RoomResult>;
    for (const room of ROOM_IDS) row[room] = measureRoom(id, room);
    rooms.set(id, row);
    boss.set(id, measureBossDamage(id));
  }
  return { rooms, boss };
}

function printMatrix(m: Matrix): void {
  const head = ["weapon".padEnd(10), ...ROOM_IDS.map((r) => r.padStart(11)), "boss".padStart(7)].join("");
  process.stdout.write(head + "\n");
  for (const id of ALL_WEAPONS) {
    const row = m.rooms.get(id)!;
    const cells = ROOM_IDS.map((r) => {
      const res = row[r];
      const t = res.isCleared ? (res.clearTicks / 60).toFixed(1) + "s" : "—";
      return `${t}/${res.hpLost}hp`.padStart(11);
    });
    process.stdout.write(id.padEnd(10) + cells.join("") + m.boss.get(id)!.toFixed(0).padStart(7) + "\n");
  }
}

// Median clear ticks among weapons that CLEARED a room (uncleared entries excluded so
// one impossible pairing can't drag the room's midpoint to the cap).
function roomMedian(m: Matrix, room: RoomId): number {
  const ts = ALL_WEAPONS.map((id) => m.rooms.get(id)![room]).filter((r) => r.isCleared).map((r) => r.clearTicks).sort((a, b) => a - b);
  if (ts.length === 0) return ROOM_CAP_TICKS;
  return ts[Math.floor(ts.length / 2)];
}

// ---- gates ---------------------------------------------------------------------------

function manifestGates(): void {
  section("[MAJOR] manifest: every weapon carries a complete authored identity");
  const KNOWN_AUTHORITY: readonly AuthorityChannel[] = [
    "bullets", "meleeSwing", "chargeT", "effects:zone", "effects:wire", "effects:orbit", "effects:sentry", "effects:tether",
  ];
  // Legacy sample families that predate the wave manifest (audio.ts SAMPLES keys).
  const LEGACY_AUDIO = new Set([
    "shootPistol", "shootShotgun", "shootRapid", "smg", "cannon", "burst", "ricochet",
    "homing", "tesla", "meleeSwing", "heavySwing",
  ]);
  check("every WeaponId has a manifest row", ALL_WEAPONS.every((id) => ARSENAL[id] !== undefined));
  check("every row fills every authored field (no empty identity)", ALL_WEAPONS.every((id) => {
    const e = ARSENAL[id];
    return e.role.length > 8 && e.strength.length > 8 && e.weakness.length > 8
      && e.modifiers.length > 8 && e.audio.length > 0 && e.visual.length > 8
      && e.authority.length > 0;
  }));
  check("audio identity resolves to a wave-manifest event or a legacy sample family",
    ALL_WEAPONS.every((id) => {
      const a = ARSENAL[id].audio;
      return Object.prototype.hasOwnProperty.call(WAVE_SOUNDS, a) || LEGACY_AUDIO.has(a);
    }));
  check("visual identity states the weapon's canonical color",
    ALL_WEAPONS.every((id) => ARSENAL[id].visual.includes(WEAPONS[id].color)));
  check("authority claims name real server-owned channels only",
    ALL_WEAPONS.every((id) => ARSENAL[id].authority.every((ch) => KNOWN_AUTHORITY.includes(ch))));
  check("every effect weapon claims its effect channel",
    ([["snapwire", "effects:wire"], ["frostline", "effects:zone"], ["halo", "effects:orbit"],
      ["sentry", "effects:sentry"], ["crook", "effects:tether"], ["breach", "chargeT"]] as Array<[WeaponId, AuthorityChannel]>)
      .every(([id, ch]) => ARSENAL[id].authority.includes(ch)));
  // "coin-fed" (the Midas) keeps the INFINITE RESERVE contract: the run economy
  // AMPLIFIES the shot, never gates it — a broke trigger still fires.
  check("the arsenal contract holds: no global ammo/meter resource models",
    ALL_WEAPONS.every((id) => ["none", "hold", "placement", "position", "health-risk", "coin-fed"].includes(ARSENAL[id].resource)));

  section("[MAJOR] roles: no duplicates; no damage/rate/color-only variants");
  const roles = ALL_WEAPONS.map((id) => ARSENAL[id].role);
  check("every role string is unique", new Set(roles).size === roles.length);
  // The variant fingerprint: mechanic signature (behavior flags — everything EXCEPT
  // damage/rate/color numbers) + the manifest's range band + target profile. Two
  // weapons sharing all three are the same weapon with different numbers — rejected.
  const mechSig = (wep: Weapon): string => [
    wep.melee ? (wep.melee.isThrust ? "thrust" : "sweep") : "",
    wep.charge ? "charge" : "", wep.wire ? "wire" : "", wep.paint ? "paint" : "",
    wep.orbit ? "orbit" : "", wep.sentry ? "sentry" : "", wep.tether ? "tether" : "",
    wep.bounce !== undefined ? "bounce" : "", wep.homing !== undefined ? "homing" : "",
    wep.chain !== undefined ? "chain" : "", wep.blast !== undefined ? "blast" : "",
    (wep.basePierce ?? 0) > 0 ? "pierce" : "", wep.pellets > 1 ? "multi" : "",
    wep.burn !== undefined ? "burn" : "", wep.chill !== undefined ? "chill" : "",
    wep.lowHpBonus !== undefined ? "risk" : "",
    // The legendary wave's signature flags — part of the structural fingerprint, so a
    // legendary can never read as a numbers-only variant of its nearest neighbor.
    wep.killShards !== undefined ? "reap" : "", wep.accel !== undefined ? "accel" : "",
    wep.coinBoost !== undefined ? "gilded" : "", wep.isPhase === true ? "phase" : "",
    wep.implode !== undefined ? "implode" : "",
  ].filter((s) => s.length > 0).join("+") || "plain";
  const fingerprints = ALL_WEAPONS.map((id) => `${mechSig(WEAPONS[id])}|${ARSENAL[id].idealRange}|${ARSENAL[id].target}`);
  const dupes = fingerprints.filter((f, i) => fingerprints.indexOf(f) !== i);
  check("no two weapons share mechanic signature + range band + target profile", dupes.length === 0,
    dupes.join(" ; "));
}

function tooltipParityGates(): void {
  section("[MAJOR] tooltips consume the ONE shared stats model (no duplicate copy)");
  const mods = createMods();
  recomputeMods(mods, ["glass_cannon", "hair_trigger", "hair_trigger", "split_shot", "big_iron"]);

  // The effect wave flows through the SAME weaponDisplayStats model #46 built — POWER and
  // REACH are the exact live sim numbers, proven against an authoritative fired bullet.
  for (const id of ["pistol", "lastlight", "railgun"] as WeaponId[]) {
    for (const [label, m] of [["base", createMods()], ["modified", mods]] as Array<[string, PlayerMods]>) {
      const w = createWorld(0x71B, 1, { isSandbox: true });
      const p = w.players.get(LOCAL_ID)!;
      p.invuln = 0;
      acquireWeaponInWorld(w, LOCAL_ID, id);
      Object.assign(p.mods, m);
      p.mods.critChance = 0; // parity checks state the non-crit line
      const lowHp = lowHpFrac(p.hp, p.maxHp);
      const card = weaponDisplayStats(id, p.mods, lowHp);
      const muzzleX = p.x + 18; // aim 0 muzzle, captured BEFORE self-knockback moves p
      stepWorld(w, new Map([[LOCAL_ID, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT);
      const b = w.bullets[0];
      const range = (b.x - muzzleX) + Math.hypot(b.vx, b.vy) * b.life;
      check(`${id} (${label}): card POWER equals the fired bullet's damage`,
        Math.abs(card.power.perHit - b.damage) < 1e-9, `card=${card.power.perHit} fired=${b.damage}`);
      check(`${id} (${label}): card REACH band tracks the bullet's actual travel`,
        Math.abs(card.reach.num - range) <= 2, `card=${Math.round(card.reach.num)} actual=${Math.round(range)}`);
    }
  }
  // The effect wave's non-projectile archetypes read their room verb + mechanic through the
  // shared model — role and technique lines, never a bespoke second tooltip.
  const wave: WeaponId[] = ["lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook"];
  check("every effect-wave weapon states a room-verb role through the shared model",
    wave.every((id) => weaponDisplayStats(id, createMods(), 0).role.length > 6));
  check("every effect-wave weapon carries at least one technique/tradeoff line",
    wave.every((id) => weaponDisplayStats(id, createMods(), 0).mechanics.length >= 1));
  check("distinct room jobs read distinct role verbs",
    new Set(wave.map((id) => weaponDisplayStats(id, createMods(), 0).role)).size >= 6);
  const wireCard = weaponDisplayStats("snapwire", createMods(), 0);
  check("the trap's coverage + mechanic read as a trap (not a projectile pattern)",
    wireCard.coverage.kind === "TRAP" && wireCard.mechanics.some((mech) => mech.tag === "WIRE"));
  const haloBase = weaponDisplayStats("halo", createMods(), 0).mechanics.find((mech) => mech.tag === "ORBIT")!;
  const haloMod = weaponDisplayStats("halo", mods, 0).mechanics.find((mech) => mech.tag === "ORBIT")!;
  check("the orbit's blade count rises with the pellets mod through the shared model",
    haloMod.mag > haloBase.mag, `base=${haloBase.mag} mod=${haloMod.mag}`);
  check("the risk curve is a mechanic line, never a fluctuating stat band",
    weaponDisplayStats("lastlight", createMods(), 0).mechanics.some((mech) => mech.tag === "RISK"));
}

function roomProofGates(m: Matrix): void {
  section("rooms: every weapon proves its excel room (clears under the QA cap)");
  for (const id of ALL_WEAPONS) {
    const entry = ARSENAL[id];
    const res = m.rooms.get(id)![entry.excelRoom];
    if (entry.excelRoom === "secondlane") {
      const baseline = measureRoom("pistol", "secondlane");
      check(`${id} excels in ${entry.excelRoom}: beats the pistol-only baseline`,
        res.isCleared && (res.clearTicks < baseline.clearTicks || res.hpLost < baseline.hpLost),
        `it=${(res.clearTicks / 60).toFixed(1)}s/${res.hpLost}hp baseline=${(baseline.clearTicks / 60).toFixed(1)}s/${baseline.hpLost}hp`);
    } else {
      check(`${id} excels in ${entry.excelRoom}`, res.isCleared,
        res.isCleared ? `${(res.clearTicks / 60).toFixed(1)}s` : "uncleared");
    }
  }

  section("rooms: every weapon's authored weakness MATTERS in its weak room");
  for (const id of ALL_WEAPONS) {
    const entry = ARSENAL[id];
    const weak = m.rooms.get(id)![entry.weakRoom];
    const median = roomMedian(m, entry.weakRoom);
    const best = Math.min(...ALL_WEAPONS.map((o) => m.rooms.get(o)![entry.weakRoom]).filter((r) => r.isCleared).map((r) => r.clearTicks));
    // The weakness is real when the weapon FAILS the room outright, clears it >=40%
    // slower than the room's median weapon, or trails the room's BEST weapon by >=50%
    // (the generalist clause: never terrible anywhere, meaningfully outclassed where
    // the specialists live).
    const matters = !weak.isCleared || weak.clearTicks >= median * 1.4 || weak.clearTicks >= best * 1.5;
    check(`${id}'s weakness shows in ${entry.weakRoom}`, matters,
      weak.isCleared ? `${(weak.clearTicks / 60).toFixed(1)}s vs median ${(median / 60).toFixed(1)}s / best ${(best / 60).toFixed(1)}s` : "uncleared (weakness proven)");
  }
}

function dominanceGates(m: Matrix): void {
  section("[REVIEW] dominance: no weapon owns most rooms by a >25% margin");
  // Generalism rooms only: cover and door exist to PROVE specific verbs (artillery over
  // a screen, a chokepoint), so a specialist owning them is authored, not dominance.
  const coreRooms: RoomId[] = ["swarm", "anchor", "brawl", "lane", "kite", "ambush"];
  for (const id of ALL_WEAPONS) {
    let dominant = 0;
    for (const room of coreRooms) {
      const res = m.rooms.get(id)![room];
      if (res.isCleared && res.clearTicks <= roomMedian(m, room) * 0.75) dominant++;
    }
    check(`${id} is not >25% faster than median in most rooms`, dominant < 4,
      `dominant in ${dominant}/${coreRooms.length} generalism rooms`);
  }

  section("[REVIEW] no triple crown: swarm + single-target + safety never one weapon");
  const bestOf = (metric: (id: WeaponId) => number): WeaponId => {
    let best = ALL_WEAPONS[0];
    for (const id of ALL_WEAPONS) if (metric(id) < metric(best)) best = id;
    return best;
  };
  const swarmKing = bestOf((id) => m.rooms.get(id)!.swarm.clearTicks);
  const anchorKing = bestOf((id) => m.rooms.get(id)!.anchor.clearTicks);
  const safetyKing = bestOf((id) => ROOM_IDS.reduce((s, r) => s + m.rooms.get(id)![r].hpLost, 0));
  check("swarm/single-target/safety crowns are split", !(swarmKing === anchorKing && anchorKing === safetyKing),
    `swarm=${swarmKing} anchor=${anchorKing} safety=${safetyKing}`);

  section("[HOLD] no weapon dominates the rooms AND the boss");
  const bossVals = ALL_WEAPONS.map((id) => m.boss.get(id)!).sort((a, b) => b - a);
  const bossTop2 = bossVals[1];
  for (const id of ALL_WEAPONS) {
    const coreDominant = coreRooms.filter((room) => {
      const res = m.rooms.get(id)![room];
      return res.isCleared && res.clearTicks <= roomMedian(m, room) * 0.75;
    }).length;
    const isBossTop = m.boss.get(id)! >= bossTop2;
    // "Dominant rooms" is the same most-rooms criterion as the review trigger: a
    // specialist may own its niche AND be the boss answer (the Longshot is authored to
    // be exactly that); owning MOST rooms and the boss together is the HOLD.
    check(`${id} does not own rooms+boss together`, !(coreDominant >= 4 && isBossTop),
      `rooms=${coreDominant} bossDmg=${m.boss.get(id)!.toFixed(0)}`);
  }
}

function authorityGates(): void {
  section("[HOLD] authority: cadence is server-clocked — a held trigger can never exceed it");
  const MIN_CYCLE: Partial<Record<WeaponId, number>> = { crook: C.TETHER_LATCH_FIRE_LOCK };
  for (const id of ["pistol", "smg", "snapwire", "crook"] as WeaponId[]) {
    const w = createWorld(0xCADE, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    acquireWeaponInWorld(w, LOCAL_ID, id);
    const seconds = 3;
    let shots = 0;
    for (let t = 0; t < seconds * 60; t++) {
      const before = p.shotSeq;
      stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT);
      if (p.shotSeq > before) shots++;
    }
    const maxAllowed = Math.ceil(seconds / (MIN_CYCLE[id] ?? WEAPONS[id].fireCd)) + 1;
    check(`${id}: held trigger stays under the authored cadence`, shots <= maxAllowed, `shots=${shots} cap=${maxAllowed}`);
  }

  section("[HOLD] authority: forged client values are protocol errors, never state");
  const forged = [
    { t: "input", seq: 1, mx: 0, my: 0, aim: 0, fire: true, dash: false, act: false, ackEv: 0, dmg: 999 },
    { t: "input", seq: 1, mx: 0, my: 0, aim: 0, fire: true, dash: false, act: false, ackEv: 0, chargeT: 99 },
    { t: "input", seq: 1, mx: 0, my: 0, aim: 0, fire: true, dash: false, act: false, ackEv: 0, crit: true },
    { t: "equip", weapon: "railgun", cseq: 1, hp: 999 },
    { t: "spawnEffect", kind: "sentry", x: 0, y: 0 },
  ];
  for (const msg of forged) {
    let rejected = false;
    try { jsonCodec.decodeClient(JSON.stringify(msg)); } catch (err) { rejected = err instanceof ProtocolError; }
    check(`forged ${JSON.stringify(msg).slice(0, 68)}… rejected`, rejected);
  }

  section("[HOLD] divergence: two authoritative worlds under one input stream stay identical");
  {
    const mk = () => {
      const w = createWorld(0xD1FF, 3, { isSandbox: false, isShared: true, skipLocalPlayer: true });
      spawnPlayerInWorld(w, "pA");
      spawnPlayerInWorld(w, "pB");
      const a = w.players.get("pA")!;
      acquireWeaponInWorld(w, "pA", "frostline");
      acquireWeaponInWorld(w, "pB", "crook");
      a.invuln = 0;
      return w;
    };
    const w1 = mk(), w2 = mk();
    const script = (t: number): Map<string, InputCmd> => new Map([
      ["pA", { seq: t, moveX: Math.sin(t / 20), moveY: 0, aim: t / 30, firing: t % 40 < 30, dash: false }],
      ["pB", { seq: t, moveX: 0, moveY: Math.cos(t / 25), aim: -t / 40, firing: t % 50 < 35, dash: t % 90 === 0 }],
    ]);
    let identical = true;
    for (let t = 1; t <= 400 && identical; t++) {
      stepWorld(w1, script(t), 1 / 20);
      stepWorld(w2, script(t), 1 / 20);
      if (t % 100 === 0) {
        const s1 = JSON.stringify(buildSnapshot(w1, "pA", 0, [], 0, false, { worldId: "w" }));
        const s2 = JSON.stringify(buildSnapshot(w2, "pA", 0, [], 0, false, { worldId: "w" }));
        if (s1 !== s2) identical = false;
      }
    }
    check("snapshots byte-identical across 400 effect-heavy ticks", identical);
  }

  section("[HOLD] reconnect/late join: effects are full state, never replay-dependent");
  {
    const w = createWorld(0x1A7E, 1, { isSandbox: true, isShared: true, skipLocalPlayer: true });
    const owner = spawnPlayerInWorld(w, "pOwner");
    owner.invuln = 0;
    acquireWeaponInWorld(w, "pOwner", "snapwire");
    stepPlayerPhase(w, owner, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }, 1 / 20, []);
    switchWeaponInWorld(w, "pOwner", "pistol");
    acquireWeaponInWorld(w, "pOwner", "sentry");
    stepPlayerPhase(w, owner, { seq: 2, moveX: 0, moveY: 0, aim: 1, firing: true, dash: false }, 1 / 20, []);
    acquireWeaponInWorld(w, "pOwner", "halo");
    stepWorldPhase(w, 1 / 20, []);
    // A LATE JOINER's very first full snapshot carries every live effect.
    spawnPlayerInWorld(w, "pLate");
    const late = buildSnapshot(w, "pLate", 0, [], 0, true, { worldId: "w" });
    check("late joiner sees wire + sentry + orbit in the first full snapshot",
      late.t === "snap" && ["wire", "sentry", "orbit"].every((k) => late.effs.some((e) => e.k === k)));
    // Reconnect: placed effects survive the owner's absence; the orbit (worn, not
    // placed) dismisses with the absent body and returns with it.
    setPlayerAbsence(w, "pOwner", true);
    stepWorldPhase(w, 1 / 20, []);
    check("absence keeps placed effects, dismisses the worn orbit",
      w.effects.some((e) => e.kind === "wire") && w.effects.some((e) => e.kind === "sentry")
      && !w.effects.some((e) => e.kind === "orbit"));
    setPlayerAbsence(w, "pOwner", false);
    stepWorldPhase(w, 1 / 20, []);
    check("resume re-conjures the worn orbit", w.effects.some((e) => e.kind === "orbit"));
  }

  section("[HOLD] no duplicate AoE application or double rewards");
  {
    const w = createWorld(0xA0E1, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 500; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "breach");
    const pack = [parked(w, "slime", 640, 580, 20), parked(w, "slime", 660, 600, 20), parked(w, "slime", 640, 620, 20)];
    // Full charge then release onto the pack (min charge distance ~140 lands among them).
    stepWorld(w, new Map([[LOCAL_ID, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT);
    for (let t = 0; t < 60; t++) stepWorld(w, new Map([[LOCAL_ID, { seq: t + 2, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT);
    check("one blast hits each body in the zone exactly once",
      pack.every((e) => Math.abs((20 - e.hp) - WEAPONS.breach.damage) < 1e-9),
      pack.map((e) => (20 - e.hp).toFixed(1)).join("/"));
  }
  {
    const w = createWorld(0xA0E2, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 500; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "snapwire");
    const ev: SimEvent[] = [];
    stepWorld(w, new Map([[LOCAL_ID, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT);
    for (let t = 0; t < 50; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: t + 2, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
    const mark = parked(w, "slime", 560, 600, 5);
    for (let t = 0; t < 30; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: t + 60, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
    const kills = ev.filter((x) => x.t === "enemyKill").length;
    check("a snap kill lands exactly one kill event and one credit", mark.dead && kills === 1 && p.kills === 1,
      `kills=${p.kills} events=${kills}`);
  }

  section("[HOLD] invisible damage: every authored damage path emits the visible hit event");
  for (const id of ["lastlight", "snapwire", "frostline", "halo", "sentry", "crook", "breach"] as WeaponId[]) {
    const w = createWorld(0x51B1E + ALL_WEAPONS.indexOf(id), 1, { isSandbox: true });
    w.isGodMode = true; // the gate tests damage VISIBILITY, not the bot's survival
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, id);
    // Parked slimes (no lunge shove): the gate reads damage VISIBILITY on a stable rig.
    parked(w, "slime", 760, 600, 200);
    parked(w, "slime", 850, 600, 200);
    const ev: SimEvent[] = [];
    for (let t = 0; t < 60 * 4; t++) {
      const aim = botAim(w, p);
      ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim, firing: botFiring(w, p, t), dash: false }]]), DT));
    }
    const hits = ev.filter((x): x is Extract<SimEvent, { t: "enemyHit" }> => x.t === "enemyHit");
    check(`${id}: damage is always announced (enemyHit with finite dmg)`,
      hits.length > 0 && hits.every((h) => Number.isFinite(h.dmg) && h.dmg > 0), `hits=${hits.length}`);
  }
}

// ---- the modifier matrix -------------------------------------------------------------

function isWorldFinite(w: WorldState): boolean {
  for (const p of w.players.values()) {
    if (!Number.isFinite(p.x + p.y + p.hp + p.fireCd + p.chargeT) || p.fireCd < 0 || p.chargeT < 0) return false;
  }
  for (const b of w.bullets) if (!Number.isFinite(b.x + b.y + b.vx + b.vy + b.damage + b.life)) return false;
  for (const e of w.enemies) if (!Number.isFinite(e.x + e.y + e.hp + e.chill + e.burn + e.shock)) return false;
  for (const e of w.effects) if (!Number.isFinite(e.x + e.y + e.life)) return false;
  return true;
}

function effectBoundsHold(w: WorldState): boolean {
  const zones = w.effects.filter((e) => e.kind === "zone").length;
  if (zones > C.MAX_ZONE_EFFECTS) return false;
  for (const p of w.players.values()) {
    if (w.effects.filter((e) => e.kind === "wire" && e.owner === p.id).length > MAX_WIRES) return false;
    if (w.effects.filter((e) => e.kind === "orbit" && e.owner === p.id).length > 1) return false;
    if (w.effects.filter((e) => e.kind === "sentry" && e.owner === p.id).length > 1) return false;
    if (w.effects.filter((e) => e.kind === "tether" && e.owner === p.id).length > 1) return false;
  }
  return true;
}

function modifierMatrixGates(): void {
  section("[HOLD] modifier matrix: every weapon x every blessing at Lv3 stays sane");
  let cells = 0, bad: string[] = [];
  for (const id of ALL_WEAPONS) {
    for (const item of ITEMS) {
      cells++;
      const w = createWorld(0x300D + cells, 1, { isSandbox: true });
      const p = w.players.get(LOCAL_ID)!;
      p.invuln = 0;
      p.x = 700; p.y = 600;
      acquireWeaponInWorld(w, LOCAL_ID, id);
      for (let l = 0; l < 3; l++) applyItemToWorld(w, LOCAL_ID, item);
      parked(w, "slime", 780, 590, 40);
      parked(w, "slime", 820, 610, 40);
      devSpawnProp(w, "barrel_explosive", 800, 560);
      let ok = true;
      for (let t = 0; t < 72 && ok; t++) {
        const firing = t % 48 < 39;
        const ev = stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim: 0, firing, dash: false }]]), DT);
        if (ev.length > 400) ok = false; // a recursion (chain/explosion) reads as an event storm
        if (!isWorldFinite(w) || !effectBoundsHold(w)) ok = false;
        if (w.bullets.length > 400) ok = false;
        for (const e of w.enemies) if (e.chill > C.CHILL_MAX + 1e-9) ok = false; // no infinite CC
      }
      if (!ok) bad.push(`${id}+${item.id}`);
    }
  }
  check(`all ${cells} weapon x Lv3-blessing cells finite, bounded, capped`, bad.length === 0, bad.slice(0, 6).join(", "));

  section("[HOLD] modifier matrix: the full every-blessing-Lv3 stack per weapon");
  bad = [];
  for (const id of ALL_WEAPONS) {
    const w = createWorld(0x57AC + ALL_WEAPONS.indexOf(id), 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, id);
    for (const item of ITEMS) for (let l = 0; l < 3; l++) applyItemToWorld(w, LOCAL_ID, item);
    for (let i = 0; i < 6; i++) parked(w, "skeleton", 760 + (i % 3) * 45, 560 + Math.floor(i / 3) * 60, 60);
    devSpawnProp(w, "barrel_explosive", 820, 600);
    let ok = true;
    for (let t = 0; t < 120 && ok; t++) {
      const firing = t % 48 < 39;
      stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim: 0, firing, dash: false }]]), DT);
      if (!isWorldFinite(w) || !effectBoundsHold(w) || w.bullets.length > 600) ok = false;
    }
    if (!ok) bad.push(id);
  }
  check("every weapon survives the maxed 19-blessing stack", bad.length === 0, bad.join(", "));

  section("[HOLD] stress: the worst legal 4P effect stack stays bounded and stepping");
  {
    const w = createWorld(0x4B4D, 6, { isSandbox: true, isShared: true, skipLocalPlayer: true });
    const pids = ["p1", "p2", "p3", "p4"];
    const loadout: WeaponId[] = ["frostline", "halo", "sentry", "snapwire"];
    pids.forEach((pid, i) => {
      const p = spawnPlayerInWorld(w, pid);
      p.invuln = 0;
      p.x = 17 * 48 + (i % 2) * 90 - 45;
      p.y = 12 * 48 + Math.floor(i / 2) * 90 - 45;
      acquireWeaponInWorld(w, pid, loadout[i]);
      for (const item of ITEMS) for (let l = 0; l < 3; l++) applyItemToWorld(w, pid, item);
    });
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      mover(w, i % 2 === 0 ? "slime" : "bat", 17 * 48 + Math.cos(a) * 320, 12 * 48 + Math.sin(a) * 320, 30);
    }
    let ok = true;
    const start = performance.now();
    for (let t = 0; t < 20 * 10 && ok; t++) {
      const inputs = new Map<string, InputCmd>();
      pids.forEach((pid, i) => inputs.set(pid, {
        seq: t, moveX: 0, moveY: 0, aim: (t / 12) + i * 1.57, firing: t % 10 < 8, dash: false,
      }));
      stepWorld(w, inputs, 1 / 20);
      if (!isWorldFinite(w) || !effectBoundsHold(w) || w.bullets.length > 800) ok = false;
    }
    const msPerTick = (performance.now() - start) / (20 * 10);
    check("10s of maxed 4P effect spam: finite, capped, no runaway", ok,
      `effects=${w.effects.length} bullets=${w.bullets.length}`);
    check("worst legal stack steps in real-time budget", msPerTick < 25, `${msPerTick.toFixed(2)}ms/tick`);
  }
}

// ---- input modes + safe cancel ---------------------------------------------------------

function inputModeGates(): void {
  section("modes: every fire/charge/alt mode is reachable through the ONE shared intent set");
  // The whole arsenal must be playable from any device that can express the InputCmd
  // fields — press/release one trigger, aim, dash. No weapon may demand a key of its own.
  check("InputCmd carries no weapon-specific fields", (() => {
    const cmd: InputCmd = { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, interact: false };
    return Object.keys(cmd).sort().join(",") === "aim,dash,firing,interact,moveX,moveY,seq";
  })());
  const reach = (id: WeaponId, expectEvents: string[]): void => {
    const w = createWorld(0x10DE + ALL_WEAPONS.indexOf(id), 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, id);
    parked(w, "spitter", 800, 600, 300);
    const seen = new Set<string>();
    for (let t = 0; t < 60 * 4; t++) {
      const firing = t % 48 < 39; // trigger press/release only — nothing device-specific
      for (const e of stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim: 0, firing, dash: false }]]), DT)) seen.add(e.t);
    }
    check(`${id}: all modes reachable via trigger press/release alone`, expectEvents.every((e) => seen.has(e)),
      `saw ${expectEvents.filter((e) => !seen.has(e)).length === 0 ? "all" : "missing " + expectEvents.filter((e) => !seen.has(e)).join("+")}`);
  };
  reach("pistol", ["shot"]);
  reach("breach", ["shot", "explosion"]);       // hold-release
  reach("snapwire", ["wirePlanted"]);
  reach("halo", ["haloFlare"]);                 // the active
  reach("sentry", ["sentryPlaced", "sentryShot"]);
  reach("crook", ["tetherLatch", "tetherSweep"]); // latch + second-press alt
  reach("sword", ["meleeSwing"]);

  section("cancel safety: a held charge NEVER fires out of a cancel");
  {
    // Dash cancels (the universal 'get out' intent doubles as the cancel).
    const w = createWorld(0xCA5E, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    acquireWeaponInWorld(w, LOCAL_ID, "breach");
    for (let t = 0; t < 40; t++) stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT);
    check("charge held", p.chargeT > 0.5);
    stepWorld(w, new Map([[LOCAL_ID, { seq: 99, moveX: 0, moveY: 0, aim: 0, firing: true, dash: true }]]), DT);
    for (let t = 0; t < 30; t++) stepWorld(w, new Map([[LOCAL_ID, { seq: 100 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT);
    check("dash-cancel dumps the charge without firing", p.chargeT === 0 && w.bullets.length === 0);
    check("a zero-movement cancel frame never dashes", p.dashTime === 0 && p.dashCd === 0);
  }
  {
    // Weapon switch cancels.
    const w = createWorld(0xCA5F, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    acquireWeaponInWorld(w, LOCAL_ID, "breach");
    for (let t = 0; t < 40; t++) stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT);
    acquireWeaponInWorld(w, LOCAL_ID, "pistol");
    check("switching weapons dumps the charge", p.chargeT === 0);
  }
  {
    // Going down cancels.
    const w = createWorld(0xCA60, 1, { isSandbox: true, isShared: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    spawnPlayerInWorld(w, "pB");
    a.invuln = 0;
    acquireWeaponInWorld(w, "pA", "breach");
    for (let t = 0; t < 30; t++) stepPlayerPhase(w, a, { seq: t, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }, 1 / 20, []);
    check("charge held before the down", a.chargeT > 0.3);
    a.hp = 1;
    w.bullets.push({ x: a.x, y: a.y, vx: 0, vy: 0, radius: 6, life: 1, friendly: false, owner: null, damage: 5, color: "#f00", pierce: 0, hitList: null, isCrit: false });
    stepWorldPhase(w, 1 / 20, []);
    check("going down dumps the charge (no posthumous shell)", a.isDown && a.chargeT === 0);
  }
}

// ---- the balancer envelope (canonical PU power bands + family rules) -----------------

// Ideal-conditions sustained boss DPS: the weapon parked at its ideal range with perfect
// uptime — damage x effective native pellets x its boss coefficient over its authored
// cycle, plus the (boss-capped) burn DoT where innate. This is the ENVELOPE model: it
// deliberately prices no aim error, so the bands below are ceilings on what a perfect
// hand can extract.
function idealBossDps(id: WeaponId, isAtRisk: boolean): number {
  const w = WEAPONS[id];
  const coef = WEAPON_BOSS_COEF[id] ?? 1;
  // The Midas is banded FED (a stocked purse is no brake inside a boss window) — the
  // same paid-ceiling treatment the risk archetype gets.
  const riskMult = (isAtRisk && w.lowHpBonus !== undefined ? 1 + w.lowHpBonus * (5 / 6) : 1) * (w.coinBoost ?? 1);
  const burnDot = w.burn !== undefined ? C.BURN_DMG_MAX_BOSS : 0;
  if (w.wire) return (w.damage * coef) / (w.fireCd + w.wire.arm);
  if (w.sentry) return (w.damage * coef) / w.sentry.fireCd;
  if (w.orbit) return (w.damage * coef) / w.orbit.rehit;
  if (w.tether) return (w.damage * coef) / w.fireCd;
  if (w.charge) return (w.damage * coef) / (w.fireCd + 0.1); // tap cycle: hold buys range, not rate
  const eff = 1 + Math.max(0, w.pellets - 1) * BOSS_NATIVE_PELLET_COEF;
  return (w.damage * riskMult * eff * coef) / w.fireCd + burnDot;
}

// Best 3-second burst window (first shot at t=0, then the cadence).
function burstBossDps3s(id: WeaponId, isAtRisk: boolean): number {
  const w = WEAPONS[id];
  const coef = WEAPON_BOSS_COEF[id] ?? 1;
  const riskMult = (isAtRisk && w.lowHpBonus !== undefined ? 1 + w.lowHpBonus * (5 / 6) : 1) * (w.coinBoost ?? 1);
  const eff = 1 + Math.max(0, w.pellets - 1) * BOSS_NATIVE_PELLET_COEF;
  const cycle = w.wire ? w.fireCd + w.wire.arm : w.sentry ? w.sentry.fireCd : w.orbit ? w.orbit.rehit : w.charge ? w.fireCd + 0.1 : w.fireCd;
  const shots = 1 + Math.floor(2.999 / cycle);
  return (shots * w.damage * riskMult * eff * coef) / 3;
}

function envelopeGates(): void {
  section("[REVIEW] envelope: canonical PU bands (boss sustained / burst / passive)");
  check("1 PU is the pistol: exactly 12.5 practical single-target DPS",
    PU_DPS === 12.5 && Math.abs(idealBossDps("pistol", false) - PU_DPS) < 1e-9);
  // Band assignment. Direct single-target-capable weapons hold the neutral band; pack/
  // swarm/control specialists are exempt from the FLOOR (their damage lives in rooms,
  // priced by their boss coefficients) but bound by the same ceiling; lob artillery
  // cannot track a boss and is floor-exempt; persistent/support families sit under the
  // passive ceiling; the risk archetype is banded AT RISK (its cost paid).
  const PERSISTENT: readonly WeaponId[] = ["snapwire", "frostline", "halo", "sentry", "crook"];
  const LOB: readonly WeaponId[] = ["mortar", "breach"];
  for (const id of ALL_WEAPONS) {
    const isAtRisk = ARSENAL[id].resource === "health-risk";
    const pu = idealBossDps(id, isAtRisk) / PU_DPS;
    const burst = burstBossDps3s(id, isAtRisk) / PU_DPS;
    if (PERSISTENT.includes(id)) {
      check(`${id}: persistent/support boss output ≤ 0.55 PU`, pu <= 0.55, `pu=${pu.toFixed(2)}`);
    } else if (LOB.includes(id)) {
      check(`${id}: lob artillery boss output ≤ 1.35 PU (floor-exempt)`, pu <= 1.35, `pu=${pu.toFixed(2)}`);
    } else {
      const isFloorBound = ["single", "mixed", "anchor", "lane"].includes(ARSENAL[id].target);
      const lo = isFloorBound ? 0.85 : 0;
      const hi = isAtRisk || !isFloorBound ? 1.35 : 1.15;
      check(`${id}: boss sustained ${lo.toFixed(2)}–${hi.toFixed(2)} PU${isAtRisk ? " (at risk)" : ""}`,
        pu >= lo && pu <= hi, `pu=${pu.toFixed(2)}`);
    }
    const burstCap = isAtRisk ? 1.75 : 1.6;
    check(`${id}: 3s burst ≤ ${burstCap} PU`, burst <= burstCap, `burst=${burst.toFixed(2)}`);
  }

  section("[REVIEW] envelope: family rules (trap arm, charge window, entity budgets)");
  // The best LEGAL bulletSpeedMult a build can reach (no blessing raises it today; the
  // gate locks that assumption so a future speed blessing re-prices the trap arm floor).
  let maxSpeedMult = 1;
  for (const item of ITEMS) {
    const m = createMods();
    recomputeMods(m, [item.id, item.id, item.id]);
    maxSpeedMult = Math.max(maxSpeedMult, m.bulletSpeedMult);
  }
  check("trap arm ≥ 0.55s under the best legal speed stack",
    WEAPONS.snapwire.wire!.arm / maxSpeedMult >= 0.55,
    `arm=${(WEAPONS.snapwire.wire!.arm / maxSpeedMult).toFixed(2)}s`);
  check("traps: ≤3 authored per player, ≤6 per party (world cap)",
    WEAPONS.snapwire.wire!.max === 3 && MAX_WIRES_PARTY === 6 && MAX_WIRES <= MAX_WIRES_PARTY);
  check("charge window 0.55–1.5s with real miss investment (cooldown + full re-hold)",
    WEAPONS.breach.charge!.time >= 0.55 && WEAPONS.breach.charge!.time <= 1.5 && WEAPONS.breach.fireCd >= 0.55);
  check("orbitals: one ring per player (≤3), ≤8 party blades-of-exposure; flare stays close",
    MAX_ORBIT_BLADES <= 8 && WEAPONS.halo.orbit!.flareRing <= 120 && WEAPONS.halo.orbit!.ring <= 60);
  check("turrets: ≤2 per player (authored 1), LOS + range bound, finite deploy life",
    WEAPONS.sentry.sentry!.range <= 320 && WEAPONS.sentry.sentry!.life <= 20);
  check("status caps shared: boss vuln 1.35x, boss burn clock capped, chill hard cap",
    BOSS_VULN_CAP === 1.35 && C.BURN_DMG_MAX_BOSS < C.BURN_DMG_MAX && C.CHILL_MAX === 4 && C.BURN_TICK === 0.25);
  check("melee: full output lives inside close range with a real commitment cycle",
    (["sword", "longsword", "spear"] as WeaponId[]).every((id) =>
      WEAPONS[id].melee!.reach <= 80 && WEAPONS[id].fireCd >= 0.18));
  check("≤3 persistent families ship per batch (shared caps/telemetry before more)",
    ALL_WEAPONS.filter((id) => ARSENAL[id].authority.some((a) => a === "effects:zone" || a === "effects:wire" || a === "effects:sentry")).length <= 3);

  section("[HOLD] envelope: party trap budget — the world holds at most 6 wires");
  {
    const w = createWorld(0x6A2E, 1, { isSandbox: true, isShared: true, skipLocalPlayer: true });
    const pids = ["p1", "p2", "p3", "p4"];
    for (const [i, pid] of pids.entries()) {
      const p = spawnPlayerInWorld(w, pid);
      p.invuln = 0;
      p.x = 17 * 48 + (i - 1.5) * 120;
      acquireWeaponInWorld(w, pid, "snapwire");
    }
    for (let round = 0; round < 3; round++) {
      for (const pid of pids) {
        const p = w.players.get(pid)!;
        p.fireCd = 0;
        stepPlayerPhase(w, p, { seq: round, moveX: 0, moveY: 0, aim: round, firing: true, dash: false }, 1 / 20, []);
      }
      stepWorldPhase(w, 1 / 20, []);
    }
    const wires = w.effects.filter((e) => e.kind === "wire" && e.life > 0).length;
    check("four planting players never exceed the party wire budget", wires <= MAX_WIRES_PARTY, `wires=${wires}`);
  }

  section("[HOLD] envelope: turrets stop while their owner is down");
  {
    const w = createWorld(0x70FF, 1, { isSandbox: true, isShared: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    spawnPlayerInWorld(w, "pB");
    a.invuln = 0;
    acquireWeaponInWorld(w, "pA", "sentry");
    stepPlayerPhase(w, a, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }, 1 / 20, []);
    const mark = devSpawnEnemy(w, "slime", a.x + 120, a.y);
    mark.spawnTimer = 0;
    mark.speed = 0;
    mark.hp = mark.maxHp = 500;
    for (let i = 0; i < 20; i++) stepWorldPhase(w, 1 / 20, []);
    check("the turret fires while its owner stands", mark.hp < 500);
    a.isDown = true;
    for (let i = 0; i < 4; i++) stepWorldPhase(w, 1 / 20, []); // flush bolts already in flight
    const hpWhileDown = mark.hp;
    for (let i = 0; i < 40; i++) stepWorldPhase(w, 1 / 20, []);
    check("a downed owner's turret holds its fire", Math.abs(mark.hp - hpWhileDown) < 1e-9, `hp=${mark.hp.toFixed(1)}`);
    const hpWhileUp = mark.hp;
    a.isDown = false;
    for (let i = 0; i < 20; i++) stepWorldPhase(w, 1 / 20, []);
    check("the revive brings the lane back online", mark.hp < hpWhileUp);
  }

  section("[HOLD] envelope: persistent boss budget — 25% of party practical DPS, deterministic");
  {
    const run = (): number => {
      const w = createWorld(0xB0D6, 5, { isSandbox: true, isShared: true, skipLocalPlayer: true });
      const pids = ["p1", "p2", "p3", "p4"];
      for (const [i, pid] of pids.entries()) {
        const p = spawnPlayerInWorld(w, pid);
        p.invuln = 0;
        p.x = 17 * 48 + (i - 1.5) * 60;
        p.y = 12 * 48 + 100;
        acquireWeaponInWorld(w, pid, i % 2 === 0 ? "sentry" : "snapwire");
      }
      const boss = devSpawnEnemy(w, "boss", 17 * 48, 12 * 48 - 60);
      boss.spawnTimer = 0;
      // Saturate: everyone deploys/plants onto the boss's ground repeatedly.
      for (let t = 0; t < 20 * 4; t++) {
        for (const pid of pids) {
          const p = w.players.get(pid)!;
          stepPlayerPhase(w, p, { seq: t, moveX: 0, moveY: 0, aim: Math.atan2(boss.y - p.y, boss.x - p.x), firing: t % 8 < 6, dash: false }, 1 / 20, []);
        }
        stepWorldPhase(w, 1 / 20, []);
      }
      return boss.maxHp - boss.hp;
    };
    const dmg = run();
    // 4 seconds x (0.25 x 4 players x 12.5 PU) = 50 damage budget (+ one window's slack).
    const budget = 4 * PERSISTENT_BOSS_DPS_FRAC * 4 * PU_DPS;
    check("saturated turret+trap party stays inside the 25% persistent boss budget",
      dmg <= budget * 1.15, `dmg=${dmg.toFixed(1)} budget=${budget.toFixed(0)}`);
    check("the budget clamp is deterministic (two identical runs, identical damage)", Math.abs(dmg - run()) < 1e-9);
  }

  section("[REVIEW] envelope: no new neutral weapon melts a brute <1.5s or an elite <1.7s");
  for (const id of ["lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook",
    "reaper", "swarm", "midas", "phase", "vortex"] as WeaponId[]) {
    for (const [tier, floorSecs] of [["brute", 1.5], ["elite", 1.7]] as Array<["brute" | "elite", number]>) {
      const w = createWorld(0x77E5, 7, { isSandbox: true });
      w.isGodMode = true;
      const p = w.players.get(LOCAL_ID)!;
      // The risk archetype is measured with the cost PAID — its ceiling case.
      if (ARSENAL[id].resource === "health-risk") p.hp = 1;
      p.x = 17 * 48; p.y = 12 * 48;
      acquireWeaponInWorld(w, LOCAL_ID, id);
      const mark = devSpawnEnemy(w, "skeleton", p.x + 90, p.y);
      mark.tier = tier;
      mark.spawnTimer = 0;
      mark.speed = 0;
      mark.kbResist = 1e9;
      mark.hp = mark.maxHp = tier === "brute" ? 30 : 42; // median mid-floor tier bodies
      let ticks = 0;
      for (let t = 0; t < 60 * 8 && !mark.dead; t++, ticks++) {
        const aim = botAim(w, p);
        stepWorld(w, new Map([[LOCAL_ID, { seq: t + 1, moveX: 0, moveY: 0, aim, firing: botFiring(w, p, t), dash: false }]]), DT);
      }
      const secs = ticks / 60;
      check(`${id} vs median ${tier}: TTK ≥ ${floorSecs}s`, !mark.dead || secs >= floorSecs,
        mark.dead ? `${secs.toFixed(2)}s` : "outlasts the window");
    }
  }
}

// Each weapon must beat the arsenal median by ≥15% on its 1-2 DECLARED metrics — and
// lose meaningfully somewhere (the weak-room gate already demands ≥40% over the median
// or ≥50% behind the best, which subsumes the envelope's ≥10% counter-loss). Risk
// archetypes prove their declared rooms WITH the cost paid.
function differentiationGates(m: Matrix): void {
  section("[MAJOR] differentiation: declared metrics beat the median by ≥15%");
  for (const id of ALL_WEAPONS) {
    const entry = ARSENAL[id];
    check(`${id} declares 1-2 metrics`, entry.metrics.length >= 1 && entry.metrics.length <= 2);
    for (const metric of entry.metrics) {
      let ok: boolean;
      let detail: string;
      if (metric === "secondlane") {
        const own = m.rooms.get(id)!.secondlane;
        const baseline = measureRoom("pistol", "secondlane");
        ok = own.isCleared && own.clearTicks <= baseline.clearTicks * 0.85;
        detail = `own=${(own.clearTicks / 60).toFixed(1)}s baseline=${(baseline.clearTicks / 60).toFixed(1)}s`;
      } else if ((entry.resource === "health-risk" || entry.resource === "coin-fed") && metric !== "boss") {
        // Cost-paid run vs the room's neutral median: the payoff must be real (the
        // Lastlight pays in hearts, the Midas in coins — same paid-ceiling contract).
        const paid = measureRoom(id, metric as RoomId, entry.resource === "health-risk" ? { riskHp: 1 } : { purse: 999 });
        const med = metricMedian(m, metric);
        ok = paid.isCleared && paid.clearTicks <= med * 0.85;
        detail = `paid=${(paid.clearTicks / 60).toFixed(1)}s median=${(med / 60).toFixed(1)}s`;
      } else {
        ok = beatsMedian(m, id, metric);
        detail = `v=${metricValue(m, id, metric).toFixed(0)} median=${metricMedian(m, metric).toFixed(0)}`;
      }
      check(`${id} beats the median ≥15% on ${metric}`, ok, detail);
    }
  }

  section("[HOLD] differentiation: no top-quartile boss+rooms+safety all-rounder");
  const coreRooms: RoomId[] = ["swarm", "anchor", "brawl", "lane", "kite", "ambush"];
  const roomScore = (id: WeaponId): number => {
    let s = 0;
    for (const r of coreRooms) s += m.rooms.get("pistol" as WeaponId)![r].clearTicks / m.rooms.get(id)![r].clearTicks;
    return s / coreRooms.length; // >1 = clears the field faster than the baseline
  };
  // Top quartile = STRICTLY better than the 75th-percentile value on that axis (an
  // exclusive boundary: sitting on the p75 line is strong, not crowned). A weapon
  // strictly inside all three at once is the all-rounder the envelope holds.
  const p75 = (vals: number[], dir: MetricDir): number => {
    const sorted = vals.slice().sort((a, b) => dir === "low" ? a - b : b - a);
    return sorted[Math.floor(sorted.length / 4)];
  };
  const bossVals75 = p75(ALL_WEAPONS.map((id) => m.boss.get(id)!), "high");
  const roomVals75 = p75(ALL_WEAPONS.map((id) => roomScore(id)), "high");
  const safetyVals75 = p75(ALL_WEAPONS.map((id) => metricValue(m, id, "safety")), "low");
  const allRounders = ALL_WEAPONS.filter((id) =>
    m.boss.get(id)! > bossVals75 && roomScore(id) > roomVals75 && metricValue(m, id, "safety") < safetyVals75);
  check("no weapon holds the boss + room + safety top quartiles at once", allRounders.length === 0,
    allRounders.join(", "));
}

// ---- the CREATIVE gate: novelty audit, no reskins, full-charge behavior, clutter proof --

function creativeGates(m: Matrix): void {
  // Every post-cluster addition is audited: the effect wave AND the legendary wave.
  const NEW_WAVE: WeaponId[] = ["lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook",
    "reaper", "swarm", "midas", "phase", "vortex"];
  const mechSig = (wep: Weapon): string => [
    wep.melee ? (wep.melee.isThrust ? "thrust" : "sweep") : "",
    wep.charge ? "charge" : "", wep.wire ? "wire" : "", wep.paint ? "paint" : "",
    wep.orbit ? "orbit" : "", wep.sentry ? "sentry" : "", wep.tether ? "tether" : "",
    wep.bounce !== undefined ? "bounce" : "", wep.homing !== undefined ? "homing" : "",
    wep.chain !== undefined ? "chain" : "", wep.blast !== undefined ? "blast" : "",
    (wep.basePierce ?? 0) > 0 ? "pierce" : "", wep.pellets > 1 ? "multi" : "",
    wep.burn !== undefined ? "burn" : "", wep.chill !== undefined ? "chill" : "",
    wep.lowHpBonus !== undefined ? "risk" : "",
    // The legendary wave's signature flags — part of the structural fingerprint, so a
    // legendary can never read as a numbers-only variant of its nearest neighbor.
    wep.killShards !== undefined ? "reap" : "", wep.accel !== undefined ? "accel" : "",
    wep.coinBoost !== undefined ? "gilded" : "", wep.isPhase === true ? "phase" : "",
    wep.implode !== undefined ? "implode" : "",
  ].filter((x) => x.length > 0).join("+") || "plain";

  section("[MAJOR] creative audit: every addition moves a whole play dimension");
  for (const id of NEW_WAVE) {
    const novelty = ARSENAL[id].novelty;
    check(`${id} declares its novelty audit (nearest neighbor + axes + rationale)`,
      novelty !== undefined && novelty.axes.length >= 1 && novelty.note.length > 40
      && novelty.nearest !== null);
    if (!novelty || novelty.nearest === null) continue;
    // A reskin shares its neighbor's mechanic signature (numbers/color/status-only
    // deltas produce IDENTICAL signatures) — every addition must differ structurally.
    check(`${id} is not a ${novelty.nearest} reskin (mechanic signature differs)`,
      mechSig(WEAPONS[id]) !== mechSig(WEAPONS[novelty.nearest]),
      `${mechSig(WEAPONS[id])} vs ${mechSig(WEAPONS[novelty.nearest])}`);
  }

  section("[MAJOR] creative audit: the legacy overlap clusters stay differentiated");
  // The named pre-wave clusters. Consolidation verdict:每 pair is held apart by a
  // range-band/target fingerprint (a REAL positioning/priority difference), so no slot
  // is removed; a future interior-wall room set is the noted follow-up for the bank
  // family, not a deletion.
  const CLUSTERS: Array<[WeaponId, WeaponId]> = [
    ["rapid", "smg"], ["shotgun", "sawnoff"], ["ricochet", "nailer"],
    ["railgun", "lastlight"], ["homing", "sentry"], ["flamer", "frostline"],
  ];
  for (const [a, b] of CLUSTERS) {
    const isDistinct = ARSENAL[a].idealRange !== ARSENAL[b].idealRange
      || ARSENAL[a].target !== ARSENAL[b].target
      || mechSig(WEAPONS[a]) !== mechSig(WEAPONS[b]);
    check(`${a}/${b} cluster is differentiated (range/target/mechanics)`, isDistinct,
      `${ARSENAL[a].idealRange}/${ARSENAL[a].target} vs ${ARSENAL[b].idealRange}/${ARSENAL[b].target}`);
  }

  section("[MAJOR] creative gate: a FULL charge changes behavior, never only numbers");
  {
    // Tap: one point blast. Full hold: the shell walks a LINE of blasts back along the
    // approach — a body behind the landing point that the tap can never touch dies to
    // the full charge's geometry.
    const runBreach = (holdTicks: number): { blasts: number; trailerHp: number } => {
      const w = createWorld(0xC12A, 1, { isSandbox: true });
      w.isGodMode = true;
      const p = w.players.get(LOCAL_ID)!;
      p.x = 500; p.y = 600;
      acquireWeaponInWorld(w, LOCAL_ID, "breach");
      // The trailer sits between the muzzle and the full-charge landing point — outside
      // any single blast at the landing, inside the walked line.
      const trailer = parked(w, "slime", 500 + 18 + 420 - C.BREACH_LINE_STEP * 2, 600, 30);
      const ev: SimEvent[] = [];
      for (let t = 0; t < holdTicks; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: t, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT));
      for (let t = 0; t < 90; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 500 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
      return { blasts: ev.filter((x) => x.t === "explosion").length, trailerHp: trailer.hp };
    };
    const tap = runBreach(1);
    const full = runBreach(60);
    check("a tap detonates ONCE (point geometry)", tap.blasts === 1, `blasts=${tap.blasts}`);
    check(`a full charge walks ${C.BREACH_LINE_BLASTS} blasts (line geometry)`, full.blasts === C.BREACH_LINE_BLASTS,
      `blasts=${full.blasts}`);
    check("the line reaches a body the tap's point blast never touches",
      tap.trailerHp === 30 && full.trailerHp < 30, `tap=${tap.trailerHp} full=${full.trailerHp}`);
  }
  {
    // The line never double-dips: one body overlapping two blast points takes ONE hit.
    const w = createWorld(0xC12B, 1, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    p.x = 500; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "breach");
    const overlap = parked(w, "skeleton", 500 + 18 + 420 - C.BREACH_LINE_STEP / 2, 600, 100);
    overlap.kbResist = 1e9;
    for (let t = 0; t < 60; t++) stepWorld(w, new Map([[LOCAL_ID, { seq: t, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT);
    for (let t = 0; t < 90; t++) stepWorld(w, new Map([[LOCAL_ID, { seq: 500 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT);
    check("overlapping line blasts land exactly ONE hit (area, never stacked damage)",
      Math.abs((100 - overlap.hp) - WEAPONS.breach.damage) < 1e-9, `dmg=${(100 - overlap.hp).toFixed(1)}`);
  }

  section("[HOLD] creative gate: Prism Sentry retention proof (defer clause)");
  {
    // The defer clause: the sentry ships ONLY with proven shared persistent caps and
    // bounded 4-player summon/projectile clutter. Caps are enforced in-sim (budget +
    // party counts + dormancy gates above); this proves the CLUTTER bound: a maxed
    // 4P party saturating deploys never exceeds 4 turrets / bounded live bolts.
    const w = createWorld(0x5C1D, 3, { isSandbox: true, isShared: true, skipLocalPlayer: true });
    const pids = ["p1", "p2", "p3", "p4"];
    for (const [i, pid] of pids.entries()) {
      const p = spawnPlayerInWorld(w, pid);
      p.invuln = 0;
      p.x = 17 * 48 + (i - 1.5) * 70;
      p.y = 12 * 48;
      acquireWeaponInWorld(w, pid, "sentry");
      for (const item of ITEMS) for (let l = 0; l < 3; l++) applyItemToWorld(w, pid, item);
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      mover(w, "slime", 17 * 48 + Math.cos(a) * 260, 12 * 48 + Math.sin(a) * 260, 40);
    }
    let maxSentries = 0, maxBolts = 0, maxPersistent = 0;
    for (let t = 0; t < 20 * 8; t++) {
      const inputs = new Map<string, InputCmd>();
      pids.forEach((pid, i) => inputs.set(pid, { seq: t, moveX: 0, moveY: 0, aim: t / 9 + i, firing: t % 6 < 4, dash: false }));
      stepWorld(w, inputs, 1 / 20);
      maxSentries = Math.max(maxSentries, w.effects.filter((e) => e.kind === "sentry").length);
      maxBolts = Math.max(maxBolts, w.bullets.filter((b) => b.isPersistent === true).length);
      maxPersistent = Math.max(maxPersistent, w.effects.length);
    }
    check("4P saturation: never more than one turret per player", maxSentries <= 4, `max=${maxSentries}`);
    // The analytic clutter ceiling: bolt flight time (range x 1.15 / speed ~= 0.53s)
    // over the fastest legal cadence (0.35s / 1.8 fire-rate cap ~= 0.19s) is ~2.7 bolts
    // in flight plus the just-fired one — 4 per turret, 16 party-wide, the worst LEGAL
    // case, and it must hold. (The premium Tempo Core made SUSTAINED cap-cadence
    // purchasable — the 1.8 cap itself never moved, so the ceiling is the cap's own.)
    check("4P saturation: live sentry bolts stay at ≤4 in flight per turret", maxBolts <= 16, `max=${maxBolts}`);
    check("4P saturation: total persistent entities stay bounded", maxPersistent <= 2 + C.MAX_ZONE_EFFECTS, `max=${maxPersistent}`);
  }

  section("creative gate: the baseline stays a NEUTRAL foundation");
  {
    const base = ARSENAL.pistol;
    check("the sidearm carries no family tags: no status, no effect channels, no resource gimmick",
      base.status === "none" && base.resource === "none"
      && base.authority.length === 1 && base.authority[0] === "bullets"
      && WEAPONS.pistol.special === undefined);
    check("the sidearm keeps its legacy voice (no magical audio family)",
      WEAPON_AUDIO.pistol === undefined);
    check("the sidearm is the arsenal's unit: exactly 1.00 PU", Math.abs(idealBossDps("pistol", false) / PU_DPS - 1) < 1e-9);
  }

  section("creative gate: combat attention — residue stays quiet, telegraphs stay loud");
  {
    // The sim half of the attention budget: weapon residue never emits per-tick events
    // (zones/wires/orbits are snapshot STATE; only authored moments raise one-shots).
    const w = createWorld(0xA77E, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 17 * 48; p.y = 12 * 48;
    acquireWeaponInWorld(w, LOCAL_ID, "frostline");
    for (let t = 0; t < 30; t++) stepWorld(w, new Map([[LOCAL_ID, { seq: t, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT);
    acquireWeaponInWorld(w, LOCAL_ID, "halo");
    let residueEvents = 0;
    for (let t = 0; t < 120; t++) {
      const ev = stepWorld(w, new Map([[LOCAL_ID, { seq: 100 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT);
      residueEvents += ev.length;
    }
    check("idle residue (zones + a live orbit) is EVENT-SILENT — state, not chatter", residueEvents === 0,
      `events=${residueEvents}`);
  }
}

// ---- the weapon AUDIO integration contract ---------------------------------------------

function audioContractGates(): void {
  section("[MAJOR] audio contract: semantic hooks per weapon (states, not file names)");
  const NEW_WAVE: WeaponId[] = ["lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook"];
  const rowOf = (id: string): (typeof WAVE_SOUNDS)[keyof typeof WAVE_SOUNDS] | null =>
    Object.prototype.hasOwnProperty.call(WAVE_SOUNDS, id) ? WAVE_SOUNDS[id as keyof typeof WAVE_SOUNDS] : null;
  for (const id of NEW_WAVE) {
    const contract = WEAPON_AUDIO[id];
    const states = contract ? Object.keys(contract) : [];
    check(`${id}: >= 3 semantic cues (multi-stage mechanics demand them)`, states.length >= 3, states.join(","));
    check(`${id}: every state resolves to a real manifest row`,
      contract !== undefined && Object.values(contract).every((row) => row !== undefined && rowOf(row) !== null));
  }
  check("trap states complete: place / arm / trigger / expire (+ the refused-plant fail)",
    (["place", "arm", "trigger", "expire", "fail"] as const).every((st) => WEAPON_AUDIO.snapwire[st] !== undefined));
  check("orbital states complete: ONE owner loop + pass / hit / catch",
    (["loop", "pass", "hit", "catch"] as const).every((st) => WEAPON_AUDIO.halo[st] !== undefined));
  check("charge states complete: prime / loop / threshold / lock / releases / travel / impact / vent",
    (["prime", "loop", "threshold", "ready", "release", "releaseAlt", "travel", "impact", "vent"] as const)
      .every((st) => WEAPON_AUDIO.breach[st] !== undefined));
  check("deployable states complete: place / unfold / acquire / fire / damaged / destroyed / timeout",
    (["place", "unfold", "acquire", "fire", "damaged", "destroyed", "timeout"] as const)
      .every((st) => WEAPON_AUDIO.sentry[st] !== undefined));
  check("risk states complete: danger / payoff / recovery",
    (["danger", "payoff", "recovery"] as const).every((st) => WEAPON_AUDIO.lastlight[st] !== undefined));
  check("tether states complete: lash / loop / hold / sweep / dragged / whiff",
    (["prime", "loop", "hold", "sweep", "dragged", "fail"] as const).every((st) => WEAPON_AUDIO.crook[st] !== undefined));
  check("the status voice is the SHARED library (frostline points at it, never a private row)",
    WEAPON_AUDIO.frostline.statusApply === STATUS_AUDIO.chill
    && WEAPON_AUDIO.frostline.statusBreak === STATUS_AUDIO.freezeBreak
    && Object.values(STATUS_AUDIO).every((row) => rowOf(row) !== null));

  section("[MAJOR] audio contract: tier releases are DISTINCT STEMS, never pitch tiers");
  {
    const short = rowOf(WEAPON_AUDIO.breach.release!)!;
    const full = rowOf(WEAPON_AUDIO.breach.releaseAlt!)!;
    check("breach's two release tiers ship different stems", short.stem !== null && full.stem !== null && short.stem !== full.stem,
      `${short.stem} vs ${full.stem}`);
    const normal = rowOf(WEAPON_AUDIO.lastlight.release!)!;
    const empowered = rowOf(WEAPON_AUDIO.lastlight.payoff!)!;
    check("lastlight's payoff is a distinct stem too", normal.stem !== empowered.stem);
  }

  section("[HOLD] audio contract: runtime repitch band, synth prohibition, loop hygiene");
  {
    const contractRows = new Set<string>();
    for (const id of [...NEW_WAVE, "mortar", "beam"]) {
      for (const row of Object.values(WEAPON_AUDIO[id] ?? {})) if (row !== undefined) contractRows.add(row);
    }
    for (const row of Object.values(STATUS_AUDIO)) contractRows.add(row);
    let isBandOk = true, isForbidOk = true, isRateOk = true;
    const loops: string[] = [];
    for (const rowId of contractRows) {
      const spec = rowOf(rowId)!;
      if (spec.jitter > 0.05) isBandOk = false; // authored playback stays inside 0.95-1.05
      if (spec.fallback?.rate !== undefined && (spec.fallback.rate < 0.85 || spec.fallback.rate > 1.15)) isRateOk = false;
      // Post-#45 de-synthesis the oscillator lane is GONE engine-wide: a row carries NO
      // synth recipe at all (authored stem -> DERIVE fallback -> silence). Proving the
      // field is absent proves the row can never reach a synth voice.
      if ("synth" in spec) isForbidOk = false;
      if (spec.loop === true) loops.push(rowId);
    }
    check("authored playback never repitches past ±5% (jitter <= 0.05 on every contract row)", isBandOk);
    check("no extreme repitch in the DERIVE lane (fallback rates within [0.85, 1.15])", isRateOk);
    check("every contract row forbids the oscillator lane (no synth recipe exists)", isForbidOk);
    check("continuous mechanics own exactly one loop row each (charge, halo, chain, beam)",
      loops.sort().join(",") === "beamLoop,breach.chargeLoop,crook.pullLoop,halo.loop", loops.join(","));
    for (const id of [...NEW_WAVE]) {
      const contract = WEAPON_AUDIO[id]!;
      const loopStates = Object.entries(contract).filter(([, row]) => row !== undefined && rowOf(row)!.loop === true);
      check(`${id}: at most ONE loop (start + keyed loop + stop, never per-tick retrigger)`, loopStates.length <= 1);
    }
  }

  section("audio contract: the sim emits the semantic tells (authoritative moments)");
  {
    // Charge tiers ride the shot event.
    const w = createWorld(0xA0D1, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    acquireWeaponInWorld(w, LOCAL_ID, "breach");
    const ev: SimEvent[] = [];
    for (let t = 0; t < 60; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: t, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT));
    for (let t = 0; t < 10; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 90 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
    const fullShot = ev.find((x): x is Extract<SimEvent, { t: "shot" }> => x.t === "shot");
    check("a full hold releases with chg ~1 (the TIER selector)", fullShot !== undefined && fullShot.chg > 0.9,
      `chg=${fullShot?.chg.toFixed(2)}`);
    ev.length = 0;
    for (let t = 0; t < 80; t++) {
      const firing = t === 56; // one-tick tap once the cooldown clears
      ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 200 + t, moveX: 0, moveY: 0, aim: 0, firing, dash: false }]]), DT));
    }
    const tapShot = ev.find((x): x is Extract<SimEvent, { t: "shot" }> => x.t === "shot");
    check("a tap releases with a small chg", tapShot !== undefined && tapShot.chg < 0.2, `chg=${tapShot?.chg.toFixed(2)}`);
    const boom = ev.find((x): x is Extract<SimEvent, { t: "explosion" }> => x.t === "explosion");
    check("the blast names its source (impact voice routing)", boom !== undefined && boom.src === "breach");
  }
  {
    // Trap lifecycle: armed once, expired when unspent, refused into a wall.
    const w = createWorld(0xA0D2, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 17 * 48; p.y = 12 * 48;
    acquireWeaponInWorld(w, LOCAL_ID, "snapwire");
    const ev: SimEvent[] = [];
    ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT));
    for (let t = 0; t < 60 * 14; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 2 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
    check("the wire announces ARMED exactly once", ev.filter((x) => x.t === "wireArmed").length === 1);
    check("an unspent wire announces its EXPIRE (a different lesson than the snap)",
      ev.filter((x) => x.t === "wireExpired").length === 1 && !ev.some((x) => x.t === "wireSnap"));
    // Refused plant: face the west wall point-blank.
    p.x = 48 + 20; p.aimAngle = Math.PI;
    p.fireCd = 0;
    const refuse: SimEvent[] = [];
    refuse.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 999, moveX: 0, moveY: 0, aim: Math.PI, firing: true, dash: false }]]), DT));
    check("a wall-refused plant reads out loud (fail state)", refuse.some((x) => x.t === "wireRefused"));
  }
  {
    // Deployable lifecycle: acquire per target, damaged chews, the two endings.
    const w = createWorld(0xA0D3, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 17 * 48; p.y = 12 * 48;
    acquireWeaponInWorld(w, LOCAL_ID, "sentry");
    const ev: SimEvent[] = [];
    ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT));
    const mark = parked(w, "slime", p.x + 160, p.y, 6);
    for (let t = 0; t < 60 * 3; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 2 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
    check("the turret announces each NEW acquire (per target, not per bolt)",
      mark.dead && ev.filter((x) => x.t === "sentryAcquire").length === 1
      && ev.filter((x) => x.t === "sentryShot").length > 1);
    for (let t = 0; t < 60 * 11; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 300 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
    const down = ev.find((x): x is Extract<SimEvent, { t: "sentryDown" }> => x.t === "sentryDown");
    check("an untouched turret ends on TIMEOUT (not the shatter)", down !== undefined && down.why === "timeout");
    // Destroyed ending + the damaged tell.
    ev.length = 0;
    p.fireCd = 0;
    ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 5000, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT));
    const s2 = w.effects.find((fx) => fx.kind === "sentry")!;
    const chewer = parked(w, "slime", s2.x + 8, s2.y, 500);
    chewer.kbResist = 1e9;
    for (let t = 0; t < 60 * 8 && w.effects.some((fx) => fx.kind === "sentry"); t++) {
      ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 5001 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
    }
    const down2 = ev.find((x): x is Extract<SimEvent, { t: "sentryDown" }> => x.t === "sentryDown");
    check("contact chews announce DAMAGED and end on DESTROYED",
      ev.some((x) => x.t === "sentryHit") && down2 !== undefined && down2.why === "destroyed");
  }
  {
    // Tether: hold transition + the inverted-drag danger flag.
    const w = createWorld(0xA0D4, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 17 * 48; p.y = 12 * 48;
    acquireWeaponInWorld(w, LOCAL_ID, "crook");
    const mark = parked(w, "spitter", p.x + 150, p.y, 60);
    mark.kbResist = 1e9;
    const ev: SimEvent[] = [];
    for (let t = 0; t < 60; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: t, moveX: 0, moveY: 0, aim: 0, firing: t === 0, dash: false }]]), DT));
    const latch = ev.find((x): x is Extract<SimEvent, { t: "tetherLatch" }> => x.t === "tetherLatch");
    check("a standard latch is NOT the danger tell (inv false) and the hold announces",
      latch !== undefined && !latch.inv && ev.some((x) => x.t === "tetherHold"));
    const brute = parked(w, "skeleton", p.x + 150, p.y + 8, 300);
    brute.tier = "brute";
    mark.dead = true;
    w.effects.length = 0; // release the spent tether so the next press LATCHES, not sweeps
    p.fireCd = 0;
    const ev2: SimEvent[] = [];
    for (let t = 0; t < 30; t++) ev2.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 100 + t, moveX: 0, moveY: 0, aim: 0.05, firing: t === 0, dash: false }]]), DT));
    const latch2 = ev2.find((x): x is Extract<SimEvent, { t: "tetherLatch" }> => x.t === "tetherLatch");
    check("a heavy latch raises the DRAGGED danger flag (inv true)", latch2 !== undefined && latch2.inv);
  }
  {
    // The shared status library: first-apply tell, freeze crossing, the break.
    const w = createWorld(0xA0D5, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0;
    p.x = 17 * 48; p.y = 12 * 48;
    acquireWeaponInWorld(w, LOCAL_ID, "frostline");
    const ev: SimEvent[] = [];
    for (let t = 0; t < 30; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: t, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }]]), DT));
    const camper = parked(w, "skeleton", p.x + 140, p.y, 400);
    camper.kbResist = 1e9;
    for (let t = 0; t < 60 * 3; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 100 + t, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]), DT));
    const applies = ev.filter((x): x is Extract<SimEvent, { t: "statusApplied" }> => x.t === "statusApplied" && x.kind === "chill" && x.eid === camper.id);
    check("chill announces on FIRST application only (re-stamps stay silent)", applies.length === 1, `applies=${applies.length}`);
    check("the freeze crossing announces", ev.some((x) => x.t === "frozeSolid" && x.eid === camper.id));
    for (let t = 0; t < 60 * 9; t++) ev.push(...stepWorld(w, new Map([[LOCAL_ID, { seq: 400 + t, moveX: 0, moveY: 0, aim: Math.PI, firing: false, dash: false }]]), DT));
    check("the shell shatters as the freeze decays (the BREAK tell)", ev.some((x) => x.t === "freezeBroke" && x.eid === camper.id));
  }
}

// The CLIENT half of cancel safety: leaving the gameplay input context mid-charge (Esc
// pause here; the HUD drawer and overlays ride the same syncInputContext seam) must turn
// the eventual trigger release into the sim's cancel intent — never a shell fired out of
// a menu. Runs the REAL Game + InputController headless, exactly like the golden harness.
/* eslint-disable @typescript-eslint/no-explicit-any */
function clientCancelGate(): void {
  section("cancel safety: a charge held into a menu never fires on resume (real client)");
  const noop = () => {};
  for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"] as const) {
    (Hud.prototype as any)[m] = noop;
  }
  (Minimap.prototype as any).render = noop;
  const game: any = new Game(domCanvas as any, domMinimap as any, domOverlay as any, noop, noop);
  game.start({ mode: "solo", coop: null, profile: null });
  game.transport.start(0xCC01, 1, { isSandbox: false, isCoop: false });
  game.world = game.transport.poll().state;
  acquireWeaponInWorld(game.world, LOCAL_ID, "breach");
  // Hold the trigger through the real controller for half a second of ticks.
  game.input.setContext("gameplay");
  game.input.isMouseDown = true;
  for (let i = 0; i < 30; i++) game.tick(DT);
  check("the real input path charges the Breach", game.p.chargeT > 0.3, `chg=${game.p.chargeT.toFixed(2)}`);
  // Esc: the pause overlay takes input ownership (the loop stops ticking while paused —
  // exactly like the live game). The controller drops the held mouse itself.
  game.input.keyDown("escape");
  check("pause owns the input context", game.input.context === "pause");
  // Resume, with the trigger physically released while the menu was up.
  game.input.keyDown("escape");
  for (let i = 0; i < 30; i++) game.tick(DT);
  check("no shell fires out of the menu (charge canceled, zero bullets)",
    game.p.chargeT === 0 && game.world.bullets.length === 0,
    `chg=${game.p.chargeT.toFixed(2)} bullets=${game.world.bullets.length}`);
  game.stop();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function main(): void {
  const isMatrixOnly = process.argv.includes("--matrix");
  const m = measureMatrix();
  if (isMatrixOnly) { printMatrix(m); printMetricDiagnostics(m); return; }
  manifestGates();
  tooltipParityGates();
  roomProofGates(m);
  dominanceGates(m);
  authorityGates();
  modifierMatrixGates();
  inputModeGates();
  clientCancelGate();
  envelopeGates();
  differentiationGates(m);
  creativeGates(m);
  audioContractGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll arsenal QA gates hold.\n");
}

main();
