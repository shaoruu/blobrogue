// Stage B/C netcode protocol: the wire contract shared by the browser client and the Node
// authoritative server. Compact, validated JSON now; a Codec seam so a binary encoding is a
// later one-module swap (production spec §4). This module imports ONLY the pure sim (no DOM,
// no ws, no Convex) so both ends compile against it.
//
// The wire structs are the plain-data subset the client needs to render + reconcile — never
// anim/cosmetics (those stay client-side per Stage A). The server sends authoritative state;
// the client sends INPUTS/INTENTS ONLY (never outcomes/positions/hits) — the core anti-cheat
// rule. BOTH directions are exhaustively validated at runtime: client frames strictly (unknown
// fields rejected — a smuggled `dt` is a protocol error), server frames defensively (every
// field type-checked before the client trusts it).

import type { PlayerSim, WorldState } from "../sim/world.js";
import { isFloorCleared, playersAtExit, isPlayerOut } from "../sim/world.js";
import type {
  Enemy, Bullet, Prop, Pickup, Chest, Hazard, HazardKind, EnemyKind, WeaponId, AttackPhase,
  AttackMove, PropKind, PickupKind, ChestKind,
} from "../sim/types.js";
import type { EnemyTier } from "../sim/balance.js";
import type { PlayerMods } from "../sim/items.js";
import { PROP_RADIUS } from "../sim/constants.js";
import { WEAPONS } from "../sim/weapons.js";
import { ENEMY_ARCHETYPES, isBossKind } from "../sim/enemies.js";
import type { SimEvent } from "../sim/events.js";
import type { PlayerId } from "../sim/input.js";
import { projectPlayer, applyPlayerSnapshot, modsFromWire } from "./playerSnapshot.js";
import type { AuthoritativePlayerSnapshot } from "./playerSnapshot.js";

export { modsFromWire } from "./playerSnapshot.js";

// ---- fixed timing (server tick + snapshot rate) ----
export const TICK_HZ = 20;
export const FIXED_DT = 1 / TICK_HZ; // 50ms authoritative step
// v3: balance reset (dash-iframe/fang fields on SelfWire, enemy tier on EnemyWire,
// dealer_heart pickups, squeeze attack move, offerBlessing{rare} + bossTransition/
// enemySpawn events). Joins must carry EXACTLY this version.
// v3-additive (no bump — client->server messages are UNCHANGED, so the strict join gate is
// honest): the join TICKET payload may carry verified room/identity claims (wld/nm/cl — see
// server/src/auth.ts), and PlayerWire carries optional nm/cl which the client decodes
// defensively with fallbacks, so old<->new client/server pairs interoperate cleanly.
// v4 (ONE migration, strict equal-version join gate — skew is explicit, never silently
// interoperated on a Sev-0 surface):
//   - hotbar inventory commands: client->server `reorder` (move an inventory slot) and
//     `drop` (drop an owned weapon as a world pickup) plus the weaponDrop event
//   - room correctness: `wid` — the authoritative world id this connection is bound to, on
//     EVERY snap, so the client can ASSERT it landed in the room it expected (mismatch =
//     close, never play); `roster` — every seat in the world (verified identity + on/away
//     state), independent of interest filtering, so readiness/HUD show who actually joined
//     and who is reconnecting
//   - reconnect resume: `tok` — the single-use seat token for THIS connection (rides every
//     per-connection snapshot), presented via join's optional `resume` to reclaim the
//     reserved body; a deliberate disconnect says `leave` so no seat is reserved; PlayerWire
//     `ab` marks an absent body (rendered as a reconnecting ghost)
// v5 (intentional bump, the content wave): the snapshot grew the `hzds` hazard list
// (webs slow PREDICTED movement, so clients must know them), boss-choice/dealer
// pickup flags + the personal-claim player flag, and the enemy wire's closed kind/move
// sets grew (charger/burrower/orbiter/shielder + the boss roster; a v4 client would
// reject any snapshot carrying them as a ProtocolError). The join gate enforcing
// equality is what turns that skew into a clean "update your client" instead of a
// mid-run desync. NOTE: the control plane's synthetic VERIFY join mirrors this constant
// (control/src/adapters/httpProbe.ts SYNTHETIC_JOIN_PROTOCOL).
// v6 (the co-op experience pass — client->server messages changed, so the strict join
// gate bumps): input carries the interact intent (`act`, the explicit revive-channel
// key), a semantic `spec` message names a downed player's spectate target (the server
// centers that client's interest view on it), PlayerWire carries `rv` (authoritative
// revive progress for the reviver-side ring) and `out` (past the floor's down limit —
// unrevivable until the descent rescue), SelfWire carries `out`, and snapshots carry
// `exr` (the living present players standing at the cleared exit — the descend gate's
// own readiness predicate, driving the party coordination readout).
// v7 (intentional bump, the depth-progression world): dungeon geometry now comes from a
// NEW shared generator (journey-chained rooms, shape archetypes, curriculum cadence) and
// seeded FLOOR hazards (spikes/pools/vents/rifts — never on the wire, derived from the
// snapshot seed), so a v6 client would silently render a DIFFERENT map than the server
// simulates — the join gate fences the skew into a clean version mismatch. Also adds the
// hazardHit event for floor-hazard damage juice.
export const PROTOCOL_VERSION = 7;

// How long the server reserves a disconnected player's body (their seat) before the
// authoritative leave lifecycle applies. 90s per the studio balance gate's reconnect
// contract (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md §6) — a reserved body is paused,
// safe, gate-neutral, and never blocks a wipe, so the long window costs teammates nothing
// while covering real-world outages (router resets, elevator rides). Shared so the client's
// reconnect loop and grace countdown agree with the server default (GS_RESUME_GRACE_MS can
// override server-side; the countdown is display-only).
export const RESUME_GRACE_MS = 90000;

// World ids are minter-controlled but still bounded/charset-checked so a compromised minter
// can't inject log-breaking or unbounded ids ("room:ABCD", "arena-1", ...). Shared by the
// ticket verifier (server), the snapshot decoder (client), and the dev mint endpoint.
const WORLD_ID_RE = /^[a-zA-Z0-9:_-]{1,40}$/;

export function isValidWorldId(id: string): boolean {
  return WORLD_ID_RE.test(id);
}

// The single room-code -> authoritative-world-id mapping the CLIENT and SERVER share. The
// Convex minter keeps its own copy (convex/gsTicketCore.ts must stay import-free of app
// code for bundling); server/test/ticket.test.ts locks the two to byte agreement.
export function worldIdForRoomCode(code: string): string {
  return "room:" + code.trim().toUpperCase();
}

// Base client interpolation delay (ms) for remote entities. The server uses this as the
// lag-comp rewind default until the client reports its ACTUAL adaptive delay via `stat.dly`
// (server-clamped to the same [min,max] the client's adaptive logic uses).
export const INTERP_BASE_DELAY_MS = 120;
export const INTERP_DELAY_MIN_MS = 90;
export const INTERP_DELAY_MAX_MS = 300;

// The fixedDev/measurement arena seed (harness + pre-join placeholder world). A REAL online
// run never uses this: the server rolls a fresh seed per run and the client rebuilds from the
// snapshot's authoritative seed/floor/rev.
export const STAGE_B_SEED = 0x51a9e_b0b;
export const STAGE_B_FLOOR = 1;

// ---- wire structs (tight plain-data; short keys keep JSON small + debuggable) ----

