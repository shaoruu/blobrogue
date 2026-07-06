import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous O/0/I/1
const CODE_LEN = 4;
const MAX_PLAYERS = 4;                 // co-op party cap
const QUICKPLAY_STALE_MS = 45_000;     // ignore rooms with no activity for this long

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

async function uniqueCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    const clash = await ctx.db.query("rooms").withIndex("by_code", (q) => q.eq("code", code)).unique();
    if (!clash) return code;
  }
  return randomCode() + CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
}

async function smallestFreeColor(ctx: MutationCtx, roomId: Id<"rooms">): Promise<number> {
  const rows = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
  const used = new Set(rows.map((r) => r.colorIndex));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

async function ensurePresence(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  playerId: Id<"players">,
  name: string,
  floor: number,
  colorIndex: number,
) {
  const existing = await ctx.db
    .query("presence")
    .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", playerId))
    .unique();
  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, { name, floor, updatedAt: now, isDown: false });
    return;
  }
  await ctx.db.insert("presence", {
    roomId, playerId, name,
    x: 0, y: 0, facing: 1,
    hp: 6, maxHp: 6, weapon: "pistol",
    floor, isDown: false, aimAngle: 0, shotSeq: 0, kills: 0,
    colorIndex, reviveNonce: 0, updatedAt: now,
  });
}

// Host a new room. Returns a short code to share with friends.
export const create = mutation({
  args: { playerId: v.id("players") },
  handler: async (ctx, { playerId }) => {
    const player = await ctx.db.get(playerId);
    if (!player) throw new Error("unknown player");
    const code = await uniqueCode(ctx);
    const seed = (Math.floor(Math.random() * 0xffffffff) | 0);
    const now = Date.now();
    const roomId = await ctx.db.insert("rooms", {
      code, hostPlayerId: playerId, seed, floor: 1,
      status: "lobby", isPublic: false, createdAt: now, lastActivity: now,
    });
    await ensurePresence(ctx, roomId, playerId, player.name, 1, 0);
    return { roomId, code, seed, floor: 1 };
  },
});

// Join an existing room by its share code.
export const join = mutation({
  args: { code: v.string(), playerId: v.id("players") },
  handler: async (ctx, { code, playerId }) => {
    const player = await ctx.db.get(playerId);
    if (!player) throw new Error("unknown player");
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code.trim().toUpperCase()))
      .unique();
    if (!room) throw new Error("no room with that code");
    if (room.status === "ended") throw new Error("that game has ended");
    const color = await smallestFreeColor(ctx, room._id);
    await ensurePresence(ctx, room._id, playerId, player.name, room.floor, color);
    await ctx.db.patch(room._id, { lastActivity: Date.now() });
    return { roomId: room._id, code: room.code, seed: room.seed, floor: room.floor, status: room.status };
  },
});


// Quick Play: drop straight into an open PUBLIC game with room to spare, or spin up
// a fresh public room for the next person. No codes, no hosting.
export const quickPlay = mutation({
  args: { playerId: v.id("players") },
  handler: async (ctx, { playerId }) => {
    const player = await ctx.db.get(playerId);
    if (!player) throw new Error("unknown player");
    const now = Date.now();

    // Look for public rooms still going (lobby or playing), freshest first.
    const candidates = await ctx.db
      .query("rooms")
      .withIndex("by_public_status", (q) => q.eq("isPublic", true))
      .order("desc")
      .take(40);

    for (const room of candidates) {
      if (room.status === "ended") continue;
      if (now - room.lastActivity > QUICKPLAY_STALE_MS) continue;
      const players = await ctx.db
        .query("presence")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      if (players.length >= MAX_PLAYERS) continue;
      // Join this one.
      const color = await smallestFreeColor(ctx, room._id);
      await ensurePresence(ctx, room._id, playerId, player.name, room.floor, color);
      await ctx.db.patch(room._id, { lastActivity: now });
      return { roomId: room._id, code: room.code, seed: room.seed, floor: room.floor, status: room.status, joined: true };
    }

    // None available — create a fresh public room and wait for others to drop in.
    const code = await uniqueCode(ctx);
    const seed = (Math.floor(Math.random() * 0xffffffff) | 0);
    const roomId = await ctx.db.insert("rooms", {
      code, hostPlayerId: playerId, seed, floor: 1,
      status: "lobby", isPublic: true, createdAt: now, lastActivity: now,
    });
    await ensurePresence(ctx, roomId, playerId, player.name, 1, 0);
    return { roomId, code, seed, floor: 1, status: "lobby" as const, joined: false };
  },
});

export const get = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return null;
    return {
      roomId: room._id,
      code: room.code,
      hostPlayerId: room.hostPlayerId,
      seed: room.seed,
      floor: room.floor,
      status: room.status,
    };
  },
});

// Host flips the lobby into a live game; everyone waiting begins.
export const start = mutation({
  args: { roomId: v.id("rooms"), playerId: v.id("players") },
  handler: async (ctx, { roomId, playerId }) => {
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error("no such room");
    if (room.hostPlayerId !== playerId) throw new Error("only the host can start");
    await ctx.db.patch(roomId, { status: "playing", lastActivity: Date.now() });
  },
});

// Advance the shared floor. Monotonic so a late/duplicate call can't rewind anyone.
export const descend = mutation({
  args: { roomId: v.id("rooms"), floor: v.number() },
  handler: async (ctx, { roomId, floor }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return;
    if (floor > room.floor) await ctx.db.patch(roomId, { floor, status: "playing", lastActivity: Date.now() });
  },
});

export const leave = mutation({
  args: { roomId: v.id("rooms"), playerId: v.id("players") },
  handler: async (ctx, { roomId, playerId }) => {
    const mine = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", playerId))
      .unique();
    if (mine) await ctx.db.delete(mine._id);
    const room = await ctx.db.get(roomId);
    if (!room) return;
    const rest = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    if (rest.length === 0) {
      await ctx.db.patch(roomId, { status: "ended", lastActivity: Date.now() });
    } else if (room.hostPlayerId === playerId) {
      await ctx.db.patch(roomId, { hostPlayerId: rest[0].playerId, lastActivity: Date.now() });
    }
  },
});
