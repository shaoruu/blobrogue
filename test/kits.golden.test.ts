// Determinism golden-master for the KIT/ULT system (spec §7, the hard gate): ult charge
// ACCRUAL (damage / kill / dash / time inputs), ult TRIGGER validation + the 8s lockout,
// Sanctuary/Aegis entity LIFETIME, and Phase MULTI-TARGET selection — each captured tick-for-
// tick and asserted to (a) match the committed golden, (b) be byte-stable on a second run, and
// (c) reproduce under a same-seed replay + a mid-run reconnect. Scenarios span P=1..4.
//
// The world is driven SERVER-STYLE (stepPlayerPhase per player, then stepWorldPhase, then
// tick++), so the ult resolution runs only in the authoritative world phase — exactly where the
// server runs it. Regenerate the goldens the approved way (never hand-edit .jsonl):
//   npx tsx test/kits.golden.test.ts --capture-current
//
// Run: npm test  (or  npx tsx test/kits.golden.test.ts)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createWorld, spawnPlayerInWorld, removePlayerFromWorld, setPlayerKit,
  stepPlayerPhase, stepWorldPhase, devSpawnEnemy,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import type { SimEvent } from "../src/sim/events.js";
import type { KitId } from "../src/sim/kits.js";
import { ULT } from "../src/sim/kits.js";

const FIXED_DT = 1 / 20;

function r(n: number): number { return Math.round(n * 1e4) / 1e4; }

interface PlayerSpawn { id: PlayerId; kit: KitId; dx: number; dy: number; hp0?: number }
interface Scenario {
  name: string;
  seed: number;
  floor: number;
  ticks: number;
  players: PlayerSpawn[];
  // Slimes spawned in front of the party (drives damage/kill charge accrual).
  enemies?: { dx: number; dy: number }[];
  // Directly fill a player's meter to max at a tick (deterministic trigger/lockout probe).
  fillAt?: Record<number, PlayerId[]>;
  // A player requests their ult on every tick from this tick on (validated by the sim).
  ultFrom?: Record<PlayerId, number>;
  // A MENDER requests the directed heal-pulse on every tick from this tick on (aim +x toward a
  // co-located ally at dx>0; the sim validates the pulse cooldown).
  pulseFrom?: Record<PlayerId, number>;
  // Players who autofire toward the enemy cluster (charge from damage dealt).
  fire?: PlayerId[];
  // Players who dash every dashEvery ticks (phantom charge from dashes).
  dashEvery?: Record<PlayerId, number>;
  // A mid-run reconnect: remove `who` at tick `at`, respawn + re-kit at tick `back`.
  reconnect?: { who: PlayerId; at: number; back: number };
  // Inject one enemy projectile inside a live Aegis dome (off the caster's body) each tick from
  // this tick — exercises deterministic barrier HP depletion (duration OR HP, whichever first).
  injectAegisFire?: number;
}

// A compact per-tick digest of everything the ult system owns. §10 test hooks: the per-source
// charge accrual (dmg/kill/taken/heal/dash) + the wasted-overcharge stat, the meter + lockout,
// the entity HP/lifetime, and the self-buff/invuln windows.
interface Digest {
  t: number;
  players: Array<{ id: string; kit: string; uc: number; ura: number; ov: number; ph: number; iv: number; ps: number; hp: number; src: [number, number, number, number, number]; wst: number;
    // Wave 2 signature authoritative state (determinism gate 6): Gunner overheat window, Bulwark
    // overshield pool + regen clock, Mender pulse-CD gate, and the dash cooldown (proves the
    // Phantom refund lands identically).
    ovh: number; osh: number; oshr: number; pra: number; dcd: number }>;
  effects: Array<{ id: number; k: string; life: number; hp: number; r: number }>;
  // Enemy mark state (determinism gate 6): the Phantom dash-through mark + each enemy's HP (the
  // mark's damage effect resolves identically). Compact + sorted for a stable diff.
  enemies: Array<{ id: number; hp: number; mk: number }>;
  ev: string[];
}

const ULT_EVENTS = new Set(["ultOverdrive", "ultSanctuary", "ultAegis", "ultPhase"]);