// Authoritative local-player state for reconciliation: the SelfWire is the compact encoding of
// AuthoritativePlayerSnapshot (src/net/playerSnapshot.ts — the single projection/apply boundary
// with compile-time exhaustive field coverage). No aim (the client owns its own aim).
export interface SelfWire {
  x: number; y: number;
  hp: number; mhp: number;
  inv: number;                 // post-hit invuln seconds
  dnv: number;                 // dash-iframe seconds (separate, non-extending window)
  dcd: number; dti: number;    // dashCd, dashTime
  ddx: number; ddy: number;    // dash direction
  fcd: number;                 // fireCd
  fng: number;                 // Vampire Fang shared proc cooldown
  fac: number;                 // facing (-1/1)
  down: boolean;               // isDown
  rev: number;                 // reviveProgress seconds (authoritative revive hold readout)
  out: boolean;                // past the floor's down limit: unrevivable until the descent
  wpn: WeaponId;
  wpns: WeaponId[];            // authoritative owned-weapon inventory (validated equip source)
  items: string[];             // authoritative owned blessing/item ids (HUD strip)
  mods: PlayerMods;            // authoritative run mods (drives client prediction: speed/firerate/dash)
  coins: number; kills: number; combo: number; ct: number; // HUD readouts
  bcl: boolean;                // hasClaimedBossChoice (gate §4 personal boss-reward claim)
}

// Another player as seen by this client (rendered via interpolation, never predicted).
// nm/cl are the verified cosmetic identity from that player's join ticket (name above the
// blob, chosen blob tint). Both are decode-OPTIONAL with safe fallbacks (nm -> id, cl ->
// null) so frames from an older server still decode. rv is the authoritative revive-channel
// progress on a DOWNED player (seconds) — it drives the reviver-side progress ring; out
// marks a body past the floor's down limit (teammates stop offering the revive). ab marks
// a network-absent body (its player disconnected and the seat is reserved for the
// reconnect grace) — rendered as an explicit reconnecting ghost, never a live/dead read.
export interface PlayerWire {
  id: PlayerId;
  x: number; y: number;
  hp: number; mhp: number;
  fac: number; aim: number;
  wpn: WeaponId; down: boolean;
  rv: number;   // authoritative revive-channel progress on a DOWNED body (seconds)
  out: boolean; // past the floor's down limit — teammates stop offering the revive
  bcl: boolean; // has claimed this floor's boss weapon choice (gate §4 personal claim)
  ab: boolean;  // absent body — the seat is reserved for a reconnect (rendered as a ghost)
  nm: string;
  cl: number | null;
}

// One SEAT in this world, as published on every snapshot REGARDLESS of interest filtering:
// the world-scoped player id, the VERIFIED ticket identity it joined with (aid — the same id
// the lobby roster keys on, so readiness can be matched member-by-member), the cosmetic
// name/color, and whether the seat is live ("on") or reserved for a reconnect ("away").
// This is the server's authoritative "who is actually in this world" — the lobby's Convex
// presence is only the expectation.
export type SeatState = "on" | "away";

export interface RosterWire {
  pid: PlayerId;
  aid: string;
  nm: string;
  cl: number | null;
  st: SeatState;
}

// A player still deciding a blessing offer + the seconds left on its authoritative TTL.
// Rides every snapshot (tiny, party-sized) so all clients agree on WHO is holding the
// descend gate and for how long — a wait that is visible and bounded, never a mystery.
export interface WaitWire {
  pid: PlayerId;
  s: number;
}

// A snapshot event carries a monotonic id so the reliable-event channel can dedupe (client
// ignores ids it already processed) and ack (client reports the max id it has seen; the server
// resends only unacked events from a bounded ring). This makes one-shot juice (kills/loot/FX)
// effectively once-delivered under packet loss — no missing, no double.
export interface WireEvent { id: number; e: SimEvent }

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
  tr: EnemyTier;               // variety tier (drives the client's draw scale + markers)
  atk: AttackWire;
  bph: number;                 // boss phase (0 when not a boss)
  burn: number; chill: number; shock: number;
}

export interface BulletWire {
  x: number; y: number; vx: number; vy: number;
  r: number; friend: boolean; color: string;
  fx: WeaponId | null;
}

// Shared world content: every client sees the SAME authoritative props/pickups/chests, so
// loot/objective state is identical. These are near-static (state flips on break/open/collect),
// so they ride the snapshot as discrete values — no interpolation needed. All three carry the
// sim's STABLE per-floor id (interest hysteresis + client anim keying + lifecycle identity).
export interface PropWire { id: number; kind: PropKind; x: number; y: number; brk: number } // brk<0 => intact
export interface PickupWire { id: number; kind: PickupKind; x: number; y: number; wpn: WeaponId | null; val: number; bch: boolean } // val<0 => face value; bch = boss weapon choice
export interface ChestWire { id: number; kind: ChestKind; x: number; y: number; op: boolean; opt: number } // opt<0 => not yet open
// Authored ground hazards (webs): bounded (hard sim cap), gameplay-relevant everywhere
// (they slow PREDICTED movement), so they ride every snapshot unfiltered.
export interface HazardWire { id: number; k: HazardKind; x: number; y: number; r: number; life: number; max: number }

// ---- messages ----

// Client -> server. The client authors INPUTS/INTENTS ONLY.
export type ClientMsg =
  // resume (optional): the single-use seat token from a previous connection's full snapshot.
  // Presenting it with a fresh valid ticket reclaims the reserved body (same player id, same
  // state, same world) instead of spawning a new one.
  | { t: "join"; ticket: string; protocol: number; resume?: string }
  // Deliberate goodbye: the player is leaving on purpose (quit to lobby / run end), so the
  // server must NOT reserve a reconnect seat for this connection.
  | { t: "leave" }
  // An input is an INTENT SAMPLE, not a time authority: it carries NO dt. The server advances
  // simulation time by its own fixed tick (one command = one fixed step), so a client can't buy
  // extra time by claiming a large dt. `ackEv` piggybacks the reliable-event ack (last event id
  // the client has processed) so the server can stop resending delivered events. `act` is the
  // interact intent (the held revive-channel key) — the sim validates proximity/liveness, so
  // the bit alone can never conjure a revive.
  | { t: "input"; seq: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean; act: boolean; ackEv: number }
  | { t: "pong"; id: number }
  // Spectate intent: which teammate a DOWNED player's camera follows. Pure view preference —
  // the server uses it only to center that client's interest view (and positional events)
  // while they are down; it never touches the sim, and an invalid/living-player target is
  // simply ignored (the publisher falls back to the first living teammate).
  | { t: "spec"; target: string }
  // Authoritative weapon equip: the server equips ONLY if the id is in the player's owned set
  // (a tampered client can't equip an unowned weapon). cseq is a monotonic command sequence:
  // the server ignores stale/duplicate commands so a resent equip can never double-apply or
  // regress a newer choice. Never carries any outcome.
  | { t: "equip"; weapon: WeaponId; cseq: number }
  // Authoritative inventory reorder: move the hotbar slot at `from` to position `to` (all
  // other slots keep relative order). The server validates both indices against the CURRENT
  // authoritative inventory — a stale index (inventory changed in flight) rejects, never
  // misplaces. Same cseq idempotency as equip. Never carries weapon ids or any outcome.
  | { t: "reorder"; from: number; to: number; cseq: number }
  // Authoritative weapon drop: request dropping an OWNED weapon into the world. Named by id
  // (not slot index) so a drop racing a reorder can never discard the wrong weapon. The
  // server validates ownership + player state and picks the spawn spot itself; the pickup
  // and the updated inventory flow back via snapshot. Same cseq idempotency as equip.
  | { t: "drop"; weapon: WeaponId; cseq: number }
  // Authoritative blessing choice: names the server offer it answers (offerId) + the chosen
  // item. The server validates offerId against the live pending offer (id match, not expired)
  // and choiceId against that offer's choice set, then applies the mods server-side.
  | { t: "chooseBlessing"; offerId: number; choiceId: string }
  // Client netcode telemetry uplink (observability + the lag-comp render-delay sample `dly`,
  // which the server clamps to the adaptive [90,300]ms window — a lie can only mis-rewind the
  // sender's own shots within that bounded window).
  | { t: "stat"; rtt: number; jit: number; rec: number; corr: number; dly: number };

