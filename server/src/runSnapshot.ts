import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { AuthoritativePlayerSnapshot } from "../../src/net/playerSnapshot.js";
import { isValidWorldId } from "../../src/net/worldId.js";
import type { BlessingOfferHistory, WeaponOfferHistory } from "../../src/sim/offerHistory.js";
import type { PlayerId } from "../../src/sim/input.js";
import type { WeaponBag } from "../../src/sim/weaponBag.js";
import { isKitId, type KitId } from "../../src/sim/kits.js";
import { createMods, itemById } from "../../src/sim/items.js";
import { WEAPONS } from "../../src/sim/weapons.js";
import { contentCatalogFor, LEGACY_CONTENT_CATALOG_VERSION } from "../../src/sim/contentCatalog.js";
import { writeJsonAtomic } from "./durableJson.js";

export const RUN_SNAPSHOT_FIDELITY = "build+floor" as const;

export interface RunSnapshotSeat {
  pid: PlayerId;
  authName: string;
  token: string;
  prevToken: string | null;
  displayName: string | null;
  colorIndex: number | null;
  hat: string | null;
  face: string | null;
  pet: string | null;
  kitId: KitId;
  lastAppliedSeq: number;
  lastCseq: number;
}

export interface RunSnapshotPlayer {
  pid: PlayerId;
  offerIdentity: string;
  state: AuthoritativePlayerSnapshot;
  pet: string | null;
  weaponOfferHistory: WeaponOfferHistory;
  blessingOfferHistory: BlessingOfferHistory;
  blessingOfferOrdinal: number;
  shopWeaponOfferOrdinal: number;
  shopBlessingOfferOrdinal: number;
  premiumWeaponOfferOrdinal: number;
  seat: RunSnapshotSeat;
}

export interface RunSnapshot {
  version: 1;
  fidelity: typeof RUN_SNAPSHOT_FIDELITY;
  createdAt: string;
  worldId: string;
  seed: number;
  floor: number;
  encounterPlayers: number;
  pityStreak: number;
  weaponBag: WeaponBag;
  players: RunSnapshotPlayer[];
}

const PLAYER_NUMBER_FIELDS: ReadonlyArray<keyof AuthoritativePlayerSnapshot> = [
  "x", "y", "hp", "maxHp", "invuln", "dashInvuln", "dashCd", "dashTime", "dashDx", "dashDy",
  "fireCd", "chargeT", "fangCd", "facing", "warmthIdleSec", "warmthPathPx", "reviveProgress",
  "kills", "coins", "combo", "comboTimer", "premiumHpBuys", "amberWindfall", "reviveTokens",
  "extraWeaponSlots", "hpTithe", "prospectorFloor", "ultCharge", "ultReadyAtTick", "overdriveT",
  "overheatT", "overshield", "pulseReadyAtTick", "phaseSpeed", "ultInvuln", "passiveState",
  "petCdReadyAtTick", "petTellT", "petLightT", "petFetchT", "petShieldT", "petNullT", "respawnT",
  "spawnGraceT", "spawnShieldT", "spawnProtectionStartedTick", "spawnHardGraceEndsAtTick",
  "spawnShieldEndsAtTick", "hearthFavorT", "hearthEmberT",
];

const PLAYER_BOOLEAN_FIELDS: ReadonlyArray<keyof AuthoritativePlayerSnapshot> = [
  "isMuddyRefundSpent", "isDown", "isWarmthChilled", "hasClaimedBossChoice",
  "isAmberCacheArmed", "isBlessingRerollArmed", "isSpawnOffenseLatched",
];
const PLAYER_MOD_FIELDS = Object.keys(createMods());

function isSnapshotToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function isWeaponId(value: string): boolean {
  return Object.hasOwn(WEAPONS, value);
}

function isSupportedCatalogVersion(value: WeaponBag["catalogVersion"]): boolean {
  try {
    contentCatalogFor(value ?? LEGACY_CONTENT_CATALOG_VERSION);
    return true;
  } catch {
    return false;
  }
}

