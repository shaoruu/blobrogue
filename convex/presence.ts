import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { pvpWorldIdForRoomCode, worldIdForRoomCode } from "./gsTicketCore";
import { loadoutBlockerForMember } from "./lobbyLoadoutCore";

const STALE_MS = 12000;   // hide players whose client stopped syncing
const REVIVE_HP = 2;

async function resolveOnlineCaller(ctx: MutationCtx, clientId: string): Promise<Doc<"players"> | null> {
  const userId = await getAuthUserId(ctx);
  return userId
    ? await ctx.db.query("players").withIndex("by_userId", (queryBuilder) => queryBuilder.eq("userId", userId)).unique()
    : await ctx.db.query("players").withIndex("by_clientId", (queryBuilder) => queryBuilder.eq("clientId", clientId)).unique();
}

// Throttled live-state sync. The client calls this ~10x/sec while playing.
export const update = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", args.roomId).eq("playerId", args.playerId))
      .unique();
    if (!row) return; // must join/create (which inserts the row) first
    // Only the presence row is written here (never the shared room doc) so the
    // ~11x/sec sync from every player doesn't contend on a single document.
    await ctx.db.patch(row._id, {
      name: args.name,
      x: args.x, y: args.y, facing: args.facing,
      hp: args.hp, maxHp: args.maxHp, weapon: args.weapon,
      floor: args.floor, isDown: args.isDown, aimAngle: args.aimAngle,
      shotSeq: args.shotSeq, kills: args.kills,
      updatedAt: Date.now(),
    });
  },
});

// Everyone currently alive-and-syncing in the room.
export const list = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const rows = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    const cutoff = Date.now() - STALE_MS;
    return rows
      .filter((r) => r.updatedAt >= cutoff && r.isDeparted !== true)
      .map((r) => ({
        playerId: r.playerId,
        name: r.name,
        x: r.x,
        y: r.y,
        facing: r.facing,
        hp: r.hp,
        maxHp: r.maxHp,
        weapon: r.weapon,
        floor: r.floor,
        isDown: r.isDown,
        aimAngle: r.aimAngle,
        shotSeq: r.shotSeq,
        kills: r.kills,
        colorIndex: r.colorIndex,
        reviveNonce: r.reviveNonce,
        updatedAt: r.updatedAt,
        gsWorldId: r.gsWorldId ?? null,
        gsJoinedAt: r.gsJoinedAt ?? null,
        isReady: r.isReady ?? false,
        pingMs: r.pingMs ?? null,
        loadoutKitId: r.loadoutKitId ?? null,
        loadoutPetId: r.loadoutPetId ?? null,
        isKitChoiceMade: r.isKitChoiceMade ?? false,
        isPetChoiceMade: r.isPetChoiceMade ?? false,
        isLoadoutConfirmed: r.isLoadoutConfirmed ?? false,
        loadoutGeneration: r.loadoutGeneration ?? null,
      }));
  },
});

// Rows count as "online" when they synced within this window. Deliberately longer than
// list()'s 12s stale cutoff so the global tally tolerates the online lobby/run heartbeat's
// slower (~5s) cadence plus a couple of missed beats without a blob flickering out.
const ONLINE_WINDOW_MS = 30000;

// A live, GLOBAL "who is connected right now" tally for the title screen — counts DISTINCT
// players with a fresh presence row (someone briefly listed in two rooms is still one blob).
// A full-table scan by design: presence holds one row per active member (dropped on leave),
// this is the only cross-room read, and the count is the same for everyone, so a dedicated
// index isn't worth the extra write cost on the ~11x/sec sync path.
export const onlineCount = query({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - ONLINE_WINDOW_MS;
    const rows = await ctx.db.query("presence").collect();
    const online = new Set<string>();
    for (const row of rows) {
      if (row.updatedAt >= cutoff) online.add(row.playerId);
    }
    return online.size;
  },
});

// The lobby READY toggle (roster shows READY/NOT READY per member; the host's START opens
// when everyone is ready — see the menu's start gate).
export const setReady = mutation({
  args: { roomId: v.id("rooms"), clientId: v.string(), isReady: v.boolean() },
  handler: async (ctx, { roomId, clientId, isReady }) => {
    const player = await resolveOnlineCaller(ctx, clientId);
    if (!player) return { ok: false as const, reason: "not_in_room" as const };
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", player._id))
      .unique();
    if (!row || row.isDeparted === true) return { ok: false as const, reason: "not_in_room" as const };
    const room = await ctx.db.get(roomId);
    if (!room || room.status !== "lobby") {
      return { ok: false as const, reason: "not_in_room" as const };
    }
    if (isReady) {
      const generation = room.loadoutGeneration ?? 1;
      const blocker = loadoutBlockerForMember(row, generation);
      if (blocker) {
        return {
          ok: false as const,
          reason: "loadout_missing" as const,
          message: blocker.message,
        };
      }
    }
    await ctx.db.patch(row._id, { isReady: isReady ? true : undefined, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// Mirror of the authoritative game-server connection state onto this member's presence row
// (ONLINE rooms): worldId = the world the server's snapshot says we are bound to (set after
// a verified join), null = left the world. Self-reported, but derived from the server's own
// snapshot — it powers the lobby's per-member LOBBY / CONNECTING / CONNECTED readout, while
// in-run readiness always keys on the server's snapshot roster directly.
export const reportWorld = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    generation: v.number(),
    worldId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { roomId, clientId, generation, worldId }) => {
    const player = await resolveOnlineCaller(ctx, clientId);
    if (!player) return;
    const room = await ctx.db.get(roomId);
    if (!room || room.kind !== "online") return;
    const currentGeneration = room.loadoutGeneration ?? 1;
    if (generation !== currentGeneration) return;
    const expectedWorldId = room.mode === "pvp"
      ? pvpWorldIdForRoomCode(room.code, currentGeneration)
      : worldIdForRoomCode(room.code, currentGeneration);
    if (worldId !== null && worldId !== expectedWorldId) return;
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", player._id))
      .unique();
    if (!row) return;
    const now = Date.now();
    if (worldId === null) await ctx.db.patch(row._id, { gsWorldId: undefined, gsJoinedAt: undefined, updatedAt: now });
    else await ctx.db.patch(row._id, { gsWorldId: worldId, gsJoinedAt: now, updatedAt: now });
  },
});

// Bring a downed teammate back. Bumps reviveNonce so their own client notices.
export const revive = mutation({
  args: { roomId: v.id("rooms"), targetPlayerId: v.id("players") },
  handler: async (ctx, { roomId, targetPlayerId }) => {
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", targetPlayerId))
      .unique();
    if (!row || !row.isDown) return;
    await ctx.db.patch(row._id, {
      isDown: false,
      hp: REVIVE_HP,
      reviveNonce: row.reviveNonce + 1,
      updatedAt: Date.now(),
    });
  },
});
