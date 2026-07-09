// The bestiary BALANCE ENVELOPE regression suite: roster capacity, module intro cadence,
// acceptance manifests (silhouette / counter verb / commitment / punish — never a
// stat-only variant), the threat-cost ladder, seeded composition/exposure caps, live
// simultaneity caps, escalation growth caps, projectile-pressure ceilings, band room-TTK
// P50 targets under reference builds, boss/miniboss structure, and planner determinism.
//
// Run: npm run test:envelope

import { createWorld, stepWorld, spawnPlayerInWorld, loadFloorIntoWorld, acquireWeaponInWorld, applyItemToWorld } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Enemy, EnemyKind } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import {
  ENEMY_ARCHETYPES, FAMILY_INTRO_FLOOR, createEnemy, spawnFloorEnemies, threatCostOf,
  isBossFloor, isGauntletFloor, isComplexMover, minibossKindForFloor, isMinibossKind,
} from "../src/sim/enemies.js";
import {
  ENEMY_ROLE, ENEMY_MODULE, ENEMY_ACCEPTANCE, REMIX_OF, BIOME_SPECIALISTS,
  isRegularKind, isControllerKind, roleOf, bandOfFloor,
} from "../src/sim/bestiary.js";
import {
  ENVELOPE, LIVE_CAPS, TIERS, ELITE_COST_CAP, MINIBOSS, GAUNTLET,
  BOSS, MARROW, CHOIR, WEAVER, GILDED, BOSS_MIN_LEGAL_TTK,
  FLOOR_HP_MULT, activeMoverCapFor, MAX_COMPLEX_PER_ROOM,
} from "../src/sim/balance.js";
import { encounterDeckForFloor } from "../src/sim/enemies.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import { itemById } from "../src/sim/items.js";
import { Rng } from "../src/sim/rng.js";
import type { WeaponId } from "../src/sim/types.js";
import * as C from "../src/sim/constants.js";

const DT = 1 / 60;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const REGULARS = (Object.keys(ENEMY_ARCHETYPES) as EnemyKind[]).filter(isRegularKind);

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

// ---- roster capacity ----

function capacityGates(): void {
  section("capacity: 8 simple / 10 complex families / 6 biome specialists (24 total)");
  const simple = REGULARS.filter((k) => ENEMY_ROLE[k] === "simple" && !BIOME_SPECIALISTS.includes(k));
  const specialists = REGULARS.filter((k) => BIOME_SPECIALISTS.includes(k));
  const complexFamilies = REGULARS.filter((k) => ENEMY_ROLE[k] !== "simple" && !BIOME_SPECIALISTS.includes(k));
  check(`simple bodies fit the bucket (${simple.length}/${ENVELOPE.capacity.simple})`,
    simple.length <= ENVELOPE.capacity.simple, simple.join(","));
  check(`complex families fit the bucket (${complexFamilies.length}/${ENVELOPE.capacity.complexFamilies})`,
    complexFamilies.length <= ENVELOPE.capacity.complexFamilies, complexFamilies.join(","));
  check(`biome specialists fit the bucket (${specialists.length}/${ENVELOPE.capacity.biomeSpecialists})`,
    specialists.length <= ENVELOPE.capacity.biomeSpecialists, specialists.join(","));
  const capacity = ENVELOPE.capacity.simple + ENVELOPE.capacity.complexFamilies + ENVELOPE.capacity.biomeSpecialists;
  check(`the whole regular roster stays inside the 24-archetype structure (${REGULARS.length}/${capacity})`,
    capacity === 24 && REGULARS.length <= capacity);
  check("every regular archetype declares a role; no summon/boss/captain kind does",
    REGULARS.every((k) => roleOf(k) !== null)
    && (["echo", "knell", "marshal", "toll", "boss", "marrow", "choir", "weaver", "gilded"] as EnemyKind[])
      .every((k) => roleOf(k) === null));
}

// ---- module intro cadence ----

