import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertPvpModeAllowed } from "./pvpFlag";
import { ConvexError } from "convex/values";
import { validateCombinedLoadout } from "./loadoutCore";
import type { CombinedLoadoutInput, ConfirmedKitId, LoadoutValidation } from "./loadoutCore";

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
const ACTIVE_MEMBER_MS = 12_000;

const kindArg = v.optional(v.union(v.literal("coop"), v.literal("online")));
type RoomKind = "coop" | "online";
const loadoutArgs = {
  kitId: v.optional(v.string()),
  petId: v.optional(v.union(v.string(), v.null())),
  isKitChoiceMade: v.optional(v.boolean()),
  isPetChoiceMade: v.optional(v.boolean()),
};

interface ConfirmedLoadout {
  kitId: ConfirmedKitId;
  petId: string | null;
}

const LOADOUT_REJECT_COPY: Record<Exclude<LoadoutValidation, { ok: true }>["reason"], string> = {
  kit_choice_required: "choose a kit for this run",
  pet_choice_required: "choose a pet or No Pet for this run",
  unknown_kit: "that kit does not exist",
  kit_locked: "that kit is locked at your account level",
  pet_unowned: "rescue that pet before choosing it",
};

function requireLoadout(player: Doc<"players">, input: CombinedLoadoutInput): ConfirmedLoadout {
  const validation = validateCombinedLoadout(player, input);
  if (!validation.ok) {
    throw new ConvexError({
      code: validation.reason,
      message: LOADOUT_REJECT_COPY[validation.reason],
    });
  }
  return validation;
}

function loadoutInput(args: {
  kitId?: string;
  petId?: string | null;
  isKitChoiceMade?: boolean;
  isPetChoiceMade?: boolean;
}): CombinedLoadoutInput {
  return {
    kitId: args.kitId ?? "",
    petId: args.petId ?? null,
    isKitChoiceMade: args.isKitChoiceMade === true,
    isPetChoiceMade: args.isPetChoiceMade === true,
  };
}

function kindOf(room: Doc<"rooms">): RoomKind {
  return room.kind ?? "coop";
}

// The MATCH mode of an online room (co-op dungeon vs pvp arena). Optional/defaulted so every
// pre-existing room reads "coop" — it only selects which authoritative world id the ticket binds.
const modeArg = v.optional(v.union(v.literal("coop"), v.literal("pvp")));
type RoomMode = "coop" | "pvp";

function modeOf(room: Doc<"rooms">): RoomMode {
  return room.mode ?? "coop";
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
  roomStatus: Doc<"rooms">["status"],
  generation: number,
  loadout: ConfirmedLoadout | null,
): Promise<ConfirmedLoadout | null> {
  const existing = await ctx.db
    .query("presence")
    .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", playerId))
    .unique();
  const now = Date.now();
  if (existing) {
    const isRunLocked = roomStatus === "playing"
      && existing.isLoadoutConfirmed === true
      && existing.isKitChoiceMade === true
      && existing.isPetChoiceMade === true
      && existing.loadoutGeneration === generation
      && existing.loadoutKitId !== undefined;
    if (isRunLocked) {
      await ctx.db.patch(existing._id, {
        name, colorIndex, floor, updatedAt: now, isDown: false,
        gsWorldId: undefined, gsJoinedAt: undefined,
      });
      return {
        kitId: existing.loadoutKitId as ConfirmedKitId,
        petId: existing.loadoutPetId ?? null,
      };
    }
    await ctx.db.patch(existing._id, {
      name, colorIndex, floor, updatedAt: now, isDown: false,
      gsWorldId: undefined, gsJoinedAt: undefined, isReady: undefined,
      ...(loadout ? {
        loadoutKitId: loadout.kitId,
        loadoutPetId: loadout.petId ?? undefined,
        isKitChoiceMade: true,
        isPetChoiceMade: true,
        isLoadoutConfirmed: true,
        loadoutGeneration: generation,
      } : {}),
    });
    return loadout;
  }
  await ctx.db.insert("presence", {
    roomId, playerId, name,
    x: 0, y: 0, facing: 1,
    hp: 6, maxHp: 6, weapon: "pistol",
    floor, isDown: false, aimAngle: 0, shotSeq: 0, kills: 0,
    colorIndex, reviveNonce: 0, updatedAt: now,
    ...(loadout ? {
      loadoutKitId: loadout.kitId,
      loadoutPetId: loadout.petId ?? undefined,
      isKitChoiceMade: true,
      isPetChoiceMade: true,
      isLoadoutConfirmed: true,
      loadoutGeneration: generation,
    } : {}),
  });
  return loadout;
}

