// Stage B netcode protocol: the wire contract shared by the browser client and the Node
// authoritative server. Compact, validated JSON now; a Codec seam so a binary encoding is a
// later one-module swap (production spec §4). This module imports ONLY the pure sim (no DOM,
// no ws, no Convex) so both ends compile against it.
//
// The wire structs are the plain-data subset the client needs to render + reconcile — never
// anim/cosmetics (those stay client-side per Stage A). The server sends authoritative state;
// the client sends INPUTS ONLY (never outcomes/positions/hits) — the core anti-cheat rule.

import type { PlayerSim, WorldState } from "../sim/world.js";
import type { Enemy, Bullet, Prop, Pickup, Chest, EnemyKind, WeaponId, AttackPhase, AttackMove, PropKind, PickupKind, ChestKind } from "../sim/types.js";
import { PROP_RADIUS } from "../sim/constants.js";
import type { SimEvent } from "../sim/events.js";
import type { PlayerId } from "../sim/input.js";

// ---- fixed timing (server tick + snapshot rate) ----
export const TICK_HZ = 20;
export const FIXED_DT = 1 / TICK_HZ; // 50ms authoritative step
export const PROTOCOL_VERSION = 1;

// Base client interpolation delay (ms) for remote entities. The server assumes this when
// computing a shooter's lag-comp rewind; the client may grow its ACTUAL delay under jitter
// (adaptive), which only makes the server slightly under-rewind — safe/bounded, never over.
export const INTERP_BASE_DELAY_MS = 120;

// The Stage-B proof world: a fixed walled arena (seed-independent, isSandbox) with a few
// server-owned enemies. Client rebuilds the identical arena locally for movement prediction;
// all dynamic entities (players/enemies/bullets) arrive via snapshots. floor stays 1 (no
// descend at B — updateExit early-returns for sandbox worlds).
export const STAGE_B_SEED = 0x51a9e_b0b;
export const STAGE_B_FLOOR = 1;

// ---- wire structs (tight plain-data; short keys keep JSON small + debuggable) ----

// Authoritative local-player state for reconciliation: enough to reset the predicted player
// to server truth before replaying unacked inputs. No aim (the client owns its own aim).
export interface SelfWire {
  x: number; y: number;
  hp: number; mhp: number;
  inv: number;                 // invuln seconds
  dcd: number; dti: number;    // dashCd, dashTime
  ddx: number; ddy: number;    // dash direction
  fcd: number;                 // fireCd
  fac: number;                 // facing (-1/1)
  down: boolean;               // isDown
  wpn: WeaponId;
  coins: number; kills: number; combo: number; ct: number; // HUD readouts
}

// Another player as seen by this client (rendered via interpolation, never predicted).
export interface PlayerWire {
  id: PlayerId;
  x: number; y: number;
  hp: number; mhp: number;
  fac: number; aim: number;
  wpn: WeaponId; down: boolean;
}

// Compact attack-state for enemy telegraph rendering.
export interface AttackWire {
  ph: AttackPhase; mv: AttackMove;
  wu: number;                  // windup 0..1
  lk: boolean; la: number;     // isAimLocked, lockedAngle
  mx: number; my: number;      // AoE marker
}

// A server-owned enemy. Positions interpolate; the rest is the latest authoritative value.
export interface EnemyWire {
  id: number; kind: EnemyKind;
  x: number; y: number;
  hp: number; mhp: number; r: number;
  atk: AttackWire;
  bph: number;                 // boss phase (0 when not a boss)
  burn: number; chill: number; shock: number;
}

export interface BulletWire {
  x: number; y: number; vx: number; vy: number;
  r: number; friend: boolean; color: string;
  fx: WeaponId | null;
}

// Shared world content (Stage C): every client sees the SAME authoritative props/pickups/
// chests, so loot/objective state is identical. These are near-static (state flips on break/
// open/collect), so they ride the snapshot as discrete values — no interpolation needed. The
// client rebuilds radius from kind, keeping the wire tiny.
export interface PropWire { id: number; kind: PropKind; x: number; y: number; brk: number } // brk<0 => intact
export interface PickupWire { kind: PickupKind; x: number; y: number; wpn: WeaponId | null; val: number } // val<0 => face value
export interface ChestWire { kind: ChestKind; x: number; y: number; op: boolean; opt: number } // opt<0 => not yet open

