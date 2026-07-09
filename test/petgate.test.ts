// STUDIO BALANCE GATE — companion pets (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md §5 + §7.7).
// MANDATORY: this suite is part of `npm test`; a pet tuning change that crosses a cap fails CI.
//
// What it proves, entirely from MEASURED play on the deterministic sim (never nominal math):
//   1. owner baseline — sustained single-target DPS of every weapon on a fixed bench; the
//      §5 caps are relative to the MEDIAN of these measurements.
//   2. per-pet bench — each combat pet's sustained DPS ≤12% of that median and its damage in
//      any 3s window ≤18% of the median's 3s output.
//   3. the mode × party matrix — Casual/Standard/Brutal × P1–4 seeded floor encounters with
//      every player running the worst-case damage pet: all pets combined ≤25% of measured
//      party player DPS, pet-finished kills ≤15% of credited kills, pet healing exactly 0,
//      pet boss damage exactly 0, byte-identical ledgers on replay (spec §7.9).
//   4. boss pulls — real floor-5 Slime King pulls per mode: pets never damage or mark the
//      boss (boss TTK calibration stays pure) and never heal.
//   5. §1 mode wiring — the difficulty table moves pressure/recovery in the authored
//      directions (spawned threat ordering, boss-chest hearts, revive channel/HP) while
//      Standard remains bit-identical to the authored baseline (the golden suite holds that).
//
// Scale: the spec's full run (≈1,000 rooms + 100 pulls/boss/mode/P) is PET_GATE_FULL=1; the
// default is a deterministic subset sized for CI. Both use fixed seeds — failures reproduce.
//
// Run: npm run test:petgate            (CI subset)
//      PET_GATE_FULL=1 npm run test:petgate   (spec-scale studio run)

import {
  createWorld, createLedger, spawnPlayerInWorld, spawnPetInWorld, devSpawnEnemy,
  loadFloorIntoWorld, acquireWeaponInWorld, stepWorld, isFloorCleared,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim, DamageLedger } from "../src/sim/world.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import type { Enemy, PetKind, WeaponId } from "../src/sim/types.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { PET_BALANCE, PET_CAPS } from "../src/sim/pets.js";
import { MODES, modeActiveCap, modeBossAddCap } from "../src/sim/difficulty.js";
import type { DifficultyMode } from "../src/sim/difficulty.js";
import { threatCostOf } from "../src/sim/enemies.js";
import { FIXED_DT, TICK_HZ } from "../src/net/protocol.js";

const IS_FULL = process.env.PET_GATE_FULL === "1";
const MODE_LIST: readonly DifficultyMode[] = ["casual", "standard", "brutal"];
const PARTY_SIZES = [1, 2, 3, 4] as const;
// CI subset vs spec-scale studio run (spec §7.7: 1,000 rooms + 100 boss pulls).
const FLOORS_PER_CONFIG = IS_FULL ? 24 : 2;      // non-boss floors simmed per (mode, P)
const BOSS_PULLS_PER_CONFIG = IS_FULL ? 100 : 1; // Slime King pulls per (mode, P)
const BOSS_PARTIES: readonly number[] = IS_FULL ? PARTY_SIZES : [1, 4];

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

// ---- deterministic scripted party ----
// Every gate world runs the same dumb-but-effective player script: seek the nearest living
// enemy, orbit at mid range, hold fire. Pure state -> input (no RNG, no wall clock), so a
// config replays byte-identically.