// Server -> client.
export type ServerMsg =
  | {
      t: "snap";
      tick: number;
      rev: number;               // world revision (increments per floor build/run reset)
      ackSeq: number;            // last input seq from THIS client the server CONSUMED
      full: boolean;             // initial (full) snapshot on join (carries no events)
      over: boolean;             // terminal run state (party wiped) — derivable from STATE
      selfId: PlayerId;          // this client's server-assigned id (on every snap so a dropped
                                 // join snapshot never loses identity)
      wid: string;               // the authoritative world id this connection is BOUND to —
                                 // the client asserts it against the expected room world and
                                 // refuses to play on a mismatch
      roster: RosterWire[];      // every seat in this world (verified identities + on/away),
                                 // interest-INDEPENDENT — drives readiness + the HUD count
      wait: WaitWire[];          // players still deciding a blessing offer (pid + seconds
                                 // left) — the party-wait state everyone sees identically,
                                 // so a held descend gate is explicit and NEVER indefinite
      tok?: string;              // single-use resume token for THIS connection (full snaps
                                 // only) — presented on reconnect to reclaim the seat
      seed: number;              // authoritative run seed (client rebuilds the identical dungeon)
      floor: number;             // authoritative floor number (objective/HUD)
      cleared: boolean;          // authoritative floor-cleared / exit-open flag (global objective)
      exr: PlayerId[];           // living players standing at the cleared exit — the SAME
                                 // predicate the descend gate requires, on the wire (drives
                                 // the "WAITING AT EXIT · N/M" coordination readout)
      evTo: number;              // highest committed event id — the client acks up to here even
                                 // when every pending event was interest-filtered away for it
      self: SelfWire | null;     // authoritative local player (null until spawned)
      players: PlayerWire[];     // OTHER players — the whole party, NEVER interest-filtered
                                 // (teammates are shared objectives: spectate targets, roster,
                                 // minimap, revive prompts all need every member)
      enemies: EnemyWire[];
      bullets: BulletWire[];
      props: PropWire[];         // shared destructibles
      pickups: PickupWire[];     // shared loot on the ground
      chests: ChestWire[];       // shared chests (incl. the boss chest)
      hzds: HazardWire[];        // shared ground hazards (the Weaver's webs)
      events: WireEvent[];       // reliable, id-tagged events (dedupe + ack) -> client replays juice
    }
  | { t: "ping"; id: number; tick: number; time: number }
  // A server-decided blessing offer for this client (seeded choice set), carrying a monotonic
  // `id` so it is idempotent: the server resends it (bounded) until the choice arrives or the
  // offer expires, and the client shows each id only once (no double prompt from resends). The
  // client replies with `chooseBlessing {offerId, choiceId}`; choice authority stays server-side.
  | { t: "offer"; id: number; choices: string[] }
  | { t: "error"; code: string; msg: string };

// ---- Codec seam (JSON now; binary is a later swap) ----

export class ProtocolError extends Error {}

export interface Codec {
  encodeServer(msg: ServerMsg): string;
  decodeServer(raw: string): ServerMsg;   // client side (server is trusted, but still validated)
  encodeClient(msg: ClientMsg): string;
  decodeClient(raw: string): ClientMsg;    // server side (STRICT — untrusted input)
}

// Guard against giant client payloads before we even parse (a client can't make us buffer MBs).
const MAX_RAW_BYTES = 4096;

// ---- primitive validators ----

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function num(o: Record<string, unknown>, k: string, lo: number, hi: number): number {
  const v = o[k];
  if (!isFiniteNum(v) || v < lo || v > hi) throw new ProtocolError(`bad ${k}`);
  return v;
}
function intOf(o: Record<string, unknown>, k: string, lo: number, hi: number): number {
  const v = num(o, k, lo, hi);
  if (Math.floor(v) !== v) throw new ProtocolError(`bad ${k}`);
  return v;
}
function boolOf(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new ProtocolError(`bad ${k}`);
  return v;
}
function shortStr(o: Record<string, unknown>, k: string, max: number): string {
  const v = o[k];
  if (typeof v !== "string" || v.length < 1 || v.length > max) throw new ProtocolError(`bad ${k}`);
  return v;
}
function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ProtocolError(`bad ${what}`);
  return v as Record<string, unknown>;
}
function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ProtocolError(`bad ${what}`);
  return v;
}

// Security-sensitive client messages allow EXACTLY their declared fields — a smuggled extra
// field (e.g. a client-authored `dt`) is a protocol error, not silently ignored.
function exactKeys(o: Record<string, unknown>, keys: readonly string[]): void {
  const ks = Object.keys(o);
  if (ks.length !== keys.length) throw new ProtocolError("unexpected fields");
  for (const k of ks) if (!keys.includes(k)) throw new ProtocolError(`unexpected field ${k}`);
}

// ---- closed-set validators (derived from sim tables so the unions can't drift) ----

function isWeaponId(v: unknown): v is WeaponId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(WEAPONS, v);
}
function weaponOf(o: Record<string, unknown>, k: string): WeaponId {
  const v = o[k];
  if (!isWeaponId(v)) throw new ProtocolError(`bad ${k}`);
  return v;
}
function isEnemyKind(v: unknown): v is EnemyKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ENEMY_ARCHETYPES, v);
}
const PROP_KINDS: Record<PropKind, true> = { crate: true, pot: true, barrel: true, barrel_explosive: true, brazier: true };
const PICKUP_KINDS: Record<PickupKind, true> = { heart: true, coin: true, weapon: true, dealer_heart: true, dealer_weapon: true };
const CHEST_KINDS: Record<ChestKind, true> = { wood: true, boss: true };
const HAZARD_KINDS: Record<HazardKind, true> = { web: true };
const ATTACK_PHASES: Record<AttackPhase, true> = { none: true, windup: true, active: true, recover: true };
const ATTACK_MOVES: Record<AttackMove, true> = {
  none: true, lunge: true, spit: true, hopslam: true, radial: true, roar: true, squeeze: true,
  rush: true, crash: true, dive: true, erupt: true, volley: true, spin: true, shield: true,
  fade: true, wail: true, split: true, pounce: true, weave: true, slam: true, sweep: true,
  brace: true,
};
const ENEMY_TIERS: Record<EnemyTier, true> = { swarm: true, standard: true, brute: true, elite: true };
function inSet<T extends string>(set: Record<T, true>, v: unknown, what: string): T {
  if (typeof v !== "string" || !Object.prototype.hasOwnProperty.call(set, v)) throw new ProtocolError(`bad ${what}`);
  return v as T;
}

