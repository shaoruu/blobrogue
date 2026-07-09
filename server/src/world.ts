// A single authoritative room/world: the shared WorldState, the connections playing in it, their
// bounded input queues, and a bounded reliable-event ring. Implements the RoomRuntime port so the
// socket server + publisher depend on the interface, not this concrete class (a Colyseus Room
// could implement it instead; see docs/adr/0001).
//
// This is a REAL authoritative dungeon floor run (isShared): the server owns floor seed/index/
// dungeon/enemies/props/chests/pickups, the party-wide descend transition, and full combat. The
// server tick alone controls simulation time — inputs are intent samples, applied ONE per tick at
// the fixed step, so a client can neither buy extra time (no client dt) nor gain advantage by its
// frame rate (fixed-cadence consumption).

import { createWorld, stepPlayerPhase, stepWorldPhase, spawnPlayerInWorld, removePlayerFromWorld, setPlayerAbsence, switchWeaponInWorld, reorderWeaponsInWorld, dropWeaponInWorld, chooseBlessingInWorld, dismissBlessingOfferInWorld, resetRunInWorld, devSpawnEnemy } from "../../src/sim/world.js";
import type { WorldState } from "../../src/sim/world.js";
import type { SimEvent } from "../../src/sim/events.js";
import type { InputCmd, PlayerId } from "../../src/sim/input.js";
import { TILE, type WeaponId } from "../../src/sim/types.js";
import { Rng, randomSeed } from "../../src/sim/rng.js";
import { rollItemChoicesWith, itemById } from "../../src/sim/items.js";
import { LAGCOMP_MAX_TICKS } from "../../src/sim/constants.js";
import { FIXED_DT, TICK_HZ, INTERP_BASE_DELAY_MS, type WireEvent } from "../../src/net/protocol.js";
import { resumeTokensEqual } from "./auth.js";
import type { Conn, InputIntent } from "./connection.js";
import type { ServerConfig } from "./config.js";
import type { RoomRuntime, BlessingOfferRequest, Seat, TakeSeatResult } from "./ports.js";

const BLESSING_CHOICES = 3;
const TICK_MS = 1000 / TICK_HZ;
// Bounded reliable-event ring. ~512 events covers many seconds of combat; a client further behind
// than this has effectively desynced and will be caught up by the next full state it reads.
const EVENT_RING = 512;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Ticks to rewind a shooter's hit test, from the SERVER's measured RTT (never client-claimed) +
// the client's REPORTED adaptive interp delay (clamped by the router to the same [90,300]ms
// window the client's interpolation actually uses; base default until reported), clamped to the
// sim history window — anti-cheat-safe. Stamped onto bullets/swings at FIRE time (fire-time lag
// comp), so it decays as a projectile travels.
function rewindTicksFor(conn: Conn): number {
  const interpMs = conn.cliInterpDelayMs > 0 ? conn.cliInterpDelayMs : INTERP_BASE_DELAY_MS;
  const viewLagMs = conn.rttMs * 0.5 + interpMs;
  return clamp(Math.round(viewLagMs / TICK_MS), 0, LAGCOMP_MAX_TICKS);
}

function intentToInput(i: InputIntent): InputCmd {
  return { seq: i.seq, moveX: i.mx, moveY: i.my, aim: i.aim, firing: i.fire, dash: i.dash };
}

export class GameWorld implements RoomRuntime {
  readonly id: string;
  readonly state: WorldState;
  readonly conns = new Map<number, Conn>();

  // Reserved reconnect seats, keyed by the VERIFIED ticket identity (one seat per identity —
  // the same key the duplicate-connection takeover uses). The body itself stays in
  // state.players (absent/paused); the seat holds the single-use token + conn continuity.
  private seatMap = new Map<string, Seat>();