function cadenceGates(): void {
  section("intro cadence: ≤2 truly new modules per band (F6+); a remix waits for its teacher");
  const newModulesByBand = new Map<number, Set<string>>();
  const moduleIntro = new Map<string, number>();
  for (const kind of REGULARS) {
    const intro = FAMILY_INTRO_FLOOR[kind];
    const module = ENEMY_MODULE[kind];
    check(`${kind}: declares an intro floor and a module`, intro !== undefined && module !== undefined,
      `intro=${intro} module=${module}`);
    if (intro === undefined || module === undefined) continue;
    const prev = moduleIntro.get(module);
    if (prev === undefined || intro < prev) moduleIntro.set(module, intro);
  }
  for (const kind of REGULARS) {
    const intro = FAMILY_INTRO_FLOOR[kind]!;
    const module = ENEMY_MODULE[kind]!;
    // Only the module's TEACHING kind counts as new; remixes ride the teacher's slot.
    if (moduleIntro.get(module) !== intro || REMIX_OF[kind] !== undefined) continue;
    const band = bandOfFloor(intro);
    if (!newModulesByBand.has(band)) newModulesByBand.set(band, new Set());
    newModulesByBand.get(band)!.add(module);
  }
  let cadenceOk = true;
  for (const [band, modules] of newModulesByBand) {
    // Band 0 (F1–5) is the shipped curriculum's teaching prologue — grandfathered: it
    // deliberately front-loads the primer verbs per the corrected gate's cadence table.
    if (band < ENVELOPE.firstEnvelopeBand) continue;
    if (modules.size > ENVELOPE.maxNewModulesPerBand) {
      cadenceOk = false;
      process.stdout.write(`    band ${band} (F${band * 5 + 1}–${band * 5 + 5}): ${[...modules].join(", ")}\n`);
    }
  }
  check("no band past the prologue introduces more than 2 truly new modules", cadenceOk);
  let remixOk = true;
  for (const [kind, teacher] of Object.entries(REMIX_OF) as Array<[EnemyKind, EnemyKind]>) {
    const kindIntro = FAMILY_INTRO_FLOOR[kind] ?? Infinity;
    const teacherIntro = FAMILY_INTRO_FLOOR[teacher] ?? Infinity;
    if (ENEMY_MODULE[kind] !== ENEMY_MODULE[teacher] || kindIntro < teacherIntro + 1) remixOk = false;
  }
  check("every remix shares its teacher's module and lands ≥1 floor after the teaching room", remixOk);
  check("kinds sharing a module are explicit remixes (never an accidental duplicate)",
    REGULARS.every((k) => {
      const twins = REGULARS.filter((o) => o !== k && ENEMY_MODULE[o] === ENEMY_MODULE[k]);
      return twins.every((o) => REMIX_OF[k] === o || REMIX_OF[o] === k);
    }));
}

// ---- acceptance manifests ----

function acceptanceGates(): void {
  section("acceptance: silhouette ≤300ms, unique counter verb, commitment + punish on record");
  for (const kind of REGULARS) {
    const a = ENEMY_ACCEPTANCE[kind];
    check(`${kind}: acceptance manifest on record (silhouette ${a?.silhouetteMs}ms ≤ 300)`,
      a !== undefined && a.silhouetteMs <= 300 && a.counterVerb.length > 0
      && a.favoredIn.length > 0 && a.weakTo.length > 0);
  }
  const verbs = REGULARS.map((k) => `${ENEMY_MODULE[k]}|${ENEMY_ACCEPTANCE[k]?.counterVerb}`);
  check("no two kinds share a (module, counter verb) — a stat-only variant cannot exist",
    new Set(verbs).size === verbs.length);
  const tints = REGULARS.map((k) => ENEMY_ARCHETYPES[k].tint);
  check("every kind reads in its own identity color (no tint collisions)",
    new Set(tints).size === tints.length);
  let timingOk = true;
  for (const kind of REGULARS) {
    const a = ENEMY_ACCEPTANCE[kind]!;
    if (a.commitmentS === null) continue;
    // The §4 guarantees the sim enforces, mirrored on the manifest: ≥0.30s post-lock
    // dodge on every aimed commitment, ≥0.35s punish window after it.
    if (a.postLockS !== null && a.postLockS < 0.30) timingOk = false;
    if (a.punishS !== null && a.punishS < 0.35) timingOk = false;
  }
  check("every committed attack keeps the ≥0.30s post-lock dodge and ≥0.35s punish window", timingOk);
  // Spot-check the manifests against the constants the sim actually runs.
  check("manifest timing mirrors the sim constants (skeleton / charger / seamcutter / caskbellows / sinderling)",
    Math.abs((ENEMY_ACCEPTANCE.skeleton!.postLockS ?? 0) - (C.SKELETON_WINDUP - C.SKELETON_LOCK)) < 1e-9
    && Math.abs((ENEMY_ACCEPTANCE.charger!.postLockS ?? 0) - (C.CHARGER_WINDUP - C.CHARGER_LOCK)) < 1e-9
    && Math.abs((ENEMY_ACCEPTANCE.seamcutter!.postLockS ?? 0) - (C.SEAM_WINDUP - C.SEAM_LOCK)) < 1e-9
    && Math.abs((ENEMY_ACCEPTANCE.caskbellows!.postLockS ?? 0) - (C.CASK_WINDUP - C.CASK_LOCK)) < 1e-9
    && Math.abs((ENEMY_ACCEPTANCE.sinderling!.postLockS ?? 0) - (C.SINDER_JET_WINDUP - C.SINDER_JET_LOCK)) < 1e-9);
}

