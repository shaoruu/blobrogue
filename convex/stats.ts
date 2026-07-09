// Run submission + profile stats. Two write paths with explicit trust labels (see the trust
// model note on the runs table in schema.ts):
//
//   applyServerRun (internal) — reached ONLY through the HMAC-verified HTTP action in
//     http.ts. The game server is the caller; the payload was validated/clamped by
//     statsCore.parseServerSubmission over the signed bytes. This is the sole path that can
//     feed the global leaderboards, and only for account-backed rows + full runs.
//
//   recordLocalRun (public) — the client's own solo/co-op simulation reporting its result.
//     Untrusted by design: it is validated/clamped, folded into the CALLER'S OWN stats and
//     run history with source "local", and never touches a leaderboard. A tampered client
//     can only lie to itself.

import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { findByClientId, ensureAccountRow, resolveRow } from "./players";
import {
  validateRun, scoreForRun, foldRunIntoAggregates, emptyAggregates, favoriteWeapon,
  improvedBests, isBoardEligibleRun, DEFAULT_DIFFICULTY,
} from "./statsCore";
import type { CleanRun, PlayerAggregates, RunSource, Difficulty, RunMode, RunOutcome } from "./statsCore";

const difficultyValidator = v.union(v.literal("casual"), v.literal("standard"), v.literal("brutal"));

// The wire shape both submission paths share (validated AGAIN by statsCore inside the
// handler — Convex validators bound the types, statsCore bounds the values).
const runFields = {
  mode: v.union(v.literal("solo"), v.literal("coop"), v.literal("online")),
  result: v.union(v.literal("death"), v.literal("victory"), v.literal("abandon")),
  difficulty: v.optional(difficultyValidator),
  floor: v.number(),
  startFloor: v.number(),
  kills: v.number(),
  coins: v.number(),
  coinsEarned: v.number(),
  coinsSpent: v.number(),
  durationMs: v.number(),
  damageDealt: v.number(),
  damageTaken: v.number(),
  bestCombo: v.number(),
  bossKills: v.number(),
  bossKillFloors: v.array(v.number()),
  firstBossKillMs: v.optional(v.number()),
  killsByWeapon: v.record(v.string(), v.number()),
  weapons: v.array(v.string()),
  blessings: v.array(v.string()),
};

type RunArgs = {
  mode: RunMode;
  result: RunOutcome;
  difficulty?: Difficulty;
  floor: number;
  startFloor: number;
  kills: number;
  coins: number;
  coinsEarned: number;
  coinsSpent: number;
  durationMs: number;
  damageDealt: number;
  damageTaken: number;
  bestCombo: number;
  bossKills: number;
  bossKillFloors: number[];
  firstBossKillMs?: number;
  killsByWeapon: Record<string, number>;
  weapons: string[];
  blessings: string[];
};

function cleanRunFromArgs(args: RunArgs): CleanRun | null {
  const validated = validateRun({
    ...args,
    difficulty: args.difficulty ?? DEFAULT_DIFFICULTY,
    firstBossKillMs: args.firstBossKillMs ?? null,
  });
  return validated.ok ? validated.run : null;
}

function aggregatesOf(doc: Doc<"players">): PlayerAggregates {
  const empty = emptyAggregates();
  return {
    gamesPlayed: doc.gamesPlayed,
    totalKills: doc.totalKills,
    totalCoins: doc.totalCoins,
    deepestFloor: doc.deepestFloor,
    wins: doc.wins ?? empty.wins,
    deaths: doc.deaths ?? empty.deaths,
    playtimeMs: doc.playtimeMs ?? empty.playtimeMs,
    bestCombo: doc.bestCombo ?? empty.bestCombo,
    coinsEarned: doc.coinsEarned ?? empty.coinsEarned,
    coinsSpent: doc.coinsSpent ?? empty.coinsSpent,
    damageDealt: doc.damageDealt ?? empty.damageDealt,
    damageTaken: doc.damageTaken ?? empty.damageTaken,
    bossKills: doc.bossKills ?? empty.bossKills,
    fastestBossMs: doc.fastestBossMs ?? null,
    bossKillsByBoss: doc.bossKillsByBoss ?? {},
    killsByWeapon: doc.killsByWeapon ?? {},
  };
}

