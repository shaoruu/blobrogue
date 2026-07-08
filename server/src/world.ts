// A single authoritative world: the shared WorldState plus the connections playing in it and
// their bounded input queues. The server holds a Map<worldId, GameWorld> from day one
// (production spec §5) — Stage B runs ONE world, but nothing assumes it.
//
// The Stage-B proof world is a fixed walled arena (seed-independent, isSandbox) seeded with a
// few server-owned enemies. Enemies chase whatever players are connected. All dynamic state
// (players/enemies/bullets) rides the snapshot; the static arena the client rebuilds locally.

import { createWorld, stepPlayerPhase, stepWorldPhase, spawnPlayerInWorld, removePlayerFromWorld, devSpawnEnemy, devSpawnProp, devSpawnChest } from "../../src/sim/world.js";
import type { WorldState } from "../../src/sim/world.js";
import type { SimEvent } from "../../src/sim/events.js";
import type { InputCmd, PlayerId } from "../../src/sim/input.js";
import { TILE } from "../../src/sim/types.js";
import { LAGCOMP_MAX_TICKS } from "../../src/sim/constants.js";
import { FIXED_DT, TICK_HZ, STAGE_B_SEED, STAGE_B_FLOOR, INTERP_BASE_DELAY_MS } from "../../src/net/protocol.js";
import type { Conn, InputIntent } from "./connection.js";
import type { ServerConfig } from "./config.js";

const TICK_MS = 1000 / TICK_HZ;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Ticks to rewind a shooter's hit test: the enemy the client rendered lagged behind the live
// server by half the round-trip (input travel) plus the client's interpolation delay. Computed
// from the SERVER's measured RTT (never client-claimed) and clamped, so it is anti-cheat-safe.
function rewindTicksFor(conn: Conn): number {
  const viewLagMs = conn.rttMs * 0.5 + INTERP_BASE_DELAY_MS;
  return clamp(Math.round(viewLagMs / TICK_MS), 0, LAGCOMP_MAX_TICKS);
}

function intentToInput(i: InputIntent): InputCmd {
  return { seq: i.seq, moveX: i.mx, moveY: i.my, aim: i.aim, firing: i.fire, dash: i.dash };
}

export class GameWorld {
  readonly id: string;
  readonly state: WorldState;
  readonly conns = new Map<number, Conn>();
  lastEvents: SimEvent[] = [];

  constructor(id: string) {
    this.id = id;
    // Stage C combat arena: fixed walls (no descend), no implicit local player. Seeded with a
    // boss, a spread of enemy archetypes, an explosive-barrel chain + breakables, and a chest,
    // so every server-owned combat subsystem (AI, projectiles, collision, status, explosions,
    // loot) is exercised and identical for all clients.
    this.state = createWorld(STAGE_B_SEED, STAGE_B_FLOOR, { isSandbox: true, skipLocalPlayer: true });
    this.seedStageC();
  }

  // A deterministic combat layout around the arena center. Enemies read the players map as
  // aggro targets, so they only chase once someone joins. Kept lean enough to stay well within
  // the per-tick + snapshot-size budgets.
  private seedStageC(): void {
    const s = this.state.dungeon.spawn;
    const cx = s.x * TILE + TILE / 2;
    const cy = s.y * TILE + TILE / 2;
    const enemies: Array<{ kind: Parameters<typeof devSpawnEnemy>[1]; dx: number; dy: number }> = [
      { kind: "boss", dx: 0, dy: -300 },
      { kind: "slime", dx: -260, dy: -120 },
      { kind: "slime", dx: 280, dy: -120 },
      { kind: "bat", dx: -120, dy: -320 },
      { kind: "skeleton", dx: 260, dy: 180 },
      { kind: "spitter", dx: -320, dy: 140 },
    ];
    for (const l of enemies) devSpawnEnemy(this.state, l.kind, cx + l.dx, cy + l.dy);

    // Two adjacent explosive barrels (chain reaction) plus a crate + pot to break.
    devSpawnProp(this.state, "barrel_explosive", cx - 90, cy + 210);
    devSpawnProp(this.state, "barrel_explosive", cx - 50, cy + 210);
    devSpawnProp(this.state, "crate", cx + 90, cy + 210);
    devSpawnProp(this.state, "pot", cx + 140, cy + 210);

    // A wood chest players can open (touch / shoot / melee) — shared loot.
    devSpawnChest(this.state, cx - 220, cy + 260);
  }

  get playerCount(): number {
    return this.state.players.size;
  }

  addPlayer(pid: PlayerId): void {
    spawnPlayerInWorld(this.state, pid);
  }

  removePlayer(pid: PlayerId): void {
    removePlayerFromWorld(this.state, pid);
  }

  // Advance one authoritative tick: drain each connected player's queued inputs (seq order,
  // clamped dt, bounded total movement per tick), step the shared world once at FIXED_DT.
  step(cfg: ServerConfig): void {
    const ev: SimEvent[] = [];

    for (const conn of this.conns.values()) {
      const pid = conn.playerId;
      if (pid === null) continue;
      const p = this.state.players.get(pid);
      if (!p) continue;

      // Refresh this player's lag-comp rewind from its measured RTT before the world resolves
      // hits this tick (so shots register against the enemy positions the client actually saw).
      p.rewindTicks = rewindTicksFor(conn);

      // Sort by seq and drop replays/dupes (<= lastAppliedSeq) — anti-cheat + ordering safety.
      const inputs = conn.queue.length > 1 ? conn.queue.slice().sort((a, b) => a.seq - b.seq) : conn.queue;
      const fresh = inputs.filter((i) => i.seq > conn.lastAppliedSeq);
      conn.queue.length = 0;

      if (fresh.length === 0) {
        // Continue-last-intent for a bounded number of starved ticks (packet loss/lag), then
        // idle so a hitching player doesn't freeze mid-motion but also can't drift forever.
        if (conn.lastInput && conn.starveTicks < cfg.maxStarveTicks) {
          const held: InputIntent = { ...conn.lastInput, dash: false }; // don't re-trigger dash on a repeat
          stepPlayerPhase(this.state, p, intentToInput(held), FIXED_DT, ev);
          conn.starveTicks++;
        }
        continue;
      }

      conn.starveTicks = 0;
      let budget = cfg.maxTickDtPerPlayer;
      for (const inp of fresh) {
        const dt = clamp(inp.dt, 0, cfg.maxInputDt);
        const use = Math.min(dt, budget);
        stepPlayerPhase(this.state, p, intentToInput(inp), use, ev);
        budget = Math.max(0, budget - use);
        conn.lastAppliedSeq = inp.seq;
        conn.lastInput = inp;
      }
    }

    stepWorldPhase(this.state, FIXED_DT, ev);
    this.state.tick++;
    this.lastEvents = ev;
  }
}
