import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Rooms come in two kinds that never cross-match (see schema.ts):
//   "coop"   — classic peer-synced co-op (the pre-authoritative path, fully preserved).
//   "online" — a lobby for the AUTHORITATIVE game server; the room code maps to a distinct
//              server world and Convex only hosts the roster/status handshake.
// `kind` is an optional arg everywhere, defaulting to "coop", so every pre-existing client
// call keeps its exact behavior.

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous O/0/I/1
const CODE_LEN = 4;
const MAX_PLAYERS = 4;                 // party cap (both kinds)
const QUICKPLAY_STALE_MS = 45_000;     // ignore rooms with no activity for this long

const kindArg = v.optional(v.union(v.literal("coop"), v.literal("online")));
type RoomKind = "coop" | "online";

function kindOf(room: Doc<"rooms">): RoomKind {
  return room.kind ?? "coop";
}

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
    // A (re)join lands in the LOBBY: any stale world-connection mirror or READY toggle from
    // a previous round must not carry over — cleared here, re-earned in this lobby.
    await ctx.db.patch(existing._id, { name, colorIndex, floor, updatedAt: now, isDown: false, gsWorldId: undefined, gsJoinedAt: undefined, isReady: undefined });
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

// Host a new room. Returns a short code to share with friends. Online rooms use the caller's
// chosen blob color for their roster dot (classic co-op keeps the assigned palette slot).
export const create = mutation({
  args: { playerId: v.id("players"), kind: kindArg, colorIndex: v.optional(v.number()) },
  handler: async (ctx, { playerId, kind, colorIndex }) => {
    const player = await ctx.db.get(playerId);
    if (!player) throw new Error("unknown player");
    const code = await uniqueCode(ctx);
    const seed = (Math.floor(Math.random() * 0xffffffff) | 0);
    const now = Date.now();
    const roomId = await ctx.db.insert("rooms", {
      code, kind: kind ?? "coop", hostPlayerId: playerId, seed, floor: 1,
      status: "lobby", isPublic: false, createdAt: now, lastActivity: now,
    });
    await ensurePresence(ctx, roomId, playerId, player.name, 1, colorIndex ?? 0);
    return { roomId, code, seed, floor: 1 };
  },
});

// Join an existing room by its share code. The kind must match the caller's flow so an online
// code can never pull someone into classic co-op (or vice versa).
export const join = mutation({
  args: { code: v.string(), playerId: v.id("players"), kind: kindArg, colorIndex: v.optional(v.number()) },
  handler: async (ctx, { code, playerId, kind, colorIndex }) => {
    const player = await ctx.db.get(playerId);
    if (!player) throw new Error("unknown player");
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code.trim().toUpperCase()))
      .unique();
    if (!room) throw new Error("no room with that code");
    const wantKind: RoomKind = kind ?? "coop";
    if (kindOf(room) !== wantKind) {
      throw new Error(wantKind === "online" ? "that code is a classic co-op room" : "that code is an online room");
    }
    if (room.status === "ended") throw new Error("that game has ended");
    if (wantKind === "online") {
      // Online rooms enforce the party cap at join (classic co-op keeps its historical
      // quickPlay-only cap, unchanged).
      const members = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", room._id)).collect();
      const isMember = members.some((r) => r.playerId === playerId);
      if (!isMember && members.length >= MAX_PLAYERS) throw new Error("that room is full");
    }
    const color = colorIndex ?? await smallestFreeColor(ctx, room._id);
    await ensurePresence(ctx, room._id, playerId, player.name, room.floor, color);
    await ctx.db.patch(room._id, { lastActivity: Date.now() });
    return { roomId: room._id, code: room.code, seed: room.seed, floor: room.floor, status: room.status };
  },
});