// Persist one validated run for a player row: dedupe by submissionId, insert the history
// row, fold the lifetime aggregates, and (server-sourced, account-backed, full runs only)
// advance the per-difficulty leaderboard bests. Shared by both submission paths.
async function persistRun(
  ctx: MutationCtx,
  doc: Doc<"players">,
  run: CleanRun,
  source: RunSource,
  submissionId: string,
): Promise<{ isDuplicate: boolean }> {
  const existing = await ctx.db
    .query("runs")
    .withIndex("by_submission", (q) => q.eq("submissionId", submissionId))
    .unique();
  if (existing) return { isDuplicate: true };

  const now = Date.now();
  const score = scoreForRun(run);
  await ctx.db.insert("runs", {
    playerId: doc._id,
    submissionId,
    source,
    mode: run.mode,
    difficulty: run.difficulty,
    result: run.result,
    floor: run.floor,
    startFloor: run.startFloor,
    kills: run.kills,
    coins: run.coins,
    coinsEarned: run.coinsEarned,
    coinsSpent: run.coinsSpent,
    durationMs: run.durationMs,
    damageDealt: run.damageDealt,
    damageTaken: run.damageTaken,
    bestCombo: run.bestCombo,
    bossKills: run.bossKills,
    bossKillFloors: run.bossKillFloors,
    ...(run.firstBossKillMs !== null ? { firstBossKillMs: run.firstBossKillMs } : {}),
    killsByWeapon: run.killsByWeapon,
    weapons: run.weapons,
    blessings: run.blessings,
    score,
    endedAt: now,
  });

  const agg = foldRunIntoAggregates(aggregatesOf(doc), run);
  await ctx.db.patch(doc._id, {
    gamesPlayed: agg.gamesPlayed,
    totalKills: agg.totalKills,
    totalCoins: agg.totalCoins,
    deepestFloor: agg.deepestFloor,
    wins: agg.wins,
    deaths: agg.deaths,
    playtimeMs: agg.playtimeMs,
    bestCombo: agg.bestCombo,
    coinsEarned: agg.coinsEarned,
    coinsSpent: agg.coinsSpent,
    damageDealt: agg.damageDealt,
    damageTaken: agg.damageTaken,
    bossKills: agg.bossKills,
    ...(agg.fastestBossMs !== null ? { fastestBossMs: agg.fastestBossMs } : {}),
    bossKillsByBoss: agg.bossKillsByBoss,
    killsByWeapon: agg.killsByWeapon,
    lastSeen: now,
  });

  // Global boards: signed-in accounts only (doc.userId), authoritative source only, full
  // runs only. Guests keep their personal stats above but never surface publicly.
  if (doc.userId !== undefined && isBoardEligibleRun(source, run)) {
    const best = await ctx.db
      .query("leaderboardBest")
      .withIndex("by_player_difficulty", (q) => q.eq("playerId", doc._id).eq("difficulty", run.difficulty))
      .unique();
    const patch = improvedBests(
      best
        ? {
          deepestFloor: best.deepestFloor,
          fastestBossMs: best.fastestBossMs ?? null,
          mostBossKills: best.mostBossKills,
          bestScore: best.bestScore,
          bestCombo: best.bestCombo,
        }
        : null,
      run, score, now,
    );
    if (best === null) {
      await ctx.db.insert("leaderboardBest", {
        playerId: doc._id,
        difficulty: run.difficulty,
        deepestFloor: patch.deepestFloor ?? run.floor,
        deepestFloorAt: now,
        ...(patch.fastestBossMs !== undefined ? { fastestBossMs: patch.fastestBossMs, fastestBossAt: now } : {}),
        mostBossKills: patch.mostBossKills ?? run.bossKills,
        mostBossKillsAt: now,
        bestScore: patch.bestScore ?? score,
        bestScoreAt: now,
        bestCombo: patch.bestCombo ?? run.bestCombo,
        bestComboAt: now,
        updatedAt: now,
      });
    } else if (Object.keys(patch).length > 0) {
      await ctx.db.patch(best._id, { ...patch, updatedAt: now });
    }
  }
  return { isDuplicate: false };
}

// ---- authoritative path (game server -> http.ts -> here) ------------------------------