function isPlayerSnapshot(value: AuthoritativePlayerSnapshot): boolean {
  for (const field of PLAYER_NUMBER_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) return false;
  }
  for (const field of PLAYER_BOOLEAN_FIELDS) {
    if (typeof value[field] !== "boolean") return false;
  }
  return value.maxHp > 0
    && typeof value.weapon === "string"
    && isWeaponId(value.weapon)
    && Array.isArray(value.ownedWeapons)
    && value.ownedWeapons.every((weapon) => typeof weapon === "string" && isWeaponId(weapon))
    && typeof value.weaponFireCooldowns === "object"
    && value.weaponFireCooldowns !== null
    && Object.keys(value.weaponFireCooldowns).every(isWeaponId)
    && Object.values(value.weaponFireCooldowns).every((cooldown) => (
      typeof cooldown === "number" && Number.isFinite(cooldown)
    ))
    && typeof value.weaponCycles === "object"
    && value.weaponCycles !== null
    && Number.isSafeInteger(value.weaponCycles.sluicegate)
    && Number.isSafeInteger(value.weaponCycles.oddsmaker)
    && Array.isArray(value.ownedItemIds)
    && value.ownedItemIds.every((item) => typeof item === "string" && itemById(item) !== undefined)
    && typeof value.mods === "object"
    && value.mods !== null
    && Object.keys(value.mods).length === PLAYER_MOD_FIELDS.length
    && PLAYER_MOD_FIELDS.every((field) => Object.hasOwn(value.mods, field))
    && Object.values(value.mods).every((modifier) => (
      typeof modifier === "number" && Number.isFinite(modifier)
    ))
    && (value.reviveBy === null || typeof value.reviveBy === "string")
    && isKitId(value.kitId)
    && typeof value.arenaUltKit === "string";
}

function isRunSnapshot(value: RunSnapshot): boolean {
  if (value.version !== 1
    || value.fidelity !== RUN_SNAPSHOT_FIDELITY
    || !isValidWorldId(value.worldId)
    || !Number.isSafeInteger(value.seed)
    || !Number.isSafeInteger(value.floor)
    || value.floor < 1
    || value.floor > 1000
    || !Number.isSafeInteger(value.encounterPlayers)
    || value.encounterPlayers < 1
    || value.encounterPlayers > 4
    || !Number.isSafeInteger(value.pityStreak)
    || value.pityStreak < 0
    || !Array.isArray(value.players)
    || value.players.length < 1
    || value.players.length > 4
    || typeof value.weaponBag !== "object"
    || value.weaponBag === null
    || !Number.isSafeInteger(value.weaponBag.seed)
    || !Number.isSafeInteger(value.weaponBag.refills)
    || !Number.isSafeInteger(value.weaponBag.weightedDraws)
    || !isSupportedCatalogVersion(value.weaponBag.catalogVersion)
    || !Array.isArray(value.weaponBag.order)
    || !value.weaponBag.order.every((weapon) => typeof weapon === "string" && isWeaponId(weapon))
    || !Array.isArray(value.weaponBag.recentWeaponOffers)
    || !value.weaponBag.recentWeaponOffers.every((weapon) => typeof weapon === "string" && isWeaponId(weapon))
    || typeof value.weaponBag.weaponSeenCounts !== "object"
    || value.weaponBag.weaponSeenCounts === null
    || !Object.keys(value.weaponBag.weaponSeenCounts).every(isWeaponId)
    || !Object.values(value.weaponBag.weaponSeenCounts).every((count) => (
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ))) {
    return false;
  }
  const playerIds = new Set<string>();
  const authNames = new Set<string>();
  for (const player of value.players) {
    if (typeof player !== "object"
      || player === null
      || typeof player.pid !== "string"
      || playerIds.has(player.pid)
      || typeof player.offerIdentity !== "string"
      || typeof player.state !== "object"
      || player.state === null
      || !isPlayerSnapshot(player.state)
      || (typeof player.pet !== "string" && player.pet !== null)
      || typeof player.weaponOfferHistory !== "object"
      || player.weaponOfferHistory === null
      || typeof player.weaponOfferHistory.weaponSeenCounts !== "object"
      || player.weaponOfferHistory.weaponSeenCounts === null
      || !Object.keys(player.weaponOfferHistory.weaponSeenCounts).every(isWeaponId)
      || !Object.values(player.weaponOfferHistory.weaponSeenCounts).every((count) => (
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ))
      || !Array.isArray(player.weaponOfferHistory.recentWeaponOffers)
      || !player.weaponOfferHistory.recentWeaponOffers.every(isWeaponId)
      || typeof player.blessingOfferHistory !== "object"
      || player.blessingOfferHistory === null
      || typeof player.blessingOfferHistory.blessingSeenCounts !== "object"
      || player.blessingOfferHistory.blessingSeenCounts === null
      || !Object.keys(player.blessingOfferHistory.blessingSeenCounts).every((item) => itemById(item) !== undefined)
      || !Object.values(player.blessingOfferHistory.blessingSeenCounts).every((count) => (
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ))
      || !Array.isArray(player.blessingOfferHistory.recentBlessingOffers)
      || !player.blessingOfferHistory.recentBlessingOffers.every((offer) => (
        Array.isArray(offer)
        && offer.every((item) => typeof item === "string" && itemById(item) !== undefined)
      ))
      || !Number.isSafeInteger(player.blessingOfferOrdinal)
      || !Number.isSafeInteger(player.shopWeaponOfferOrdinal)
      || !Number.isSafeInteger(player.shopBlessingOfferOrdinal)
      || !Number.isSafeInteger(player.premiumWeaponOfferOrdinal)
      || typeof player.seat !== "object"
      || player.seat === null
      || player.seat.pid !== player.pid
      || typeof player.seat.authName !== "string"
      || authNames.has(player.seat.authName)
      || !isSnapshotToken(player.seat.token)
      || (player.seat.prevToken !== null && !isSnapshotToken(player.seat.prevToken))
      || !isKitId(player.seat.kitId)
      || !Number.isSafeInteger(player.seat.lastAppliedSeq)
      || !Number.isSafeInteger(player.seat.lastCseq)) {
      return false;
    }
    playerIds.add(player.pid);
    authNames.add(player.seat.authName);
  }
  return true;
}

