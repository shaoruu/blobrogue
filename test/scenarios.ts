// Shared golden-master scenarios. Each is fully deterministic: a fixed seed + floor, a
// scripted per-tick input, and a list of timed commands (weapon swaps, item grants,
// controlled entity spawns near the spawn tile). Both the pre-extraction oracle harness
// and the refactored-sim test replay these identically and diff the resulting state (and,
// for the refactor, the emitted SimEvent stream) tick-for-tick.
//
// The goal is COVERAGE + determinism, not "winning" — the scripts exercise every major
// subsystem (movement/dash, all weapons incl. melee, boss phases, item synergies, props/
// explosions/chests/pickups, elemental status + combo + lifesteal). Exact outcomes only
// need to AGREE between oracle and refactor.

import type { WeaponId, EnemyKind, PropKind } from "../src/sim/types.js";

export interface FrameInput {
  moveX: number; // -1..1
  moveY: number; // -1..1
  aim: number; // radians (world-space)
  firing: boolean;
  dash: boolean;
}

// Commands applied BEFORE update()/stepWorld() on their tick, in array order. Positions
// are relative to the floor spawn tile center so both harnesses resolve them identically.
export type Command =
  | { t: "weapon"; tick: number; weapon: WeaponId }
  | { t: "item"; tick: number; itemId: string }
  | { t: "spawnEnemy"; tick: number; kind: EnemyKind; dx: number; dy: number }
  | { t: "spawnProp"; tick: number; kind: PropKind; dx: number; dy: number }
  | { t: "spawnChest"; tick: number; dx: number; dy: number }
  // Sim god mode (damagePlayer no-ops): the boss scenario's stationary gunner must survive
  // the full 900-HP phase machine — the scenario's purpose is state-machine coverage.
  | { t: "godmode"; tick: number };

export interface Scenario {
  name: string;
  seed: number;
  floor: number;
  ticks: number;
  commands: Command[];
  input(tick: number): FrameInput;
}

const idle: FrameInput = { moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };

// Movement + dash around the spawn floor. No firing; natural floor enemies wander in and
// exercise AI/pathfinding/collision + player contact damage.
const movement: Scenario = {
  name: "movement",
  seed: 0x1111,
  floor: 1,
  ticks: 600,
  commands: [],
  input(tick) {
    // Trace a square, dashing at each corner; pause mid-way.
    const phase = tick % 120;
    let moveX = 0;
    let moveY = 0;
    if (phase < 30) moveX = 1;
    else if (phase < 60) moveY = 1;
    else if (phase < 90) moveX = -1;
    else moveY = -1;
    const dash = phase % 30 === 1; // one-tick dash intent at each leg start
    return { moveX, moveY, aim: 0, firing: false, dash };
  },
};

// Full combat: a stationary gunner mowing down a refreshing line of enemies while
// cycling through every weapon (ranged then the three melee weapons at the end).
const WEAPON_CYCLE: WeaponId[] = [
  "pistol", "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing",
  "tesla", "sawnoff", "railgun", "nailer", "flamer", "mortar", "beam",
  "sword", "longsword", "spear",
];
const combat: Scenario = {
  name: "combat",
  seed: 0x2222,
  floor: 1,
  ticks: 800,
  commands: (() => {
    const cmds: Command[] = [];
    // Swap weapon every 44 ticks (18 weapons fit inside the 800-tick script).
    for (let i = 0; i < WEAPON_CYCLE.length; i++) cmds.push({ t: "weapon", tick: i * 44, weapon: WEAPON_CYCLE[i] });
    // Keep feeding the full regular-enemy roster to the right of the player.
    for (let tick = 0; tick < 800; tick += 24) {
      const kinds: EnemyKind[] = ["slime", "bat", "skeleton", "ghost", "spitter", "charger", "burrower", "orbiter", "shielder"];
      const kind = kinds[(tick / 24) % kinds.length];
      cmds.push({ t: "spawnEnemy", tick, kind, dx: 90 + ((tick / 24) % 3) * 22, dy: ((tick / 24) % 5) * 10 - 20 });
    }
    return cmds;
  })(),
  input() {
    return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
  },
};