// ---- messages ----

// Client -> server. The client authors INPUTS ONLY.
export type ClientMsg =
  | { t: "join"; ticket: string; protocol: number }
  | { t: "input"; seq: number; dt: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean }
  | { t: "pong"; id: number };

// Server -> client.
export type ServerMsg =
  | {
      t: "snap";
      tick: number;
      ackSeq: number;           // last input seq from THIS client the server applied
      full: boolean;            // initial (full) snapshot on join (carries no events)
      selfId: PlayerId;         // this client's server-assigned id (on every snap so a dropped
                                // join snapshot never loses identity)
      floor: number;            // shared floor number (objective/HUD)
      self: SelfWire | null;    // authoritative local player (null until spawned)
      players: PlayerWire[];    // OTHER players (interest-filtered @ C)
      enemies: EnemyWire[];
      bullets: BulletWire[];
      props: PropWire[];        // shared destructibles
      pickups: PickupWire[];    // shared loot on the ground
      chests: ChestWire[];      // shared chests (incl. the boss chest)
      events: SimEvent[];       // events since last snap -> client replays juice
    }
  | { t: "ping"; id: number; tick: number; time: number }
  | { t: "error"; code: string; msg: string };

// ---- Codec seam (JSON now; binary is a later swap) ----

export class ProtocolError extends Error {}

export interface Codec {
  encodeServer(msg: ServerMsg): string;
  decodeServer(raw: string): ServerMsg;   // client side (server is trusted, but still parse-guard)
  encodeClient(msg: ClientMsg): string;
  decodeClient(raw: string): ClientMsg;    // server side (STRICT — untrusted input)
}

// Guard against giant payloads before we even parse (a client can't make us buffer MBs).
const MAX_RAW_BYTES = 4096;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function num(o: Record<string, unknown>, k: string, lo: number, hi: number): number {
  const v = o[k];
  if (!isFiniteNum(v) || v < lo || v > hi) throw new ProtocolError(`bad ${k}`);
  return v;
}
function boolOf(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new ProtocolError(`bad ${k}`);
  return v;
}

// Strict decoder for untrusted client messages. Rejects unknown types, wrong shapes,
// non-finite numbers, out-of-range values, and oversized strings. NEVER throws anything but
// ProtocolError (the server isolates it per-connection); a fuzzer cannot reach the tick loop.
function decodeClientMsg(raw: string): ClientMsg {
  if (typeof raw !== "string") throw new ProtocolError("non-string frame");
  if (raw.length > MAX_RAW_BYTES) throw new ProtocolError("oversized");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("bad json");
  }
  if (typeof parsed !== "object" || parsed === null) throw new ProtocolError("not an object");
  const o = parsed as Record<string, unknown>;
  switch (o.t) {
    case "join": {
      const ticket = o.ticket;
      if (typeof ticket !== "string" || ticket.length < 1 || ticket.length > 512) throw new ProtocolError("bad ticket");
      const protocol = isFiniteNum(o.protocol) ? o.protocol : 0;
      return { t: "join", ticket, protocol };
    }
    case "input": {
      // seq: non-negative safe integer. dt: bounded (server further clamps for anti-cheat).
      const seq = o.seq;
      if (!isFiniteNum(seq) || seq < 0 || seq > Number.MAX_SAFE_INTEGER || Math.floor(seq) !== seq) throw new ProtocolError("bad seq");
      return {
        t: "input",
        seq,
        dt: num(o, "dt", 0, 1),          // seconds; a frame is ~0.016, server caps to a tick
        mx: num(o, "mx", -8, 8),         // raw axis; server clamps to unit length
        my: num(o, "my", -8, 8),
        aim: num(o, "aim", -1000, 1000), // radians; unbounded angle is fine to clamp loosely
        fire: boolOf(o, "fire"),
        dash: boolOf(o, "dash"),
      };
    }
    case "pong": {
      return { t: "pong", id: num(o, "id", -1e12, 1e12) };
    }
    default:
      throw new ProtocolError(`unknown type ${String(o.t)}`);
  }
}