// ---- event schema table ----
// ONE table drives both the runtime validator (server->client decode) and the server's
// per-client interest scope. Record<SimEvent["t"], ...> makes it compile-time exhaustive: a new
// SimEvent variant will not compile until its wire schema + scope are declared here.

type FieldKind = "num" | "str" | "bool";
// Scope for interest filtering: "global" reaches every client, "pid" only the named player,
// "pos" only clients whose interest view covers (x,y) — distant one-shot FX stop leaking
// worldwide shake/audio and bandwidth.
export type EventScopeKind = "global" | "pid" | "pos";
interface EventSpec { scope: EventScopeKind; fields: Record<string, FieldKind> }

const EVENT_SPECS: Record<SimEvent["t"], EventSpec> = {
  shot: { scope: "pid", fields: { pid: "str", weapon: "str", x: "num", y: "num", aim: "num", px: "num", py: "num" } },
  meleeSwing: { scope: "pid", fields: { pid: "str", weapon: "str", x: "num", y: "num", aim: "num", bx: "num", by: "num" } },
  enemyHit: { scope: "pos", fields: { eid: "num", dmgX: "num", dmgY: "num", dmg: "num", crit: "bool", puffX: "num", puffY: "num", puffColor: "str", melee: "bool", closeShotgun: "bool", killed: "bool" } },
  thornsHit: { scope: "pos", fields: { eid: "num", x: "num", y: "num", radius: "num", dmg: "num", tint: "str" } },
  burnTick: { scope: "pos", fields: { x: "num", y: "num", radius: "num", dmg: "num" } },
  shockArc: { scope: "pos", fields: { eid: "num", x: "num", y: "num", tx: "num", ty: "num", tRadius: "num", dmg: "num", color: "str", killed: "bool" } },
  enemyKill: { scope: "pos", fields: { eid: "num", kind: "str", tier: "str", x: "num", y: "num", combo: "num" } },
  heal: { scope: "pid", fields: { pid: "str", x: "num", y: "num" } },
  dashStart: { scope: "pid", fields: { pid: "str", x: "num", y: "num" } },
  dashTrail: { scope: "pid", fields: { pid: "str", x: "num", y: "num" } },
  playerHurt: { scope: "pid", fields: { pid: "str", x: "num", y: "num" } },
  itemPicked: { scope: "pid", fields: { pid: "str", x: "num", y: "num", tint: "str" } },
  offerBlessing: { scope: "pid", fields: { pid: "str", rare: "bool" } },
  blessingExpired: { scope: "pid", fields: { pid: "str" } },
  // Positional: the revive moment plays for everyone standing at it (the reviver most of
  // all), not only the revived player. The revived player is AT the point by definition.
  revive: { scope: "pos", fields: { pid: "str", by: "str", x: "num", y: "num" } },
  pickup: { scope: "pid", fields: { pid: "str", kind: "str", x: "num", y: "num" } },
  lootDrop: { scope: "pos", fields: { x: "num", y: "num", color: "str" } },
  weaponDrop: { scope: "pos", fields: { weapon: "str", x: "num", y: "num" } },
  bulletWall: { scope: "pos", fields: { x: "num", y: "num", aim: "num" } },
  bulletBounce: { scope: "pos", fields: { x: "num", y: "num", aim: "num", color: "str" } },
  bulletExpire: { scope: "pos", fields: { x: "num", y: "num", color: "str" } },
  bulletBlocked: { scope: "pos", fields: { x: "num", y: "num", aim: "num" } },
  propHit: { scope: "pos", fields: { propId: "num", kind: "str", x: "num", y: "num" } },
  propBreak: { scope: "pos", fields: { kind: "str", x: "num", y: "num" } },
  explosion: { scope: "pos", fields: { x: "num", y: "num", r: "num" } },
  chestOpen: { scope: "pos", fields: { kind: "str", x: "num", y: "num" } },
  hazardHit: { scope: "pos", fields: { pid: "str", kind: "str", x: "num", y: "num" } },
  spitMuzzle: { scope: "pos", fields: { x: "num", y: "num" } },
  lungeTrail: { scope: "pos", fields: { x: "num", y: "num" } },
  chargeCrash: { scope: "pos", fields: { x: "num", y: "num" } },
  burrowDive: { scope: "pos", fields: { x: "num", y: "num" } },
  burrowErupt: { scope: "pos", fields: { x: "num", y: "num", r: "num" } },
  bossSlam: { scope: "pos", fields: { x: "num", y: "num" } },
  radialBurst: { scope: "pos", fields: { x: "num", y: "num" } },
  bossVolley: { scope: "pos", fields: { x: "num", y: "num" } },
  webPlaced: { scope: "pos", fields: { x: "num", y: "num", r: "num" } },
  bossAddSpawn: { scope: "pos", fields: { eid: "num", x: "num", y: "num", mx: "num", my: "num", spawned: "bool" } },
  // Global: shared-objective transitions every client must see regardless of distance.
  bossPhase: { scope: "global", fields: { eid: "num", x: "num", y: "num" } },
  bossTransition: { scope: "global", fields: { eid: "num", phase: "num", entering: "bool", queued: "num", hpFrac: "num" } },
  enemySpawn: { scope: "pos", fields: { eid: "num", kind: "str", tier: "str", x: "num", y: "num" } },
  descend: { scope: "global", fields: { toFloor: "num" } },
  reachExit: { scope: "global", fields: { toFloor: "num" } },
  gameOver: { scope: "pid", fields: { pid: "str" } },
  // flash/trauma carry no position — rare, tiny, and safe to deliver globally.
  flash: { scope: "global", fields: { eid: "num" } },
  puff: { scope: "pos", fields: { x: "num", y: "num", n: "num", color: "str" } },
  trauma: { scope: "global", fields: { amount: "num" } },
  cue: { scope: "pos", fields: { name: "str", x: "num", y: "num", rate: "num", gain: "num", trauma: "num" } },
};

// Resolve one event's interest scope for server-side filtering. "pos" events expose their
// coordinates; "pid" events their target player.
export type EventScope =
  | { kind: "global" }
  | { kind: "pid"; pid: PlayerId }
  | { kind: "pos"; x: number; y: number };

export function eventScope(e: SimEvent): EventScope {
  const spec = EVENT_SPECS[e.t];
  if (spec.scope === "pid") return { kind: "pid", pid: (e as { pid: PlayerId }).pid };
  if (spec.scope === "pos") {
    const p = e as unknown as Record<string, unknown>;
    const x = p.x, y = p.y;
    if (isFiniteNum(x) && isFiniteNum(y)) return { kind: "pos", x, y };
    return { kind: "global" };
  }
  return { kind: "global" };
}

function validateEvent(v: unknown): SimEvent {
  const o = obj(v, "event");
  const t = o.t;
  if (typeof t !== "string" || !Object.prototype.hasOwnProperty.call(EVENT_SPECS, t)) throw new ProtocolError(`bad event type ${String(t)}`);
  const spec = EVENT_SPECS[t as SimEvent["t"]];
  for (const [field, kind] of Object.entries(spec.fields)) {
    const val = o[field];
    if (kind === "num" && !isFiniteNum(val)) throw new ProtocolError(`bad event ${t}.${field}`);
    if (kind === "str" && typeof val !== "string") throw new ProtocolError(`bad event ${t}.${field}`);
    if (kind === "bool" && typeof val !== "boolean") throw new ProtocolError(`bad event ${t}.${field}`);
  }
  return o as unknown as SimEvent;
}