// Boss floor: spawn the 900-HP Slime King point-blank and hose it down with a strong
// Lv3 build (~40 sustained DPS) so the golden walks the FULL new phase machine: P1 hop
// slams + adds, both 1.2s transition roars (floors + queued overflow), P2 radials, the P3
// arena squeeze, and death. God mode keeps the stationary gunner alive through all of it.
const boss: Scenario = {
  name: "boss",
  seed: 0x3333,
  floor: 5,
  ticks: 1750,
  commands: (() => {
    const cmds: Command[] = [];
    cmds.push({ t: "godmode", tick: 0 });
    for (const itemId of ["vitality", "hair_trigger", "deadeye", "full_metal"]) {
      for (let i = 0; i < 3; i++) cmds.push({ t: "item", tick: 0, itemId });
    }
    cmds.push({ t: "weapon", tick: 0, weapon: "smg" });
    cmds.push({ t: "spawnEnemy", tick: 2, kind: "boss", dx: 170, dy: 0 });
    return cmds;
  })(),
  input() {
    // Stationary gunner: fire steadily so the boss walks its full phase machine.
    return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
  },
};

// Deep boss floor: spawn MARROW point-blank and hose it down with the same
// strong Lv3 build so the golden walks ITS full phase machine: P1 line charges (incl. the
// wall-crash stun) + volleys, both interactive shield beats (floors + queued overflow +
// husk adds), P2 crash rings, the P3 spiral barrage, and death.
const marrow: Scenario = {
  name: "marrow",
  seed: 0x7777,
  floor: 10,
  ticks: 2400,
  commands: (() => {
    const cmds: Command[] = [];
    cmds.push({ t: "godmode", tick: 0 });
    for (const itemId of ["vitality", "hair_trigger", "deadeye", "full_metal"]) {
      for (let i = 0; i < 3; i++) cmds.push({ t: "item", tick: 0, itemId });
    }
    cmds.push({ t: "weapon", tick: 0, weapon: "smg" });
    cmds.push({ t: "spawnEnemy", tick: 2, kind: "marrow", dx: 190, dy: 0 });
    return cmds;
  })(),
  input() {
    return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
  },
};

// The rest of the boss roster, each hosed down by the same strong Lv3 build so the
// goldens walk every phase machine tick-for-tick: the Choir's wails/fades/wisp-splits,
// the Weaver's webs/pounces/molt, the Gilded Warden's plate/quakes/sweeps/sanctifies.
function bossGolden(name: string, seed: number, kind: EnemyKind, floor: number): Scenario {
  return {
    name,
    seed,
    floor,
    ticks: 2400,
    commands: (() => {
      const cmds: Command[] = [];
      cmds.push({ t: "godmode", tick: 0 });
      for (const itemId of ["vitality", "hair_trigger", "deadeye", "full_metal"]) {
        for (let i = 0; i < 3; i++) cmds.push({ t: "item", tick: 0, itemId });
      }
      cmds.push({ t: "weapon", tick: 0, weapon: "smg" });
      cmds.push({ t: "spawnEnemy", tick: 2, kind, dx: 190, dy: 0 });
      return cmds;
    })(),
    input() {
      return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
    },
  };
}

// Each deep boss is exercised at its authored gate floor (F15/F20/F25).
const choir = bossGolden("choir", 0x8888, "choir", 25);
const weaverScenario = bossGolden("weaver", 0x9999, "weaver", 15);
const gilded = bossGolden("gilded", 0xAAAA, "gilded", 20);

