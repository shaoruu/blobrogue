// Content-wave coverage: the eight new guns and ten new blessings, exercised on the pure
// authoritative sim. Locks (1) every new weapon carries a COMPLETE contract (WEAPONS +
// ARSENAL + resonance + KB/knockback records + pickup pool + sprite hook), (2) each new
// weapon's signature behavior actually resolves through a real trigger pull (pierce, ghost
// lane, bounce, shock, chill, blast+burn, homing, and the legendary's two-stage
// implosion→nova), (3) every new blessing applies cleanly at all three levels with finite,
// capped mods and a real effect, and (4) the new content stays DETERMINISTIC (byte-stable
// replay, no wall-clock / Math.random in the sim path).
//
// Run: npm run test:contentwave

import {
  createWorld, stepWorld, devSpawnEnemy, acquireWeaponInWorld, applyItemToWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Enemy, EnemyKind, WeaponId } from "../src/sim/types.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import { ARSENAL } from "../src/sim/arsenal.js";
import { WEAPON_RESONANCE, RESONANCE_FAMILIES } from "../src/sim/balance.js";
import { WEAPON_KB, FIRE_KNOCKBACK } from "../src/sim/constants.js";
import { ITEMS, itemById, createMods, recomputeMods, clampModCaps, MAX_ITEM_LEVEL } from "../src/sim/items.js";
import type { PlayerMods } from "../src/sim/items.js";
import { weaponDisplayStats } from "../src/sim/weaponStats.js";
import { CAPS } from "../src/sim/balance.js";
import "./harness/domShim.js";
import { heldWeaponSrc, weaponIconSrc } from "../src/game/assets.js";

const DT = 1 / 60;

const NEW_WEAPONS: WeaponId[] = [
  "cleaver", "scrapper", "skipper", "arcbolt", "cryobolt", "firebomb", "tracker", "singularity",
];
const NEW_ITEMS = [
  "marksman", "juggernaut", "heavy_rounds", "skirmisher", "executioner",
  "overload", "featherweight", "frostbite", "quickdraw", "vanguard",
];

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function arena(seed: number): { w: WorldState; p: PlayerSim } {
  const w = createWorld(seed, 1, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  p.x = 300; p.y = 600;
  return { w, p };
}
function parked(w: WorldState, kind: EnemyKind, x: number, y: number, hp: number): Enemy {
  const e = devSpawnEnemy(w, kind, x, y);
  e.spawnTimer = 0; e.speed = 0; e.kbResist = 1e9; e.hp = e.maxHp = hp;
  return e;
}
function fire(w: WorldState, p: PlayerSim, aim: number): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, { seq: w.tick + 1, moveX: 0, moveY: 0, aim, firing: true, dash: false }]]), DT);
}
function stepFor(w: WorldState, p: PlayerSim, seconds: number, aim: number, firing: boolean, ev?: SimEvent[]): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const out = stepWorld(w, new Map([[LOCAL_ID, { seq: w.tick + 1, moveX: 0, moveY: 0, aim, firing, dash: false }]]), DT);
    if (ev) ev.push(...out);
  }
}

// ---- 1. contract completeness ----

function contractGates(): void {
  section("contract: every new weapon carries a complete authored + record contract");
  for (const id of NEW_WEAPONS) {
    check(`${id} is in WEAPONS`, WEAPONS[id] !== undefined);
    check(`${id} is in the pickup pool`, PICKUP_WEAPONS.includes(id));
    check(`${id} has an ARSENAL manifest row`, ARSENAL[id] !== undefined);
    check(`${id} declares a resonance family`, RESONANCE_FAMILIES.includes(WEAPON_RESONANCE[id]));
    check(`${id} has a knockback + self-knockback entry`,
      typeof WEAPON_KB[id] === "number" && typeof FIRE_KNOCKBACK[id] === "number");
    check(`${id} registers a held_${id}.png sprite hook`, heldWeaponSrc(id) === `/sprites/held_${id}.png`);
    check(`${id} registers a weapon_${id}.png pickup/hotbar hook`, weaponIconSrc(id) === `/sprites/weapon_${id}.png`);
    const card = weaponDisplayStats(id, createMods(), 0);
    check(`${id} resolves a non-empty display card`,
      card.role.length > 0 && card.impact.band.length > 0 && card.cadence.band.length > 0 && card.reach.band.length > 0);
  }
  // Every new weapon with a signature MECHANIC carries canonical `special` copy.
  for (const id of NEW_WEAPONS) {
    check(`${id} carries a signature 'special' tooltip line`, typeof WEAPONS[id].special === "string" && WEAPONS[id].special!.length > 8);
  }
}

