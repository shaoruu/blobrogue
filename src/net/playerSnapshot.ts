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
  dashInvuln: number;
  dashCd: number;
  dashTime: number;
  dashDx: number;
  dashDy: number;
  fireCd: number;
  fangCd: number;
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
  hasClaimedBossChoice: boolean;
}

type ServerOwnedField = keyof AuthoritativePlayerSnapshot;

// Client-owned / non-wire PlayerSim fields, each with the reason it stays off the wire:
// - id:            transport identity (snapshots carry selfId separately)
// - pr:            constant collision radius
// - aimAngle:      the client owns its own aim (never reconciled, or the cursor would fight)
// - shotSeq:       legacy presence-driven remote-shot FX counter (server FX ride events instead)
// - rewindTicks:   server-internal lag-comp bookkeeping, meaningless to a client
// - meleeSwing:    derived swing state; the client's own prediction recreates it from inputs
// - isInteracting: per-tick input derivative (the interact key) — the wire carries the input
//                  bit itself; both server and prediction re-derive this from consumed inputs
// - isAbsent:      connection-lifecycle bookkeeping (reserved reconnect seat). The OWNING
//                  client is by definition connected whenever it can receive a SelfWire, so
//                  it would always read false there; others see it via PlayerWire.ab instead.
type ClientOwnedField = "id" | "pr" | "aimAngle" | "shotSeq" | "rewindTicks" | "meleeSwing" | "isInteracting" | "isAbsent";
// Server-only revive/down bookkeeping, off the reconcile snapshot entirely:
// - reviveBy:       the channel's identity (WHO is reviving whom) — prediction has no
//                   teammates to bind it to; the readouts ride SelfWire.rev / PlayerWire.rv
// - downsThisFloor: the per-floor down count behind the OUT state — the client consumes
//                   the derived out flag on the wire, never the counter
type ServerOnlyField = "reviveBy" | "downsThisFloor";

// Compile-time exhaustiveness: every PlayerSim key must be classified exactly once. The
// MustBeNever constraint fails to instantiate for any non-empty type, so adding a PlayerSim
// field without classifying it above (or classifying it twice) is a COMPILE error here.
type MustBeNever<T extends never> = T;
export type _AssertAllPlayerFieldsClassified = MustBeNever<Exclude<keyof PlayerSim, ServerOwnedField | ClientOwnedField | ServerOnlyField>>;
export type _AssertClassificationDisjoint = MustBeNever<Extract<ServerOwnedField, ClientOwnedField | ServerOnlyField>>;

// Project the server-owned slice out of a live player. Arrays/objects are copied so the
// snapshot never aliases sim state.
export function projectPlayer(p: PlayerSim): AuthoritativePlayerSnapshot {
  return {
    x: p.x,
    y: p.y,
    hp: p.hp,
    maxHp: p.maxHp,
    invuln: p.invuln,
    dashInvuln: p.dashInvuln,
    dashCd: p.dashCd,
    dashTime: p.dashTime,
    dashDx: p.dashDx,
    dashDy: p.dashDy,
    fireCd: p.fireCd,
    fangCd: p.fangCd,
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
    hasClaimedBossChoice: p.hasClaimedBossChoice,
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
  p.dashInvuln = s.dashInvuln;
  p.dashCd = s.dashCd;
  p.dashTime = s.dashTime;
  p.dashDx = s.dashDx;
  p.dashDy = s.dashDy;
  p.fireCd = s.fireCd;
  p.fangCd = s.fangCd;
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
  p.hasClaimedBossChoice = s.hasClaimedBossChoice;
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
