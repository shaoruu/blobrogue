// The ONE projection/apply boundary between the authoritative PlayerSim and the wire (TD audit:
// the split-inventory bug came from ad-hoc manual copying that silently missed fields). Every
// PlayerSim field is classified EXACTLY ONCE below as either server-owned (projected to the wire
// and applied back on reconcile) or client-owned (never on the wire). Adding a field to
// PlayerSim without classifying it here is a COMPILE error, so a new piece of player state can
// never fork authority again. protocol.ts encodes/decodes SelfWire through this module, and
// WSTransport copies predicted -> render players through it too — one boundary, three call sites.

import type { PlayerSim } from "../sim/world.js";
import type { PlayerMods } from "../sim/items.js";
import { createMods } from "../sim/items.js";
import type { WeaponId } from "../sim/types.js";

// The authoritative (server-owned) slice of a player: everything the server simulates and the
// client must treat as truth. This is the full-fidelity projection; SelfWire is its compact
// wire encoding (short keys), mapped 1:1 in protocol.ts.
export interface AuthoritativePlayerSnapshot {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  invuln: number;
  dashCd: number;
  dashTime: number;
  dashDx: number;
  dashDy: number;
  fireCd: number;
  facing: number;
  weapon: WeaponId;
  ownedWeapons: WeaponId[];
  ownedItemIds: string[];
  mods: PlayerMods;
  isDown: boolean;
  reviveProgress: number;
  kills: number;
  coins: number;
  combo: number;
  comboTimer: number;
}

type ServerOwnedField = keyof AuthoritativePlayerSnapshot;

// Client-owned / non-wire PlayerSim fields, each with the reason it stays off the wire:
// - id:          transport identity (snapshots carry selfId separately)
// - pr:          constant collision radius
// - aimAngle:    the client owns its own aim (never reconciled, or the cursor would fight)
// - shotSeq:     legacy presence-driven remote-shot FX counter (server FX ride events instead)
// - rewindTicks: server-internal lag-comp bookkeeping, meaningless to a client
// - meleeSwing:  derived swing state; the client's own prediction recreates it from inputs
type ClientOwnedField = "id" | "pr" | "aimAngle" | "shotSeq" | "rewindTicks" | "meleeSwing";

// Compile-time exhaustiveness: every PlayerSim key must be classified exactly once. A new field
// fails BOTH assertions until it is added to one (and only one) of the two lists above.
type Unclassified = Exclude<keyof PlayerSim, ServerOwnedField | ClientOwnedField>;
type DoublyClassified = Extract<ServerOwnedField, ClientOwnedField>;
type AssertTrue<T extends true> = T;
export type _AssertAllPlayerFieldsClassified = AssertTrue<Unclassified extends never ? true : never>;
export type _AssertClassificationDisjoint = AssertTrue<DoublyClassified extends never ? true : never>;

// Project the server-owned slice out of a live player. Arrays/objects are copied so the
// snapshot never aliases sim state.
export function projectPlayer(p: PlayerSim): AuthoritativePlayerSnapshot {
  return {
    x: p.x,
    y: p.y,
    hp: p.hp,
    maxHp: p.maxHp,
    invuln: p.invuln,
    dashCd: p.dashCd,
    dashTime: p.dashTime,
    dashDx: p.dashDx,
    dashDy: p.dashDy,
    fireCd: p.fireCd,
    facing: p.facing,
    weapon: p.weapon,
    ownedWeapons: p.ownedWeapons.slice(),
    ownedItemIds: p.ownedItemIds.slice(),
    mods: { ...p.mods },
    isDown: p.isDown,
    reviveProgress: p.reviveProgress,
    kills: p.kills,
    coins: p.coins,
    combo: p.combo,
    comboTimer: p.comboTimer,
  };
}

// Apply an authoritative snapshot back onto a player (reconciliation reset / render-player
// refresh). Mods are assigned onto the existing object so held references stay valid.
export function applyPlayerSnapshot(p: PlayerSim, s: AuthoritativePlayerSnapshot): void {
  p.x = s.x;
  p.y = s.y;
  p.hp = s.hp;
  p.maxHp = s.maxHp;
  p.invuln = s.invuln;
  p.dashCd = s.dashCd;
  p.dashTime = s.dashTime;
  p.dashDx = s.dashDx;
  p.dashDy = s.dashDy;
  p.fireCd = s.fireCd;
  p.facing = s.facing;
  p.weapon = s.weapon;
  p.ownedWeapons = s.ownedWeapons.slice();
  p.ownedItemIds = s.ownedItemIds.slice();
  Object.assign(p.mods, s.mods);
  p.isDown = s.isDown;
  p.reviveProgress = s.reviveProgress;
  p.kills = s.kills;
  p.coins = s.coins;
  p.combo = s.combo;
  p.comboTimer = s.comboTimer;
}

// Reconstruct a full PlayerMods from a received mods value (a JSON-parse boundary: the input is
// unknown and every field is narrowed here), defaulting any missing/invalid field to its
// identity so a malformed frame can't leave holes. Unknown keys are dropped (only fields
// createMods defines survive).
export function modsFromWire(w: unknown): PlayerMods {
  const base = createMods();
  if (typeof w !== "object" || w === null) return base;
  const src = w as Record<string, number | undefined>;
  for (const key of Object.keys(base) as Array<keyof PlayerMods>) {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) base[key] = v;
  }
  return base;
}