// ---- strict client decode (untrusted input) ----

// Rejects unknown types, wrong shapes, non-finite numbers, out-of-range values, oversized
// strings, and UNKNOWN FIELDS. NEVER throws anything but ProtocolError (the server isolates it
// per-connection); a fuzzer cannot reach the tick loop.
function decodeClientMsg(raw: string): ClientMsg {
  if (typeof raw !== "string") throw new ProtocolError("non-string frame");
  if (raw.length > MAX_RAW_BYTES) throw new ProtocolError("oversized");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("bad json");
  }
  const o = obj(parsed, "frame");
  switch (o.t) {
    case "join": {
      // `resume` is the ONE optional field on a security-sensitive frame: validate the two
      // allowed shapes exactly (with/without it) — anything else is still an error.
      exactKeys(o, o.resume === undefined ? ["t", "ticket", "protocol"] : ["t", "ticket", "protocol", "resume"]);
      const ticket = shortStr(o, "ticket", 512);
      // Protocol must be an explicit finite integer (no defaulting to 0 — that was a bypass).
      // The join handler additionally enforces it EQUALS the current PROTOCOL_VERSION.
      const protocol = intOf(o, "protocol", 0, 1e6);
      if (o.resume === undefined) return { t: "join", ticket, protocol };
      return { t: "join", ticket, protocol, resume: shortStr(o, "resume", 64) };
    }
    case "leave": {
      exactKeys(o, ["t"]);
      return { t: "leave" };
    }
    case "input": {
      // seq + ackEv: non-negative safe integers. NO dt — inputs are intent samples; the server
      // tick owns simulation time, and exactKeys rejects a smuggled dt outright.
      exactKeys(o, ["t", "seq", "mx", "my", "aim", "fire", "dash", "act", "ackEv"]);
      return {
        t: "input",
        seq: intOf(o, "seq", 0, Number.MAX_SAFE_INTEGER),
        mx: num(o, "mx", -8, 8),         // raw axis; server clamps to unit length
        my: num(o, "my", -8, 8),
        aim: num(o, "aim", -1000, 1000), // radians; unbounded angle is fine to clamp loosely
        fire: boolOf(o, "fire"),
        dash: boolOf(o, "dash"),
        act: boolOf(o, "act"),
        ackEv: intOf(o, "ackEv", 0, Number.MAX_SAFE_INTEGER),
      };
    }
    case "pong": {
      exactKeys(o, ["t", "id"]);
      return { t: "pong", id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER) };
    }
    case "spec": {
      exactKeys(o, ["t", "target"]);
      return { t: "spec", target: shortStr(o, "target", 64) };
    }
    case "equip": {
      // The weapon id must be a KNOWN weapon; the server further validates it is actually owned.
      exactKeys(o, ["t", "weapon", "cseq"]);
      return { t: "equip", weapon: weaponOf(o, "weapon"), cseq: intOf(o, "cseq", 0, Number.MAX_SAFE_INTEGER) };
    }
    case "reorder": {
      // Slot indices are small non-negative integers; the server further validates them
      // against the player's actual inventory length.
      exactKeys(o, ["t", "from", "to", "cseq"]);
      return {
        t: "reorder",
        from: intOf(o, "from", 0, 63),
        to: intOf(o, "to", 0, 63),
        cseq: intOf(o, "cseq", 0, Number.MAX_SAFE_INTEGER),
      };
    }
    case "drop": {
      // The weapon id must be a KNOWN weapon; the server further validates ownership, player
      // state (not downed/pending/terminal), and the never-drop-the-last-weapon rule.
      exactKeys(o, ["t", "weapon", "cseq"]);
      return { t: "drop", weapon: weaponOf(o, "weapon"), cseq: intOf(o, "cseq", 0, Number.MAX_SAFE_INTEGER) };
    }
    case "chooseBlessing": {
      exactKeys(o, ["t", "offerId", "choiceId"]);
      return { t: "chooseBlessing", offerId: intOf(o, "offerId", 0, Number.MAX_SAFE_INTEGER), choiceId: shortStr(o, "choiceId", 48) };
    }
    case "stat": {
      exactKeys(o, ["t", "rtt", "jit", "rec", "corr", "dly"]);
      return {
        t: "stat",
        rtt: num(o, "rtt", 0, 60000),
        jit: num(o, "jit", 0, 60000),
        rec: num(o, "rec", 0, 1e9),
        corr: num(o, "corr", 0, 1e7),
        dly: num(o, "dly", 0, 60000),
      };
    }
    default:
      throw new ProtocolError(`unknown type ${String(o.t)}`);
  }
}

// ---- exhaustive server decode (trusted source, validated anyway) ----
// Every field of every server message is type/range-checked before the client acts on it, so a
// corrupt/truncated frame (or a compromised path) surfaces as a ProtocolError the client drops,
// never as NaN state or an uncaught throw inside the game loop.

const POS_LIMIT = 1e7; // generous world-coordinate bound; rejects Infinity/absurd values

function validateSelfWire(v: unknown): SelfWire {
  const o = obj(v, "self");
  const wpns = arr(o.wpns, "self.wpns").map((w) => {
    if (!isWeaponId(w)) throw new ProtocolError("bad self.wpns entry");
    return w;
  });
  const items = arr(o.items, "self.items").map((it) => {
    if (typeof it !== "string" || it.length > 48) throw new ProtocolError("bad self.items entry");
    return it;
  });
  return {
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    hp: num(o, "hp", 0, 1e6), mhp: num(o, "mhp", 0, 1e6),
    inv: num(o, "inv", 0, 1e4),
    dnv: num(o, "dnv", 0, 1e4),
    dcd: num(o, "dcd", 0, 1e4), dti: num(o, "dti", -1e4, 1e4),
    ddx: num(o, "ddx", -8, 8), ddy: num(o, "ddy", -8, 8),
    fcd: num(o, "fcd", 0, 1e4),
    fng: num(o, "fng", 0, 1e4),
    fac: num(o, "fac", -1, 1),
    down: boolOf(o, "down"),
    rev: num(o, "rev", 0, 1e4),
    out: boolOf(o, "out"),
    wpn: weaponOf(o, "wpn"),
    wpns, items,
    mods: modsFromWire(obj(o.mods, "self.mods")),
    coins: num(o, "coins", 0, 1e9), kills: num(o, "kills", 0, 1e9),
    combo: num(o, "combo", 0, 1e9), ct: num(o, "ct", 0, 1e4),
    bcl: boolOf(o, "bcl"),
  };
}

function validatePlayerWire(v: unknown): PlayerWire {
  const o = obj(v, "player");
  const id = shortStr(o, "id", 64);
  // nm/cl are optional (older servers omit them): validate strictly WHEN present, fall back
  // safely when absent — never a decode failure across a version skew.
  let nm = id;
  if (o.nm !== undefined) nm = shortStr(o, "nm", 24);
  let cl: number | null = null;
  if (o.cl !== undefined && o.cl !== null) cl = intOf(o, "cl", 0, 63);
  return {
    id,
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    hp: num(o, "hp", 0, 1e6), mhp: num(o, "mhp", 0, 1e6),
    fac: num(o, "fac", -1, 1), aim: num(o, "aim", -1000, 1000),
    wpn: weaponOf(o, "wpn"), down: boolOf(o, "down"),
    rv: num(o, "rv", 0, 1e4),
    out: boolOf(o, "out"),
    bcl: boolOf(o, "bcl"),
    ab: boolOf(o, "ab"),
    nm, cl,
  };
}

