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
    // Companion pets (additive migration: every field optional, absent on old rows).
    // deepestBossKill — deepest floor whose boss this player's party ever defeated; the
    // boss-kill milestone unlock requirements evaluate against it (src/sim/pets.ts).
    deepestBossKill: v.optional(v.number()),
    // unlockedPets — earned PetKind ids. Written ONLY for account-backed rows (signed in);
    // guests accrue the underlying stats but never the unlocks, and inherit them the moment
    // their row migrates onto an account (see players.ensureAccountRow).
    unlockedPets: v.optional(v.array(v.string())),
    // activePet — the one equipped companion (a PetKind in unlockedPets); absent = none.
    activePet: v.optional(v.string()),
    createdAt: v.number(),
    lastSeen: v.number(),
  })
    .index("by_clientId", ["clientId"])
    .index("by_userId", ["userId"]),

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
    // The member's equipped companion (a PetKind), so the lobby roster can show it.
    // Refreshed from the players row on join + heartbeat; absent = none.
    pet: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_player", ["roomId", "playerId"]),
});
