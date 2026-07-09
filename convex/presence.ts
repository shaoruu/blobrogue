import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const STALE_MS = 12000;   // hide players whose client stopped syncing
const REVIVE_HP = 2;

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
      .filter((r) => r.updatedAt >= cutoff)
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
        phase: r.phase ?? "lobby",
      }));
  },
});

// Room-lifecycle phase for the replay flow: the client marks where it sits ("lobby" /
// "playing" / "over") at each screen transition, and the lobby's START gate waits for
// members still marked "playing". Doubles as a keepalive (bumps updatedAt), so a client
// that stops phasing goes stale and releases the gate — the explicit roster timeout.
export const setPhase = mutation({
  args: {
    roomId: v.id("rooms"),
    playerId: v.id("players"),
    phase: v.union(v.literal("lobby"), v.literal("playing"), v.literal("over")),
  },
  handler: async (ctx, { roomId, playerId, phase }) => {
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", playerId))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { phase, updatedAt: Date.now() });
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