// Quick Play: drop straight into an open PUBLIC game (of the SAME kind) with room to spare, or
// spin up a fresh public room for the next person. No codes, no hosting. Online quick-play
// rooms are born "playing" — the authoritative world runs on demand, so there is no host gate
// and players drop in/out of the public pool freely.
export const quickPlay = mutation({
  args: { playerId: v.id("players"), kind: kindArg, colorIndex: v.optional(v.number()) },
  handler: async (ctx, { playerId, kind, colorIndex }) => {
    const player = await ctx.db.get(playerId);
    if (!player) throw new Error("unknown player");
    const wantKind: RoomKind = kind ?? "coop";
    const now = Date.now();

    // Look for public rooms still going (lobby or playing), freshest first.
    const candidates = await ctx.db
      .query("rooms")
      .withIndex("by_public_status", (q) => q.eq("isPublic", true))
      .order("desc")
      .take(40);

    for (const room of candidates) {
      if (room.status === "ended") continue;
      if (kindOf(room) !== wantKind) continue;
      if (now - room.lastActivity > QUICKPLAY_STALE_MS) continue;
      const players = await ctx.db
        .query("presence")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      if (players.length >= MAX_PLAYERS) continue;
      // Join this one.
      const color = colorIndex ?? await smallestFreeColor(ctx, room._id);
      await ensurePresence(ctx, room._id, playerId, player.name, room.floor, color);
      await ctx.db.patch(room._id, { lastActivity: now });
      return { roomId: room._id, code: room.code, seed: room.seed, floor: room.floor, status: room.status, joined: true };
    }

    // None available — create a fresh public room and wait for others to drop in.
    const code = await uniqueCode(ctx);
    const seed = (Math.floor(Math.random() * 0xffffffff) | 0);
    const status = wantKind === "online" ? ("playing" as const) : ("lobby" as const);
    const roomId = await ctx.db.insert("rooms", {
      code, kind: wantKind, hostPlayerId: playerId, seed, floor: 1,
      status, isPublic: true, createdAt: now, lastActivity: now,
    });
    await ensurePresence(ctx, roomId, playerId, player.name, 1, colorIndex ?? 0);
    return { roomId, code, seed, floor: 1, status, joined: false };
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

// Membership check backing the game-server ticket mint (gsTicket.mint): a `wld` claim is
// minted ONLY for a player who actually sits in that online room. This is what turns "I know
// a code" into a verified, signed world authorization.
export const membership = query({
  args: { code: v.string(), playerId: v.id("players") },
  handler: async (ctx, { code, playerId }) => {
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code.trim().toUpperCase()))
      .unique();
    if (!room || kindOf(room) !== "online" || room.status === "ended") return { isMember: false };
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", room._id).eq("playerId", playerId))
      .unique();
    return { isMember: row !== null };
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

// After an online run ends (party wipe), the room regroups: back from "playing" to "lobby" so
// the same code hosts the next run. Any member may flip it (all clients land here at once
// after a wipe; the patch is idempotent). Ended rooms stay ended.
export const reopen = mutation({
  args: { roomId: v.id("rooms"), playerId: v.id("players") },
  handler: async (ctx, { roomId, playerId }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.status !== "playing") return;
    const member = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", playerId))
      .unique();
    if (!member) return;
    await ctx.db.patch(roomId, { status: "lobby", lastActivity: Date.now() });
    // A fresh round needs fresh consent: every member's READY toggle resets with the reopen.
    const rows = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    for (const row of rows) {
      if (row.isReady) await ctx.db.patch(row._id, { isReady: undefined });
    }
  },
});

// Keepalive while a player sits in a lobby or plays on the game server: refreshes their
// presence row (the roster hides rows stale for >12s) and the room's lastActivity (so open
// public rooms stay quick-play matchable). Classic co-op refreshes through presence.update
// instead; online play has no gameplay presence sync, hence this explicit heartbeat. The
// beat also carries the CURRENT identity (name/color pick): a color chosen while sitting in
// the lobby reaches the roster within one beat, so the roster dot and the ticket identity
// the next run will carry never disagree.
export const heartbeat = mutation({
  args: { roomId: v.id("rooms"), playerId: v.id("players"), name: v.optional(v.string()), colorIndex: v.optional(v.number()), pingMs: v.optional(v.number()) },
  handler: async (ctx, { roomId, playerId, name, colorIndex, pingMs }) => {
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", playerId))
      .unique();
    if (!row) return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      updatedAt: now,
      ...(name !== undefined && name.length > 0 ? { name } : {}),
      ...(colorIndex !== undefined ? { colorIndex } : {}),
      ...(pingMs !== undefined ? { pingMs: Math.max(0, Math.round(pingMs)) } : {}),
    });
    const room = await ctx.db.get(roomId);
    if (room && room.status !== "ended") await ctx.db.patch(roomId, { lastActivity: now });
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