// ---- the threat-cost ladder ----

function threatLadderGates(): void {
  section("threat ladder: swarm .5 / simple 1 / ranged 1.5 / complex 2 / controller 2.25 / brute 3 / elite 4 (≤6 complex)");
  check("tier costs match the envelope", TIERS.swarm.threatCost === ENVELOPE.threatCost.swarm
    && TIERS.standard.threatCost === ENVELOPE.threatCost.simple
    && TIERS.brute.threatCost === ENVELOPE.threatCost.brute
    && TIERS.elite.threatCost === ENVELOPE.threatCost.elite);
  const priceOf: Record<string, number> = {
    simple: ENVELOPE.threatCost.simple, ranged: ENVELOPE.threatCost.ranged,
    complex: ENVELOPE.threatCost.complex, controller: ENVELOPE.threatCost.controller,
  };
  check("every regular archetype prices its role class",
    REGULARS.every((k) => ENEMY_ARCHETYPES[k].threat === priceOf[ENEMY_ROLE[k]!]),
    REGULARS.filter((k) => ENEMY_ARCHETYPES[k].threat !== priceOf[ENEMY_ROLE[k]!]).join(",") || "all priced");
  check("an elite on a complex/controller chassis clamps at 6",
    ELITE_COST_CAP === ENVELOPE.threatCost.eliteComplexCap
    && threatCostOf("charger", "elite") === 6 && threatCostOf("echojack", "elite") === 6
    && threatCostOf("slime", "elite") === 4);
  check("the miniboss prices inside the 8–12 band",
    MINIBOSS.threatCost >= ENVELOPE.threatCost.minibossMin && MINIBOSS.threatCost <= ENVELOPE.threatCost.minibossMax);
  check("summons cost threat (decoys carry a real live price)",
    ENEMY_ARCHETYPES.echo.threat > 0 && ENEMY_ARCHETYPES.knell.threat > 0);
  check("the hazard-unit equivalents are on record for composition math",
    ENVELOPE.threatCost.hazardUnit === 1.5 && ENVELOPE.threatCost.hazardArena === 4);
}

// ---- seeded composition / exposure caps ----

function roomOfEnemy(d: ReturnType<typeof generateDungeon>, e: Enemy): number {
  const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
  for (let i = 0; i < d.rooms.length; i++) {
    const r = d.rooms[i];
    if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return i;
  }
  return -1;
}