  // Reliable-event ring: every emitted event gets a monotonic id; the publisher sends per client
  // only the ids newer than that client's ack (dedupe + resend under loss).
  private eventLog: WireEvent[] = [];
  private nextEventId = 1;
  // Events produced OUTSIDE the tick (async blessing apply) merged into the next tick's stream.
  private injectedEvents: SimEvent[] = [];
  // Players whose run ended this tick (full wipe) — the server drives a deterministic leave.
  private gameOverThisTick: PlayerId[] = [];
  // Blessing offers raised this tick (descend/boss chest) — the server turns each into a
  // server-decided, validated offer message.
  private offerThisTick: BlessingOfferRequest[] = [];
  // Offers whose TTL expired this tick (already resolved on BOTH sides here) — surfaced for
  // the server's logging/metrics.
  private expiredOffersThisTick: PlayerId[] = [];
  // Dedicated RNG for blessing offers, kept OUT of the sim RNG stream (deterministic, no perturb).
  private offerRng: Rng;

  constructor(id: string, seed: number = randomSeed(), arena = false) {
    this.id = id;
    // Production: a REAL generated dungeon (isShared) with a FRESH random run seed — the server
    // alone owns the seed; clients rebuild geometry from the snapshot's authoritative seed/floor.
    // Measurement (arena=true): an OPEN sandbox arena so the load harness can move a probe in a
    // straight monotonic line — same stepWorld, tick, and netcode, only different geometry.
    // Arena seeds a few enemies for bandwidth realism.
    this.state = createWorld(seed, 1, { isShared: true, skipLocalPlayer: true, isSandbox: arena });
    this.offerRng = new Rng(seed ^ 0x0ffe4);
    if (arena) this.seedArenaEnemies();
  }

  // Reset to a FRESH run (new seed/floor 1/cleared terminal state). Called by the session store
  // when the room empties — the next party starts a new dungeon, not a half-played one. The
  // world revision increments (stale-snapshot guard) and tick stays monotonic.
  resetRun(): void {
    const seed = randomSeed();
    resetRunInWorld(this.state, seed);
    this.offerRng = new Rng(seed ^ 0x0ffe4);
    this.injectedEvents.length = 0;
    this.gameOverThisTick = [];
    this.offerThisTick = [];
    this.seatMap.clear();
  }

