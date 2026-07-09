// Pure run-result logic shared by every submission path: field validation + clamping, the
// derived score, aggregate folding, and per-category leaderboard bests. No Convex imports —
// it runs in the Convex default runtime, in Node (the game server's reporter + tsx tests),
// and nothing here trusts its input: the caller supplies parsed JSON and this module decides
// exactly what survives. Clients can therefore never invent score/depth/kills — a submitted
// number either round-trips these clamps or the submission is rejected.

// Difficulty is authoritative-server-owned. The schema/API accept the enum TODAY with a
// "standard" default so the in-flight difficulty feature (Casual/Standard/Brutal) plugs in
// by just passing its value through — no schema migration later.
export type Difficulty = "casual" | "standard" | "brutal";
export const DIFFICULTIES: readonly Difficulty[] = ["casual", "standard", "brutal"];
export const DEFAULT_DIFFICULTY: Difficulty = "standard";

export type RunSource = "server" | "local";
export type RunMode = "solo" | "coop" | "online";
export type RunOutcome = "death" | "victory" | "abandon";
export const RUN_MODES: readonly RunMode[] = ["solo", "coop", "online"];
export const RUN_OUTCOMES: readonly RunOutcome[] = ["death", "victory", "abandon"];

// Parsed-JSON top type (what JSON.parse can produce), so validation never needs `any`.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// A validated, clamped run. Every field is bounded below; nothing else survives validation.
export interface CleanRun {
  difficulty: Difficulty;
  mode: RunMode;
  result: RunOutcome;
  floor: number;      // deepest floor reached when the run ended
  startFloor: number; // floor the player entered on (1 = a full run; >1 = mid-run join)
  kills: number;
  coins: number;      // final wallet (legacy totalCoins semantic)
  coinsEarned: number;
  coinsSpent: number;
  durationMs: number;
  damageDealt: number;
  damageTaken: number;
  bestCombo: number;
  bossKills: number;
  bossKillFloors: number[];
  firstBossKillMs: number | null;
  killsByWeapon: Record<string, number>;
  weapons: string[];
  blessings: string[];
}

// Hard bounds. Values outside are CLAMPED (a legitimate outlier saturates rather than
// erroring a whole run away); wrong TYPES are rejected outright.
const LIMITS = {
  floor: 1000,
  kills: 100000,
  coins: 1000000,
  durationMs: 12 * 60 * 60 * 1000,
  damage: 10000000,
  combo: 10000,
  bossKills: 200,
  listLen: 64,
  blessingsLen: 200,
  idLen: 48,
} as const;

function clampInt(v: JsonValue | undefined, lo: number, hi: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function cleanIdList(v: JsonValue | undefined, maxLen: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v.slice(0, maxLen)) {
    if (typeof item !== "string") return null;
    const id = item.slice(0, LIMITS.idLen);
    if (id.length > 0) out.push(id);
  }
  return out;
}

function cleanCountRecord(v: JsonValue | undefined): Record<string, number> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [key, value] of Object.entries(v)) {
    if (n++ >= LIMITS.listLen) break;
    const count = clampInt(value, 0, LIMITS.kills);
    if (count === null) return null;
    if (key.length > 0 && key.length <= LIMITS.idLen && count > 0) out[key] = count;
  }
  return out;
}

function oneOf<T extends string>(v: JsonValue | undefined, options: readonly T[]): T | null {
  return typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : null;
}

export type ValidationResult = { ok: true; run: CleanRun } | { ok: false; reason: string };

