// A single authoritative world: the shared WorldState plus the connections playing in it and
// their bounded input queues. The server holds a Map<worldId, GameWorld> from day one
// (production spec §5) — Stage B runs ONE world, but nothing assumes it.
//
// The Stage-B proof world is a fixed walled arena (seed-independent, isSandbox) seeded with a
// few server-owned enemies. Enemies chase whatever players are connected. All dynamic state
// (players/enemies/bullets) rides the snapshot; the static arena the client rebuilds locally.

import { createWorld, stepPlayerPhase, stepWorldPhase, spawnPlayerInWorld, removePlayerFromWorld, switchWeaponInWorld, applyItemToWorld } from "../../src/sim/world.js";
import type { WorldState } from "../../src/sim/world.js";
import type { SimEvent } from "../../src/sim/events.js";
import type { InputCmd, PlayerId } from "../../src/sim/input.js";
import type { WeaponId } from "../../src/sim/types.js";
import { Rng } from "../../src/sim/rng.js";
import { rollItemChoicesWith, itemById } from "../../src/sim/items.js";
import { LAGCOMP_MAX_TICKS } from "../../src/sim/constants.js";
import { FIXED_DT, TICK_HZ, STAGE_B_SEED, INTERP_BASE_DELAY_MS } from "../../src/net/protocol.js";
import type { Conn, InputIntent } from "./connection.js";
import type { ServerConfig } from "./config.js";

// The number of blessing choices offered per prompt.
const BLESSING_CHOICES = 3;

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
  // Events produced OUTSIDE the tick (e.g. an async blessing apply on a pickBlessing message),
  // merged into the next tick's event stream so they broadcast to clients exactly once.
  private injectedEvents: SimEvent[] = [];
  // Dedicated RNG for server-decided blessing offers, kept OUT of the sim's own RNG stream so
  // offering choices never perturbs deterministic loot/spawn rolls. Seeded from the world seed.
  private offerRng: Rng;

  constructor(id: string, seed: number = STAGE_B_SEED) {
    this.id = id;
    // A REAL authoritative dungeon floor run (not a sandbox arena): the server owns floor
    // seed/index/dungeon/enemies/props/chests/pickups and the descend transition. Clients rebuild
    // the identical dungeon geometry from the snapshot's seed+floor for movement prediction.
    // isShared: a downed player doesn't end the world (down/revive), and descend happens in-sim
    // (party-wide) — the server, never a client, decides the transition.
    this.state = createWorld(seed, 1, { isShared: true, skipLocalPlayer: true });
    this.offerRng = new Rng(seed ^ 0x0ffe4);
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

  // Authoritative weapon switch: equips only an owned slot (a tampered client can't equip a
  // weapon it never acquired). Returns whether it was accepted.
  trySwitchWeapon(pid: PlayerId, weapon: WeaponId): boolean {
    return switchWeaponInWorld(this.state, pid, weapon);
  }

  // Roll a server-decided blessing choice set (deterministic via the dedicated offer RNG). The
  // ids are sent to the offered client; a pick is later validated against exactly this set.
  rollBlessingChoices(): string[] {
    return rollItemChoicesWith(BLESSING_CHOICES, () => this.offerRng.next()).map((it) => it.id);
  }

  // Authoritative blessing apply: the item must be one the server offered this player (validated
  // by the caller against the pending offer) AND a real item id. Applies mods server-side and
  // returns the emitted events (itemPicked) for broadcast, or null if the id is invalid.
  applyBlessing(pid: PlayerId, itemId: string): SimEvent[] | null {
    const def = itemById(itemId);
    if (!def) return null;
    const evs = applyItemToWorld(this.state, pid, def);
    for (const e of evs) this.injectedEvents.push(e);
    return evs;
  }

  // Advance one authoritative tick: drain each connected player's queued inputs (seq order,
  // clamped dt, bounded total movement per tick), step the shared world once at FIXED_DT.
  step(cfg: ServerConfig): void {
    const ev: SimEvent[] = [];
    // Fold in any out-of-tick events (async blessing applies) so they broadcast exactly once.
    if (this.injectedEvents.length > 0) { for (const e of this.injectedEvents) ev.push(e); this.injectedEvents.length = 0; }

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