function validateEnemyWire(v: unknown): EnemyWire {
  const o = obj(v, "enemy");
  const kind = o.kind;
  if (!isEnemyKind(kind)) throw new ProtocolError("bad enemy.kind");
  const a = obj(o.atk, "enemy.atk");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER), kind,
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    hp: num(o, "hp", -1e6, 1e6), mhp: num(o, "mhp", 0, 1e6), r: num(o, "r", 0, 1e4),
    tr: inSet(ENEMY_TIERS, o.tr, "enemy.tr"),
    atk: {
      ph: inSet(ATTACK_PHASES, a.ph, "enemy.atk.ph"),
      mv: inSet(ATTACK_MOVES, a.mv, "enemy.atk.mv"),
      wu: num(a, "wu", 0, 1),
      lk: boolOf(a, "lk"), la: num(a, "la", -1000, 1000),
      mx: num(a, "mx", -POS_LIMIT, POS_LIMIT), my: num(a, "my", -POS_LIMIT, POS_LIMIT),
    },
    bph: num(o, "bph", 0, 16),
    burn: num(o, "burn", 0, 1e4), chill: num(o, "chill", 0, 1e4), shock: num(o, "shock", 0, 1e4),
  };
}

function validateBulletWire(v: unknown): BulletWire {
  const o = obj(v, "bullet");
  const fx = o.fx;
  if (fx !== null && !isWeaponId(fx)) throw new ProtocolError("bad bullet.fx");
  return {
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    vx: num(o, "vx", -1e6, 1e6), vy: num(o, "vy", -1e6, 1e6),
    r: num(o, "r", 0, 1e4), friend: boolOf(o, "friend"), color: shortStr(o, "color", 32),
    fx: fx as WeaponId | null,
  };
}

function validatePropWire(v: unknown): PropWire {
  const o = obj(v, "prop");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    kind: inSet(PROP_KINDS, o.kind, "prop.kind"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    brk: num(o, "brk", -1, 1e4),
  };
}

function validatePickupWire(v: unknown): PickupWire {
  const o = obj(v, "pickup");
  const wpn = o.wpn;
  if (wpn !== null && !isWeaponId(wpn)) throw new ProtocolError("bad pickup.wpn");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    kind: inSet(PICKUP_KINDS, o.kind, "pickup.kind"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    wpn: wpn as WeaponId | null,
    val: num(o, "val", -1, 1e9),
    bch: boolOf(o, "bch"),
  };
}

function validateChestWire(v: unknown): ChestWire {
  const o = obj(v, "chest");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    kind: inSet(CHEST_KINDS, o.kind, "chest.kind"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    op: boolOf(o, "op"), opt: num(o, "opt", -1, 1e4),
  };
}

function validateHazardWire(v: unknown): HazardWire {
  const o = obj(v, "hazard");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    k: inSet(HAZARD_KINDS, o.k, "hazard.k"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    r: num(o, "r", 0, 1e4), life: num(o, "life", 0, 1e4), max: num(o, "max", 0, 1e4),
  };
}

function validateWireEvent(v: unknown): WireEvent {
  const o = obj(v, "wireEvent");
  return { id: intOf(o, "id", 1, Number.MAX_SAFE_INTEGER), e: validateEvent(o.e) };
}

const SEAT_STATES: Record<SeatState, true> = { on: true, away: true };

function validateWaitWire(v: unknown): WaitWire {
  const o = obj(v, "wait");
  return { pid: shortStr(o, "pid", 64), s: num(o, "s", 0, 1e4) };
}

function validateRosterWire(v: unknown): RosterWire {
  const o = obj(v, "roster");
  let cl: number | null = null;
  if (o.cl !== undefined && o.cl !== null) cl = intOf(o, "cl", 0, 63);
  return {
    pid: shortStr(o, "pid", 64),
    aid: shortStr(o, "aid", 64),
    nm: shortStr(o, "nm", 24),
    cl,
    st: inSet(SEAT_STATES, o.st, "roster.st"),
  };
}

function worldIdOf(o: Record<string, unknown>): string {
  const wid = shortStr(o, "wid", 40);
  if (!isValidWorldId(wid)) throw new ProtocolError("bad wid");
  return wid;
}

function decodeServerMsg(raw: string): ServerMsg {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("bad json");
  }
  const o = obj(parsed, "frame");
  switch (o.t) {
    case "snap": {
      const pidList = (k: "exr"): PlayerId[] => arr(o[k], k).map((p) => {
        if (typeof p !== "string" || p.length < 1 || p.length > 64) throw new ProtocolError(`bad ${k} entry`);
        return p;
      });
      const exr = pidList("exr");
      return {
        t: "snap",
        tick: intOf(o, "tick", 0, Number.MAX_SAFE_INTEGER),
        rev: intOf(o, "rev", 0, Number.MAX_SAFE_INTEGER),
        ackSeq: intOf(o, "ackSeq", 0, Number.MAX_SAFE_INTEGER),
        full: boolOf(o, "full"),
        over: boolOf(o, "over"),
        selfId: shortStr(o, "selfId", 64),
        wid: worldIdOf(o),
        roster: arr(o.roster, "roster").map(validateRosterWire),
        wait: arr(o.wait, "wait").map(validateWaitWire),
        ...(o.tok !== undefined ? { tok: shortStr(o, "tok", 64) } : {}),
        seed: intOf(o, "seed", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        floor: intOf(o, "floor", 1, 1e6),
        cleared: boolOf(o, "cleared"),
        exr,
        evTo: intOf(o, "evTo", 0, Number.MAX_SAFE_INTEGER),
        self: o.self === null ? null : validateSelfWire(o.self),
        players: arr(o.players, "players").map(validatePlayerWire),
        enemies: arr(o.enemies, "enemies").map(validateEnemyWire),
        bullets: arr(o.bullets, "bullets").map(validateBulletWire),
        props: arr(o.props, "props").map(validatePropWire),
        pickups: arr(o.pickups, "pickups").map(validatePickupWire),
        chests: arr(o.chests, "chests").map(validateChestWire),
        hzds: arr(o.hzds, "hzds").map(validateHazardWire),
        events: arr(o.events, "events").map(validateWireEvent),
      };
    }
    case "ping":
      return {
        t: "ping",
        id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
        tick: intOf(o, "tick", 0, Number.MAX_SAFE_INTEGER),
        time: num(o, "time", 0, 1e15),
      };
    case "offer": {
      const choices = arr(o.choices, "offer.choices").map((c) => {
        if (typeof c !== "string" || c.length < 1 || c.length > 48) throw new ProtocolError("bad offer choice");
        return c;
      });
      if (choices.length < 1 || choices.length > 8) throw new ProtocolError("bad offer size");
      return { t: "offer", id: intOf(o, "id", 1, Number.MAX_SAFE_INTEGER), choices };
    }
    case "error":
      return { t: "error", code: shortStr(o, "code", 64), msg: typeof o.msg === "string" && o.msg.length <= 256 ? o.msg : "" };
    default:
      throw new ProtocolError(`unknown server type ${String(o.t)}`);
  }
}

export const jsonCodec: Codec = {
  encodeServer: (msg) => JSON.stringify(msg),
  decodeServer: decodeServerMsg,
  encodeClient: (msg) => JSON.stringify(msg),
  decodeClient: decodeClientMsg,
};