  private seedArenaEnemies(): void {
    const s = this.state.dungeon.spawn;
    const cx = s.x * TILE + TILE / 2, cy = s.y * TILE + TILE / 2;
    const layout: Array<[Parameters<typeof devSpawnEnemy>[1], number, number]> = [
      ["slime", 220, -160], ["slime", 260, -120], ["bat", 120, -260], ["skeleton", 300, 160],
    ];
    for (const [kind, dx, dy] of layout) devSpawnEnemy(this.state, kind, cx + dx, cy + dy);
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

  setPlayerAbsent(pid: PlayerId, isAbsent: boolean): void {
    setPlayerAbsence(this.state, pid, isAbsent);
  }

  // ---- reconnect seats ----

  reserveSeat(conn: Conn, nowMs: number, ttlMs: number): void {
    if (conn.playerId === null || conn.authName === null || conn.resumeToken === null) return;
    if (!this.state.players.has(conn.playerId)) return;
    setPlayerAbsence(this.state, conn.playerId, true);
    this.seatMap.set(conn.authName, {
      pid: conn.playerId,
      authName: conn.authName,
      token: conn.resumeToken,
      reservedAt: nowMs,
      expiresAt: nowMs + ttlMs,
      displayName: conn.displayName,
      colorIndex: conn.colorIndex,
      lastAppliedSeq: conn.lastAppliedSeq,
      lastCseq: conn.lastCseq,
      pendingOffer: conn.pendingOffer,
      offerId: conn.offerId,
      offerDeadline: conn.offerDeadline,
    });
  }

  takeSeat(authName: string, token: string, nowMs: number): TakeSeatResult {
    const seat = this.seatMap.get(authName);
    if (!seat) return { ok: false, reason: "none" };
    if (nowMs >= seat.expiresAt) {
      // Overdue but not yet swept: apply the authoritative leave right here rather than
      // letting a straggler resurrect a seat the lifecycle already gave up on.
      this.dropSeat(seat);
      return { ok: false, reason: "expired" };
    }
    if (!resumeTokensEqual(seat.token, token)) return { ok: false, reason: "token_mismatch" };
    this.seatMap.delete(authName);
    setPlayerAbsence(this.state, seat.pid, false);
    return { ok: true, seat };
  }

  discardSeat(authName: string): boolean {
    const seat = this.seatMap.get(authName);
    if (!seat) return false;
    this.dropSeat(seat);
    return true;
  }

  expireSeats(nowMs: number): Seat[] {
    const expired: Seat[] = [];
    for (const seat of this.seatMap.values()) {
      if (nowMs >= seat.expiresAt) expired.push(seat);
    }
    for (const seat of expired) this.dropSeat(seat);
    return expired;
  }

  seats(): IterableIterator<Seat> {
    return this.seatMap.values();
  }

  private dropSeat(seat: Seat): void {
    this.seatMap.delete(seat.authName);
    removePlayerFromWorld(this.state, seat.pid);
  }

  trySwitchWeapon(pid: PlayerId, weapon: WeaponId): boolean {
    return switchWeaponInWorld(this.state, pid, weapon);
  }

  tryReorderWeapons(pid: PlayerId, from: number, to: number): boolean {
    return reorderWeaponsInWorld(this.state, pid, from, to);
  }

  tryDropWeapon(pid: PlayerId, weapon: WeaponId): boolean {
    // The drop runs outside the tick (message handler), so its event merges into the next
    // tick's reliable stream — same path async blessing applies already use.
    const ev: SimEvent[] = [];
    const ok = dropWeaponInWorld(this.state, pid, weapon, ev);
    for (const e of ev) this.injectedEvents.push(e);
    return ok;
  }

  rollBlessingChoices(pid: PlayerId, rare: boolean): string[] {
    const owned = this.state.players.get(pid)?.ownedItemIds ?? [];
    return rollItemChoicesWith(BLESSING_CHOICES, () => this.offerRng.next(), owned, { rareOnly: rare }).map((it) => it.id);
  }

  applyBlessing(pid: PlayerId, itemId: string): boolean {
    // The sim's pending entry is THE offer's liveness: once it expired (or was never
    // raised), a late choice is REJECTED outright — the gate already released, the pause
    // already lifted, and applying now would grant a blessing the run moved past.
    if (!this.state.pendingBlessings.has(pid)) return false;
    const def = itemById(itemId);
    if (!def) return false;
    // Resolves the sim's pending offer too: the pick ends the player's pause/damage shield
    // and releases the party's descend gate.
    const evs = chooseBlessingInWorld(this.state, pid, def);
    for (const e of evs) this.injectedEvents.push(e);
    return true;
  }

  dismissBlessing(pid: PlayerId): void {
    dismissBlessingOfferInWorld(this.state, pid);
  }

  // Queue a validated input INTENT. Bounded (drop oldest beyond the cap) so a fast/flooding client
  // can neither exhaust memory nor gain an advantage — the tick still consumes only one per tick.
  queueInput(conn: Conn, cmd: InputIntent, maxQueue: number): void {
    conn.queue.push(cmd);
    while (conn.queue.length > maxQueue) conn.queue.shift(); // drop oldest (backpressure)
  }

  // Reliable-event channel: the id-tagged events newer than a client's ack (from the bounded ring).
  eventsSince(ackedId: number): WireEvent[] {
    if (this.eventLog.length === 0) return [];
    if (ackedId <= 0) return this.eventLog.slice();
    const out: WireEvent[] = [];
    for (const w of this.eventLog) if (w.id > ackedId) out.push(w);
    return out;
  }
  latestEventId(): number {
    return this.nextEventId - 1;
  }

  gameOverPlayers(): PlayerId[] {
    return this.gameOverThisTick;
  }
  offerPlayers(): BlessingOfferRequest[] {
    return this.offerThisTick;
  }
  expiredOfferPlayers(): PlayerId[] {
    return this.expiredOffersThisTick;
  }

  // Advance ONE authoritative tick. The server tick owns simulation time: each connected player
  // consumes at most ONE queued input command, applied at the FIXED step. If none arrived,
  // continue-last-intent for a bounded number of ticks (packet loss), then idle. This makes the
  // simulation rate independent of client frame rate and immune to client-authored dt.
  step(cfg: ServerConfig): void {
    const ev: SimEvent[] = [];
    if (this.injectedEvents.length > 0) { for (const e of this.injectedEvents) ev.push(e); this.injectedEvents.length = 0; }

    for (const conn of this.conns.values()) {
      const pid = conn.playerId;
      if (pid === null) continue;
      const p = this.state.players.get(pid);
      if (!p) continue;

      p.rewindTicks = rewindTicksFor(conn);

      // Consume exactly ONE fresh command (oldest with seq > lastAppliedSeq). Sorting guards
      // against reordering; the queue is bounded so a flood can't advance more than 1/tick.
      if (conn.queue.length > 1) conn.queue.sort((a, b) => a.seq - b.seq);
      let cmd: InputIntent | null = null;
      let consumedIdx = -1;
      for (let i = 0; i < conn.queue.length; i++) {
        if (conn.queue[i].seq > conn.lastAppliedSeq) { cmd = conn.queue[i]; consumedIdx = i; break; }
      }

      if (cmd) {
        // Drop everything up to and including the consumed command (older = stale/dupes).
        conn.queue.splice(0, consumedIdx + 1);
        conn.lastAppliedSeq = cmd.seq;
        conn.lastInput = cmd;
        conn.starveTicks = 0;
        stepPlayerPhase(this.state, p, intentToInput(cmd), FIXED_DT, ev);
      } else if (conn.lastInput && conn.starveTicks < cfg.maxStarveTicks) {
        const held: InputIntent = { ...conn.lastInput, dash: false }; // don't re-trigger dash on a repeat
        stepPlayerPhase(this.state, p, intentToInput(held), FIXED_DT, ev);
        conn.starveTicks++;
      }
    }

    stepWorldPhase(this.state, FIXED_DT, ev);
    this.state.tick++;
    this.commitEvents(ev);
  }

  // Tag this tick's events with monotonic ids, append to the bounded ring, and record any
  // game-over (full-wipe) players so the server can drive a deterministic leave. An expired
  // blessing offer is resolved on BOTH sides on the SAME tick it expired: the sim map entry
  // is already gone (tickPendingBlessings emitted the event), and here the matching
  // connection/seat offer is cleared — no half-expired state can survive a disconnect, a
  // reconnect, or a late choice, and the descend gate can never be held past the TTL.
  private commitEvents(ev: SimEvent[]): void {
    this.gameOverThisTick = [];
    this.offerThisTick = [];
    this.expiredOffersThisTick = [];
    for (const e of ev) {
      this.eventLog.push({ id: this.nextEventId++, e });
      if (e.t === "gameOver") this.gameOverThisTick.push(e.pid);
      else if (e.t === "offerBlessing") this.offerThisTick.push({ pid: e.pid, rare: e.rare });
      else if (e.t === "blessingExpired") {
        this.clearOfferFor(e.pid);
        this.expiredOffersThisTick.push(e.pid);
      }
    }
    if (this.eventLog.length > EVENT_RING) this.eventLog.splice(0, this.eventLog.length - EVENT_RING);
  }

  // Idempotently drop the server-side offer state for a player whose offer resolved without
  // them (TTL expiry): the live connection's pending offer, and — for a player mid-outage —
  // the reserved seat's copy, so a resume can never resurrect an expired offer.
  private clearOfferFor(pid: PlayerId): void {
    for (const conn of this.conns.values()) {
      if (conn.playerId !== pid) continue;
      conn.pendingOffer = null;
      conn.offerResendsLeft = 0;
    }
    for (const seat of this.seatMap.values()) {
      if (seat.pid !== pid) continue;
      seat.pendingOffer = null;
    }
  }
}
