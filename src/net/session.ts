import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { ProfileDoc, PlayerStatsDoc, LocalRunArgs, RunHistoryEntryDoc } from "./api.js";
import type { RunResult } from "../game/game.js";
import {
  validateRun, foldRunIntoAggregates, emptyAggregates, scoreForRun, favoriteWeapon,
} from "../../convex/statsCore.js";

const CLIENT_ID_KEY = "blobrogue.clientId";
const NAME_KEY = "blobrogue.name";
const COLOR_KEY = "blobrogue.color";
const LOCAL_STATS_KEY = "blobrogue.localstats.v1";
const LOCAL_RUNS_KEY = "blobrogue.localruns.v1";
const LOCAL_RUNS_MAX = 20;

function readOrMintClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, minted);
    return minted;
  } catch {
    // Private mode / storage disabled: fall back to an in-memory id for this tab.
    return crypto.randomUUID();
  }
}

function readStoredColor(): number | null {
  try {
    const raw = localStorage.getItem(COLOR_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 15 ? n : null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: object): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

// Translate a finished run into the shared submission shape (the exact fields
// convex/statsCore.ts validates). Reused for the Convex call AND the local mirror fold.
function localRunArgs(clientId: string, result: RunResult): LocalRunArgs {
  return {
    clientId,
    submissionId: crypto.randomUUID(),
    mode: result.mode,
    result: result.result,
    floor: Math.max(1, Math.round(result.floor)),
    startFloor: result.stats.startFloor,
    kills: result.kills,
    coins: result.coins,
    coinsEarned: Math.round(result.stats.coinsEarned),
    coinsSpent: Math.round(result.stats.coinsSpent),
    durationMs: Math.round(result.durationMs),
    damageDealt: Math.round(result.stats.damageDealt),
    damageTaken: Math.round(result.stats.damageTaken),
    bestCombo: result.stats.bestCombo,
    bossKills: result.stats.bossKills,
    bossKillFloors: result.stats.bossKillFloors,
    ...(result.stats.firstBossKillMs !== null ? { firstBossKillMs: result.stats.firstBossKillMs } : {}),
    killsByWeapon: Object.fromEntries(Object.entries(result.stats.killsByWeapon).map(([k, n]) => [k, n ?? 0])),
    weapons: result.weapons,
    blessings: result.blessings,
    ...(result.stats.deathCause !== null ? { deathCause: result.stats.deathCause } : {}),
    partySize: Math.max(1, Math.round(result.stats.partySize)),
  };
}

// The local snapshot the profile panel renders when no backend is reachable (offline build,
// or a guest whose network call failed). Same shapes as the Convex reads.
export interface LocalStatsSnapshot {
  stats: PlayerStatsDoc;
  runs: RunHistoryEntryDoc[];
}

// Owns the persistent player identity (name + chosen blob color) and their saved stats.
// Works with or without a Convex client: with none, it just remembers everything locally.
export class Session {
  readonly clientId: string;
  name: string;
  // Chosen blob tint (client palette index). null = never picked (renders the natural
  // amber hero). Persisted locally always, and onto the Convex profile at login so
  // signed-in players keep it across devices.
  colorIndex: number | null;
  profile: ProfileDoc | null = null;
  private client: ConvexClient | null;

  constructor(client: ConvexClient | null) {
    this.client = client;
    this.clientId = readOrMintClientId();
    let stored = "";
    try { stored = localStorage.getItem(NAME_KEY) ?? ""; } catch { stored = ""; }
    this.name = stored;
    this.colorIndex = readStoredColor();
  }

  get playerId(): string | null {
    return this.profile?.playerId ?? null;
  }

  get isOnline(): boolean {
    return this.client !== null;
  }

  private persistName(name: string) {
    this.name = name;
    try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
  }

  setColorIndex(colorIndex: number) {
    this.colorIndex = colorIndex;
    try { localStorage.setItem(COLOR_KEY, String(colorIndex)); } catch { /* ignore */ }
    // Persist the pick onto the profile in the background; the local value already applies.
    if (this.client) void this.login(this.name || "blob").catch(() => {});
  }

  async login(name: string): Promise<ProfileDoc | null> {
    this.persistName(name);
    if (!this.client) return null;
    this.profile = await this.client.mutation(api.players.ensurePlayer, {
      clientId: this.clientId,
      name,
      // Only an explicit local pick is sent — undefined never overwrites a saved pick.
      ...(this.colorIndex !== null ? { colorIndex: this.colorIndex } : {}),
    });
    // A signed-in account may carry a pick made on another device; adopt it locally.
    if (this.colorIndex === null && this.profile.colorIndex !== null) {
      this.colorIndex = this.profile.colorIndex;
      try { localStorage.setItem(COLOR_KEY, String(this.profile.colorIndex)); } catch { /* ignore */ }
    }
    return this.profile;
  }

  async refreshProfile(): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    this.profile = await this.client.query(api.players.getProfile, { clientId: this.clientId });
    return this.profile;
  }

  // Record a LOCALLY SIMULATED run (solo / classic co-op). Two sinks, both always fed:
  //   1. localStorage mirror — the offline/guest fallback the profile panel can render
  //      with no backend at all.
  //   2. Convex stats:recordLocalRun — personal stats/history only (source "local");
  //      by design it can never touch a leaderboard, so this untrusted path stays honest.
  // ONLINE runs must NOT come through here: the authoritative server reports those itself.
  async recordRun(result: RunResult): Promise<ProfileDoc | null> {
    const args = localRunArgs(this.clientId, result);
    this.foldLocalMirror(args);
    if (!this.client) return null;
    try {
      await this.client.mutation(api.stats.recordLocalRun, args);
      this.profile = await this.client.query(api.players.getProfile, { clientId: this.clientId });
    } catch {
      // Never let a stats-save failure interrupt the play loop.
    }
    return this.profile;
  }

  private foldLocalMirror(args: LocalRunArgs): void {
    // Same validation + fold the backend runs (imported from convex/statsCore) — the
    // mirror can't drift from the server's aggregation semantics.
    const validated = validateRun({ ...args, firstBossKillMs: args.firstBossKillMs ?? null });
    if (!validated.ok) return;
    const run = validated.run;
    const prev = readJson<PlayerStatsDoc["aggregates"]>(LOCAL_STATS_KEY) ?? emptyAggregates();
    writeJson(LOCAL_STATS_KEY, foldRunIntoAggregates({ ...emptyAggregates(), ...prev }, run));
    const entry: RunHistoryEntryDoc = {
      runId: args.submissionId,
      source: "local",
      mode: run.mode,
      difficulty: run.difficulty,
      result: run.result,
      floor: run.floor,
      startFloor: run.startFloor,
      kills: run.kills,
      coins: run.coins,
      durationMs: run.durationMs,
      damageDealt: run.damageDealt,
      damageTaken: run.damageTaken,
      bestCombo: run.bestCombo,
      bossKills: run.bossKills,
      bossKillFloors: run.bossKillFloors,
      firstBossKillMs: run.firstBossKillMs,
      weapons: run.weapons,
      blessings: run.blessings,
      deathCause: run.deathCause,
      partySize: run.partySize,
      score: scoreForRun(run),
      endedAt: Date.now(),
    };
    const log = readJson<RunHistoryEntryDoc[]>(LOCAL_RUNS_KEY) ?? [];
    writeJson(LOCAL_RUNS_KEY, [entry, ...log].slice(0, LOCAL_RUNS_MAX));
  }

  localStatsSnapshot(): LocalStatsSnapshot {
    const aggregates = { ...emptyAggregates(), ...(readJson<PlayerStatsDoc["aggregates"]>(LOCAL_STATS_KEY) ?? {}) };
    return {
      stats: {
        playerId: "local",
        name: this.name || "blob",
        isAccount: false,
        aggregates,
        favoriteWeapon: favoriteWeapon(aggregates.killsByWeapon),
        hasExtendedStats: true, // the mirror only ever holds post-tracking runs
      },
      runs: readJson<RunHistoryEntryDoc[]>(LOCAL_RUNS_KEY) ?? [],
    };
  }
}