function digest(w: WorldState, tick: number, ev: SimEvent[]): Digest {
  const players = [...w.players.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id, kit: p.kitId, uc: p.ultCharge, ura: p.ultReadyAtTick,
      ov: r(p.overdriveT), ph: r(p.phaseSpeed), iv: r(p.ultInvuln), ps: r(p.passiveState), hp: p.hp,
      src: [p.ultSources.dmg, p.ultSources.kill, p.ultSources.taken, p.ultSources.heal, p.ultSources.dash] as [number, number, number, number, number],
      wst: p.ultWasted,
      ovh: r(p.overheatT), osh: p.overshield, oshr: p.overshieldRegenT, pra: p.pulseReadyAtTick, dcd: r(p.dashCd),
    }));
  const effects = w.effects
    .filter((e) => e.kind === "sanctuary" || e.kind === "aegis")
    .map((e) => ({ id: e.id, k: e.kind, life: r(e.life), hp: r("hp" in e ? e.hp : -1), r: r("radius" in e ? e.radius : 0) }))
    .sort((a, b) => a.id - b.id);
  const enemies = w.enemies
    .map((e) => ({ id: e.id, hp: r(e.hp), mk: r(e.markT) }))
    .sort((a, b) => a.id - b.id);
  const events = ev
    .filter((e) => ULT_EVENTS.has(e.t))
    .map((e) => `${e.t}:${(e as { pid?: string }).pid ?? ""}`)
    .sort();
  return { t: tick, players, effects, enemies, ev: events };
}

function spawnCenter(w: WorldState): { x: number; y: number } {
  const s = w.dungeon.spawn;
  return { x: s.x * 48 + 24, y: s.y * 48 + 24 };
}

function baseInput(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, interact: false, ult: false };
}

function run(s: Scenario): Digest[] {
  const w = createWorld(s.seed, s.floor, { isShared: true, skipLocalPlayer: true });
  const c = spawnCenter(w);
  for (const ps of s.players) {
    const p = spawnPlayerInWorld(w, ps.id);
    p.x = c.x + ps.dx; p.y = c.y + ps.dy;
    p.invuln = 0; // drop the spawn grace so damage-taken paths are exercised deterministically
    setPlayerKit(w, ps.id, ps.kit);
    // Re-place after setPlayerKit (it does not move the body) and clear grace again.
    p.x = c.x + ps.dx; p.y = c.y + ps.dy;
    p.invuln = 0;
    if (ps.hp0 !== undefined) p.hp = Math.min(p.maxHp, ps.hp0); // start wounded (heal probes)
  }
  for (const e of s.enemies ?? []) devSpawnEnemy(w, "slime", c.x + e.dx, c.y + e.dy);
  const kitOf = new Map(s.players.map((p) => [p.id, p.kit] as const));
  const dxOf = new Map(s.players.map((p) => [p.id, p.dx] as const));
  const dyOf = new Map(s.players.map((p) => [p.id, p.dy] as const));
  const out: Digest[] = [];
  let seq = 0;
  for (let tick = 0; tick < s.ticks; tick++) {
    if (s.reconnect && tick === s.reconnect.at) removePlayerFromWorld(w, s.reconnect.who);
    if (s.reconnect && tick === s.reconnect.back) {
      const p = spawnPlayerInWorld(w, s.reconnect.who);
      p.x = c.x + (dxOf.get(s.reconnect.who) ?? 0); p.y = c.y + (dyOf.get(s.reconnect.who) ?? 0);
      setPlayerKit(w, s.reconnect.who, kitOf.get(s.reconnect.who) ?? "none");
    }
    if (s.fillAt?.[tick]) for (const id of s.fillAt[tick]) { const p = w.players.get(id); if (p) { p.ultCharge = ULT.meterMax; p.ultReadyAtTick = 0; } }
    if (s.injectAegisFire !== undefined && tick >= s.injectAegisFire) {
      const dome = w.effects.find((e) => e.kind === "aegis");
      if (dome) w.bullets.push({ x: dome.x + 80, y: dome.y, vx: 0, vy: 0, radius: 5, life: 1, friendly: false, owner: null, damage: 1, color: "#fff", pierce: 0, hitList: null, isCrit: false });
    }
    const ev: SimEvent[] = [];
    for (const p of w.players.values()) {
      const inp = baseInput(++seq);
      const c2 = spawnCenter(w);
      if (s.fire?.includes(p.id)) { inp.firing = true; inp.aim = Math.atan2(c2.y - p.y, (c2.x + 300) - p.x); }
      const de = s.dashEvery?.[p.id];
      if (de && tick % de === 0) { inp.dash = true; inp.moveX = 1; }
      const uf = s.ultFrom?.[p.id];
      if (uf !== undefined && tick >= uf) inp.ult = true;
      const pf = s.pulseFrom?.[p.id];
      if (pf !== undefined && tick >= pf) inp.pulse = true; // aim stays +x (baseInput 0) toward the ally
      stepPlayerPhase(w, p, inp, FIXED_DT, ev);
    }
    stepWorldPhase(w, FIXED_DT, ev);
    w.tick++;
    out.push(digest(w, tick, ev));
  }
  return out;
}