function compositionGates(): void {
  section("seeded composition: ≤7 archetypes/floor, ≤4/room, ≤2 complex, ≤1 elite, ≤1 controller, no control+denial room, ≥35% simple rooms");
  let floorExposureOk = true;
  let roomExposureOk = true;
  let complexOk = true;
  let eliteOk = true;
  let controllerOk = true;
  let pairingOk = true;
  let quotaOk = true;
  for (let s = 0; s < 14; s++) {
    const seed = 0xE57 + s * 6151;
    for (let floor = 1; floor <= 34; floor++) {
      if (isBossFloor(floor) || isGauntletFloor(floor)) continue;
      const d = generateDungeon(seed, floor);
      const spawns = spawnFloorEnemies(d, seed, floor);
      const all = [...spawns.active, ...spawns.pending].filter((e) => e.captainPhase === undefined);
      const kinds = new Set(all.map((e) => e.kind));
      if (kinds.size > ENVELOPE.floorArchetypeCap) floorExposureOk = false;
      const byRoom = new Map<number, Enemy[]>();
      for (const e of all) {
        const room = roomOfEnemy(d, e);
        if (!byRoom.has(room)) byRoom.set(room, []);
        byRoom.get(room)!.push(e);
      }
      for (const [, inRoom] of byRoom) {
        const roomKinds = new Set(inRoom.map((e) => e.kind));
        if (roomKinds.size > ENVELOPE.roomArchetypeCap) roomExposureOk = false;
        if (inRoom.filter((e) => ENEMY_ARCHETYPES[e.kind].threat > 1).length > MAX_COMPLEX_PER_ROOM) complexOk = false;
        if (inRoom.filter((e) => e.tier === "elite").length > 1) eliteOk = false;
        const controllers = inRoom.filter((e) => isControllerKind(e.kind)).length;
        if (controllers > ENVELOPE.roomControllerCap) controllerOk = false;
        const hasDenial = inRoom.some((e) => ENEMY_MODULE[e.kind] === "guard");
        if (controllers > 0 && hasDenial) pairingOk = false;
      }
      const deck = encounterDeckForFloor(seed, floor, 5);
      const simpleCards = deck.filter((c) => c === "breather" || c === "pack" || c === "hunt").length;
      if (simpleCards < Math.ceil(deck.length * ENVELOPE.simpleRoomShare)) quotaOk = false;
    }
  }
  check("no floor exposes more than 7 regular archetypes", floorExposureOk);
  check("no room holds more than 4 distinct archetypes", roomExposureOk);
  check("no room holds more than 2 complex units", complexOk);
  check("no room holds more than 1 elite affix", eliteOk);
  check("no room holds more than 1 controller", controllerOk);
  check("controllers never share a room with a guard wall (the banned control+denial pair)", pairingOk);
  check("every deck keeps ≥35% simple/mastery rooms", quotaOk);
}

// ---- live simultaneity caps ----

function liveCapGates(): void {
  section("live caps: bodies/movers/brutes/elites/controllers hold through a full seeded fight (P1 + P4)");
  const runWorld = (players: number, floor: number, seed: number): boolean => {
    const w = createWorld(seed, floor, { isShared: true, skipLocalPlayer: true });
    const ids: PlayerId[] = [];
    for (let i = 0; i < players; i++) ids.push(`p${i}`);
    for (const id of ids) spawnPlayerInWorld(w, id);
    loadFloorIntoWorld(w, floor); // re-snapshot the encounter at the real party size
    const moverCap = activeMoverCapFor(players);
    const inputs = new Map<PlayerId, InputCmd>(ids.map((id) => [id, idle(0)]));
    for (let t = 0; t < 20 * 60; t++) {
      stepWorld(w, inputs, 1 / 20);
      let bodies = 0, movers = 0, brutes = 0, elites = 0, controllers = 0;
      for (const e of w.enemies) {
        if (e.dead || e.captainPhase !== undefined) continue;
        bodies++;
        if (isComplexMover(e.kind)) movers++;
        if (e.tier === "brute") brutes++;
        if (e.tier === "elite") elites++;
        if (isControllerKind(e.kind)) controllers++;
      }
      if (bodies > LIVE_CAPS.bodies || movers > moverCap || brutes > LIVE_CAPS.brutes
        || elites > LIVE_CAPS.elites || controllers > LIVE_CAPS.controllers) {
        process.stdout.write(`    violation @t=${t}: bodies=${bodies} movers=${movers} brutes=${brutes} elites=${elites} controllers=${controllers}\n`);
        return false;
      }
      if (w.enemies.length === 0 && w.pendingSpawns.length === 0) break;
    }
    return true;
  };
  check("P1 deep floor holds every live cap for a sim-minute", runWorld(1, 17, 0xCAFE1));
  check("P4 deep floor holds every live cap (mover cap +1 at the full party)",
    runWorld(4, 17, 0xCAFE4) && activeMoverCapFor(4) === LIVE_CAPS.complexMovers + 1
    && activeMoverCapFor(2) === LIVE_CAPS.complexMovers);
}

// ---- escalation regression ----

