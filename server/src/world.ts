// A single authoritative world: the shared WorldState plus the connections playing in it and
// their bounded input queues. The server holds a Map<worldId, GameWorld> from day one
// (production spec §5) — Stage B runs ONE world, but nothing assumes it.
//
// The Stage-B proof world is a fixed walled arena (seed-independent, isSandbox) seeded with a
// few server-owned enemies. Enemies chase whatever players are connected. All dynamic state
// (players/enemies/bullets) rides the snapshot; the static arena the client rebuilds locally.

import { createWorld, stepPlayerPhase, stepWorldPhase, spawnPlayerInWorld, removePlayerFromWorld, devSpawnEnemy } from "../../src/sim/world.js";
import type { WorldState } from "../../src/sim/world.js";
import type { SimEvent } from "../../src/sim/events.js";
import type { InputCmd, PlayerId } from "../../src/sim/input.js";
import { TILE } from "../../src/sim/types.js";
import { FIXED_DT, STAGE_B_SEED, STAGE_B_FLOOR } from "../../src/net/protocol.js";
import type { Conn, InputIntent } from "./connection.js";
import type { ServerConfig } from "./config.js";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
    // Arena world: fixed walls, no props/pickups/chests clutter, no implicit local player.
    this.state = createWorld(STAGE_B_SEED, STAGE_B_FLOOR, { isSandbox: true, skipLocalPlayer: true });
    this.seedEnemies();
  }

  // A deterministic handful of enemies placed around the arena center. They read the players
  // map as aggro targets, so they only chase once someone joins.
  private seedEnemies(): void {
    const s = this.state.dungeon.spawn;
    const cx = s.x * TILE + TILE / 2;
    const cy = s.y * TILE + TILE / 2;
    const layout: Array<{ kind: Parameters<typeof devSpawnEnemy>[1]; dx: number; dy: number }> = [
      { kind: "slime", dx: -220, dy: -160 },
      { kind: "slime", dx: 240, dy: -140 },
      { kind: "bat", dx: -60, dy: -260 },
      { kind: "skeleton", dx: 200, dy: 180 },
    ];
    for (const l of layout) devSpawnEnemy(this.state, l.kind, cx + l.dx, cy + l.dy);
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