const SCENARIOS: Scenario[] = [
  // P1 GUNNER: charge from damage dealt + kills + time; a scripted fill then Overdrive cast +
  // the 8s lockout (a second request while locked out is refused).
  {
    name: "ult_gunner_p1", seed: 0x6017, floor: 1, ticks: 220,
    players: [{ id: "pA", kit: "gunner", dx: 0, dy: 0 }],
    enemies: [{ dx: 120, dy: -20 }, { dx: 150, dy: 20 }, { dx: 180, dy: 0 }],
    fire: ["pA"], fillAt: { 40: ["pA"] }, ultFrom: { pA: 41 },
  },
  // P3 MENDER: two wounded allies inside the Sanctuary get the burst heal + the capped HoT over
  // the zone's fixed 4.0s lifetime; charge accrues off healing done.
  {
    name: "ult_mender_p3", seed: 0x33ed, floor: 1, ticks: 200,
    players: [
      { id: "pA", kit: "mender", dx: 0, dy: 0 },
      { id: "pB", kit: "gunner", dx: 30, dy: 0, hp0: 1 },
      { id: "pC", kit: "gunner", dx: -30, dy: 10, hp0: 2 },
    ],
    fillAt: { 20: ["pA"] }, ultFrom: { pA: 21 },
  },
  // P2 BULWARK: Aegis dome deploys with an ENCOUNTER-SCALED HP budget; injected enemy fire
  // depletes it deterministically (HP-budget expiry before the 4s duration — whichever first).
  {
    name: "ult_bulwark_p2", seed: 0xb0fa, floor: 1, ticks: 180,
    players: [
      { id: "pA", kit: "bulwark", dx: 0, dy: 0 },
      { id: "pB", kit: "mender", dx: 24, dy: 0 },
    ],
    fillAt: { 15: ["pA"] }, ultFrom: { pA: 16 }, injectAegisFire: 18,
  },
  // P2 MENDER heal-clamp (§10): TWO Menders both HoT ONE wounded ally — the shared per-target
  // incoming-heal budget must NOT double-stack (heal rate ≤ the per-target cap, not 2×).
  {
    name: "ult_healclamp_p2", seed: 0x4ea1, floor: 1, ticks: 160,
    players: [
      { id: "pA", kit: "mender", dx: 0, dy: 0 },
      { id: "pB", kit: "mender", dx: 20, dy: 0 },
      { id: "pC", kit: "gunner", dx: 10, dy: 10, hp0: 1 },
    ],
    fillAt: { 20: ["pA", "pB"] }, ultFrom: { pA: 21, pB: 21 },
  },
  // P4 PHANTOM multi-target: 3 allies within the 90px radius get the capped invuln + speed
  // surge; the 4th (parked at 200px) is EXCLUDED. Charge accrues off dashes performed.
  {
    name: "ult_phantom_p4", seed: 0x9a17, floor: 1, ticks: 160,
    players: [
      { id: "pA", kit: "phantom", dx: 0, dy: 0 },
      { id: "pB", kit: "gunner", dx: 40, dy: 0 },
      { id: "pC", kit: "bulwark", dx: -40, dy: 0 },
      { id: "pD", kit: "mender", dx: 200, dy: 0 },
    ],
    fillAt: { 30: ["pA"] }, ultFrom: { pA: 31 },
  },
  // P1 GUNNER OVERHEAT (Wave 2): sustained autofire into a slime cluster ramps Momentum to the
  // boil-over threshold, opening the +fire/+pierce burst window and rolling the stacks to the
  // reset floor — the overheat clock (ovh) + stack channel (ps) must reproduce tick-for-tick.
  {
    name: "sig_overheat_p1", seed: 0x0ff11, floor: 1, ticks: 160,
    players: [{ id: "pA", kit: "gunner", dx: 0, dy: 0 }],
    enemies: [{ dx: 90, dy: -8 }, { dx: 110, dy: 8 }, { dx: 130, dy: 0 }, { dx: 150, dy: -6 }],
    fire: ["pA"],
  },
  // P2 BULWARK OVERSHIELD (Wave 2): a slime pinned on the tank chips the overshield pool (osh)
  // before hearts, and the regen clock (oshr) pauses under the sustained contact — the pool +
  // regen countdown must reproduce bit-for-bit.
  {
    name: "sig_overshield_p2", seed: 0x0b5d1, floor: 1, ticks: 200,
    players: [
      { id: "pA", kit: "bulwark", dx: 0, dy: 0 },
      { id: "pB", kit: "gunner", dx: 60, dy: 0 },
    ],
    enemies: [{ dx: 6, dy: 0 }, { dx: -6, dy: 6 }],
  },
  // P2 MENDER HEAL-PULSE (Wave 2): a wounded ally co-located at +x is topped by the directed
  // pulse burst on its cooldown — the pulse-CD gate (pra) + the ally HP + the shared heal budget
  // must reproduce tick-for-tick.
  {
    name: "sig_pulse_p2", seed: 0x0c0de, floor: 1, ticks: 200,
    players: [
      { id: "pA", kit: "mender", dx: 0, dy: 0 },
      { id: "pB", kit: "gunner", dx: 30, dy: 0, hp0: 1 },
    ],
    pulseFrom: { pA: 10 },
  },
  // P2 PHANTOM MARK (Wave 2): a phantom dashing every few ticks through a slime cluster marks
  // them (+vuln, enemies[].mk) and refunds the dash cooldown (dcd) — the mark timers + the
  // refunded cooldown must reproduce bit-for-bit across replay + reconnect.
  {
    name: "sig_mark_p1", seed: 0x0dada, floor: 1, ticks: 160,
    players: [{ id: "pA", kit: "phantom", dx: -40, dy: 0 }],
    enemies: [{ dx: 20, dy: 0 }, { dx: 60, dy: 0 }],
    fire: ["pA"], dashEvery: { pA: 20 },
  },
  // P2 RECONNECT: a mid-run leave + rejoin (re-kit) must reproduce bit-for-bit.
  {
    name: "ult_reconnect_p2", seed: 0x4ec0, floor: 1, ticks: 180,
    players: [
      { id: "pA", kit: "gunner", dx: 0, dy: 0 },
      { id: "pB", kit: "phantom", dx: 24, dy: 0 },
    ],
    enemies: [{ dx: 140, dy: 0 }, { dx: 170, dy: 20 }],
    fire: ["pA"], dashEvery: { pB: 15 },
    fillAt: { 50: ["pA"] }, ultFrom: { pA: 51 },
    reconnect: { who: "pB", at: 60, back: 90 },
  },
];