function escalationGates(): void {
  section("escalation: effective HP growth ≤ +12%/floor past the ramp; damage NEVER grows");
  let hpOk = true;
  for (let f = ENVELOPE.hpGrowthCapFromFloor; f < FLOOR_HP_MULT.length; f++) {
    const growth = FLOOR_HP_MULT[f] / FLOOR_HP_MULT[f - 1] - 1;
    if (growth > ENVELOPE.hpGrowthCapPerFloor + 1e-9) hpOk = false;
  }
  check(`per-floor HP growth ≤ ${ENVELOPE.hpGrowthCapPerFloor * 100}% from F${ENVELOPE.hpGrowthCapFromFloor} on (the F1–4 teaching ramp is authored)`, hpOk);
  let dmgOk = true;
  for (const kind of REGULARS) {
    const base = ENEMY_ARCHETYPES[kind].touchDamage;
    for (const floor of [1, 8, 16, 24, 32]) {
      const e = createEnemy(kind, 0, 0, floor, new Rng(1), 0);
      if (e.touchDamage !== base) dmgOk = false;
    }
  }
  check("contact damage is floor-invariant for every archetype (≤ +10% trivially: it is +0%)", dmgOk);
}

// ---- projectile pressure ----

function pressureGates(): void {
  section("pressure: a worst-case ranged stack stays under 50 sustained / 60 hard live projectiles");
  const w = createWorld(0x9E55, 18, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.x = 840; p.y = 600;
  const toll = createEnemy("toll", 1240, 600, 18, w.rng, w.nextEnemyId++, {});
  toll.hp = toll.maxHp = 4000;
  toll.captainPhase = 2;
  toll.spawnTimer = 0;
  w.enemies.push(toll);
  const marshal = createEnemy("marshal", 440, 600, 18, w.rng, w.nextEnemyId++, {});
  marshal.hp = marshal.maxHp = 4000;
  marshal.captainPhase = 2;
  marshal.spawnTimer = 0;
  w.enemies.push(marshal);
  const stack: Array<[EnemyKind, number, number]> = [
    ["caskbellows", 840, 300], ["caskbellows", 640, 900], ["caskbellows", 1040, 900],
    ["spitter", 540, 400], ["spitter", 1140, 400], ["seamcutter", 840, 950],
  ];
  for (const [kind, x, y] of stack) {
    const e = createEnemy(kind, x, y, 18, w.rng, w.nextEnemyId++, {});
    e.spawnTimer = 0;
    w.enemies.push(e);
  }
  const counts: number[] = [];
  const inputs = new Map([[LOCAL_ID, idle(0)]]);
  for (let t = 0; t < 60 * 30; t++) {
    stepWorld(w, inputs, DT);
    counts.push(w.bullets.filter((b) => !b.friendly).length);
  }
  const max = Math.max(...counts);
  const sorted = [...counts].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  process.stdout.write(`    live enemy projectiles over 30s: p95=${p95}, max=${max}\n`);
  check(`sustained pressure ≤ ${ENVELOPE.pressure.sustained} (p95)`, p95 <= ENVELOPE.pressure.sustained, `p95=${p95}`);
  check(`hard pressure ceiling ≤ ${ENVELOPE.pressure.hard} (max)`, max <= ENVELOPE.pressure.hard, `max=${max}`);
}

// ---- band room-TTK P50 ----

interface ReferenceBuild { weapon: WeaponId; items: Array<[string, number]> }

// The band-median reference builds the P50 targets are measured against (documented
// calibration, mirroring the balance suite's estimator convention: a documented model,
// not live telemetry). Builds past the early band carry pierce (Full Metal) — the
// roster's guard verbs demand it of any real mid-game loadout.
const BAND_BUILDS: Record<string, { floor: number; build: ReferenceBuild; band: readonly number[] }> = {
  early: { floor: 3, build: { weapon: "pistol", items: [] }, band: ENVELOPE.roomTtkP50.early },
  mid: { floor: 9, build: { weapon: "smg", items: [["full_metal", 1], ["hair_trigger", 2]] }, band: ENVELOPE.roomTtkP50.mid },
  late: { floor: 17, build: { weapon: "smg", items: [["hair_trigger", 2], ["full_metal", 2], ["deadeye", 1]] }, band: ENVELOPE.roomTtkP50.late },
};

// The floor's combat chain: every planned unit, grouped by room, in progression order.
// The P50 target paces the floor's ROOM-TO-ROOM combat (the deck's whole encounter
// sequence), so the harness clears the rooms sequentially — traversal excluded, spawn
// grace and every telegraph included.
function floorRoomChain(seed: number, floor: number): Array<Array<[EnemyKind, Enemy["tier"]]>> {
  const d = generateDungeon(seed, floor);
  const spawns = spawnFloorEnemies(d, seed, floor);
  const byRoom = new Map<number, Array<[EnemyKind, Enemy["tier"]]>>();
  for (const e of [...spawns.active, ...spawns.pending]) {
    if (e.captainPhase !== undefined) continue; // minibosses pace their own floors
    const room = roomOfEnemy(d, e);
    if (!byRoom.has(room)) byRoom.set(room, []);
    byRoom.get(room)!.push([e.kind, e.tier]);
  }
  return [...byRoom.entries()].sort((a, b) => a[0] - b[0]).map(([, units]) => units);
}

// The envelope's P50 targets pace REAL room play — approach, reading, repositioning,
// hesitation. The deterministic harness measures pure combat throughput of a
// perfect-tracking bot, so the targets scale by this documented share of room time the
// harness actually models (the same convention as the balance suite's practical-DPS
// estimator, whose per-family accuracy factors are likewise a documented model). The
// pacing REGRESSION lives in the measurement: a drift out of the scaled band is a real
// composition/HP-curve change.
const HARNESS_TIME_SHARE = 0.55;

// Clear one floor's combat chain in a sandbox with the reference build: a gunner that
// tracks the nearest live body, CLOSES on kiters/fleeing controllers, and plays the
// shielder's authored counter (bait the bash inside its trigger, then strafe off the
// frozen guard and punish) — god mode so time-to-clear is the only variable.
function clearChainSeconds(rooms: Array<Array<[EnemyKind, Enemy["tier"]]>>, floor: number, build: ReferenceBuild, seed: number): number {
  const w = createWorld(seed, floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, build.weapon);
  for (const [id, level] of build.items) {
    for (let l = 0; l < level; l++) applyItemToWorld(w, LOCAL_ID, itemById(id)!);
  }
  let ticks = 0;
  const maxTicks = 60 * 150;
  for (const units of rooms) {
    p.x = 840; p.y = 600;
    units.forEach(([kind, tier], i) => {
      const ang = (i / Math.max(1, units.length)) * Math.PI * 2;
      const dist = 300 + (i % 3) * 40;
      const e = createEnemy(kind, p.x + Math.cos(ang) * dist, p.y + Math.sin(ang) * dist, floor, w.rng, w.nextEnemyId++, { tier });
      w.enemies.push(e);
    });
    while (w.enemies.some((e) => !e.dead) && ticks < maxTicks) {
      let target: Enemy | null = null;
      let bestD = Infinity;
      for (const e of w.enemies) {
        if (e.dead) continue;
        const d2 = Math.hypot(e.x - p.x, e.y - p.y);
        if (d2 < bestD) { bestD = d2; target = e; }
      }
      const aim = target ? Math.atan2(target.y - p.y, target.x - p.x) : 0;
      let moveX = 0, moveY = 0;
      let firing = true;
      if (target && target.kind === "shielder" && target.attack.phase === "none") {
        // The shielder's snap guard eats everything frontal while it walks: bait the
        // bash by closing inside its trigger, hold fire (a player stops wasting ammo).
        firing = false;
        if (bestD > 110) { moveX = Math.cos(aim); moveY = Math.sin(aim); }
      } else if (target && target.kind === "shielder") {
        // Committed: the guard is frozen on its locked angle — strafe off it and punish.
        moveX = Math.cos(aim + Math.PI / 2);
        moveY = Math.sin(aim + Math.PI / 2);
      } else if (target && bestD < 60) {
        // A body sitting ON the gunner is inside the muzzle: step back to open the shot
        // (the dodge every real player makes).
        moveX = -Math.cos(aim);
        moveY = -Math.sin(aim);
      } else if (target && bestD > 280) {
        moveX = Math.cos(aim);
        moveY = Math.sin(aim);
      }
      stepWorld(w, new Map([[LOCAL_ID, { seq: ticks, moveX, moveY, aim, firing, dash: false }]]), DT);
      ticks++;
    }
    if (ticks >= maxTicks) break;
  }
  return ticks * DT;
}

function ttkGates(): void {
  section("floor-chain P50: seeded room-to-room combat under the band reference builds");
  for (const [bandName, { floor, build, band }] of Object.entries(BAND_BUILDS)) {
    const times: number[] = [];
    for (let s = 0; s < 7; s++) {
      const seed = 0x77C + s * 3571;
      const rooms = floorRoomChain(seed, floor);
      if (rooms.length === 0) continue;
      times.push(clearChainSeconds(rooms, floor, build, seed));
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    const lo = band[0] * HARNESS_TIME_SHARE;
    const hi = band[1] * HARNESS_TIME_SHARE;
    process.stdout.write(`    ${bandName} (F${floor}): clears ${times.map((t) => t.toFixed(1)).join(", ")}s — P50 ${p50.toFixed(1)}s (target [${lo.toFixed(1)}, ${hi.toFixed(1)}])\n`);
    check(`${bandName} band P50 sits in the scaled [${lo.toFixed(1)}, ${hi.toFixed(1)}]s window (envelope [${band[0]}, ${band[1]}] × ${HARNESS_TIME_SHARE})`,
      p50 >= lo && p50 <= hi, `p50=${p50.toFixed(1)}s`);
  }
}

// ---- boss / miniboss structure ----

function bossStructureGates(): void {
  section("bosses: 3 phases, one technique per phase then remix, adds capped, high-roll floor");
  const bossBlocks: Array<[string, { phaseAt: readonly number[] }]> = [
    ["boss", BOSS], ["marrow", MARROW], ["choir", CHOIR], ["weaver", WEAVER], ["gilded", GILDED],
  ];
  check("every boss runs exactly 3 phases (two transition beats)",
    bossBlocks.every(([, b]) => b.phaseAt.length === 2));
  check("summoner bosses cap their adds per phase (never unbounded pressure)",
    BOSS.addCap.every((c) => c <= 8) && MARROW.addCap.every((c) => c <= 8));
  check("every boss keeps a ≥20s high-roll floor (the fastest legal build still sees the techniques)",
    (["boss", "marrow", "weaver", "gilded", "choir"] as const).every((k) => (BOSS_MIN_LEGAL_TTK[k] ?? 0) >= 20));

  section("minibosses: max one per band, 1–2 moves + the 50% phase, no immunity");
  let cadenceOk = true;
  for (let floor = 1; floor <= 48; floor++) {
    const kind = minibossKindForFloor(0xABCD, floor);
    if (kind === null) continue;
    // One per band by construction: the cadence is exactly one floor per 5-floor band.
    const band = bandOfFloor(floor);
    for (let other = band * 5 + 1; other <= band * 5 + 5; other++) {
      if (other !== floor && minibossKindForFloor(0xABCD, other) !== null) cadenceOk = false;
    }
    if (!isMinibossKind(kind)) cadenceOk = false;
  }
  check("at most one miniboss per 5-floor band, always a registered template", cadenceOk);
  check("the captain phase is the 50% split with a short NON-invulnerable stagger (no floors, no DR)",
    GAUNTLET.captainPhaseAt === 0.5 && GAUNTLET.captainTransition <= 1.0);
}

// ---- planner determinism ----

function determinismGates(): void {
  section("determinism: the whole floor plan is a pure function of (seed, floor, players)");
  let planOk = true;
  for (let s = 0; s < 20 && planOk; s++) {
    const seed = 0xD37E + s * 2953;
    for (const floor of [2, 7, 13, 18, 27, 33]) {
      const key = (players: number): string => {
        const d = generateDungeon(seed, floor);
        const spawns = spawnFloorEnemies(d, seed, floor, players);
        return [...spawns.active, ...spawns.pending].map((e) => `${e.kind}/${e.tier}/${e.x.toFixed(4)}/${e.y.toFixed(4)}/${e.hp}`).join(";");
      };
      if (key(1) !== key(1) || key(4) !== key(4)) planOk = false;
    }
  }
  check("two fresh plans agree byte-for-byte at P1 and P4 across seeds and floors", planOk);
}

function main(): void {
  capacityGates();
  cadenceGates();
  acceptanceGates();
  threatLadderGates();
  compositionGates();
  liveCapGates();
  escalationGates();
  pressureGates();
  ttkGates();
  bossStructureGates();
  determinismGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe bestiary balance envelope holds.\n");
}

main();
