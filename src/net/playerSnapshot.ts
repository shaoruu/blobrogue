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
import type { KitId } from "../sim/kits.js";

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
  chargeT: number;
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
  premiumHpBuys: number;
  isAmberCacheArmed: boolean;
  amberWindfall: number;
  isBlessingRerollArmed: boolean;
  reviveTokens: number;
  extraWeaponSlots: number;
  hpTithe: number;
  prospectorFloor: number;
  // KIT / ULT authoritative state (server-owned; the client reconciles + renders it).
  kitId: KitId;
  ultCharge: number;
  ultReadyAtTick: number;
  overdriveT: number;
  overheatT: number;
  overshield: number;
  pulseReadyAtTick: number;
  phaseSpeed: number;
  ultInvuln: number;
  passiveState: number;
  // pvp respawn countdown (ticks; 0 = alive). Server-owned + reconciled so client prediction
  // gates movement/shooting on the local player's dead-awaiting-respawn state. Always 0 in co-op.
  respawnT: number;
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
// - isUltRequested:  per-tick input derivative (the ult key) — re-derived from the consumed
//                  input every stepPlayerPhase (server + prediction), never wired, so a client
//                  can only REQUEST an ult; the server alone validates + resolves it.
// - isPulseRequested: per-tick input derivative (the Mender pulse key) — re-derived from the
//                  consumed input every stepPlayerPhase (server + prediction), never wired, so a
//                  client can only REQUEST a pulse; the server alone validates + resolves it.
type ClientOwnedField = "id" | "pr" | "aimAngle" | "shotSeq" | "rewindTicks" | "meleeSwing" | "isInteracting" | "isAbsent" | "isUltRequested" | "isPulseRequested";
// Server-only revive/down bookkeeping, off the reconcile snapshot entirely:
// - reviveBy:       the channel's identity (WHO is reviving whom) — prediction has no
//                   teammates to bind it to; the readouts ride SelfWire.rev / PlayerWire.rv
// - downsThisFloor: the per-floor down count behind the OUT state — the client consumes
//                   the derived out flag on the wire, never the counter
// - ultSources/ultWasted: §10 server-side charge-accrual bookkeeping (per-source share caps +
//   the wasted-overcharge tuning stat). The client only ever reconciles the TOTAL meter
//   (ultCharge), and never accrues locally, so these never cross the wire.
// - overshieldRegenT: BULWARK overshield regen bookkeeping (the paused-under-fire countdown). The
//   client only needs the POOL (overshield) to draw the chip layer; the regen clock is pure
//   server upkeep and never accrues in prediction, so it stays off the wire.
// - team:      pvp FFA team id — always 0 for the local player (self) in the FFA MVP, so it need
//              not ride SelfWire; other players' teams ride PlayerWire.tm (built in toPlayerWire).
// - lastDamagedTick: the tick a landed hit last cut this player, driving the MENDER post-damage
//              SELF-heal delay. Self-heal resolves only in the authoritative world phase (never in
//              prediction), so this is pure server upkeep and never crosses the wire.
// - selfHealReadyTick: the earliest tick the next MENDER self-heal HP may land (the sustained
//              self-heal ceiling). Same story as lastDamagedTick — world-phase-only self-heal
//              bookkeeping, off the wire.
// - lastPvpHitBy/lastPvpHitTick: authoritative ring-out credit bookkeeping.
// - pvpDraft*: authoritative offer cadence, deterministic seed identity, and comeback weighting.
//              The server sends the validated offer itself; prediction never rolls an online pick.
type ServerOnlyField =
  | "reviveBy"
  | "downsThisFloor"
  | "ultSources"
  | "ultWasted"
  | "overshieldRegenT"
  | "team"
  | "lastDamagedTick"
  | "selfHealReadyTick"
  | "lastPvpHitBy"
  | "lastPvpHitTick"
  | "pvpDraftFrags"
  | "pvpNextDraftTick"
  | "pvpDraftOrdinal"
  | "pvpDraftTick"
  | "pvpDraftTierBump";

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
    chargeT: p.chargeT,
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
    premiumHpBuys: p.premiumHpBuys,
    isAmberCacheArmed: p.isAmberCacheArmed,
    amberWindfall: p.amberWindfall,
    isBlessingRerollArmed: p.isBlessingRerollArmed,
    reviveTokens: p.reviveTokens,
    extraWeaponSlots: p.extraWeaponSlots,
    hpTithe: p.hpTithe,
    prospectorFloor: p.prospectorFloor,
    kitId: p.kitId,
    ultCharge: p.ultCharge,
    ultReadyAtTick: p.ultReadyAtTick,
    overdriveT: p.overdriveT,
    overheatT: p.overheatT,
    overshield: p.overshield,
    pulseReadyAtTick: p.pulseReadyAtTick,
    phaseSpeed: p.phaseSpeed,
    ultInvuln: p.ultInvuln,
    passiveState: p.passiveState,
    respawnT: p.respawnT,
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
  p.chargeT = s.chargeT;
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
  p.premiumHpBuys = s.premiumHpBuys;
  p.isAmberCacheArmed = s.isAmberCacheArmed;
  p.amberWindfall = s.amberWindfall;
  p.isBlessingRerollArmed = s.isBlessingRerollArmed;
  p.reviveTokens = s.reviveTokens;
  p.extraWeaponSlots = s.extraWeaponSlots;
  p.hpTithe = s.hpTithe;
  p.prospectorFloor = s.prospectorFloor;
  p.kitId = s.kitId;
  p.ultCharge = s.ultCharge;
  p.ultReadyAtTick = s.ultReadyAtTick;
  p.overdriveT = s.overdriveT;
  p.overheatT = s.overheatT;
  p.overshield = s.overshield;
  p.pulseReadyAtTick = s.pulseReadyAtTick;
  p.phaseSpeed = s.phaseSpeed;
  p.ultInvuln = s.ultInvuln;
  p.passiveState = s.passiveState;
  p.respawnT = s.respawnT;
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