function decodeServerMsg(raw: string): ServerMsg {
  // The server is trusted, but still parse-guard so a corrupt frame surfaces as an error
  // rather than an uncaught throw in the client's onmessage.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("bad json");
  }
  if (typeof parsed !== "object" || parsed === null) throw new ProtocolError("not an object");
  const o = parsed as { t?: unknown };
  if (o.t !== "snap" && o.t !== "ping" && o.t !== "error") throw new ProtocolError(`unknown server type ${String(o.t)}`);
  return parsed as ServerMsg;
}

export const jsonCodec: Codec = {
  encodeServer: (msg) => JSON.stringify(msg),
  decodeServer: decodeServerMsg,
  encodeClient: (msg) => JSON.stringify(msg),
  decodeClient: decodeClientMsg,
};

// ---- entity <-> wire conversions ----

export function toSelfWire(p: PlayerSim): SelfWire {
  return {
    x: p.x, y: p.y, hp: p.hp, mhp: p.maxHp, inv: p.invuln,
    dcd: p.dashCd, dti: p.dashTime, ddx: p.dashDx, ddy: p.dashDy, fcd: p.fireCd,
    fac: p.facing, down: p.isDown, wpn: p.weapon,
    coins: p.coins, kills: p.kills, combo: p.combo, ct: p.comboTimer,
  };
}

export function toPlayerWire(p: PlayerSim): PlayerWire {
  return { id: p.id, x: p.x, y: p.y, hp: p.hp, mhp: p.maxHp, fac: p.facing, aim: p.aimAngle, wpn: p.weapon, down: p.isDown };
}

export function toEnemyWire(e: Enemy): EnemyWire {
  const a = e.attack;
  return {
    id: e.id, kind: e.kind, x: e.x, y: e.y, hp: e.hp, mhp: e.maxHp, r: e.radius,
    atk: { ph: a.phase, mv: a.move, wu: a.windup, lk: a.isAimLocked, la: a.lockedAngle, mx: a.markX, my: a.markY },
    bph: e.boss ? e.boss.phase : 0,
    burn: e.burn, chill: e.chill, shock: e.shock,
  };
}

export function toBulletWire(b: Bullet): BulletWire {
  return { x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.radius, friend: b.friendly, color: b.color, fx: b.fx ?? null };
}

// Reset a predicted local player to authoritative server truth (the reconciliation snap).
// Only server-owned fields are copied; the client keeps its own aim/mods (mods are static at
// B — no blessings on the arena) and re-derives predicted position by replaying inputs.
export function applySelfWire(p: PlayerSim, s: SelfWire): void {
  p.x = s.x; p.y = s.y; p.hp = s.hp; p.maxHp = s.mhp; p.invuln = s.inv;
  p.dashCd = s.dcd; p.dashTime = s.dti; p.dashDx = s.ddx; p.dashDy = s.ddy; p.fireCd = s.fcd;
  p.facing = s.fac; p.isDown = s.down; p.weapon = s.wpn;
  p.coins = s.coins; p.kills = s.kills; p.combo = s.combo; p.comboTimer = s.ct;
}

// Build a render-ready Enemy from a wire struct at an (interpolated) position. Scratch fields
// the renderer never reads are defaulted; the client's cosmetic anim is keyed by id elsewhere.
export function enemyFromWire(w: EnemyWire, x: number, y: number): Enemy {
  return {
    id: w.id, kind: w.kind, x, y, vx: 0, vy: 0, radius: w.r, hp: w.hp, maxHp: w.mhp, dead: false,
    speed: 0, touchDamage: 0, zig: 0, hopClock: 0, hopMove: 0, spawnTimer: 0, stuckTimer: 0,
    burn: w.burn, burnDmg: 0, chill: w.chill, shock: w.shock, statusTick: 0, burnOwner: null,
    attack: {
      phase: w.atk.ph, time: 0, move: w.atk.mv, windup: w.atk.wu, cooldown: 0,
      lockedAngle: w.atk.la, isAimLocked: w.atk.lk, markX: w.atk.mx, markY: w.atk.my,
    },
    boss: w.bph > 0 ? { phase: w.bph, minionTimer: 0, isNextRadial: false, burstParity: 0 } : null,
  };
}

export function toPropWire(p: Prop): PropWire {
  return { id: p.id, kind: p.kind, x: p.x, y: p.y, brk: p.breakT ?? -1 };
}
export function toPickupWire(p: Pickup): PickupWire {
  return { kind: p.kind, x: p.x, y: p.y, wpn: p.weapon, val: p.value ?? -1 };
}
export function toChestWire(c: Chest): ChestWire {
  return { kind: c.kind, x: c.x, y: c.y, op: c.opened, opt: c.openT ?? -1 };
}