// ---- entity <-> wire conversions ----

// Self projection rides the ONE tested projection/apply boundary (playerSnapshot.ts); these two
// map its full-fidelity field names onto the compact wire keys, 1:1.
export function selfWireFromSnapshot(s: AuthoritativePlayerSnapshot): SelfWire {
  return {
    x: s.x, y: s.y, hp: s.hp, mhp: s.maxHp, inv: s.invuln, dnv: s.dashInvuln,
    dcd: s.dashCd, dti: s.dashTime, ddx: s.dashDx, ddy: s.dashDy, fcd: s.fireCd, fng: s.fangCd,
    fac: s.facing, down: s.isDown, rev: s.reviveProgress, out: false, wpn: s.weapon,
    wpns: s.ownedWeapons, items: s.ownedItemIds, mods: s.mods,
    coins: s.coins, kills: s.kills, combo: s.combo, ct: s.comboTimer,
    bcl: s.hasClaimedBossChoice,
  };
}

export function snapshotFromSelfWire(w: SelfWire): AuthoritativePlayerSnapshot {
  return {
    x: w.x, y: w.y, hp: w.hp, maxHp: w.mhp, invuln: w.inv, dashInvuln: w.dnv,
    dashCd: w.dcd, dashTime: w.dti, dashDx: w.ddx, dashDy: w.ddy, fireCd: w.fcd, fangCd: w.fng,
    facing: w.fac, isDown: w.down, reviveProgress: w.rev, weapon: w.wpn,
    ownedWeapons: w.wpns.slice(), ownedItemIds: w.items.slice(), mods: modsFromWire(w.mods),
    coins: w.coins, kills: w.kills, combo: w.combo, comboTimer: w.ct,
    hasClaimedBossChoice: w.bcl,
  };
}

export function toSelfWire(p: PlayerSim): SelfWire {
  // `out` is derived from server-only down bookkeeping (never reconciled back — the
  // prediction world has no down counter to apply it to), so it rides beside the
  // snapshot-projected fields.
  return { ...selfWireFromSnapshot(projectPlayer(p)), out: isPlayerOut(p) };
}

// Reset a predicted local player to authoritative server truth (the reconciliation snap). All
// server-owned fields flow through the exhaustive projection; the client keeps only its own
// client-owned fields (aim etc. — see playerSnapshot.ts).
export function applySelfWire(p: PlayerSim, s: SelfWire): void {
  applyPlayerSnapshot(p, snapshotFromSelfWire(s));
}

// Cosmetic identity attached to a player's wire struct. It lives OUTSIDE the sim (the sim
// stays pure gameplay state); the server keeps it per-connection from the verified join
// ticket and passes it in at snapshot-build time.
export interface PlayerIdentity {
  name: string | null;
  colorIndex: number | null;
}

export function toPlayerWire(p: PlayerSim, identity?: PlayerIdentity): PlayerWire {
  return {
    id: p.id, x: p.x, y: p.y, hp: p.hp, mhp: p.maxHp, fac: p.facing, aim: p.aimAngle, wpn: p.weapon, down: p.isDown,
    rv: p.reviveProgress,
    out: isPlayerOut(p),
    bcl: p.hasClaimedBossChoice,
    ab: p.isAbsent,
    nm: identity?.name ?? p.id,
    cl: identity?.colorIndex ?? null,
  };
}

export function toEnemyWire(e: Enemy): EnemyWire {
  const a = e.attack;
  return {
    id: e.id, kind: e.kind, x: e.x, y: e.y, hp: e.hp, mhp: e.maxHp, r: e.radius, tr: e.tier,
    atk: { ph: a.phase, mv: a.move, wu: a.windup, lk: a.isAimLocked, la: a.lockedAngle, mx: a.markX, my: a.markY },
    bph: e.boss ? e.boss.phase : 0,
    burn: e.burn, chill: e.chill, shock: e.shock,
  };
}

export function toBulletWire(b: Bullet): BulletWire {
  return { x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.radius, friend: b.friendly, color: b.color, fx: b.fx ?? null };
}

// Build a render-ready Enemy from a wire struct at an (interpolated) position. Scratch fields
// the renderer never reads are defaulted; the client's cosmetic anim is keyed by id elsewhere.
export function enemyFromWire(w: EnemyWire, x: number, y: number): Enemy {
  return {
    id: w.id, kind: w.kind, x, y, vx: 0, vy: 0, radius: w.r, hp: w.hp, maxHp: w.mhp, dead: false,
    tier: w.tr, isSummoned: false, kbResist: 1, surgeDelay: 0, surgeTime: 0,
    speed: 0, touchDamage: 0, zig: 0, hopClock: 0, hopMove: 0, spawnTimer: 0, stuckTimer: 0,
    avoidSide: 0, avoidTime: 0,
    burn: w.burn, burnDmg: 0, chill: w.chill, shock: w.shock, statusTick: 0, burnOwner: null,
    attack: {
      phase: w.atk.ph, time: 0, move: w.atk.mv, windup: w.atk.wu, cooldown: 0,
      lockedAngle: w.atk.la, isAimLocked: w.atk.lk, markX: w.atk.mx, markY: w.atk.my,
    },
    boss: w.bph > 0
      ? { phase: w.bph, transitionsDone: 0, roar: null, addTimer: 0, attackCount: 0, isNextRadial: false, burstParity: 0, beatAddIds: [], spinCount: 0 }
      : null,
  };
}

export function toPropWire(p: Prop): PropWire {
  return { id: p.id, kind: p.kind, x: p.x, y: p.y, brk: p.breakT ?? -1 };
}
export function toPickupWire(p: Pickup): PickupWire {
  return { id: p.id, kind: p.kind, x: p.x, y: p.y, wpn: p.weapon, val: p.value ?? -1, bch: p.isBossChoice ?? false };
}
export function toChestWire(c: Chest): ChestWire {
  return { id: c.id, kind: c.kind, x: c.x, y: c.y, op: c.opened, opt: c.openT ?? -1 };
}
export function toHazardWire(h: Hazard): HazardWire {
  return { id: h.id, k: h.kind, x: h.x, y: h.y, r: h.radius, life: h.life, max: h.maxLife };
}

// Radius reconstructed from kind so the wire stays tiny. Matches the sim's placement radii
// (constants.PROP_RADIUS for props; pickups 13/16; chests 16/18) so client collision +
// pickup ranges agree with the server.
export function propFromWire(w: PropWire): Prop {
  return { id: w.id, kind: w.kind, x: w.x, y: w.y, radius: PROP_RADIUS, hp: 1, dead: w.brk >= 0, breakT: w.brk < 0 ? undefined : w.brk };
}
export function pickupFromWire(w: PickupWire): Pickup {
  const radius = w.kind === "weapon" ? 16 : w.kind === "dealer_weapon" ? 15 : 13;
  return { id: w.id, kind: w.kind, x: w.x, y: w.y, radius, weapon: w.wpn, value: w.val < 0 ? undefined : w.val, isBossChoice: w.bch || undefined };
}
export function chestFromWire(w: ChestWire): Chest {
  return { id: w.id, kind: w.kind, x: w.x, y: w.y, radius: w.kind === "boss" ? 18 : 16, opened: w.op, openT: w.opt < 0 ? undefined : w.opt };
}
export function hazardFromWire(w: HazardWire): Hazard {
  return { id: w.id, kind: w.k, x: w.x, y: w.y, radius: w.r, life: w.life, maxLife: w.max };
}