// Validate + clamp one run's fields from parsed JSON (or any typed superset — object type
// aliases carry an implicit index signature, so typed callers pass their args directly).
// `difficulty` defaults to "standard" when absent (the pre-difficulty world); an INVALID
// present value is rejected, not defaulted.
export function validateRun(raw: Record<string, JsonValue | undefined>): ValidationResult {
  const fail = (reason: string): ValidationResult => ({ ok: false, reason });

  const difficulty = raw.difficulty === undefined ? DEFAULT_DIFFICULTY : oneOf(raw.difficulty, DIFFICULTIES);
  if (difficulty === null) return fail("bad_difficulty");
  const mode = oneOf(raw.mode, RUN_MODES);
  if (mode === null) return fail("bad_mode");
  const result = oneOf(raw.result, RUN_OUTCOMES);
  if (result === null) return fail("bad_result");

  const floor = clampInt(raw.floor, 1, LIMITS.floor);
  const startFloor = clampInt(raw.startFloor ?? 1, 1, LIMITS.floor);
  const kills = clampInt(raw.kills, 0, LIMITS.kills);
  const coins = clampInt(raw.coins, 0, LIMITS.coins);
  const coinsEarned = clampInt(raw.coinsEarned ?? 0, 0, LIMITS.coins);
  const coinsSpent = clampInt(raw.coinsSpent ?? 0, 0, LIMITS.coins);
  const durationMs = clampInt(raw.durationMs, 0, LIMITS.durationMs);
  const damageDealt = clampInt(raw.damageDealt ?? 0, 0, LIMITS.damage);
  const damageTaken = clampInt(raw.damageTaken ?? 0, 0, LIMITS.damage);
  const bestCombo = clampInt(raw.bestCombo ?? 0, 0, LIMITS.combo);
  const bossKills = clampInt(raw.bossKills ?? 0, 0, LIMITS.bossKills);
  if (floor === null || startFloor === null || kills === null || coins === null
    || coinsEarned === null || coinsSpent === null || durationMs === null
    || damageDealt === null || damageTaken === null || bestCombo === null || bossKills === null) {
    return fail("bad_number");
  }

  let firstBossKillMs: number | null = null;
  if (raw.firstBossKillMs !== undefined && raw.firstBossKillMs !== null) {
    firstBossKillMs = clampInt(raw.firstBossKillMs, 1, LIMITS.durationMs);
    if (firstBossKillMs === null) return fail("bad_boss_time");
  }
  // A boss time without a boss kill is incoherent — drop the time, keep the run.
  if (bossKills === 0) firstBossKillMs = null;

  const rawBossFloors = raw.bossKillFloors ?? [];
  if (!Array.isArray(rawBossFloors)) return fail("bad_boss_floors");
  const bossKillFloors: number[] = [];
  for (const f of rawBossFloors.slice(0, LIMITS.bossKills)) {
    const clean = clampInt(f, 1, LIMITS.floor);
    if (clean === null) return fail("bad_boss_floors");
    bossKillFloors.push(clean);
  }

  const killsByWeapon = cleanCountRecord(raw.killsByWeapon ?? {});
  if (killsByWeapon === null) return fail("bad_kills_by_weapon");
  const weapons = cleanIdList(raw.weapons ?? [], LIMITS.listLen);
  if (weapons === null) return fail("bad_weapons");
  const blessings = cleanIdList(raw.blessings ?? [], LIMITS.blessingsLen);
  if (blessings === null) return fail("bad_blessings");

  return {
    ok: true,
    run: {
      difficulty, mode, result,
      floor: Math.max(floor, startFloor),
      startFloor,
      kills, coins, coinsEarned, coinsSpent, durationMs,
      damageDealt, damageTaken, bestCombo, bossKills, bossKillFloors,
      firstBossKillMs, killsByWeapon, weapons, blessings,
    },
  };
}

// The derived run score — computed HERE from validated fields, never submitted, so no
// client (or compromised reporter) can assert a score directly. Integer arithmetic only.
export function scoreForRun(run: CleanRun): number {
  return run.floor * 1000
    + run.bossKills * 500
    + run.kills * 10
    + run.bestCombo * 20
    + Math.min(run.coinsEarned, 100000);
}

// Boss identity per kill floor. The current roster fields one boss (The Slime King) on
// every 5th floor; when the full roster lands this mapping grows with it.
export function bossIdForFloor(_floor: number): string {
  return "slime_king";
}

