import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// blobrogue multiplayer schema.
//
// Identity is intentionally lightweight: each browser mints a random `clientId`
// (stored in localStorage) that maps to one `players` row. This gives persistent,
// cross-session saved stats without the weight of a full auth provider. See
// MULTIPLAYER.md for the rationale and the trade-offs.

export default defineSchema({
  // Persistent per-player identity + all-time stats.
  players: defineTable({
    clientId: v.string(),
    name: v.string(),
    totalKills: v.number(),
    deepestFloor: v.number(),
    totalCoins: v.number(),
    gamesPlayed: v.number(),
    unlocks: v.array(v.string()),
    createdAt: v.number(),
    lastSeen: v.number(),
  }).index("by_clientId", ["clientId"]),

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