// ---- 2. signature behaviors ----

function behaviorGates(): void {
  section("behavior: each new weapon's signature resolves through a real trigger pull");

  // Cleaver: one disc shreds a whole line (deep pierce hits several bodies at once).
  {
    const { w, p } = arena(0xC1EA);
    acquireWeaponInWorld(w, LOCAL_ID, "cleaver");
    const line = [parked(w, "slime", 420, 600, 40), parked(w, "slime", 470, 600, 40), parked(w, "slime", 520, 600, 40)];
    stepFor(w, p, 0.6, 0, true);
    check("cleaver's disc damages an entire line from one volley", line.every((e) => e.hp < 40),
      line.map((e) => e.hp.toFixed(0)).join("/"));
  }
  // Shoulderfire: one aimed round plus a straight same-side aim-offset ghost lane.
  {
    const { w, p } = arena(0x5C2A);
    acquireWeaponInWorld(w, LOCAL_ID, "scrapper");
    p.facing = -1;
    p.fireCd = 0;
    fire(w, p, 0);
    const bullets = w.bullets.filter((bullet) => bullet.friendly);
    const main = bullets.find((bullet) => bullet.isGhostLane !== true);
    const ghost = bullets.find((bullet) => bullet.isGhostLane === true);
    check("Shoulderfire fires one aimed round and one fixed aim +80° ghost",
      bullets.length === 2
      && main !== undefined
      && ghost !== undefined
      && Math.abs(Math.atan2(main.vy, main.vx)) < 1e-9
      && Math.abs(Math.atan2(ghost.vy, ghost.vx) - 80 * Math.PI / 180) < 1e-9
      && Math.abs(ghost.damage - main.damage * 0.6) < 1e-9,
      `bullets=${bullets.length}`);
  }
  // Skipper: buckshot that banks off a wall. Fire point-blank into the west wall so the
  // fan actually reaches geometry and banks (the mechanic, not just the flag).
  {
    const { w, p } = arena(0x5819);
    acquireWeaponInWorld(w, LOCAL_ID, "skipper");
    p.x = 5 * 48; p.y = 12 * 48; // room to travel before the west wall
    p.fireCd = 0;
    const first = fire(w, p, Math.PI); // aim into the wall
    check("skipper's fan carries the ricochet flag", w.bullets.some((b) => b.friendly && (b.bounce ?? 0) >= 1));
    const ev: SimEvent[] = [...first];
    stepFor(w, p, 0.5, Math.PI, false, ev);
    check("skipper's buckshot banks off the wall", ev.some((x) => x.t === "bulletBounce"), "no bounce event");
  }
  // Arcbolt: every round stamps shock.
  {
    const { w, p } = arena(0xA2C0);
    acquireWeaponInWorld(w, LOCAL_ID, "arcbolt");
    const mark = parked(w, "slime", 420, 600, 60);
    stepFor(w, p, 0.4, 0, true);
    check("arcbolt shocks the body it hits", mark.shock > 0, `shock=${mark.shock.toFixed(2)}`);
  }
  // Cryobolt: sustained fire chills a body.
  {
    const { w, p } = arena(0xC4B0);
    acquireWeaponInWorld(w, LOCAL_ID, "cryobolt");
    const mark = parked(w, "slime", 430, 600, 200);
    stepFor(w, p, 0.8, 0, true);
    check("cryobolt chills the body it hits", mark.chill > 0, `chill=${mark.chill.toFixed(2)}`);
  }
  // Firebomb: a shell detonates and leaves the blast ablaze.
  {
    const { w, p } = arena(0xF12B);
    acquireWeaponInWorld(w, LOCAL_ID, "firebomb");
    const mark = parked(w, "slime", 470, 600, 200);
    const ev: SimEvent[] = [];
    stepFor(w, p, 0.9, 0, true, ev);
    check("firebomb detonates a blast", ev.some((x) => x.t === "explosion"));
    check("firebomb leaves its target burning", mark.burn > 0, `burn=${mark.burn.toFixed(2)}`);
  }
  // Tracker: a heavy seeker bends onto an off-axis body.
  {
    const { w, p } = arena(0x77AC);
    acquireWeaponInWorld(w, LOCAL_ID, "tracker");
    const off = parked(w, "slime", 430, 720, 200); // below the aim line
    p.fireCd = 0;
    fire(w, p, 0); // aim straight right; homing must bend downward
    const b = w.bullets.find((x) => x.friendly)!;
    const vy0 = b.vy;
    stepFor(w, p, 0.4, 0, false);
    check("tracker's round seeks an off-axis body (bends toward it)", b.vy > vy0 + 20,
      `vy ${vy0.toFixed(0)} -> ${b.vy.toFixed(0)}`);
    check("the seeker eventually connects", off.hp < 200, `hp=${off.hp.toFixed(0)}`);
  }
  // Singularity: the two-stage payload — implosion, then a delayed nova on the clump. The
  // pack sits near the muzzle so the round implodes quickly; the inward pull is measured in
  // the window BETWEEN the implosion and the nova (the nova's own blast KB re-scatters).
  {
    const { w, p } = arena(0x51A0);
    acquireWeaponInWorld(w, LOCAL_ID, "singularity");
    const center = devSpawnEnemy(w, "slime", 350, 600); center.spawnTimer = 99; center.speed = 0; center.kbResist = 1; center.hp = center.maxHp = 80;
    const north = devSpawnEnemy(w, "slime", 350, 520); north.spawnTimer = 99; north.speed = 0; north.kbResist = 1; north.hp = north.maxHp = 80;
    const south = devSpawnEnemy(w, "slime", 350, 680); south.spawnTimer = 99; south.speed = 0; south.kbResist = 1; south.hp = south.maxHp = 80;
    const gap0 = Math.abs(north.y - south.y);
    const ev: SimEvent[] = [];
    p.fireCd = 0;
    fire(w, p, 0);
    // Let the implosion land and its inward knockback integrate — but stop before the nova
    // fuse (NOVA_FUSE 0.22s after impact) fires and its blast re-scatters the clump. The
    // round reaches the near pack almost immediately, so 0.18s sits inside the pull window.
    stepFor(w, p, 0.18, 0, false, ev);
    check("the round implodes on impact", ev.some((x) => x.t === "implosion"));
    const gapAfterPull = Math.abs(north.y - south.y);
    check("the implosion drags the flanking pack inward", gapAfterPull < gap0 - 15,
      `gap ${gap0.toFixed(0)} -> ${gapAfterPull.toFixed(0)}`);
    stepFor(w, p, 0.5, 0, false, ev);
    check("a SECOND-stage nova detonates on the clump (the two-stage signature)",
      ev.some((x) => x.t === "explosion"));
    check("both flank bodies take the two-stage payload", north.hp < 80 && south.hp < 80,
      `${north.hp.toFixed(0)}/${south.hp.toFixed(0)}`);
  }
}

