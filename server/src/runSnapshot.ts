import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { AuthoritativePlayerSnapshot } from "../../src/net/playerSnapshot.js";
import { isValidWorldId } from "../../src/net/worldId.js";
import type { BlessingOfferHistory, WeaponOfferHistory } from "../../src/sim/offerHistory.js";
import type { PlayerId } from "../../src/sim/input.js";
import type { WeaponBag } from "../../src/sim/weaponBag.js";
import type { KitId } from "../../src/sim/kits.js";
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

function isSnapshotToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
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
    || value.weaponBag === null) {
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
      || !Number.isFinite(player.state.hp)
      || !Number.isFinite(player.state.maxHp)
      || player.state.maxHp <= 0
      || typeof player.seat !== "object"
      || player.seat === null
      || player.seat.pid !== player.pid
      || typeof player.seat.authName !== "string"
      || authNames.has(player.seat.authName)
      || !isSnapshotToken(player.seat.token)
      || (player.seat.prevToken !== null && !isSnapshotToken(player.seat.prevToken))) {
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

  loadAll(): RunSnapshot[] {
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
      const snapshot = this.load(worldId);
      if (snapshot !== null) snapshots.push(snapshot);
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
