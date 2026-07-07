// The seam between the client and the simulation. The client never calls stepWorld
// directly — it goes through a Transport, so solo (in-process sim) and multiplayer (WS to
// an authoritative server, Stage B) share ONE client code path.
//
// Stage A ships ONLY LocalTransport: it runs stepWorld in-process every tick with zero
// serialization, sockets, latency, or reconciliation — the local sim IS the authority, so
// solo is byte-for-byte the current game.

import type { WorldState, WorldOptions } from "../sim/world.js";
import { createWorld, stepWorld } from "../sim/world.js";
import type { SimEvent } from "../sim/events.js";
import type { InputCmd, PlayerId } from "../sim/input.js";
import { LOCAL_ID, IDLE_INPUT } from "../sim/input.js";

export interface PollResult {
  state: WorldState;
  events: SimEvent[];
  ackSeq: number;
}

export interface Transport {
  start(seed: number, floor: number, opts?: WorldOptions): void;
  sendInput(cmd: InputCmd): void;
  // Advance one frame with the real dt (solo). A WSTransport would instead ingest the
  // latest server snapshot here.
  advance(dt: number): void;
  poll(): PollResult;
  stop(): void;
}

export class LocalTransport implements Transport {
  private state!: WorldState;
  private pending: InputCmd | null = null;
  private events: SimEvent[] = [];

  start(seed: number, floor: number, opts?: WorldOptions): void {
    this.state = createWorld(seed, floor, opts);
    this.pending = null;
    this.events = [];
  }

  sendInput(cmd: InputCmd): void {
    this.pending = cmd;
  }

  advance(dt: number): void {
    const inputs = new Map<PlayerId, InputCmd>([[LOCAL_ID, this.pending ?? IDLE_INPUT]]);
    const out = stepWorld(this.state, inputs, dt);
    for (const e of out) this.events.push(e);
  }

  poll(): PollResult {
    const events = this.events;
    this.events = [];
    return { state: this.state, events, ackSeq: this.pending?.seq ?? 0 };
  }

  stop(): void {}

  // Solo lets the client reach the live world for rendering-adjacent reads, co-op target
  // feeding, blessing application, and dev tools. (A WSTransport would expose only the
  // last snapshot.)
  world(): WorldState {
    return this.state;
  }
}
