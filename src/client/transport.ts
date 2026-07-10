// The seam between the client and the simulation. The client never calls stepWorld
// directly — it goes through a Transport, so solo (in-process sim) and multiplayer (WS to
// an authoritative server, Stage B) share ONE client code path.
//
// Stage A ships ONLY LocalTransport: it runs stepWorld in-process every tick with zero
// serialization, sockets, latency, or reconciliation — the local sim IS the authority, so
// solo is byte-for-byte the current game.

import type { WorldState, WorldOptions } from "../sim/world.js";
import { createWorld, stepWorld, switchWeaponInWorld, reorderWeaponsInWorld, dropWeaponInWorld, swapWeaponInWorld, buyFromShopInWorld } from "../sim/world.js";
import type { SimEvent } from "../sim/events.js";
import type { InputCmd, PlayerId } from "../sim/input.js";
import { LOCAL_ID, IDLE_INPUT } from "../sim/input.js";
import type { WeaponId } from "../sim/types.js";

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
  // Semantic inventory commands — the ONE path for solo and online. LocalTransport applies
  // them through the same validated sim mutators the server uses; WSTransport sends the
  // authoritative command and lets the snapshot confirm. All are inputs/intents, never
  // outcomes: an invalid command is rejected wherever the authority lives.
  requestEquip(weapon: WeaponId): void;
  requestReorder(from: number, to: number): void;
  requestDrop(weapon: WeaponId): void;
  // Full-hotbar swap: trade the owned weapon `drop` for the weapon pickup `pickup` (the
  // sim's stable pickup id). Only the swap prompt calls this; declining sends nothing.
  requestSwap(pickup: number, drop: WeaponId): void;
  // Shop purchase (Patch's room): the panel's BUY button, and nothing else, calls this.
  requestShopBuy(slot: number): void;
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

  requestEquip(weapon: WeaponId): void {
    switchWeaponInWorld(this.state, LOCAL_ID, weapon);
  }

  requestReorder(from: number, to: number): void {
    reorderWeaponsInWorld(this.state, LOCAL_ID, from, to);
  }

  requestDrop(weapon: WeaponId): void {
    // The drop's weaponDrop event joins the normal event stream so solo plays the same
    // pop/label FX the online reliable channel delivers.
    dropWeaponInWorld(this.state, LOCAL_ID, weapon, this.events);
  }

  requestSwap(pickup: number, drop: WeaponId): void {
    // Same validated sim mutator the server routes the swap command through — solo and
    // online share ONE authority path, and an invalid swap mutates nothing here too.
    swapWeaponInWorld(this.state, LOCAL_ID, pickup, drop, this.events);
  }

  requestShopBuy(slot: number): void {
    // Same validated sim mutator the server routes shopBuy through — solo and online
    // purchases share ONE authority path, and an invalid buy mutates nothing here too.
    buyFromShopInWorld(this.state, LOCAL_ID, slot, this.events);
  }

  // Solo lets the client reach the live world for rendering-adjacent reads, co-op target
  // feeding, blessing application, and dev tools. (A WSTransport would expose only the
  // last snapshot.)
  world(): WorldState {
    return this.state;
  }
}
