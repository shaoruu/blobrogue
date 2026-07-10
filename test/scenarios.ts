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

import type { WeaponId, EnemyKind, PropKind, Enemy } from "../src/sim/types.js";
import type { WorldState } from "../src/sim/world.js";
import { LOCAL_ID } from "../src/sim/input.js";

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
  // Scripted per-tick intent. `w` is the live authoritative world (read-only by
  // convention): earned-window boss scripts must PLAY THE MECHANICS — aim at a lattice
  // knot, sidestep a locked rush — which no pure function of the tick can do. The
  // script stays a deterministic function of (tick, state), so both golden runs and
  // every replay harness reproduce it byte-for-byte.
  input(tick: number, w?: WorldState): FrameInput;
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
// cycling through every weapon (ranged, the three melee blades, then the effect wave).
const WEAPON_CYCLE: WeaponId[] = [
  "pistol", "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing",
  "tesla", "sawnoff", "railgun", "nailer", "flamer", "mortar", "beam",
  "sword", "longsword", "spear",
  "lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook",
  "reaper", "swarm", "midas", "phase", "vortex",
];
const COMBAT_TICKS = WEAPON_CYCLE.length * 44 + 48;
const combat: Scenario = {
  name: "combat",
  seed: 0x2222,
  floor: 1,
  ticks: COMBAT_TICKS,
  commands: (() => {
    const cmds: Command[] = [];
    // God mode: the gunner must SURVIVE the whole cycle — the point is exercising every
    // weapon's full code path (the effect wave sits at the end of the cycle).
    cmds.push({ t: "godmode", tick: 0 });
    // Swap weapon every 44 ticks (the whole cycle fits inside the script).
    for (let i = 0; i < WEAPON_CYCLE.length; i++) cmds.push({ t: "weapon", tick: i * 44, weapon: WEAPON_CYCLE[i] });
    // Keep feeding the full regular-enemy roster to the right of the player.
    for (let tick = 0; tick < COMBAT_TICKS; tick += 24) {
      const kinds: EnemyKind[] = ["slime", "bat", "skeleton", "ghost", "spitter", "charger", "burrower", "orbiter", "shielder"];
      const kind = kinds[(tick / 24) % kinds.length];
      cmds.push({ t: "spawnEnemy", tick, kind, dx: 90 + ((tick / 24) % 3) * 22, dy: ((tick / 24) % 5) * 10 - 20 });
    }
    return cmds;
  })(),
  input(tick) {
    // The trigger PULSES (released for the last 8 ticks of each 44-tick weapon window)
    // so hold-release mechanics get real coverage: the Breach charges then fires on the
    // release, and the Crooked Chain's latch -> second-press sweep both execute.
    return { moveX: 0, moveY: 0, aim: 0, firing: tick % 44 < 36, dash: false };
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

// The rest of the boss roster, each hosed down by the same strong Lv3 build so the
// goldens walk every phase machine tick-for-tick. The earned-window bosses need their
// scripts to PLAY THE MECHANICS (aim a knot, silence a fragment, sidestep a locked
// rush) — a bot that ignores them would only golden the guard chip — so each boss
// script is a deterministic function of (tick, world state).
function bossGoldenCommands(kind: EnemyKind, dx = 190): Command[] {
  const cmds: Command[] = [];
  cmds.push({ t: "godmode", tick: 0 });
  for (const itemId of ["vitality", "hair_trigger", "deadeye", "full_metal"]) {
    for (let i = 0; i < 3; i++) cmds.push({ t: "item", tick: 0, itemId });
  }
  cmds.push({ t: "weapon", tick: 0, weapon: "smg" });
  cmds.push({ t: "spawnEnemy", tick: 2, kind, dx, dy: 0 });
  return cmds;
}

// Nearest live body of a kind (a boss floor carries its NATURAL boss in the far arena
// besides the scenario's dev-spawned one — the script fights the one at hand).
function liveKind(w: WorldState, kind: EnemyKind): Enemy | undefined {
  const p = w.players.get(LOCAL_ID);
  if (!p) return undefined;
  let best: Enemy | undefined;
  let bestD = Infinity;
  for (const e of w.enemies) {
    if (e.dead || e.kind !== kind) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function aimFrom(w: WorldState, at: { x: number; y: number } | undefined): number {
  const p = w.players.get(LOCAL_ID);
  if (!p || !at) return 0;
  return Math.atan2(at.y - p.y, at.x - p.x);
}

// MARROW: hold ground, aim the boss, and SIDESTEP each locked rush so the blind bull
// carries past into geometry — the baited crash is its earned window, and this script
// walks it (plus the shield beats, the spiral, and the death) into the golden.
const marrow: Scenario = {
  name: "marrow",
  seed: 0x7777,
  floor: 15,
  ticks: 2400,
  // dx -190: this seed's spawn room opens WEST (dx +190 is inside the east wall — the
  // old golden's dev marrow sat wedged there, never actually fighting).
  commands: bossGoldenCommands("marrow", -190),
  input(_tick, w) {
    if (!w) return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
    const boss = liveKind(w, "marrow");
    const p = w.players.get(LOCAL_ID);
    let moveX = 0, moveY = 0;
    if (boss && boss.attack.move === "rush" && boss.attack.phase === "windup" && boss.attack.isAimLocked) {
      const side = boss.attack.lockedAngle + Math.PI / 2;
      moveX = Math.cos(side); moveY = Math.sin(side);
    } else if (p) {
      // Between commitments, walk back to the spawn-room anchor: dodge drift would
      // otherwise kite the fight into corridors and lose the line of fire.
      const ax = w.dungeon.spawn.x * 48 + 24, ay = w.dungeon.spawn.y * 48 + 24;
      if (Math.hypot(ax - p.x, ay - p.y) > 30) {
        const back = Math.atan2(ay - p.y, ax - p.x);
        moveX = Math.cos(back); moveY = Math.sin(back);
      }
    }
    return { moveX, moveY, aim: aimFrom(w, boss), firing: true, dash: false };
  },
};

// The Hollow Choir: silence the FRAGMENT verses (aim them first), circle off the
// drifting mass so it never body-blocks the fragment line — the goldens walk the
// verse/silence/exposed loop, both wisp-splits and the death.
const choir: Scenario = {
  name: "choir",
  seed: 0x8888,
  floor: 30,
  ticks: 2400,
  commands: bossGoldenCommands("choir"),
  input(_tick, w) {
    if (!w) return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
    const boss = liveKind(w, "choir");
    const fragment = w.enemies.find((e) => !e.dead && e.isSummoned && e.kind === "ghost");
    const p = w.players.get(LOCAL_ID);
    let moveX = 0, moveY = 0;
    if (boss && p && Math.hypot(boss.x - p.x, boss.y - p.y) < 170) {
      const away = Math.atan2(p.y - boss.y, p.x - boss.x) + 0.7;
      moveX = Math.cos(away); moveY = Math.sin(away);
    }
    return { moveX, moveY, aim: aimFrom(w, fragment ?? boss), firing: true, dash: false };
  },
};

// THE WEAVER (the earned-windows + fair-surprise flagship): break the lattice KNOTS
// (P1 windows + P3 lane denial), burst the EGG-SAC clutch to force her off the walls
// (P2), and unload through every earned window — the golden walks lanes/blink/snag,
// the climb loop with its omen ambushes, the molt reshapes and the P3 lane dashes.
const weaverScenario: Scenario = {
  name: "weaver",
  seed: 0x9999,
  floor: 20,
  ticks: 3000,
  // The flagship needs the full arc on the golden clock: a Glass Cannon stack (the
  // gauntlet golden's precedent) converts windows hard enough to reach P3 in time —
  // and proves the bank/floor plumbing under real pressure.
  commands: [
    ...bossGoldenCommands("weaver"),
    { t: "item", tick: 0, itemId: "glass_cannon" },
    { t: "item", tick: 0, itemId: "glass_cannon" },
    { t: "item", tick: 0, itemId: "glass_cannon" },
  ],
  input(_tick, w) {
    if (!w) return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
    const boss = liveKind(w, "weaver");
    const mechanic = boss !== undefined && boss.boss !== null && boss.boss.exposed > 0
      ? undefined // the window is open: unload on the boss, not the scaffolding
      : liveKind(w, "sac") ?? liveKind(w, "knot");
    const p = w.players.get(LOCAL_ID);
    let moveX = 0, moveY = 0;
    if (mechanic !== undefined && p !== undefined) {
      if (Math.hypot(mechanic.x - p.x, mechanic.y - p.y) > 280) {
        // The clutch spreads by design: run the mechanic down.
        const toward = Math.atan2(mechanic.y - p.y, mechanic.x - p.x);
        moveX = Math.cos(toward); moveY = Math.sin(toward);
      } else if (boss !== undefined && Math.hypot(boss.x - p.x, boss.y - p.y) < 140) {
        // A weaver parked on the muzzle eats the mechanic shot: circle off her.
        const away = Math.atan2(p.y - boss.y, p.x - boss.x) + 0.7;
        moveX = Math.cos(away); moveY = Math.sin(away);
      }
    }
    return { moveX, moveY, aim: aimFrom(w, mechanic ?? boss), firing: true, dash: false };
  },
};

// The Gilded Warden's windows are its own committed recovers: the stationary gunner
// converts them unchanged (aim tracks the boss so sweeps/sanctify reposition never
// drops the line).
const gilded: Scenario = {
  name: "gilded",
  seed: 0xAAAA,
  floor: 25,
  ticks: 2400,
  commands: bossGoldenCommands("gilded"),
  input(_tick, w) {
    if (!w) return { moveX: 0, moveY: 0, aim: 0, firing: true, dash: false };
    return { moveX: 0, moveY: 0, aim: aimFrom(w, liveKind(w, "gilded")), firing: true, dash: false };
  },
};

// The F10 Miniboss Gauntlet: a NATURAL floor-10 world (no sandbox, no spawn command) —
// the stage machine itself is the scenario. A god-mode player hoses everything down and
// the golden locks the machine's cadence: the approach clear, the Flock Commander stage,
// the authored breath, and the Orbiter elite's entrance + burn-down. (The full
// three-stage arc incl. the premium chest is proven in test:content; the golden pins the
// deterministic replay of the plumbing.)
const gauntlet: Scenario = {
  name: "gauntlet",
  seed: 0x6A07,
  floor: 10,
  ticks: 2800,
  commands: (() => {
    const cmds: Command[] = [];
    cmds.push({ t: "godmode", tick: 0 });
    for (const itemId of ["vitality", "hair_trigger", "deadeye", "full_metal", "glass_cannon"]) {
      for (let i = 0; i < 3; i++) cmds.push({ t: "item", tick: 0, itemId });
    }
    // Seekers track the wheeling commander and the ring-holding orbiter without any
    // aim scripting.
    cmds.push({ t: "weapon", tick: 0, weapon: "homing" });
    return cmds;
  })(),
  input(tick) {
    // A slow sweep spreads the seekers (and lobs shells) across the whole approach.
    return { moveX: 0, moveY: 0, aim: (tick / 240) * Math.PI * 2, firing: true, dash: false };
  },
};

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

export const SCENARIOS: Scenario[] = [movement, combat, boss, marrow, gauntlet, choir, weaverScenario, gilded, items, props, status];

export const DT = 1 / 60;

export function inputAt(s: Scenario, tick: number): FrameInput {
  return s.input(tick) ?? idle;
}