async function persistLoadoutConvenience(
  ctx: MutationCtx,
  player: Doc<"players">,
  loadout: ConfirmedLoadout,
): Promise<void> {
  await ctx.db.patch(player._id, {
    lastKitId: loadout.kitId,
    equippedPet: loadout.petId ?? undefined,
    lastSeen: Date.now(),
  });
}

// Host a new room. Returns a short code to share with friends. Online rooms use the caller's
// chosen blob color for their roster dot (classic co-op keeps the assigned palette slot).
export const create = mutation({
  args: {
    playerId: v.id("players"), kind: kindArg, mode: modeArg,
    colorIndex: v.optional(v.number()), ...loadoutArgs,
  },
  handler: async (ctx, args) => {
    const { playerId, kind, mode, colorIndex } = args;
    // TEMP kill switch (independent of the client UI): a pvp room can't be hosted while PVP is
    // disabled, so a stale client with a cached bundle can't create one either. Co-op untouched.
    assertPvpModeAllowed(mode);
    const player = await ctx.db.get(playerId);
    if (!player) throw new Error("unknown player");
    const roomKind = kind ?? "coop";
    const loadout = roomKind === "online" ? requireLoadout(player, loadoutInput(args)) : null;
    const code = await uniqueCode(ctx);
    const seed = (Math.floor(Math.random() * 0xffffffff) | 0);
    const now = Date.now();
    const generation = 1;
    const roomId = await ctx.db.insert("rooms", {
      code, kind: roomKind, mode: mode ?? "coop", hostPlayerId: playerId, seed, floor: 1,
      status: "lobby", isPublic: false, loadoutGeneration: generation,
      createdAt: now, lastActivity: now,
    });
    const effectiveLoadout = await ensurePresence(
      ctx, roomId, playerId, player.name, 1, colorIndex ?? 0, "lobby", generation, loadout,
    );
    if (effectiveLoadout) await persistLoadoutConvenience(ctx, player, effectiveLoadout);
    return {
      roomId, code, seed, floor: 1, mode: mode ?? "coop",
      loadoutGeneration: generation,
      kitId: effectiveLoadout?.kitId,
      petId: effectiveLoadout?.petId,
    };
  },
});

// Join an existing room by its share code. The kind must match the caller's flow so an online
// code can never pull someone into classic co-op (or vice versa).
export const join = mutation({
  args: {
    code: v.string(), playerId: v.id("players"), kind: kindArg,
    colorIndex: v.optional(v.number()), ...loadoutArgs,
  },
  handler: async (ctx, args) => {
    const { code, playerId, kind, colorIndex } = args;
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
    // TEMP kill switch: the mode comes from the EXISTING room doc, so joining a pvp room (even
    // one created before the switch flipped) is rejected while disabled. Co-op joins untouched.
    assertPvpModeAllowed(modeOf(room));
    if (wantKind === "online") {
      // Online rooms enforce the party cap at join (classic co-op keeps its historical
      // quickPlay-only cap, unchanged).
      const members = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", room._id)).collect();
      const isMember = members.some((r) => r.playerId === playerId);
      if (!isMember && members.length >= MAX_PLAYERS) throw new Error("that room is full");
    }
    const loadout = wantKind === "online" ? requireLoadout(player, loadoutInput(args)) : null;
    const color = colorIndex ?? await smallestFreeColor(ctx, room._id);
    const generation = room.loadoutGeneration ?? 1;
    const effectiveLoadout = await ensurePresence(
      ctx, room._id, playerId, player.name, room.floor, color,
      room.status, generation, loadout,
    );
    if (effectiveLoadout) await persistLoadoutConvenience(ctx, player, effectiveLoadout);
    await ctx.db.patch(room._id, { lastActivity: Date.now() });
    // The room dictates its own match mode; the joiner adopts it (drives the client's world-id
    // expectation + which ticket world the mint binds).
    return {
      roomId: room._id, code: room.code, seed: room.seed, floor: room.floor,
      status: room.status, mode: modeOf(room), loadoutGeneration: generation,
      kitId: effectiveLoadout?.kitId, petId: effectiveLoadout?.petId,
    };
  },
});