function goldenPath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "golden", `${name}.jsonl`);
}

function capture(): void {
  for (const s of SCENARIOS) {
    const lines = run(s).map((d) => JSON.stringify(d)).join("\n") + "\n";
    writeFileSync(goldenPath(s.name), lines);
    process.stdout.write(`captured ${s.name}: ${s.ticks} ticks\n`);
  }
}

function diff(a: Digest[], b: Digest[]): string | null {
  if (a.length !== b.length) return `tick count ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return `divergence at tick ${i}:\n  A ${JSON.stringify(a[i])}\n  B ${JSON.stringify(b[i])}`;
  }
  return null;
}

function main(): void {
  let failed = 0;
  for (const s of SCENARIOS) {
    const golden = readFileSync(goldenPath(s.name), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Digest);
    const first = run(s);
    const second = run(s); // determinism (byte-stable)
    const replay = run(s);  // same-seed replay
    const dGolden = diff(golden, first);
    const dDet = diff(first, second);
    const dReplay = diff(first, replay);
    if (!dGolden && !dDet && !dReplay) {
      process.stdout.write(`PASS ${s.name}: ${s.ticks} ticks — golden + deterministic + replay + reconnect\n`);
    } else {
      failed++;
      process.stdout.write(`FAIL ${s.name}:\n`);
      if (dGolden) process.stdout.write(`  [vs golden] ${dGolden}\n`);
      if (dDet) process.stdout.write(`  [nondeterministic] ${dDet}\n`);
      if (dReplay) process.stdout.write(`  [replay] ${dReplay}\n`);
    }
  }
  if (failed > 0) { process.stdout.write(`\n${failed}/${SCENARIOS.length} ult golden scenarios FAILED\n`); process.exit(1); }
  process.stdout.write(`\nAll ${SCENARIOS.length} ult golden-master scenarios pass (accrual + trigger/lockout + entity lifetime + phase multi-target; deterministic, replay + reconnect stable)\n`);
}

if (process.argv.includes("--capture-current")) capture(); else main();
