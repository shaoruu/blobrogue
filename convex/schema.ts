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
    // The player's PARTY color (index into the client palette): the network identity color
    // for name labels, minimap dots, and lobby roster — deliberately separate from the
    // cosmetic body palette (cosmeticLoadout.body), though the closet keeps them in step
    // at launch. Optional: absent until the player explicitly picks one, so a fresh
    // browser never clobbers an account's pick.
    colorIndex: v.optional(v.number()),
    // Equipped visual-only cosmetic loadout (ids from convex/cosmeticsCore.ts; one field
    // per shipped slot). A missing field is the empty slot; only OWNED ids are ever
    // written (players.ts validates ownership + slot). Absent on pre-cosmetics rows —
    // everything defaults safely.
    cosmeticLoadout: v.optional(v.object({
      hat: v.optional(v.string()),
      face: v.optional(v.string()),
      body: v.optional(v.string()),
      title: v.optional(v.string()),
    })),
    totalKills: v.number(),
    deepestFloor: v.number(),
    totalCoins: v.number(),
    gamesPlayed: v.number(),
    // Earned cosmetic/unlock ids. Seeded [] since day one; recordRun grants earned
    // cosmetics into it (see cosmeticsCore.earnedCosmeticsFor).
    unlocks: v.array(v.string()),
    createdAt: v.number(),
    lastSeen: v.number(),
  })
    .index("by_clientId", ["clientId"])
    .index("by_userId", ["userId"]),

  // Global leaderboard: ONE row per player — their best run (deepest floor, kills as the
  // tie-break) — folded in by players.recordRun. The row SNAPSHOTS the run's build and the
  // player's cosmetic loadout separately from the mutable profile, so the leaderboard
  // profile view needs no join against players (and can never leak account fields:
  // name/appearance/run stats only, by construction).
  leaderboard: defineTable({
    playerId: v.id("players"),
    name: v.string(),
    colorIndex: v.optional(v.number()),
    hat: v.optional(v.string()),
    face: v.optional(v.string()),
    body: v.optional(v.string()),
    title: v.optional(v.string()),
    floor: v.number(),
    kills: v.number(),
    coins: v.number(),
    durationMs: v.number(),
    // The run's final build: owned weapon ids + collapsed blessing ids with levels.
    weapons: v.array(v.string()),
    items: v.array(v.object({ id: v.string(), count: v.number() })),
    achievedAt: v.number(),
  })
    .index("by_player", ["playerId"])
    .index("by_floor", ["floor"]),

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
    // ONLINE rooms only: the authoritative game-server world this member is actually
    // CONNECTED to (self-reported from the server's own snapshot after a verified join;
    // absent while in the lobby / after leaving the world). This is what lets the lobby
    // roster show LOBBY / CONNECTING / CONNECTED TO WORLD per member instead of pretending
    // Convex presence alone means "playing together".
    gsWorldId: v.optional(v.string()),
    gsJoinedAt: v.optional(v.number()),
    // ONLINE lobby readiness: the member's explicit READY toggle (reset on every lobby
    // (re)entry and on reopen after a wipe) and their measured lobby round-trip in ms
    // (reported by their own heartbeat) — the roster's READY/NOT READY + ping readout.
    isReady: v.optional(v.boolean()),
    pingMs: v.optional(v.number()),
  })
    .index("by_room", ["roomId"])
    .index("by_room_player", ["roomId", "playerId"]),
});
