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
    // The EFFECTIVE display name — what renders in lobbies, in-run labels, and on the
    // leaderboard. For guests it is the typed/generated name; for accounts it is the
    // chosen customName when set, else the Google account name. Kept as the single
    // display field so every consumer (toProfile, foldBestRun, syncIdentity, presence)
    // reads one place.
    name: v.string(),
    // A signed-in account's chosen display-name OVERRIDE. Absent = fall back to the Google
    // account name. Written only by the authenticated setCustomName mutation (sanitized:
    // trimmed, whitespace-collapsed, capped 20, never empty, never the literal "blob"), so
    // login/recordRun never revert a name the player deliberately chose. Guests never set it.
    customName: v.optional(v.string()),
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
    // The ONE persistent currency (progression spec §4): banked by the premium economy's
    // amber cache / mythic windfall at run end. Coins never persist and never buy
    // permanent power directly — Amber is the only coins→permanence route, and it only
    // trickles. Optional: pre-Amber rows read 0.
    amber: v.optional(v.number()),
    // Account MASTERY XP (KIT/XP spec §4): a persistent ACCESS track — it gates WHICH kits/
    // cosmetics may be selected, NOT a currency and NOT spendable (the 2-currency rule is
    // intact). Granted every run from run performance (floors/bosses/depth). Optional: pre-
    // mastery rows read 0 (account level 1 -> Gunner + Mender unlocked).
    masteryXp: v.optional(v.number()),
    // Earned cosmetic/unlock ids AND owned meta-progression ids (WAVE 1): recordRun grants
    // earned cosmetics; buyNode grants owned Amber Camp node ids (camp_/pet_/stash_/coin_
    // prefixes, see src/sim/camp_nodes.ts); first-boss grants add bosskill:<kind> flags. All
    // disjoint namespaces sharing this one list. Seeded [] since day one.
    unlocks: v.array(v.string()),
    // The equipped cosmetic COMPANION pet id (WAVE 1, META spec §3), or absent for none. A
    // pure visual-only companion — it rides the wire like a hat/face label and never enters
    // the sim. Only a pet the player OWNS (via an owned companion node) is ever written.
    equippedPet: v.optional(v.string()),
    // Convenience only: the last kit confirmed on the combined pre-run gate. A room's
    // generation-bound presence row is authoritative for online play; this field only
    // preselects the next gate and can never authorize a run.
    lastKitId: v.optional(v.string()),
    createdAt: v.number(),
    lastSeen: v.number(),
  })
    .index("by_clientId", ["clientId"])
    .index("by_userId", ["userId"]),

  guestSessions: defineTable({
    token: v.string(),
    refreshToken: v.string(),
    clientId: v.string(),
    playerId: v.id("players"),
    scopes: v.array(v.union(
      v.literal("profile"),
      v.literal("room"),
      v.literal("ticket"),
      v.literal("economy"),
    )),
    createdAt: v.number(),
    expiresAt: v.number(),
    refreshExpiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_refresh", ["refreshToken"])
    .index("by_player", ["playerId"])
    .index("by_client", ["clientId"]),

  // Global leaderboard: ONE row per player — their best run (deepest floor, kills as the
  // tie-break) — folded only from a verified game-server receipt. The row SNAPSHOTS the
  // run's build and player's cosmetic loadout separately from the mutable profile, so the
  // leaderboard profile view needs no join against players (and can never leak account fields:
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
    // The MATCH mode of an authoritative (kind "online") room: co-op dungeon (default) or the
    // PVP arena deathmatch. Optional so every pre-existing room reads as "coop" (zero change);
    // it only changes which authoritative WORLD id the ticket mint binds (pvp: prefix).
    mode: v.optional(v.union(v.literal("coop"), v.literal("pvp"))),
    hostPlayerId: v.id("players"),
    seed: v.number(),
    floor: v.number(),
    status: v.union(v.literal("lobby"), v.literal("playing"), v.literal("ended")),
    isPublic: v.optional(v.boolean()),
    // Monotonic run generation. Reopen increments it before clearing every member's
    // confirmation, so a confirmation from the previous run cannot ready or mint a ticket
    // for the next one.
    loadoutGeneration: v.optional(v.number()),
    generationState: v.optional(v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("completed"),
    )),
    generationCompletedAt: v.optional(v.number()),
    generationCompletionJti: v.optional(v.string()),
    createdAt: v.number(),
    lastActivity: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_host", ["hostPlayerId"])
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
    // Combined per-generation run loadout. pet id absence is a valid NO PET value only
    // when isPetChoiceMade is true; this preserves the required distinction between an
    // explicit null and a choice that was never made.
    loadoutKitId: v.optional(v.string()),
    loadoutPetId: v.optional(v.string()),
    isKitChoiceMade: v.optional(v.boolean()),
    isPetChoiceMade: v.optional(v.boolean()),
    isLoadoutConfirmed: v.optional(v.boolean()),
    loadoutGeneration: v.optional(v.number()),
    loadoutEditRevision: v.optional(v.number()),
    // A deliberate leave during a live generation keeps this row as a loadout tombstone:
    // rejoining the same run restores the immutable pair, while the row no longer occupies
    // an active roster/capacity slot.
    isDeparted: v.optional(v.boolean()),
  })
    .index("by_room", ["roomId"])
    .index("by_player", ["playerId"])
    .index("by_room_player", ["roomId", "playerId"]),

  runReceipts: defineTable({
    jti: v.string(),
    runId: v.string(),
    worldId: v.string(),
    roomId: v.id("rooms"),
    generation: v.number(),
    status: v.union(
      v.literal("completed"),
      v.literal("abandoned"),
      v.literal("server_restart"),
    ),
    playerIds: v.array(v.id("players")),
    rewardedPlayerIds: v.array(v.id("players")),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.number(),
  })
    .index("by_jti", ["jti"])
    .index("by_run", ["runId"])
    .index("by_expiry", ["expiresAt"]),
});