export const BOSS_NAMES: Record<string, string> = {
  slime_king: "The Slime King",
};

// ---- lifetime aggregates -------------------------------------------------------------

export interface PlayerAggregates {
  gamesPlayed: number;
  totalKills: number;
  totalCoins: number;
  deepestFloor: number;
  wins: number;
  deaths: number;
  playtimeMs: number;
  bestCombo: number;
  coinsEarned: number;
  coinsSpent: number;
  damageDealt: number;
  damageTaken: number;
  bossKills: number;
  fastestBossMs: number | null;
  bossKillsByBoss: Record<string, number>;
  killsByWeapon: Record<string, number>;
}

export function emptyAggregates(): PlayerAggregates {
  return {
    gamesPlayed: 0, totalKills: 0, totalCoins: 0, deepestFloor: 0,
    wins: 0, deaths: 0, playtimeMs: 0, bestCombo: 0,
    coinsEarned: 0, coinsSpent: 0, damageDealt: 0, damageTaken: 0,
    bossKills: 0, fastestBossMs: null,
    bossKillsByBoss: {}, killsByWeapon: {},
  };
}

function mergeCounts(base: Record<string, number>, add: Record<string, number>): Record<string, number> {
  const out = { ...base };
  for (const [key, count] of Object.entries(add)) out[key] = (out[key] ?? 0) + count;
  return out;
}

// Fold one validated run into the lifetime aggregates. Pure — the mutation applies the
// returned struct onto the player row, so aggregation is directly unit-testable.
export function foldRunIntoAggregates(prev: PlayerAggregates, run: CleanRun): PlayerAggregates {
  const bossByBoss: Record<string, number> = {};
  for (const floor of run.bossKillFloors) {
    const id = bossIdForFloor(floor);
    bossByBoss[id] = (bossByBoss[id] ?? 0) + 1;
  }
  // Fastest-boss aggregate only counts full runs (startFloor 1) — a mid-run join killing
  // the floor-5 boss minutes after joining isn't a speedrun.
  const bossTime = run.startFloor <= 1 ? run.firstBossKillMs : null;
  return {
    gamesPlayed: prev.gamesPlayed + 1,
    totalKills: prev.totalKills + run.kills,
    totalCoins: prev.totalCoins + run.coins,
    deepestFloor: Math.max(prev.deepestFloor, run.floor),
    wins: prev.wins + (run.result === "victory" ? 1 : 0),
    deaths: prev.deaths + (run.result === "death" ? 1 : 0),
    playtimeMs: prev.playtimeMs + run.durationMs,
    bestCombo: Math.max(prev.bestCombo, run.bestCombo),
    coinsEarned: prev.coinsEarned + run.coinsEarned,
    coinsSpent: prev.coinsSpent + run.coinsSpent,
    damageDealt: prev.damageDealt + run.damageDealt,
    damageTaken: prev.damageTaken + run.damageTaken,
    bossKills: prev.bossKills + run.bossKills,
    fastestBossMs: bossTime === null ? prev.fastestBossMs
      : prev.fastestBossMs === null ? bossTime : Math.min(prev.fastestBossMs, bossTime),
    bossKillsByBoss: mergeCounts(prev.bossKillsByBoss, bossByBoss),
    killsByWeapon: mergeCounts(prev.killsByWeapon, run.killsByWeapon),
  };
}

// The weapon with the most killing blows (ties: lexicographic id, so it's deterministic).
export function favoriteWeapon(killsByWeapon: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of Object.entries(killsByWeapon).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (count > bestCount) { best = id; bestCount = count; }
  }
  return best;
}

// ---- leaderboard bests ---------------------------------------------------------------

export type LeaderboardCategory = "deepestFloor" | "fastestBoss" | "bossKills" | "score" | "combo";
export const LEADERBOARD_CATEGORIES: readonly LeaderboardCategory[] = [
  "deepestFloor", "fastestBoss", "bossKills", "score", "combo",
];

