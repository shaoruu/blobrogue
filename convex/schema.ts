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
    totalKills: v.number(),
    deepestFloor: v.number(),
    totalCoins: v.number(),
    gamesPlayed: v.number(),
    unlocks: v.array(v.string()),
    createdAt: v.number(),
    lastSeen: v.number(),
  })
    .index("by_clientId", ["clientId"])
    .index("by_userId", ["userId"]),

  // A co-op lobby / running game. The (seed, floor) pair is the shared source of
  // truth that makes every player generate the same dungeon and descend together.
  rooms: defineTable({
    code: v.string(),
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