// Quick Play: drop straight into an open PUBLIC game (of the SAME kind) with room to spare, or
// spin up a fresh public room for the next person. No codes, no hosting. Online quick-play
// rooms are born "playing" — the authoritative world runs on demand, so there is no host gate
// and players drop in/out of the public pool freely.
export const quickPlay = mutation({
  args: {
    playerId: v.id("players"), kind: kindArg, mode: modeArg,
    colorIndex: v.optional(v.number()), ...loadoutArgs,
  },
  handler: async (ctx, args) => {
    const { playerId, kind, mode, colorIndex } = args;
    // TEMP kill switch: quick-play into the pvp pool is closed while disabled (independent of
    // the UI), so a stale client can neither join an open pvp room nor spin up a fresh one.
    assertPvpModeAllowed(mode);
    const player = await ctx.db.get(playerId);
    if (!player) throw new Error("unknown player");
    const wantKind: RoomKind = kind ?? "coop";
    const wantMode: RoomMode = mode ?? "coop";
    const loadout = wantKind === "online" ? requireLoadout(player, loadoutInput(args)) : null;
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
      if (modeOf(room) !== wantMode) continue; // a pvp quick-play only pools with pvp rooms
      if (now - room.lastActivity > QUICKPLAY_STALE_MS) continue;
      const players = await ctx.db
        .query("presence")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      if (players.length >= MAX_PLAYERS) continue;
      // Join this one.
      const color = colorIndex ?? await smallestFreeColor(ctx, room._id);
      const generation = room.loadoutGeneration ?? 1;
      const effectiveLoadout = await ensurePresence(
        ctx, room._id, playerId, player.name, room.floor, color,
        room.status, generation, loadout,
      );
      if (effectiveLoadout) await persistLoadoutConvenience(ctx, player, effectiveLoadout);
      await ctx.db.patch(room._id, { lastActivity: now });
      return {
        roomId: room._id, code: room.code, seed: room.seed, floor: room.floor,
        status: room.status, mode: modeOf(room), joined: true,
        loadoutGeneration: generation,
        kitId: effectiveLoadout?.kitId, petId: effectiveLoadout?.petId,
      };
    }

    // None available — create a fresh public room and wait for others to drop in.
    const code = await uniqueCode(ctx);
    const seed = (Math.floor(Math.random() * 0xffffffff) | 0);
    const status = wantKind === "online" ? ("playing" as const) : ("lobby" as const);
    const generation = 1;
    const roomId = await ctx.db.insert("rooms", {
      code, kind: wantKind, mode: wantMode, hostPlayerId: playerId, seed, floor: 1,
      status, isPublic: true, loadoutGeneration: generation, createdAt: now, lastActivity: now,
    });
    const effectiveLoadout = await ensurePresence(
      ctx, roomId, playerId, player.name, 1, colorIndex ?? 0,
      status, generation, loadout,
    );
    if (effectiveLoadout) await persistLoadoutConvenience(ctx, player, effectiveLoadout);
    return {
      roomId, code, seed, floor: 1, status, mode: wantMode, joined: false,
      loadoutGeneration: generation,
      kitId: effectiveLoadout?.kitId, petId: effectiveLoadout?.petId,
    };
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
      mode: modeOf(room),
      loadoutGeneration: room.loadoutGeneration ?? 1,
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
    if (!room || kindOf(room) !== "online" || room.status === "ended") {
      return {
        isMember: false, mode: "coop" as RoomMode, isLoadoutConfirmed: false,
        kitId: null, petId: null, masteryXp: 0,
      };
    }
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", room._id).eq("playerId", playerId))
      .unique();
    const generation = room.loadoutGeneration ?? 1;
    const isLoadoutConfirmed = row !== null
      && row.isKitChoiceMade === true
      && row.isPetChoiceMade === true
      && row.isLoadoutConfirmed === true
      && row.loadoutGeneration === generation
      && row.loadoutKitId !== undefined;
    const player = row ? await ctx.db.get(row.playerId) : null;
    return {
      isMember: row !== null,
      mode: modeOf(room),
      isLoadoutConfirmed,
      kitId: isLoadoutConfirmed ? row.loadoutKitId ?? null : null,
      petId: isLoadoutConfirmed ? row.loadoutPetId ?? null : null,
      masteryXp: player?.masteryXp ?? 0,
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
    if (room.status !== "lobby") {
      return { ok: false as const, code: "run_already_started" as const, message: "this run already started" };
    }
    if (kindOf(room) === "online") {
      const generation = room.loadoutGeneration ?? 1;
      const cutoff = Date.now() - ACTIVE_MEMBER_MS;
      const rows = (await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect())
        .filter((row) => row.updatedAt >= cutoff);
      for (const row of rows) {
        const isConfirmed = row.isKitChoiceMade === true
          && row.isPetChoiceMade === true
          && row.isLoadoutConfirmed === true
          && row.loadoutGeneration === generation
          && row.loadoutKitId !== undefined;
        if (!isConfirmed) {
          return {
            ok: false as const,
            code: "loadout_missing" as const,
            playerName: row.name,
            message: `${row.name} must confirm KIT + PET`,
          };
        }
      }
      for (const row of rows) {
        if (row.isReady !== true) {
          return {
            ok: false as const,
            code: "not_ready" as const,
            playerName: row.name,
            message: `${row.name} is not ready`,
          };
        }
      }
    }
    await ctx.db.patch(roomId, { status: "playing", lastActivity: Date.now() });
    return { ok: true as const };
  },
});