// Global-board eligibility: ONLY authoritative server results, and ONLY full runs (started
// on floor 1). Account gating (signed-in users only) is enforced at the write site, where
// the player row is known.
export function isBoardEligibleRun(source: RunSource, run: CleanRun): boolean {
  return source === "server" && run.startFloor <= 1;
}

export interface BestPatch {
  deepestFloor?: number;
  deepestFloorAt?: number;
  fastestBossMs?: number;
  fastestBossAt?: number;
  mostBossKills?: number;
  mostBossKillsAt?: number;
  bestScore?: number;
  bestScoreAt?: number;
  bestCombo?: number;
  bestComboAt?: number;
}

export interface BestValues {
  deepestFloor: number;
  fastestBossMs: number | null;
  mostBossKills: number;
  bestScore: number;
  bestCombo: number;
}

// Which per-category bests this run improves over the previous entry. Empty patch = no
// improvement anywhere (the caller skips the write).
export function improvedBests(prev: BestValues | null, run: CleanRun, score: number, now: number): BestPatch {
  const patch: BestPatch = {};
  if (prev === null || run.floor > prev.deepestFloor) {
    patch.deepestFloor = run.floor;
    patch.deepestFloorAt = now;
  }
  if (run.firstBossKillMs !== null && (prev === null || prev.fastestBossMs === null || run.firstBossKillMs < prev.fastestBossMs)) {
    patch.fastestBossMs = run.firstBossKillMs;
    patch.fastestBossAt = now;
  }
  if (prev === null || run.bossKills > prev.mostBossKills) {
    patch.mostBossKills = run.bossKills;
    patch.mostBossKillsAt = now;
  }
  if (prev === null || score > prev.bestScore) {
    patch.bestScore = score;
    patch.bestScoreAt = now;
  }
  if (prev === null || run.bestCombo > prev.bestCombo) {
    patch.bestCombo = run.bestCombo;
    patch.bestComboAt = now;
  }
  return patch;
}

// ---- server submission envelope --------------------------------------------------------

// Freshness window for a signed submission (defense-in-depth on top of submissionId dedupe).
export const SUBMISSION_MAX_AGE_MS = 10 * 60 * 1000;

export interface ServerSubmission {
  submissionId: string;
  playerId: string; // the verified ticket identity the game server bound the connection to
  worldId: string;
  sentAt: number;
  run: CleanRun;
}

export type SubmissionParse = { ok: true; sub: ServerSubmission } | { ok: false; reason: string };

// Parse + validate a signed run-result body (the game server's POST). The signature was
// already verified over these exact bytes; this pass bounds every field.
export function parseServerSubmission(body: string, nowMs: number): SubmissionParse {
  let raw: JsonValue;
  try {
    raw = JSON.parse(body) as JsonValue;
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "bad_shape" };
  const obj = raw;
  if (obj.v !== 1) return { ok: false, reason: "bad_version" };
  const submissionId = typeof obj.submissionId === "string" && obj.submissionId.length >= 8 && obj.submissionId.length <= 64
    ? obj.submissionId : null;
  const playerId = typeof obj.playerId === "string" && obj.playerId.length >= 1 && obj.playerId.length <= 64
    ? obj.playerId : null;
  const worldId = typeof obj.worldId === "string" && obj.worldId.length >= 1 && obj.worldId.length <= 40
    ? obj.worldId : null;
  const sentAt = typeof obj.sentAt === "number" && Number.isFinite(obj.sentAt) ? obj.sentAt : null;
  if (submissionId === null || playerId === null || worldId === null || sentAt === null) {
    return { ok: false, reason: "bad_envelope" };
  }
  if (Math.abs(nowMs - sentAt) > SUBMISSION_MAX_AGE_MS) return { ok: false, reason: "stale" };
  const validated = validateRun(obj);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  return { ok: true, sub: { submissionId, playerId, worldId, sentAt, run: validated.run } };
}
