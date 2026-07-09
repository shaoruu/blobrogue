import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// blobrogue multiplayer schema.
//
// Identity has two, non-exclusive layers:
//   1. Guest (default): each browser mints a random `clientId` (localStorage) that
//      maps to one `players` row. Zero-config, persistent, cross-session stats.
//   2. Account (optional): an authenticated Convex Auth user (Google). When signed
//      in, the player's stats row is keyed off `userId` instead of `clientId`.
// Signing in migrates the current browser's unowned guest row to the account, so a
// guest who later signs in keeps their all-time stats. Guests are never touched.
// See AUTH_SETUP.md + MULTIPLAYER.md for the rationale and the trade-offs.

export default defineSchema({
  // Convex Auth tables (users / authSessions / authAccounts / ...). The auth library
  // owns these; the app only reads `users` (for the display name + avatar).
  ...authTables,

  // Persistent per-player identity + all-time stats.
  players: defineTable({
    // Guest identity. Optional so account rows created without a prior guest row
    // don't have to invent one (which would collide on the unique `by_clientId`).
    clientId: v.optional(v.string()),
    // Account identity. Set once the row is linked to a signed-in Convex Auth user.
    userId: v.optional(v.id("users")),
    name: v.string(),
    // Chosen blob tint (index into the client palette). Optional: absent until the
    // player explicitly picks one, so a fresh browser never clobbers an account's pick.
    colorIndex: v.optional(v.number()),
    totalKills: v.number(),
    deepestFloor: v.number(),
    totalCoins: v.number(),
    gamesPlayed: v.number(),
    unlocks: v.array(v.string()),
    createdAt: v.number(),
    lastSeen: v.number(),
    // Extended lifetime aggregates (see convex/statsCore.ts). ALL optional so every
    // pre-existing row stays valid untouched — absent reads as 0 / empty / null.
    wins: v.optional(v.number()),
    deaths: v.optional(v.number()),
    playtimeMs: v.optional(v.number()),
    bestCombo: v.optional(v.number()),
    coinsEarned: v.optional(v.number()),
    coinsSpent: v.optional(v.number()),
    damageDealt: v.optional(v.number()),
    damageTaken: v.optional(v.number()),
    bossKills: v.optional(v.number()),
    fastestBossMs: v.optional(v.number()),
    bossKillsByBoss: v.optional(v.record(v.string(), v.number())),
    killsByWeapon: v.optional(v.record(v.string(), v.number())),
  })
    .index("by_clientId", ["clientId"])
    .index("by_userId", ["userId"]),

  // One row per finished run (the profile panel's run history). Written by exactly two
  // paths with an explicit trust label:
  //   source "server" — the authoritative game server's HMAC-signed POST (convex/http.ts
  //                     /gs/run-result). The only rows eligible for global leaderboards.
  //   source "local"  — the client's own solo/co-op sim via stats:recordLocalRun. Folds
  //                     into the caller's personal stats/history only; NEVER the boards.
  // submissionId dedupes retries (a resend of the same result is a no-op).
  runs: defineTable({
    playerId: v.id("players"),
    submissionId: v.string(),
    source: v.union(v.literal("server"), v.literal("local")),
    mode: v.union(v.literal("solo"), v.literal("coop"), v.literal("online")),
    difficulty: v.union(v.literal("casual"), v.literal("standard"), v.literal("brutal")),
    result: v.union(v.literal("death"), v.literal("victory"), v.literal("abandon")),
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
    // The sim's DeathCause id for the killing blow (descriptive; absent when unknown).
    deathCause: v.optional(v.string()),
    // Most players simultaneously present during the run (absent on early rows -> 1).
    partySize: v.optional(v.number()),
    // Derived by statsCore.scoreForRun from the validated fields — never submitted.
    score: v.number(),
    endedAt: v.number(),
  })
    .index("by_submission", ["submissionId"])
    .index("by_player", ["playerId"]),

  // One row per (signed-in player, difficulty, party bucket): their best-ever value per
  // leaderboard category. Written ONLY from validated server submissions of full runs
  // (startFloor 1) on account-backed player rows — guests and local/solo-sim results never
  // appear here. Boards split by mode/party (solo vs party runs aren't comparable), so the
  // bucket rides every index. Each category has its own index so every board reads straight
  // off an index scan: ties share the value and fall back to the row's _creationTime (the
  // first submission that put the player on the board), keeping pagination stable and total.
  leaderboardBest: defineTable({
    playerId: v.id("players"),
    difficulty: v.union(v.literal("casual"), v.literal("standard"), v.literal("brutal")),
    // Optional only for pre-split scratch rows; every write sets it (absent rows never
    // match a board filter, so they simply stop charting until their next run).
    party: v.optional(v.union(v.literal("solo"), v.literal("party"))),
    deepestFloor: v.number(),
    deepestFloorAt: v.optional(v.number()),
    fastestBossMs: v.optional(v.number()),
    fastestBossAt: v.optional(v.number()),
    mostBossKills: v.number(),
    mostBossKillsAt: v.optional(v.number()),
    bestScore: v.number(),
    bestScoreAt: v.optional(v.number()),
    bestCombo: v.number(),
    bestComboAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_player_board", ["playerId", "difficulty", "party"])
    .index("by_deepest", ["difficulty", "party", "deepestFloor"])
    .index("by_fastest_boss", ["difficulty", "party", "fastestBossMs"])
    .index("by_boss_kills", ["difficulty", "party", "mostBossKills"])
    .index("by_score", ["difficulty", "party", "bestScore"])
    .index("by_combo", ["difficulty", "party", "bestCombo"]),

  // A lobby / running game. The two kinds NEVER cross-match:
  //   "coop"   — classic peer-synced co-op (each client simulates from the shared seed/floor;
  //              this table's seed/floor pair is the source of truth). The default when
  //              `kind` is absent, so pre-existing rows/clients keep exact behavior.
  //   "online" — a room on the AUTHORITATIVE game server: the room code maps to a distinct
  //              server world (`room:<CODE>`), minted into each member's join ticket by
  //              gsTicket.mint. Convex holds only the lobby (roster/status); the game server
  //              owns all gameplay state, so seed/floor here are unused for this kind.
  rooms: defineTable({
    code: v.string(),
    kind: v.optional(v.union(v.literal("coop"), v.literal("online"))),
    hostPlayerId: v.id("players"),
    seed: v.number(),
    floor: v.number(),
    status: v.union(v.literal("lobby"), v.literal("playing"), v.literal("ended")),
    isPublic: v.optional(v.boolean()),
    createdAt: v.number(),
    lastActivity: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_public_status", ["isPublic", "status", "lastActivity"]),

  // Live per-player state inside a room, synced ~10x/sec by the client.
  presence: defineTable({
    roomId: v.id("rooms"),
    playerId: v.id("players"),
    name: v.string(),
    x: v.number(),
    y: v.number(),
    facing: v.number(),
    hp: v.number(),
    maxHp: v.number(),
    weapon: v.string(),
    floor: v.number(),
    isDown: v.boolean(),
    aimAngle: v.number(),
    shotSeq: v.number(),
    kills: v.number(),
    colorIndex: v.number(),
    reviveNonce: v.number(),
    updatedAt: v.number(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_player", ["roomId", "playerId"]),
});