export const applyServerRun = internalMutation({
  args: {
    submissionId: v.string(),
    playerId: v.string(),
    worldId: v.string(),
    ...runFields,
  },
  handler: async (ctx, { submissionId, playerId, worldId: _worldId, ...runArgs }) => {
    const run = cleanRunFromArgs(runArgs);
    if (run === null) return { ok: false as const, reason: "invalid_run" };
    // The ticket identity is either a players row id, or "guest:<clientId>" for a guest
    // the mint couldn't find a row for (resolve their row now — it may exist by run end).
    // Unknown identities (e.g. dev-auth "dev:*") are acknowledged and dropped: the server
    // must not retry what can never resolve.
    let doc: Doc<"players"> | null = null;
    if (playerId.startsWith("guest:")) {
      doc = await findByClientId(ctx, playerId.slice("guest:".length));
    } else {
      const id = ctx.db.normalizeId("players", playerId);
      doc = id !== null ? await ctx.db.get(id) : null;
    }
    if (doc === null) return { ok: true as const, isSkipped: true };
    const { isDuplicate } = await persistRun(ctx, doc, run, "server", submissionId);
    return { ok: true as const, isDuplicate };
  },
});

// ---- local path (the client's own solo/co-op sim) --------------------------------------

export const recordLocalRun = mutation({
  args: {
    clientId: v.string(),
    submissionId: v.string(),
    ...runFields,
  },
  handler: async (ctx, { clientId, submissionId, ...runArgs }) => {
    const run = cleanRunFromArgs(runArgs);
    if (run === null) return null;
    // Same identity rules as players.recordRun: signed-in folds into the account row
    // (creating/migrating it if login hadn't run yet); guests need an existing row.
    const userId = await getAuthUserId(ctx);
    let doc: Doc<"players"> | null;
    if (userId !== null) {
      doc = (await ensureAccountRow(ctx, userId, clientId, "blob")).row;
    } else {
      doc = await findByClientId(ctx, clientId);
    }
    if (doc === null) return null;
    await persistRun(ctx, doc, run, "local", submissionId);
    const updated = await ctx.db.get(doc._id);
    return updated ? statsOf(updated) : null;
  },
});

// ---- reads ------------------------------------------------------------------------------

export interface PlayerStats {
  playerId: string;
  name: string;
  isAccount: boolean;
  aggregates: PlayerAggregates;
  favoriteWeapon: string | null;
}

function statsOf(doc: Doc<"players">): PlayerStats {
  const aggregates = aggregatesOf(doc);
  return {
    playerId: doc._id,
    name: doc.name,
    isAccount: doc.userId !== undefined,
    aggregates,
    favoriteWeapon: favoriteWeapon(aggregates.killsByWeapon),
  };
}

// Full lifetime aggregates for the caller (account row when signed in, else the guest row).
export const getMyStats = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const { row } = await resolveRow(ctx, clientId);
    return row ? statsOf(row) : null;
  },
});

export interface RunHistoryEntry {
  runId: string;
  source: RunSource;
  mode: RunMode;
  difficulty: Difficulty;
  result: RunOutcome;
  floor: number;
  startFloor: number;
  kills: number;
  coins: number;
  durationMs: number;
  damageDealt: number;
  damageTaken: number;
  bestCombo: number;
  bossKills: number;
  bossKillFloors: number[];
  firstBossKillMs: number | null;
  weapons: string[];
  blessings: string[];
  score: number;
  endedAt: number;
}

// The caller's run history, newest first, cursor-paginated.
export const listMyRuns = query({
  args: {
    clientId: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, { clientId, cursor, numItems }) => {
    const { row } = await resolveRow(ctx, clientId);
    if (!row) return { page: [] as RunHistoryEntry[], isDone: true, continueCursor: null as string | null };
    const result = await ctx.db
      .query("runs")
      .withIndex("by_player", (q) => q.eq("playerId", row._id))
      .order("desc")
      .paginate({ cursor, numItems: Math.min(50, Math.max(1, Math.round(numItems))) });
    const page: RunHistoryEntry[] = result.page.map((r) => ({
      runId: r._id,
      source: r.source,
      mode: r.mode,
      difficulty: r.difficulty,
      result: r.result,
      floor: r.floor,
      startFloor: r.startFloor,
      kills: r.kills,
      coins: r.coins,
      durationMs: r.durationMs,
      damageDealt: r.damageDealt,
      damageTaken: r.damageTaken,
      bestCombo: r.bestCombo,
      bossKills: r.bossKills,
      bossKillFloors: r.bossKillFloors,
      firstBossKillMs: r.firstBossKillMs ?? null,
      weapons: r.weapons,
      blessings: r.blessings,
      score: r.score,
      endedAt: r.endedAt,
    }));
    return { page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