// Radius reconstructed from kind so the wire stays tiny. Matches the sim's placement radii
// (constants.PROP_RADIUS for props; pickups 13/16; chests 16/18) so client collision +
// pickup ranges agree with the server.
export function propFromWire(w: PropWire): Prop {
  return { id: w.id, kind: w.kind, x: w.x, y: w.y, radius: PROP_RADIUS, hp: 1, dead: w.brk >= 0, breakT: w.brk < 0 ? undefined : w.brk };
}
export function pickupFromWire(w: PickupWire): Pickup {
  const radius = w.kind === "weapon" ? 16 : 13;
  return { kind: w.kind, x: w.x, y: w.y, radius, weapon: w.wpn, value: w.val < 0 ? undefined : w.val };
}
export function chestFromWire(w: ChestWire): Chest {
  return { kind: w.kind, x: w.x, y: w.y, radius: w.kind === "boss" ? 18 : 16, opened: w.op, openT: w.opt < 0 ? undefined : w.opt };
}

export function bulletFromWire(b: BulletWire): Bullet {
  return {
    x: b.x, y: b.y, vx: b.vx, vy: b.vy, radius: b.r, life: 1, friendly: b.friend,
    owner: null, damage: 0, color: b.color, pierce: 0, hitList: null, isCrit: false,
    fx: b.fx ?? undefined,
  };
}

// Snapshot the current server world into a full ServerMsg body for one client. The client's
// own player becomes `self`; everyone else becomes a PlayerWire. events are supplied by the
// caller (accumulated over the ticks since this client's last snapshot).
export interface SnapshotOpts {
  // Interest radius in px around the client's own player. Entities outside it are omitted from
  // this client's snapshot (the primary bandwidth + CPU lever @ Stage C). <= 0 disables the
  // filter (send everything) — the default, so direct callers/tests keep full snapshots.
  interestRadius?: number;
}

// Interest management (Stage C): a client always receives its OWN player + globally-relevant
// state (the boss enemy and the boss chest — the shared objective) and, in addition, only the
// nearby players/enemies/bullets/props/pickups/chests within its interest radius. A simple
// distance filter is enough for a single bounded floor (a spatial index is Stage E).
export function buildSnapshot(
  w: WorldState,
  selfPid: PlayerId,
  ackSeq: number,
  events: SimEvent[],
  full: boolean,
  opts: SnapshotOpts = {},
): ServerMsg {
  const self = w.players.get(selfPid);
  const r = opts.interestRadius ?? 0;
  const r2 = r * r;
  const sx = self ? self.x : 0;
  const sy = self ? self.y : 0;
  // No radius, or we don't know where this client is yet -> send everything.
  const near = (x: number, y: number): boolean => {
    if (r <= 0 || !self) return true;
    const dx = x - sx, dy = y - sy;
    return dx * dx + dy * dy <= r2;
  };

  const players: PlayerWire[] = [];
  for (const p of w.players.values()) if (p.id !== selfPid && near(p.x, p.y)) players.push(toPlayerWire(p));
  const enemies: EnemyWire[] = [];
  for (const e of w.enemies) if (e.kind === "boss" || near(e.x, e.y)) enemies.push(toEnemyWire(e));
  const bullets: BulletWire[] = [];
  for (const b of w.bullets) if (near(b.x, b.y)) bullets.push(toBulletWire(b));
  const props: PropWire[] = [];
  for (const p of w.props) if (near(p.x, p.y)) props.push(toPropWire(p));
  const pickups: PickupWire[] = [];
  for (const p of w.pickups) if (near(p.x, p.y)) pickups.push(toPickupWire(p));
  const chests: ChestWire[] = [];
  for (const c of w.chests) if (c.kind === "boss" || near(c.x, c.y)) chests.push(toChestWire(c));

  return {
    t: "snap",
    tick: w.tick,
    ackSeq,
    full,
    selfId: selfPid,
    floor: w.floor,
    self: self ? toSelfWire(self) : null,
    players,
    enemies,
    bullets,
    props,
    pickups,
    chests,
    events,
  };
}