function nearestLiving(w: WorldState, x: number, y: number): Enemy | null {
  let best: Enemy | null = null;
  let bestD = Infinity;
  for (const e of w.enemies) {
    if (e.dead) continue;
    const d = (e.x - x) ** 2 + (e.y - y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function scriptedInput(w: WorldState, p: PlayerSim, seq: number): InputCmd {
  const target = nearestLiving(w, p.x, p.y);
  if (!target) return { seq, moveX: 0, moveY: 0, aim: p.aimAngle, firing: false, dash: false };
  const dx = target.x - p.x, dy = target.y - p.y;
  const dist = Math.hypot(dx, dy) || 1;
  const aim = Math.atan2(dy, dx);
  // Close to engagement range, then strafe the orbit so spitters/lunges don't stack hits.
  let moveX = 0, moveY = 0;
  if (dist > 150) { moveX = dx / dist; moveY = dy / dist; }
  else { moveX = -dy / dist; moveY = dx / dist; }
  return { seq, moveX, moveY, aim, firing: true, dash: false };
}

function stepScripted(w: WorldState, ticks: number, until?: () => boolean): number {
  let t = 0;
  for (; t < ticks; t++) {
    const inputs = new Map<PlayerId, InputCmd>();
    for (const p of w.players.values()) inputs.set(p.id, scriptedInput(w, p, t + 1));
    stepWorld(w, inputs, FIXED_DT);
    if (until && until()) { t++; break; }
  }
  return t;
}

// A party-scaled gate world: players spawned FIRST, then the floor rebuilt so the encounter
// snapshot (enemy HP / threat / hearts) scales to the real party size.
function gateWorld(seed: number, floor: number, mode: DifficultyMode, party: number, pet: PetKind | null): WorldState {
  const w = createWorld(seed, floor, { skipLocalPlayer: true, mode });
  for (let i = 0; i < party; i++) {
    const p = spawnPlayerInWorld(w, "p" + i);
    p.mods.lifestealChance = 0.17; // Fang Lv3 on every owner: any pet-kill heal would show up
    if (pet) spawnPetInWorld(w, p.id, pet);
  }
  loadFloorIntoWorld(w, floor);
  w.isGodMode = true; // the gate measures pet contribution, not party survival
  w.ledger = createLedger();
  return w;
}

// ---- 1. owner weapon baseline (the §5 caps are relative to this measurement) ----

// A stationary, unshovable, non-attacking target: the slime archetype with motion zeroed
// and effectively infinite mass/HP.
function parkDummy(w: WorldState, x: number, y: number): Enemy {
  const dummy = devSpawnEnemy(w, "slime", x, y);
  dummy.hp = dummy.maxHp = 1e9;
  dummy.speed = 0;
  dummy.kbResist = 1e9;
  return dummy;
}

function benchWorld(): { w: WorldState; p: PlayerSim } {
  const w = createWorld(0xBE7C4, 1, { isSandbox: true, skipLocalPlayer: true });
  const p = spawnPlayerInWorld(w, "p0");
  w.isGodMode = true;
  w.ledger = createLedger();
  return { w, p };
}

const BENCH_SECS = 20;

function measureWeaponDps(id: WeaponId): number {
  const { w, p } = benchWorld();
  acquireWeaponInWorld(w, p.id, id);
  const def = WEAPONS[id];
  // Park the target inside this weapon's effective envelope (melee at reach, short-lived
  // sprays like the flamer up close, everything else at mid range).
  const range = def.melee ? def.melee.reach * 0.6 : Math.min(140, Math.max(40, def.speed * def.life * 0.6));
  const dummy = parkDummy(w, p.x + range, p.y);
  const ticks = BENCH_SECS * TICK_HZ;
  for (let t = 0; t < ticks; t++) {
    const inputs = new Map<PlayerId, InputCmd>([[p.id, { seq: t + 1, moveX: 0, moveY: 0, aim: Math.atan2(dummy.y - p.y, dummy.x - p.x), firing: true, dash: false }]]);
    stepWorld(w, inputs, FIXED_DT);
  }
  return w.ledger!.playerDamage / BENCH_SECS;
}

function measureOwnerMedianDps(): number {
  section("owner baseline: measured sustained single-target DPS per weapon (fixed bench)");
  const ids = Object.keys(WEAPONS) as WeaponId[];
  const measured = ids
    .map((id) => ({ id, dps: measureWeaponDps(id) }))
    .sort((a, b) => a.dps - b.dps);
  for (const m of measured) process.stdout.write(`    ${m.id.padEnd(10)} ${m.dps.toFixed(2)} dps\n`);
  const mid = measured.length / 2;
  const median = measured.length % 2 === 0
    ? (measured[mid - 1].dps + measured[mid].dps) / 2
    : measured[Math.floor(mid)].dps;
  check("every weapon produced sustained damage on the bench", measured[0].dps > 0, `min=${measured[0].dps.toFixed(2)}`);
  process.stdout.write(`    median owner weapon DPS: ${median.toFixed(2)}\n`);
  return median;
}

// ---- 2. per-pet bench vs the owner baseline ----

function maxWindowDamage(hits: DamageLedger["petHits"], windowTicks: number): number {
  let best = 0;
  for (let i = 0; i < hits.length; i++) {
    let sum = 0;
    for (let j = i; j < hits.length && hits[j].tick - hits[i].tick < windowTicks; j++) sum += hits[j].dmg;
    if (sum > best) best = sum;
  }
  return best;
}

function petBench(kind: PetKind, ownerMedianDps: number): void {
  section(`pet bench: ${kind} vs the measured owner median (≤12% sustained, ≤18% in any 3s window)`);
  const { w, p } = benchWorld();
  spawnPetInWorld(w, p.id, kind);
  const dummy = parkDummy(w, p.x + 60, p.y);
  const secs = 40;
  for (let t = 0; t < secs * TICK_HZ; t++) {
    // Owner present but holding fire: the bench isolates the pet's own output.
    const inputs = new Map<PlayerId, InputCmd>([[p.id, { seq: t + 1, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]);
    stepWorld(w, inputs, FIXED_DT);
  }
  const led = w.ledger!;
  const dps = led.petDamage / secs;
  const share = dps / ownerMedianDps;
  check(`${kind} sustained DPS ≤ ${PET_CAPS.ownerDpsShare * 100}% of the owner median`,
    share <= PET_CAPS.ownerDpsShare, `${dps.toFixed(3)} dps = ${(share * 100).toFixed(1)}%`);
  const burst = maxWindowDamage(led.petHits, 3 * TICK_HZ);
  const burstShare = burst / (ownerMedianDps * 3);
  check(`${kind} damage in ANY 3s window ≤ ${PET_CAPS.ownerBurstShare * 100}% of the owner median's 3s output`,
    burstShare <= PET_CAPS.ownerBurstShare, `${burst.toFixed(2)} dmg = ${(burstShare * 100).toFixed(1)}%`);
  check(`${kind} absolute sustained ceiling holds`, dps <= PET_CAPS.sustainedDps, `${dps.toFixed(3)} <= ${PET_CAPS.sustainedDps}`);
  check(`${kind} healed nothing on the bench`, led.petHealing === 0);
  check(`${kind} never touched a boss on the bench`, led.petBossDamage === 0);
  if (kind === "bonebird") {
    // Worst-case single-target mark uptime, measured against the parked dummy.
    let marked = 0;
    const uptimeTicks = 30 * TICK_HZ;
    for (let t = 0; t < uptimeTicks; t++) {
      const inputs = new Map<PlayerId, InputCmd>([[p.id, { seq: t + 1, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false }]]);
      stepWorld(w, inputs, FIXED_DT);
      if (dummy.petMark > 0) marked++;
    }
    const uptime = marked / uptimeTicks;
    check("mark uptime on a focused target ≤ 25% (control budget)",
      uptime > 0 && uptime <= PET_CAPS.markUptime, `${(uptime * 100).toFixed(1)}%`);
    check("mark multiplier ≤ +8% (vulnerability budget)", PET_BALANCE.bonebird.markDamageMult <= PET_CAPS.markDamageMult);
    check("triggered utility cadence ≥ 6s (owner ship decision)",
      PET_BALANCE.bonebird.peckCd >= PET_CAPS.utilityCooldownMin, `peckCd=${PET_BALANCE.bonebird.peckCd}`);
  }
}

// ---- 3. mode × party encounter matrix ----

interface ConfigStats {
  floors: number;
  rooms: number;
  cleared: number;
  playerDamage: number;
  petDamage: number;
  petBossDamage: number;
  playerKills: number;
  petKills: number;
  petHealing: number;
}

function runFloor(seed: number, floor: number, mode: DifficultyMode, party: number): { led: DamageLedger; cleared: boolean; rooms: number } {
  const w = gateWorld(seed, floor, mode, party, "ember_pup"); // worst-case damage pet on every owner
  stepScripted(w, 90 * TICK_HZ, () => isFloorCleared(w));
  return { led: w.ledger!, cleared: isFloorCleared(w), rooms: Math.max(1, w.dungeon.rooms.length - 1) };
}

function roomMatrix(): ConfigStats[] {
  section(`mode × party encounter matrix (${FLOORS_PER_CONFIG} floors per config${IS_FULL ? " — FULL STUDIO RUN" : "; PET_GATE_FULL=1 for spec scale"})`);
  const out: ConfigStats[] = [];
  const gateFloors = [2, 3, 4, 6]; // non-boss floors with roster variety
  for (const mode of MODE_LIST) {
    for (const party of PARTY_SIZES) {
      const stats: ConfigStats = { floors: 0, rooms: 0, cleared: 0, playerDamage: 0, petDamage: 0, petBossDamage: 0, playerKills: 0, petKills: 0, petHealing: 0 };
      for (let i = 0; i < FLOORS_PER_CONFIG; i++) {
        const floor = gateFloors[i % gateFloors.length];
        const seed = 0x9e7 ^ (MODE_LIST.indexOf(mode) << 20) ^ (party << 16) ^ (i * 2654435761);
        const { led, cleared, rooms } = runFloor(seed, floor, mode, party);
        stats.floors++;
        stats.rooms += rooms;
        if (cleared) stats.cleared++;
        stats.playerDamage += led.playerDamage;
        stats.petDamage += led.petDamage;
        stats.petBossDamage += led.petBossDamage;
        stats.playerKills += led.playerKills;
        stats.petKills += led.petKills;
        stats.petHealing += led.petHealing;
      }
      const dpsShare = stats.petDamage / Math.max(1, stats.playerDamage);
      const killShare = stats.petKills / Math.max(1, stats.playerKills + stats.petKills);
      const label = `${mode} P${party}`;
      process.stdout.write(`    ${label.padEnd(12)} rooms=${String(stats.rooms).padStart(3)} cleared=${stats.cleared}/${stats.floors} petDPS-share=${(dpsShare * 100).toFixed(1)}% kill-share=${(killShare * 100).toFixed(1)}%\n`);
      check(`${label}: all pets combined ≤ ${PET_CAPS.partyDpsShare * 100}% of party DPS`,
        dpsShare <= PET_CAPS.partyDpsShare, `${(dpsShare * 100).toFixed(1)}%`);
      check(`${label}: pet kills ≤ ${PET_CAPS.killShare * 100}% of credited kills`,
        killShare <= PET_CAPS.killShare, `${(killShare * 100).toFixed(1)}%`);
      check(`${label}: pet healing is exactly zero (Fang never procs off pets)`, stats.petHealing === 0);
      check(`${label}: pets dealt zero boss damage`, stats.petBossDamage === 0);
      check(`${label}: the scripted party actually fought (measurement validity)`,
        stats.playerKills > 0 && stats.cleared * 2 >= stats.floors, `cleared=${stats.cleared}/${stats.floors}`);
      out.push(stats);
    }
  }
  return out;
}

// ---- 4. boss pulls (Slime King, floor 5) ----

function bossPulls(): void {
  section(`boss pulls: Slime King per mode (${BOSS_PULLS_PER_CONFIG}/config; pets must never touch the boss)`);
  for (const mode of MODE_LIST) {
    for (const party of BOSS_PARTIES) {
      let killed = 0;
      let markedBossTicks = 0;
      let petBossDamage = 0;
      let petHealing = 0;
      for (let i = 0; i < BOSS_PULLS_PER_CONFIG; i++) {
        const seed = 0xB055 ^ (MODE_LIST.indexOf(mode) << 20) ^ (party << 16) ^ (i * 40503);
        const w = gateWorld(seed, 5, mode, party, "ember_pup");
        const boss = () => w.enemies.find((e) => e.kind === "boss");
        for (let t = 0; t < 180 * TICK_HZ; t++) {
          const inputs = new Map<PlayerId, InputCmd>();
          for (const p of w.players.values()) inputs.set(p.id, scriptedInput(w, p, t + 1));
          stepWorld(w, inputs, FIXED_DT);
          const b = boss();
          if (b && b.petMark > 0) markedBossTicks++;
          if (!b) break; // boss dead: danger cleared
        }
        if (!boss()) killed++;
        petBossDamage += w.ledger!.petBossDamage;
        petHealing += w.ledger!.petHealing;
      }
      const label = `${mode} P${party}`;
      check(`${label}: pets dealt ZERO boss damage across ${BOSS_PULLS_PER_CONFIG} pull(s)`, petBossDamage === 0, `dmg=${petBossDamage}`);
      check(`${label}: the boss was never marked`, markedBossTicks === 0);
      check(`${label}: no pet healing during pulls`, petHealing === 0);
      check(`${label}: the scripted party can still finish the fight (pets aren't load-bearing)`,
        killed * 2 >= BOSS_PULLS_PER_CONFIG, `killed=${killed}/${BOSS_PULLS_PER_CONFIG}`);
    }
  }
}

// ---- 5. §1 mode wiring (pressure moves the authored way; recovery knobs land) ----

function totalThreat(w: WorldState): number {
  let sum = 0;
  for (const e of w.enemies) if (e.kind !== "boss") sum += threatCostOf(e.kind, e.tier);
  for (const e of w.pendingSpawns) sum += threatCostOf(e.kind, e.tier);
  return sum;
}

function modeWiring(): void {
  section("§1 mode wiring: pressure ordering, cap rounding, recovery knobs");
  for (const floor of [3, 6]) {
    const spawned = MODE_LIST.map((mode) => totalThreat(createWorld(0x51ee7, floor, { skipLocalPlayer: true, mode })));
    check(`floor ${floor}: spawned threat orders casual ≤ standard ≤ brutal`,
      spawned[0] <= spawned[1] && spawned[1] <= spawned[2], spawned.map((v) => v.toFixed(1)).join(" / "));
  }
  check("active-cap rounding: casual floors down with min 6, brutal ceils with max 18",
    modeActiveCap("casual", 9) === 7 && modeActiveCap("casual", 6) === 6
    && modeActiveCap("brutal", 16) === 18 && modeActiveCap("brutal", 17) === 18
    && modeActiveCap("standard", 16) === 16);
  check("boss add cap shifts ±1 with casual's floor of 2",
    modeBossAddCap("casual", 5) === 4 && modeBossAddCap("casual", 2) === 2
    && modeBossAddCap("standard", 5) === 5 && modeBossAddCap("brutal", 5) === 6);

  // Boss-chest hearts: casual pays +2, standard/brutal +1 (spec §1 boss heart reward).
  // Counted via the floor's heart-generation ledger — the opener may inhale them instantly.
  for (const mode of MODE_LIST) {
    const w = createWorld(0xC4E57, 1, { isSandbox: true, skipLocalPlayer: true, mode });
    const p = spawnPlayerInWorld(w, "p0");
    w.chests.push({ id: w.nextChestId++, kind: "boss", x: p.x + 20, y: p.y, radius: 18, opened: false });
    stepScripted(w, 2);
    check(`${mode} boss chest ejects ${MODES[mode].bossChestHearts} heart(s)`,
      w.heartsThisFloor === MODES[mode].bossChestHearts, `hearts=${w.heartsThisFloor}`);
  }

  // Revive channel/HP per mode: a 1.3s hold revives on casual (1.2s) only; the revived HP
  // follows the mode table (3 on casual, 2 elsewhere).
  for (const mode of MODE_LIST) {
    const w = createWorld(0xEE71E, 1, { isSandbox: true, skipLocalPlayer: true, mode });
    const down = spawnPlayerInWorld(w, "pDown");
    const medic = spawnPlayerInWorld(w, "pMedic");
    medic.x = down.x + 20; medic.y = down.y;
    down.isDown = true; down.hp = 0;
    for (let t = 0; t < Math.round(1.3 / FIXED_DT); t++) {
      stepWorld(w, new Map<PlayerId, InputCmd>(), FIXED_DT);
    }
    const isRevived = !down.isDown;
    if (mode === "casual") check("casual revive lands inside 1.3s at 3 HP", isRevived && down.hp === 3, `hp=${down.hp}`);
    else check(`${mode} revive is still channeling at 1.3s (${MODES[mode].reviveChannel}s hold)`, !isRevived);
  }
}

// ---- 6. determinism (spec §7.9: pet procs replay byte-identically) ----

function determinism(): void {
  section("determinism: one config, two runs, byte-identical ledgers");
  const a = runFloor(0xD37, 3, "brutal", 3);
  const b = runFloor(0xD37, 3, "brutal", 3);
  check("replayed gate floor produces an identical ledger", JSON.stringify(a.led) === JSON.stringify(b.led));
  check("replayed gate floor produces an identical clear result", a.cleared === b.cleared);
}

function main(): void {
  const ownerMedianDps = measureOwnerMedianDps();
  petBench("ember_pup", ownerMedianDps);
  petBench("bonebird", ownerMedianDps);
  petBench("lantern_wisp", ownerMedianDps);
  const stats = roomMatrix();
  bossPulls();
  modeWiring();
  determinism();

  const rooms = stats.reduce((s, c) => s + c.rooms, 0);
  process.stdout.write(`\n[gate scale] ${rooms} rooms across ${stats.reduce((s, c) => s + c.floors, 0)} floors, ${MODE_LIST.length * BOSS_PARTIES.length * BOSS_PULLS_PER_CONFIG} boss pulls${IS_FULL ? "" : " (CI subset — PET_GATE_FULL=1 for the spec-scale run)"}\n`);
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nStudio pet balance gate holds across every mode and party size.\n");
}

main();