export function bulletFromWire(b: BulletWire): Bullet {
  return {
    x: b.x, y: b.y, vx: b.vx, vy: b.vy, radius: b.r, life: 1, friendly: b.friend,
    owner: null, damage: 0, color: b.color, pierce: 0, hitList: null, isCrit: false,
    fx: b.fx ?? undefined,
  };
}

// ---- interest view (per-client, with enter/exit hysteresis) ----

// An entity ENTERS a client's view inside interestRadius and LEAVES only beyond
// interestRadius * INTEREST_EXIT_FACTOR, so an entity hovering at the boundary doesn't flicker
// in/out of the snapshot (and the client's collision/interp state doesn't pop) every tick.
export const INTEREST_EXIT_FACTOR = 1.15;

// The per-client view membership, keyed by STABLE entity ids. rev-scoped: a new floor (new
// world revision) invalidates every set. Bullets are excluded on purpose — they are fast,
// short-lived, and id-less; plain radius filtering is correct for them. Players are excluded
// too: the party (≤4 members) is a shared objective and always rides every snapshot.
export interface InterestView {
  rev: number;
  enemies: Set<number>;
  props: Set<number>;
  pickups: Set<number>;
  chests: Set<number>;
}

export function createInterestView(): InterestView {
  return { rev: -1, enemies: new Set(), props: new Set(), pickups: new Set(), chests: new Set() };
}

// Snapshot the current server world into a full ServerMsg body for one client. The client's
// own player becomes `self`; everyone else becomes a PlayerWire. events are supplied by the
// caller (per-client reliable stream); evTo is the room's highest committed event id.
export interface SnapshotOpts {
  // The authoritative world id this snapshot describes (REQUIRED — the client asserts it
  // against the room it expected to join; see the v4 protocol note).
  worldId: string;
  // Every seat in this world (verified identities + on/away), independent of interest
  // filtering. Omitted => empty (direct test callers that don't exercise readiness).
  roster?: RosterWire[];
  // Single-use resume token for the receiving connection (full snapshots only).
  resumeToken?: string;
  // Interest radius in px around the client's view center. Entities outside it are omitted from
  // this client's snapshot (the primary bandwidth + CPU lever). <= 0 disables the filter (send
  // everything) — the default, so direct callers/tests keep full snapshots.
  interestRadius?: number;
  // The client's persistent view membership (enter/exit hysteresis). Omitted => no hysteresis
  // (pure radius filter), which full/bootstrap snapshots and tests use.
  view?: InterestView;
  // Per-player cosmetic identity (verified name/color from each join ticket), keyed by the
  // world-scoped player id. Omitted / missing entries fall back to id-as-name, no color.
  identities?: ReadonlyMap<PlayerId, PlayerIdentity>;
  // The interest view center, when it is NOT the client's own player: a downed spectator's
  // view follows the teammate they are watching, so their snapshots stay coherent with what
  // their camera shows. Omitted => centered on self (the ordinary case).
  viewCenter?: { x: number; y: number };
}

// The party-wait state straight off the sim's pending-blessing map, identical for every
// client (sorted for determinism; whole seconds — a countdown readout, not a timer source).
function partyWait(w: WorldState): WaitWire[] {
  if (w.pendingBlessings.size === 0) return [];
  const out: WaitWire[] = [];
  for (const [pid, left] of w.pendingBlessings) out.push({ pid, s: Math.max(0, Math.ceil(left)) });
  out.sort((a, b) => a.pid.localeCompare(b.pid));
  return out;
}

// Interest management: a client always receives its OWN player, EVERY party member (the
// party is a shared objective — spectate/roster/revive prompts need all of it), globally-
// relevant state (the boss enemy and the boss chest), and, in addition, the nearby
// enemies/bullets/props/pickups/chests within its interest radius (with exit hysteresis).
// A simple distance filter is enough for a single bounded floor.
export function buildSnapshot(
  w: WorldState,
  selfPid: PlayerId,
  ackSeq: number,
  events: WireEvent[],
  evTo: number,
  full: boolean,
  opts: SnapshotOpts,
): ServerMsg {
  const self = w.players.get(selfPid);
  const r = opts.interestRadius ?? 0;
  const r2 = r * r;
  const rExit = r * INTEREST_EXIT_FACTOR;
  const rExit2 = rExit * rExit;
  const center = opts.viewCenter ?? (self ? { x: self.x, y: self.y } : null);
  const view = opts.view;
  if (view && view.rev !== w.rev) {
    view.rev = w.rev;
    view.enemies.clear(); view.props.clear(); view.pickups.clear(); view.chests.clear();
  }
  // No radius, or we don't know where this client is looking yet -> send everything.
  const near = (x: number, y: number, wasKnown: boolean): boolean => {
    if (r <= 0 || center === null) return true;
    const dx = x - center.x, dy = y - center.y;
    const d2 = dx * dx + dy * dy;
    return d2 <= r2 || (wasKnown && d2 <= rExit2);
  };

  const players: PlayerWire[] = [];
  for (const p of w.players.values()) {
    if (p.id === selfPid) continue;
    players.push(toPlayerWire(p, opts.identities?.get(p.id)));
  }
  const enemies: EnemyWire[] = [];
  const keepEnemies = new Set<number>();
  for (const e of w.enemies) {
    if (isBossKind(e.kind) || near(e.x, e.y, view?.enemies.has(e.id) ?? false)) { enemies.push(toEnemyWire(e)); keepEnemies.add(e.id); }
  }
  const bullets: BulletWire[] = [];
  for (const b of w.bullets) if (near(b.x, b.y, false)) bullets.push(toBulletWire(b));
  const props: PropWire[] = [];
  const keepProps = new Set<number>();
  for (const p of w.props) {
    if (near(p.x, p.y, view?.props.has(p.id) ?? false)) { props.push(toPropWire(p)); keepProps.add(p.id); }
  }
  const pickups: PickupWire[] = [];
  const keepPickups = new Set<number>();
  for (const p of w.pickups) {
    if (near(p.x, p.y, view?.pickups.has(p.id) ?? false)) { pickups.push(toPickupWire(p)); keepPickups.add(p.id); }
  }
  const chests: ChestWire[] = [];
  const keepChests = new Set<number>();
  for (const c of w.chests) {
    if (c.kind === "boss" || near(c.x, c.y, view?.chests.has(c.id) ?? false)) { chests.push(toChestWire(c)); keepChests.add(c.id); }
  }
  if (view) {
    view.enemies = keepEnemies;
    view.props = keepProps;
    view.pickups = keepPickups;
    view.chests = keepChests;
  }

  return {
    t: "snap",
    tick: w.tick,
    rev: w.rev,
    ackSeq,
    full,
    over: w.isRunOver,
    selfId: selfPid,
    wid: opts.worldId,
    roster: opts.roster ?? [],
    wait: partyWait(w),
    ...(opts.resumeToken !== undefined ? { tok: opts.resumeToken } : {}),
    seed: w.seed,
    floor: w.floor,
    cleared: isFloorCleared(w),
    exr: playersAtExit(w),
    evTo,
    self: self ? toSelfWire(self) : null,
    players,
    enemies,
    bullets,
    props,
    pickups,
    chests,
    // Unfiltered by design: hazards are hard-capped in the sim, and PREDICTED movement
    // must know about a web before the player walks into interest range of its center.
    hzds: w.hazards.map(toHazardWire),
    events,
  };
}