// ---- 3. blessing application ----

function blessingGates(): void {
  section("blessings: every new trait applies cleanly at all three levels (finite + capped)");
  const base = createMods();
  const modKeys = Object.keys(base) as Array<keyof PlayerMods>;
  for (const id of NEW_ITEMS) {
    const def = itemById(id);
    check(`${id} is a registered blessing`, def !== undefined);
    if (!def) continue;
    check(`${id} carries three level descriptions + glyph + tint + rarity`,
      def.descs.length === 3 && def.descs.every((d) => d.length > 4)
      && def.glyph.length >= 1 && def.tint.startsWith("#")
      && ["common", "uncommon", "rare"].includes(def.rarity));
    let changesSomething = false;
    let allFinite = true;
    for (let level = 1; level <= MAX_ITEM_LEVEL; level++) {
      const m = createMods();
      recomputeMods(m, Array.from({ length: level }, () => id)); // level = pick count
      for (const k of modKeys) if (!Number.isFinite(m[k])) allFinite = false;
      if (modKeys.some((k) => m[k] !== base[k])) changesSomething = true;
    }
    check(`${id} produces finite mods at Lv1-3`, allFinite);
    check(`${id} actually changes the build (not a dead knob)`, changesSomething);
  }

  section("blessings: the whole new pool stacked at Lv3 stays inside the raw caps");
  {
    const owned: string[] = [];
    for (const id of NEW_ITEMS) for (let i = 0; i < 3; i++) owned.push(id);
    const m = createMods();
    recomputeMods(m, owned);
    const keys = Object.keys(m) as Array<keyof PlayerMods>;
    check("no NaN / Infinity anywhere in the stacked build", keys.every((k) => Number.isFinite(m[k])));
    check("damage/fire-rate/move/hearts/pierce/elemental all clamp to the §6 caps",
      m.damageMult <= CAPS.damageMult && m.fireRateMult <= CAPS.fireRateMult
      && m.moveSpeedMult <= CAPS.moveSpeedMult && m.maxHpBonus <= CAPS.maxHpBonus
      && m.pierce <= CAPS.pierce
      && m.chillChance <= CAPS.elementalChance,
      `dmg=${m.damageMult.toFixed(2)} rate=${m.fireRateMult.toFixed(2)} hp=${m.maxHpBonus}`);
    // clampModCaps is idempotent — a second pass never changes an already-capped build.
    const before = JSON.stringify(m);
    clampModCaps(m);
    check("the clamp is idempotent (recompute already applied it)", JSON.stringify(m) === before);
  }

  section("blessings: a couple of signature effects resolve on a real player");
  {
    // Overload trades hearts for offense.
    const { w, p } = arena(0x0FA0);
    const hp0 = p.maxHp;
    for (let i = 0; i < 3; i++) applyItemToWorld(w, LOCAL_ID, itemById("overload")!);
    check("Overload raises damage & fire rate and lowers max hearts",
      p.mods.damageMult > 1 && p.mods.fireRateMult > 1 && p.maxHp < hp0,
      `dmg=${p.mods.damageMult.toFixed(2)} rate=${p.mods.fireRateMult.toFixed(2)} hp ${hp0}->${p.maxHp}`);
  }
  {
    // Juggernaut adds thorns + hearts at a move-speed cost.
    const { w, p } = arena(0x0FA1);
    applyItemToWorld(w, LOCAL_ID, itemById("juggernaut")!);
    check("Juggernaut grants thorns + hearts but slows the walk",
      p.mods.thorns > 0 && p.mods.maxHpBonus > 0 && p.mods.moveSpeedMult < 1);
  }
}

