// Global leaderboard reads. Every board is a straight index scan over leaderboardBest
// (one row per signed-in player per difficulty per party bucket; see schema.ts for the
// write rules), so ordering is total and pagination is cursor-stable:
//   - boards split by mode/party (solo vs party runs never compete),
//   - value ordering per category (desc, except fastest-boss which is asc),
//   - ties fall back to the row's _creationTime (Convex appends it to every index):
//     ascending boards break ties toward the earlier row; descending boards toward the
//     newer row. Deterministic either way, and documented behavior locked by tests.
// Zero/absent values never chart: gte(1) range-excludes rows that haven't earned the
// category (and `undefined` sorts below all numbers in Convex index order).
//
// REWARD POLICY (owner directive): leaderboard standing grants COSMETIC recognition only
// (rank markers, crowns, titles) — never gameplay power, currency, or unlocks. Anything
// consuming these reads must keep to that line.

import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { resolveRow } from "./players";
import type { Difficulty, LeaderboardCategory, PartyBucket } from "./statsCore";

const difficultyValidator = v.union(v.literal("casual"), v.literal("standard"), v.literal("brutal"));
const partyValidator = v.union(v.literal("solo"), v.literal("party"));
const categoryValidator = v.union(
  v.literal("deepestFloor"), v.literal("fastestBoss"), v.literal("bossKills"),
  v.literal("score"), v.literal("combo"),
);

// Rank scans are bounded: beyond this many better entries the caller's rank reads as
// "off the charts" (null) rather than the query loading an unbounded range.
const RANK_SCAN_CAP = 1000;

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  colorIndex: number | null;
  value: number;
  achievedAt: number | null;
}

export interface LeaderboardSelfEntry extends LeaderboardEntry {
  // 1-based standard competition rank (ties share the better rank); null when the entry
  // sits beyond the bounded rank scan.
  rank: number | null;
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
    party: partyValidator,
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    // Optional caller identity: when supplied, the response carries the caller's own best
    // + computed rank for this board (drives the pinned "you" row). Guests get null.
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, { category, difficulty, party, cursor, numItems, clientId }) => {
    const n = Math.min(50, Math.max(1, Math.round(numItems)));
    const opts = { cursor, numItems: n };
    const table = ctx.db.query("leaderboardBest");
    const result =
      category === "deepestFloor"
        ? await table.withIndex("by_deepest", (q) => q.eq("difficulty", difficulty).eq("party", party).gte("deepestFloor", 1)).order("desc").paginate(opts)
        : category === "fastestBoss"
          ? await table.withIndex("by_fastest_boss", (q) => q.eq("difficulty", difficulty).eq("party", party).gte("fastestBossMs", 1)).paginate(opts)
          : category === "bossKills"
            ? await table.withIndex("by_boss_kills", (q) => q.eq("difficulty", difficulty).eq("party", party).gte("mostBossKills", 1)).order("desc").paginate(opts)
            : category === "score"
              ? await table.withIndex("by_score", (q) => q.eq("difficulty", difficulty).eq("party", party).gte("bestScore", 1)).order("desc").paginate(opts)
              : await table.withIndex("by_combo", (q) => q.eq("difficulty", difficulty).eq("party", party).gte("bestCombo", 1)).order("desc").paginate(opts);

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

    // The caller's own standing on this board with a computed rank — the client pins it
    // under the list when the row isn't on the visible page. Null for guests / uncharted.
    let me: LeaderboardSelfEntry | null = null;
    if (clientId !== undefined) {
      const { row } = await resolveRow(ctx, clientId);
      if (row) {
        const mine = await ctx.db
          .query("leaderboardBest")
          .withIndex("by_player_board", (q) => q.eq("playerId", row._id).eq("difficulty", difficulty).eq("party", party))
          .unique();
        const val = mine ? entryValue(mine, category) : null;
        if (mine && val !== null && val.value >= 1) {
          const rank = await rankOf(ctx, category, difficulty, party, val.value);
          me = { playerId: row._id, name: row.name, colorIndex: row.colorIndex ?? null, value: val.value, achievedAt: val.at, rank };
        }
      }
    }

    return { entries, me, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

// Standard competition ("1224") rank: 1 + the number of strictly better entries on this
// board. Bounded by RANK_SCAN_CAP — a deeper standing reads as null ("beyond #1000").
async function rankOf(
  ctx: QueryCtx,
  category: LeaderboardCategory,
  difficulty: Difficulty,
  party: PartyBucket,
  value: number,
): Promise<number | null> {
  const table = ctx.db.query("leaderboardBest");
  const better =
    category === "deepestFloor"
      ? await table.withIndex("by_deepest", (q) => q.eq("difficulty", difficulty).eq("party", party).gt("deepestFloor", value)).take(RANK_SCAN_CAP + 1)
      : category === "fastestBoss"
        ? await table.withIndex("by_fastest_boss", (q) => q.eq("difficulty", difficulty).eq("party", party).gte("fastestBossMs", 1).lt("fastestBossMs", value)).take(RANK_SCAN_CAP + 1)
        : category === "bossKills"
          ? await table.withIndex("by_boss_kills", (q) => q.eq("difficulty", difficulty).eq("party", party).gt("mostBossKills", value)).take(RANK_SCAN_CAP + 1)
          : category === "score"
            ? await table.withIndex("by_score", (q) => q.eq("difficulty", difficulty).eq("party", party).gt("bestScore", value)).take(RANK_SCAN_CAP + 1)
            : await table.withIndex("by_combo", (q) => q.eq("difficulty", difficulty).eq("party", party).gt("bestCombo", value)).take(RANK_SCAN_CAP + 1);
  return better.length > RANK_SCAN_CAP ? null : better.length + 1;
}
