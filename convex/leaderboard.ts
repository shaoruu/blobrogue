// Global leaderboard reads. Every board is a straight index scan over leaderboardBest
// (one row per signed-in player per difficulty; see schema.ts for the write rules), so
// ordering is total and pagination is cursor-stable:
//
// REWARD POLICY (owner directive): leaderboard standing grants COSMETIC recognition only
// (rank markers, crowns, titles) — never gameplay power, currency, or unlocks. Anything
// consuming these reads must keep to that line.
//   - value ordering per category (desc, except fastest-boss which is asc),
//   - ties fall back to the row's _creationTime (Convex appends it to every index):
//     ascending boards break ties toward the earlier row; descending boards toward the
//     newer row. Deterministic either way, and documented behavior locked by tests.
// Zero/absent values never chart: gte(1) range-excludes rows that haven't earned the
// category (and `undefined` sorts below all numbers in Convex index order).

import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { resolveRow } from "./players";
import type { Difficulty, LeaderboardCategory } from "./statsCore";

const difficultyValidator = v.union(v.literal("casual"), v.literal("standard"), v.literal("brutal"));
const categoryValidator = v.union(
  v.literal("deepestFloor"), v.literal("fastestBoss"), v.literal("bossKills"),
  v.literal("score"), v.literal("combo"),
);

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  colorIndex: number | null;
  value: number;
  achievedAt: number | null;
}

function entryValue(doc: Doc<"leaderboardBest">, category: LeaderboardCategory): { value: number; at: number | null } | null {
  switch (category) {
    case "deepestFloor": return { value: doc.deepestFloor, at: doc.deepestFloorAt ?? null };
    case "fastestBoss": return doc.fastestBossMs === undefined ? null : { value: doc.fastestBossMs, at: doc.fastestBossAt ?? null };
    case "bossKills": return { value: doc.mostBossKills, at: doc.mostBossKillsAt ?? null };
    case "score": return { value: doc.bestScore, at: doc.bestScoreAt ?? null };
    case "combo": return { value: doc.bestCombo, at: doc.bestComboAt ?? null };
  }
}

export const top = query({
  args: {
    category: categoryValidator,
    difficulty: difficultyValidator,
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    // Optional caller identity: when supplied, the response carries the caller's own best
    // for this board (shown as a "you" line even when off-page). Guests get null.
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, { category, difficulty, cursor, numItems, clientId }) => {
    const n = Math.min(50, Math.max(1, Math.round(numItems)));
    const opts = { cursor, numItems: n };
    const table = ctx.db.query("leaderboardBest");
    const result =
      category === "deepestFloor"
        ? await table.withIndex("by_deepest", (q) => q.eq("difficulty", difficulty).gte("deepestFloor", 1)).order("desc").paginate(opts)
        : category === "fastestBoss"
          ? await table.withIndex("by_fastest_boss", (q) => q.eq("difficulty", difficulty).gte("fastestBossMs", 1)).paginate(opts)
          : category === "bossKills"
            ? await table.withIndex("by_boss_kills", (q) => q.eq("difficulty", difficulty).gte("mostBossKills", 1)).order("desc").paginate(opts)
            : category === "score"
              ? await table.withIndex("by_score", (q) => q.eq("difficulty", difficulty).gte("bestScore", 1)).order("desc").paginate(opts)
              : await table.withIndex("by_combo", (q) => q.eq("difficulty", difficulty).gte("bestCombo", 1)).order("desc").paginate(opts);

    // Join display identity at read time (never denormalized -> renames show immediately).
    const entries: LeaderboardEntry[] = [];
    for (const doc of result.page) {
      const val = entryValue(doc, category);
      if (val === null) continue;
      const player = await ctx.db.get(doc.playerId);
      entries.push({
        playerId: doc.playerId,
        name: player?.name ?? "blob",
        colorIndex: player?.colorIndex ?? null,
        value: val.value,
        achievedAt: val.at,
      });
    }

    // The caller's own standing on this board (null for guests / never-charted players).
    let me: LeaderboardEntry | null = null;
    if (clientId !== undefined) {
      const { row } = await resolveRow(ctx, clientId);
      if (row) {
        const mine = await ctx.db
          .query("leaderboardBest")
          .withIndex("by_player_difficulty", (q) => q.eq("playerId", row._id).eq("difficulty", difficulty))
          .unique();
        const val = mine ? entryValue(mine, category) : null;
        if (mine && val !== null && val.value >= 1) {
          me = { playerId: row._id, name: row.name, colorIndex: row.colorIndex ?? null, value: val.value, achievedAt: val.at };
        }
      }
    }

    return { entries, me, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