export const confirmLoadout = mutation({
  args: {
    roomId: v.id("rooms"),
    playerId: v.id("players"),
    generation: v.number(),
    kitId: v.string(),
    petId: v.union(v.string(), v.null()),
    isKitChoiceMade: v.boolean(),
    isPetChoiceMade: v.boolean(),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || kindOf(room) !== "online") {
      return { ok: false as const, reason: "not_in_room" as const };
    }
    const generation = room.loadoutGeneration ?? 1;
    if (room.status !== "lobby") return { ok: false as const, reason: "run_locked" as const };
    if (args.generation !== generation) return { ok: false as const, reason: "generation_changed" as const };
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", args.roomId).eq("playerId", args.playerId))
      .unique();
    if (!row) return { ok: false as const, reason: "not_in_room" as const };
    const player = await ctx.db.get(args.playerId);
    if (!player) return { ok: false as const, reason: "not_in_room" as const };
    const validation = validateCombinedLoadout(player, args);
    if (!validation.ok) return { ok: false as const, reason: validation.reason };
    await ctx.db.patch(row._id, {
      loadoutKitId: validation.kitId,
      loadoutPetId: validation.petId ?? undefined,
      isKitChoiceMade: true,
      isPetChoiceMade: true,
      isLoadoutConfirmed: true,
      loadoutGeneration: generation,
      isReady: undefined,
      updatedAt: Date.now(),
    });
    await persistLoadoutConvenience(ctx, player, validation);
    return {
      ok: true as const,
      generation,
      kitId: validation.kitId,
      petId: validation.petId,
    };
  },
});

export const clearLoadoutConfirmation = mutation({
  args: {
    roomId: v.id("rooms"),
    playerId: v.id("players"),
    generation: v.number(),
  },
  handler: async (ctx, { roomId, playerId, generation }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.status !== "lobby" || (room.loadoutGeneration ?? 1) !== generation) {
      return { ok: false as const };
    }
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", playerId))
      .unique();
    if (!row) return { ok: false as const };
    await ctx.db.patch(row._id, {
      isKitChoiceMade: undefined,
      isPetChoiceMade: undefined,
      isLoadoutConfirmed: undefined,
      isReady: undefined,
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

// After an online run ends (party wipe), the room regroups: back from "playing" to "lobby" so
// the same code hosts the next run. Any member may flip it (all clients land here at once
// after a wipe; the patch is idempotent). Ended rooms stay ended.
export const reopen = mutation({
  args: { roomId: v.id("rooms"), playerId: v.id("players") },
  handler: async (ctx, { roomId, playerId }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return { loadoutGeneration: 1 };
    if (room.status !== "playing") return { loadoutGeneration: room.loadoutGeneration ?? 1 };
    const member = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", playerId))
      .unique();
    if (!member) return { loadoutGeneration: room.loadoutGeneration ?? 1 };
    const generation = (room.loadoutGeneration ?? 1) + 1;
    await ctx.db.patch(roomId, {
      status: "lobby",
      loadoutGeneration: generation,
      lastActivity: Date.now(),
    });
    const rows = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        isKitChoiceMade: undefined,
        isPetChoiceMade: undefined,
        isLoadoutConfirmed: undefined,
        isReady: undefined,
      });
    }
    return { loadoutGeneration: generation };
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