export class RunSnapshotStore {
  constructor(private directory: string | null) {}

  isEnabled(): boolean {
    return this.directory !== null;
  }

  pathFor(worldId: string): string | null {
    if (this.directory === null || !isValidWorldId(worldId)) return null;
    return join(this.directory, `${worldId}.json`);
  }

  has(worldId: string): boolean {
    return this.load(worldId) !== null;
  }

  save(snapshot: RunSnapshot): string {
    if (this.directory === null) throw new Error("run snapshot storage is disabled");
    const path = this.pathFor(snapshot.worldId);
    if (path === null) throw new Error("run snapshot storage is disabled");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, snapshot);
    return path;
  }

  load(worldId: string): RunSnapshot | null {
    const path = this.pathFor(worldId);
    if (path === null) return null;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let snapshot: RunSnapshot;
    try {
      snapshot = JSON.parse(raw) as RunSnapshot;
    } catch {
      throw new Error(`run snapshot is malformed: ${worldId}`);
    }
    if (!isRunSnapshot(snapshot) || snapshot.worldId !== worldId) {
      throw new Error(`run snapshot is invalid: ${worldId}`);
    }
    return snapshot;
  }

  loadAll(onInvalid: (worldId: string, reason: string) => void = () => {}): RunSnapshot[] {
    if (this.directory === null) return [];
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const snapshots: RunSnapshot[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const worldId = name.slice(0, -5);
      if (!isValidWorldId(worldId)) continue;
      try {
        const snapshot = this.load(worldId);
        if (snapshot !== null) snapshots.push(snapshot);
      } catch (error) {
        onInvalid(worldId, error instanceof Error ? error.message : String(error));
      }
    }
    return snapshots;
  }

  remove(worldId: string): void {
    const path = this.pathFor(worldId);
    if (path === null) return;
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