// Items + synergies: stack pellet/crit/pierce/bounce mods, then verify mod-affected shots
// against a fed line of enemies (pierce punches through, ricochet bounces off walls).
const items: Scenario = {
  name: "items",
  seed: 0x4444,
  floor: 2,
  ticks: 500,
  commands: (() => {
    const cmds: Command[] = [];
    const grants = ["split_shot", "scattergun", "full_metal", "big_iron", "deadeye", "swift_boots", "hair_trigger"];
    grants.forEach((itemId, i) => cmds.push({ t: "item", tick: 4 + i * 8, itemId }));
    cmds.push({ t: "weapon", tick: 80, weapon: "ricochet" });
    for (let tick = 60; tick < 500; tick += 20) {
      cmds.push({ t: "spawnEnemy", tick, kind: "slime", dx: 80 + ((tick / 20) % 4) * 20, dy: ((tick / 20) % 3) * 24 - 24 });
    }
    return cmds;
  })(),
  input(tick) {
    return { moveX: 0, moveY: 0, aim: 0, firing: tick > 40, dash: false };
  },
};

// Props + explosion chain + chest + pickups. Break a line of props (incl. explosive
// barrels that chain) then walk onto a chest and collect the loot it drops. No firing
// while opening the chest so the pickup-collect path is clean.
const props: Scenario = {
  name: "props",
  seed: 0x5555,
  floor: 2,
  ticks: 500,
  commands: (() => {
    const cmds: Command[] = [];
    cmds.push({ t: "spawnProp", tick: 0, kind: "crate", dx: 80, dy: 0 });
    cmds.push({ t: "spawnProp", tick: 0, kind: "pot", dx: 110, dy: -20 });
    cmds.push({ t: "spawnProp", tick: 0, kind: "barrel", dx: 110, dy: 20 });
    cmds.push({ t: "spawnProp", tick: 0, kind: "barrel_explosive", dx: 140, dy: 0 });
    cmds.push({ t: "spawnProp", tick: 0, kind: "barrel_explosive", dx: 168, dy: 0 });
    cmds.push({ t: "spawnChest", tick: 0, dx: -60, dy: 0 });
    cmds.push({ t: "weapon", tick: 0, weapon: "cannon" });
    return cmds;
  })(),
  input(tick) {
    // First ~200 ticks: fire right to smash the prop line. Then stop firing and walk
    // left onto the chest to open it + collect drops.
    if (tick < 200) return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
    return { moveX: -1, moveY: 0, aim: Math.PI, firing: false, dash: false };
  },
};

// Status + combo + lifesteal: laced elemental shots (burn/chill/shock) into a fed line,
// racking a kill combo and healing via lifesteal.
const status: Scenario = {
  name: "status",
  seed: 0x6666,
  floor: 3,
  ticks: 700,
  commands: (() => {
    const cmds: Command[] = [];
    ["elementalist", "incendiary_rounds", "cryo_coating", "static_charge", "vampire_fang", "deadeye"].forEach((itemId, i) =>
      cmds.push({ t: "item", tick: 2 + i * 6, itemId })
    );
    cmds.push({ t: "weapon", tick: 0, weapon: "flamer" });
    cmds.push({ t: "weapon", tick: 350, weapon: "tesla" });
    const kinds: EnemyKind[] = ["slime", "skeleton", "bat"];
    let i = 0;
    for (let tick = 40; tick < 700; tick += 18, i++) {
      cmds.push({ t: "spawnEnemy", tick, kind: kinds[i % kinds.length], dx: 70 + (i % 5) * 16, dy: (i % 3) * 20 - 20 });
    }
    return cmds;
  })(),
  input(tick) {
    return { moveX: 0, moveY: 0, aim: 0, firing: tick > 30, dash: false };
  },
};

export const SCENARIOS: Scenario[] = [movement, combat, boss, marrow, choir, weaverScenario, gilded, items, props, status];

export const DT = 1 / 60;

export function inputAt(s: Scenario, tick: number): FrameInput {
  return s.input(tick) ?? idle;
}