// ---- 4. determinism ----

function determinismGates(): void {
  section("determinism: the new content replays byte-identically (no wall-clock / Math.random)");
  const run = (weapon: WeaponId): string => {
    const w = createWorld(0xDE7E7, 1, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 0; p.x = 300; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, weapon);
    for (const id of ["marksman", "frostbite", "executioner"]) {
      for (let i = 0; i < 2; i++) applyItemToWorld(w, LOCAL_ID, itemById(id)!);
    }
    for (let i = 0; i < 6; i++) {
      const e = devSpawnEnemy(w, i % 2 === 0 ? "slime" : "bat", 460 + (i % 3) * 40, 560 + (i % 3) * 30);
      e.hp = 6;
    }
    const trace: string[] = [];
    for (let t = 0; t < 180; t++) {
      const evs: SimEvent[] = stepWorld(w, new Map<string, InputCmd>([[LOCAL_ID, {
        seq: t + 1, moveX: Math.sin(t / 25), moveY: 0, aim: t / 30, firing: t % 3 === 0, dash: false,
      }]]), DT);
      for (const e of evs) if (e.t === "enemyKill" || e.t === "implosion" || e.t === "explosion") trace.push(JSON.stringify(e));
    }
    trace.push(JSON.stringify(w.bullets.map((b) => [Math.round(b.x), Math.round(b.y), b.damage])));
    return trace.join("\n");
  };
  for (const weapon of ["singularity", "cleaver", "tracker"] as WeaponId[]) {
    check(`${weapon}: two identical runs match exactly`, run(weapon) === run(weapon));
  }
}

function main(): void {
  contractGates();
  behaviorGates();
  blessingGates();
  determinismGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll content-wave assertions hold.\n");
}

main();
