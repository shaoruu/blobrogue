import { internalQuery, mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertPvpModeAllowed } from "./pvpFlag";
import { validateCombinedLoadout, validateKitDraft, validatePetDraft } from "./loadoutCore";
import type { CombinedLoadoutInput, ConfirmedKitId, LoadoutValidation } from "./loadoutCore";
import { evaluateLobbyStart } from "./lobbyLoadoutCore";
import { resolveAuthorizedPlayer } from "./guestAuth";
import { pvpWorldIdForRoomCode, worldIdForRoomCode } from "./gsTicketCore";

// Rooms come in two kinds that never cross-match (see schema.ts):
//   "coop"   — classic peer-synced co-op (the pre-authoritative path, fully preserved).
//   "online" — a lobby for the AUTHORITATIVE game server; the room code maps to a distinct
//              server world and Convex only hosts the roster/status handshake.
// `kind` remains optional/default-coop for the legacy path. Online writes resolve the caller
// from auth or the guest client capability instead of trusting a caller-supplied player id.

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

async function resolveRoomCaller(
  ctx: MutationCtx,
  kind: RoomKind,
  clientId: string | undefined,
  guestCapability: string | undefined,
  playerId: Id<"players"> | undefined,
): Promise<Doc<"players">> {
  if (kind === "online") {
    return await resolveAuthorizedPlayer(ctx, clientId ?? "", guestCapability, "room");
  }
  if (!playerId) throw new Error("unknown player");
  const player = await ctx.db.get(playerId);
  if (!player) throw new Error("unknown player");
  return player;
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
  const used = new Set(rows.filter((row) => row.isDeparted !== true).map((row) => row.colorIndex));
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
        gsWorldId: undefined, gsJoinedAt: undefined, isDeparted: undefined,
        ...(roomStatus === "playing" ? { isReady: true } : {}),
      });
      return {
        kitId: existing.loadoutKitId as ConfirmedKitId,
        petId: existing.loadoutPetId ?? null,
      };
    }
    await ctx.db.patch(existing._id, {
      name, colorIndex, floor, updatedAt: now, isDown: false,
      gsWorldId: undefined, gsJoinedAt: undefined, isReady: undefined, isDeparted: undefined,
      ...(loadout ? {
        loadoutKitId: loadout.kitId,
        loadoutPetId: loadout.petId ?? undefined,
        isKitChoiceMade: true,
        isPetChoiceMade: true,
        isLoadoutConfirmed: true,
        loadoutGeneration: generation,
        ...(roomStatus === "playing" ? { isReady: true } : {}),
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
      ...(roomStatus === "playing" ? { isReady: true } : {}),
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
    clientId: v.optional(v.string()), guestCapability: v.optional(v.string()),
    playerId: v.optional(v.id("players")), kind: kindArg, mode: modeArg,
    colorIndex: v.optional(v.number()), ...loadoutArgs,
  },
  handler: async (ctx, args) => {
    const { clientId, guestCapability, playerId: requestedPlayerId, kind, mode, colorIndex } = args;
    // TEMP kill switch (independent of the client UI): a pvp room can't be hosted while PVP is
    // disabled, so a stale client with a cached bundle can't create one either. Co-op untouched.
    assertPvpModeAllowed(mode);
    const roomKind = kind ?? "coop";
    const player = await resolveRoomCaller(ctx, roomKind, clientId, guestCapability, requestedPlayerId);
    const playerId = player._id;
    const loadout = roomKind === "online" ? requireLoadout(player, loadoutInput(args)) : null;
    const code = await uniqueCode(ctx);
    const seed = (Math.floor(Math.random() * 0xffffffff) | 0);
    const now = Date.now();
    const generation = 1;
    const roomId = await ctx.db.insert("rooms", {
      code, kind: roomKind, mode: mode ?? "coop", hostPlayerId: playerId, seed, floor: 1,
      status: "lobby", isPublic: false, loadoutGeneration: generation,
      generationState: roomKind === "online" ? "pending" : undefined,
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
    code: v.string(), clientId: v.optional(v.string()), guestCapability: v.optional(v.string()),
    playerId: v.optional(v.id("players")), kind: kindArg,
    colorIndex: v.optional(v.number()), ...loadoutArgs,
  },
  handler: async (ctx, args) => {
    const { code, clientId, guestCapability, playerId: requestedPlayerId, kind, colorIndex } = args;
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", code.trim().toUpperCase()))
      .unique();
    if (!room) throw new Error("no room with that code");
    const wantKind: RoomKind = kind ?? "coop";
    if (kindOf(room) !== wantKind) {
      throw new Error(wantKind === "online" ? "that code is a classic co-op room" : "that code is an online room");
    }
    const player = await resolveRoomCaller(ctx, wantKind, clientId, guestCapability, requestedPlayerId);
    const playerId = player._id;
    if (room.status === "ended") throw new Error("that game has ended");
    // TEMP kill switch: the mode comes from the EXISTING room doc, so joining a pvp room (even
    // one created before the switch flipped) is rejected while disabled. Co-op joins untouched.
    assertPvpModeAllowed(modeOf(room));
    if (wantKind === "online") {
      // Online rooms enforce the party cap at join (classic co-op keeps its historical
      // quickPlay-only cap, unchanged).
      const members = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", room._id)).collect();
      const isMember = members.some((member) => member.playerId === playerId && member.isDeparted !== true);
      const activeCount = members.filter((member) => member.isDeparted !== true).length;
      if (!isMember && activeCount >= MAX_PLAYERS) throw new Error("that room is full");
    }
    const loadout = wantKind === "online" ? requireLoadout(player, loadoutInput(args)) : null;
    const color = colorIndex ?? await smallestFreeColor(ctx, room._id);
    const generation = room.loadoutGeneration ?? 1;
    const effectiveLoadout = await ensurePresence(ctx, room._id,
      playerId, player.name, room.floor, color,
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
    clientId: v.optional(v.string()), guestCapability: v.optional(v.string()),
    playerId: v.optional(v.id("players")), kind: kindArg, mode: modeArg,
    colorIndex: v.optional(v.number()), ...loadoutArgs,
  },
  handler: async (ctx, args) => {
    const { clientId, guestCapability, playerId: requestedPlayerId, kind, mode, colorIndex } = args;
    // TEMP kill switch: quick-play into the pvp pool is closed while disabled (independent of
    // the UI), so a stale client can neither join an open pvp room nor spin up a fresh one.
    assertPvpModeAllowed(mode);
    const wantKind: RoomKind = kind ?? "coop";
    const player = await resolveRoomCaller(ctx, wantKind, clientId, guestCapability, requestedPlayerId);
    const playerId = player._id;
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
      if (wantKind === "online" && room.generationState !== "active") continue;
      if (now - room.lastActivity > QUICKPLAY_STALE_MS) continue;
      const players = await ctx.db
        .query("presence")
        .withIndex("by_room", (q) => q.eq("roomId", room._id))
        .collect();
      if (players.filter((player) => player.isDeparted !== true).length >= MAX_PLAYERS) continue;
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
      status, isPublic: true, loadoutGeneration: generation,
      generationState: wantKind === "online" ? "active" : undefined,
      createdAt: now, lastActivity: now,
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
        isRunLocked: false, loadoutGeneration: 1,
        kitId: null, petId: null,
      };
    }
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", room._id).eq("playerId", playerId))
      .unique();
    const generation = room.loadoutGeneration ?? 1;
    const isMember = row !== null
      && row.isDeparted !== true
      && (room.isPublic === true || row.isReady === true);
    const isLoadoutConfirmed = row !== null
      && row.isKitChoiceMade === true
      && row.isPetChoiceMade === true
      && row.isLoadoutConfirmed === true
      && row.loadoutGeneration === generation
      && row.loadoutKitId !== undefined;
    return {
      isMember,
      mode: modeOf(room),
      isRunLocked: room.status === "playing",
      loadoutGeneration: generation,
      isLoadoutConfirmed,
      kitId: isLoadoutConfirmed ? row.loadoutKitId ?? null : null,
      petId: isLoadoutConfirmed ? row.loadoutPetId ?? null : null,
    };
  },
});

export const ticketSnapshot = internalQuery({
  args: {
    clientId: v.string(),
    guestCapability: v.optional(v.string()),
    code: v.string(),
  },
  handler: async (ctx, { clientId, guestCapability, code }) => {
    const player = await resolveAuthorizedPlayer(ctx, clientId, guestCapability, "ticket");
    const room = await ctx.db.query("rooms")
      .withIndex("by_code", (queryBuilder) => queryBuilder.eq("code", code.trim().toUpperCase()))
      .unique();
    if (!room || kindOf(room) !== "online" || room.status !== "playing") {
      throw new ConvexError({ code: "room_not_active", message: "that room is not active" });
    }
    if (room.generationState !== "active") {
      throw new ConvexError({ code: "generation_not_active", message: "that run generation is not active" });
    }
    const row = await ctx.db.query("presence")
      .withIndex("by_room_player", (queryBuilder) => (
        queryBuilder.eq("roomId", room._id).eq("playerId", player._id)
      ))
      .unique();
    const generation = room.loadoutGeneration ?? 1;
    const isMember = row !== null
      && row.isDeparted !== true
      && (room.isPublic === true || row.isReady === true);
    const isConfirmed = row !== null
      && row.isKitChoiceMade === true
      && row.isPetChoiceMade === true
      && row.isLoadoutConfirmed === true
      && row.loadoutGeneration === generation
      && row.loadoutKitId !== undefined;
    if (!isMember || !isConfirmed || !row?.loadoutKitId) {
      throw new ConvexError({ code: "loadout_not_confirmed", message: "confirm and ready the loadout first" });
    }
    return {
      playerId: player._id,
      name: player.name,
      colorIndex: player.colorIndex ?? 0,
      hat: player.cosmeticLoadout?.hat ?? null,
      face: player.cosmeticLoadout?.face ?? null,
      masteryXp: player.masteryXp ?? 0,
      kitId: row.loadoutKitId,
      petId: row.loadoutPetId ?? null,
      roomCode: room.code,
      mode: modeOf(room),
      generation,
    };
  },
});

export const generationAdmission = internalQuery({
  args: {
    playerId: v.string(),
    worldId: v.string(),
    roomCode: v.string(),
    generation: v.number(),
    kitId: v.string(),
    petId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db.query("rooms")
      .withIndex("by_code", (queryBuilder) => queryBuilder.eq("code", args.roomCode))
      .unique();
    if (!room || kindOf(room) !== "online" || room.status !== "playing") {
      return { isAllowed: false as const, code: "room_not_active" };
    }
    const generation = room.loadoutGeneration ?? 1;
    const expectedWorldId = modeOf(room) === "pvp"
      ? pvpWorldIdForRoomCode(room.code, generation)
      : worldIdForRoomCode(room.code, generation);
    if (room.generationState !== "active"
      || generation !== args.generation
      || expectedWorldId !== args.worldId) {
      return { isAllowed: false as const, code: "generation_not_active" };
    }
    const playerId = args.playerId as Id<"players">;
    const player = await ctx.db.get(playerId);
    if (!player) return { isAllowed: false as const, code: "player_missing" };
    const row = await ctx.db.query("presence")
      .withIndex("by_room_player", (queryBuilder) => (
        queryBuilder.eq("roomId", room._id).eq("playerId", playerId)
      ))
      .unique();
    const isLoadoutCurrent = row !== null
      && row.isDeparted !== true
      && row.isKitChoiceMade === true
      && row.isPetChoiceMade === true
      && row.isLoadoutConfirmed === true
      && row.loadoutGeneration === generation
      && row.loadoutKitId === args.kitId
      && (row.loadoutPetId ?? null) === args.petId;
    const isMember = isLoadoutCurrent && (room.isPublic === true || row?.isReady === true);
    return isMember
      ? { isAllowed: true as const, code: "ok" }
      : { isAllowed: false as const, code: "membership_changed" };
  },
});

// Host flips the lobby into a live game; everyone waiting begins.
export const start = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.optional(v.string()),
    guestCapability: v.optional(v.string()),
    playerId: v.optional(v.id("players")),
  },
  handler: async (ctx, { roomId, clientId, guestCapability, playerId }) => {
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error("no such room");
    const caller = await resolveRoomCaller(ctx, kindOf(room), clientId, guestCapability, playerId);
    if (room.hostPlayerId !== caller._id) throw new Error("only the host can start");
    if (room.status !== "lobby") {
      return { ok: false as const, code: "run_already_started" as const, message: "this run already started" };
    }
    if (kindOf(room) === "online") {
      const generation = room.loadoutGeneration ?? 1;
      const allRows = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
      const decision = evaluateLobbyStart(
        allRows,
        room.hostPlayerId,
        generation,
        Date.now(),
        ACTIVE_MEMBER_MS,
      );
      if (!decision.ok) return decision;
    }
    await ctx.db.patch(roomId, {
      status: "playing",
      generationState: kindOf(room) === "online" ? "active" : room.generationState,
      generationCompletedAt: undefined,
      generationCompletionJti: undefined,
      lastActivity: Date.now(),
    });
    return { ok: true as const };
  },
});

export const beginLoadoutEdit = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    guestCapability: v.optional(v.string()),
    generation: v.number(),
  },
  handler: async (ctx, { roomId, clientId, guestCapability, generation }) => {
    const room = await ctx.db.get(roomId);
    if (!room || kindOf(room) !== "online" || room.status !== "lobby") {
      return { ok: false as const, reason: "run_locked" as const };
    }
    const currentGeneration = room.loadoutGeneration ?? 1;
    if (generation !== currentGeneration) {
      return { ok: false as const, reason: "generation_changed" as const };
    }
    const player = await resolveAuthorizedPlayer(ctx, clientId, guestCapability, "room");
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", player._id))
      .unique();
    if (!row || row.isDeparted === true) return { ok: false as const, reason: "not_in_room" as const };
    const editRevision = (row.loadoutEditRevision ?? 0) + 1;
    await ctx.db.patch(row._id, {
      isKitChoiceMade: undefined,
      isPetChoiceMade: undefined,
      isLoadoutConfirmed: undefined,
      isReady: undefined,
      loadoutGeneration: currentGeneration,
      loadoutEditRevision: editRevision,
      isDeparted: undefined,
      updatedAt: Date.now(),
    });
    return { ok: true as const, editRevision };
  },
});

export const chooseDraftKit = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    guestCapability: v.optional(v.string()),
    generation: v.number(),
    editRevision: v.number(),
    kitId: v.string(),
  },
  handler: async (ctx, { roomId, clientId, guestCapability, generation, editRevision, kitId }) => {
    const room = await ctx.db.get(roomId);
    if (!room || kindOf(room) !== "online" || room.status !== "lobby") {
      return { ok: false as const, reason: "run_locked" as const };
    }
    const currentGeneration = room.loadoutGeneration ?? 1;
    if (generation !== currentGeneration) {
      return { ok: false as const, reason: "generation_changed" as const };
    }
    const player = await resolveAuthorizedPlayer(ctx, clientId, guestCapability, "room");
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", player._id))
      .unique();
    if (!row || row.isDeparted === true) return { ok: false as const, reason: "not_in_room" as const };
    if (row.loadoutEditRevision !== editRevision) {
      return { ok: false as const, reason: "edit_changed" as const };
    }
    const validation = validateKitDraft(player, kitId);
    if (!validation.ok) return { ok: false as const, reason: validation.reason };
    await ctx.db.patch(row._id, {
      loadoutKitId: validation.kitId,
      isKitChoiceMade: true,
      isLoadoutConfirmed: undefined,
      isReady: undefined,
      loadoutGeneration: currentGeneration,
      isDeparted: undefined,
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

export const chooseDraftPet = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    guestCapability: v.optional(v.string()),
    generation: v.number(),
    editRevision: v.number(),
    petId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { roomId, clientId, guestCapability, generation, editRevision, petId }) => {
    const room = await ctx.db.get(roomId);
    if (!room || kindOf(room) !== "online" || room.status !== "lobby") {
      return { ok: false as const, reason: "run_locked" as const };
    }
    const currentGeneration = room.loadoutGeneration ?? 1;
    if (generation !== currentGeneration) {
      return { ok: false as const, reason: "generation_changed" as const };
    }
    const player = await resolveAuthorizedPlayer(ctx, clientId, guestCapability, "room");
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", player._id))
      .unique();
    if (!row || row.isDeparted === true) return { ok: false as const, reason: "not_in_room" as const };
    if (row.loadoutEditRevision !== editRevision) {
      return { ok: false as const, reason: "edit_changed" as const };
    }
    const validation = validatePetDraft(player, petId);
    if (!validation.ok) return { ok: false as const, reason: validation.reason };
    await ctx.db.patch(row._id, {
      loadoutPetId: validation.petId ?? undefined,
      isPetChoiceMade: true,
      isLoadoutConfirmed: undefined,
      isReady: undefined,
      loadoutGeneration: currentGeneration,
      isDeparted: undefined,
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

export const confirmLoadout = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    guestCapability: v.optional(v.string()),
    generation: v.number(),
    editRevision: v.number(),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || kindOf(room) !== "online") {
      return { ok: false as const, reason: "not_in_room" as const };
    }
    const generation = room.loadoutGeneration ?? 1;
    if (room.status !== "lobby") return { ok: false as const, reason: "run_locked" as const };
    if (args.generation !== generation) return { ok: false as const, reason: "generation_changed" as const };
    const player = await resolveAuthorizedPlayer(
      ctx,
      args.clientId,
      args.guestCapability,
      "room",
    );
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", args.roomId).eq("playerId", player._id))
      .unique();
    if (!row || row.isDeparted === true) return { ok: false as const, reason: "not_in_room" as const };
    if (row.loadoutEditRevision !== args.editRevision) {
      return { ok: false as const, reason: "edit_changed" as const };
    }
    const validation = validateCombinedLoadout(player, {
      kitId: row.loadoutKitId ?? "",
      petId: row.loadoutPetId ?? null,
      isKitChoiceMade: row.isKitChoiceMade === true,
      isPetChoiceMade: row.isPetChoiceMade === true,
    });
    if (!validation.ok) return { ok: false as const, reason: validation.reason };
    await ctx.db.patch(row._id, {
      loadoutKitId: validation.kitId,
      loadoutPetId: validation.petId ?? undefined,
      isKitChoiceMade: true,
      isPetChoiceMade: true,
      isLoadoutConfirmed: true,
      loadoutGeneration: generation,
      loadoutEditRevision: args.editRevision + 1,
      isReady: undefined,
      isDeparted: undefined,
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

// After a server-attested completion, the host advances exactly one generation.
export const reopen = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.optional(v.string()),
    guestCapability: v.optional(v.string()),
    playerId: v.optional(v.id("players")),
    generation: v.optional(v.number()),
  },
  handler: async (ctx, { roomId, clientId, guestCapability, playerId, generation }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return { loadoutGeneration: 1, isReopened: false };
    const currentGeneration = room.loadoutGeneration ?? 1;
    if (kindOf(room) === "online" && generation !== currentGeneration) {
      return { loadoutGeneration: currentGeneration, isReopened: false };
    }
    if (room.status !== "playing") {
      return { loadoutGeneration: currentGeneration, isReopened: room.status === "lobby" };
    }
    const caller = await resolveRoomCaller(ctx, kindOf(room), clientId, guestCapability, playerId);
    if (kindOf(room) === "online" && room.hostPlayerId !== caller._id) {
      return { loadoutGeneration: currentGeneration, isReopened: false };
    }
    const member = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", caller._id))
      .unique();
    if (!member || member.isDeparted === true) {
      return { loadoutGeneration: currentGeneration, isReopened: false };
    }
    if (kindOf(room) === "online" && room.generationState !== "completed") {
      return { loadoutGeneration: currentGeneration, isReopened: false };
    }
    const rows = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    const nextGeneration = currentGeneration + 1;
    await ctx.db.patch(roomId, {
      status: "lobby",
      loadoutGeneration: nextGeneration,
      generationState: kindOf(room) === "online" ? "pending" : room.generationState,
      generationCompletedAt: undefined,
      generationCompletionJti: undefined,
      lastActivity: Date.now(),
    });
    for (const row of rows) {
      if (row.isDeparted === true) {
        await ctx.db.delete(row._id);
        continue;
      }
      await ctx.db.patch(row._id, {
        isKitChoiceMade: undefined,
        isPetChoiceMade: undefined,
        isLoadoutConfirmed: undefined,
        isReady: undefined,
        gsWorldId: undefined,
        gsJoinedAt: undefined,
        loadoutGeneration: nextGeneration,
        loadoutEditRevision: undefined,
      });
    }
    return { loadoutGeneration: nextGeneration, isReopened: true };
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
  args: {
    roomId: v.id("rooms"),
    clientId: v.optional(v.string()),
    guestCapability: v.optional(v.string()),
    playerId: v.optional(v.id("players")),
    name: v.optional(v.string()),
    colorIndex: v.optional(v.number()),
    pingMs: v.optional(v.number()),
  },
  handler: async (ctx, { roomId, clientId, guestCapability, playerId, name, colorIndex, pingMs }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.status === "ended") return;
    const caller = await resolveRoomCaller(ctx, kindOf(room), clientId, guestCapability, playerId);
    const row = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", caller._id))
      .unique();
    if (!row || row.isDeparted === true) return;
    const now = Date.now();
    const isOnline = kindOf(room) === "online";
    await ctx.db.patch(row._id, {
      updatedAt: now,
      ...(isOnline
        ? { name: caller.name, colorIndex: caller.colorIndex ?? row.colorIndex }
        : name !== undefined && name.length > 0 ? { name } : {}),
      ...(!isOnline && colorIndex !== undefined ? { colorIndex } : {}),
      ...(pingMs !== undefined ? { pingMs: Math.max(0, Math.round(pingMs)) } : {}),
    });
    await ctx.db.patch(roomId, { lastActivity: now });
  },
});

// Advance the shared floor. Monotonic so a late/duplicate call can't rewind anyone.
export const descend = mutation({
  args: { roomId: v.id("rooms"), floor: v.number() },
  handler: async (ctx, { roomId, floor }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return;
    if (kindOf(room) === "online") return;
    if (floor > room.floor) await ctx.db.patch(roomId, { floor, status: "playing", lastActivity: Date.now() });
  },
});

export const leave = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.optional(v.string()),
    guestCapability: v.optional(v.string()),
    playerId: v.optional(v.id("players")),
  },
  handler: async (ctx, { roomId, clientId, guestCapability, playerId }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return;
    const caller = await resolveRoomCaller(ctx, kindOf(room), clientId, guestCapability, playerId);
    const mine = await ctx.db
      .query("presence")
      .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerId", caller._id))
      .unique();
    if (mine && kindOf(room) === "online" && room.status === "playing") {
      await ctx.db.patch(mine._id, {
        isDeparted: true,
        isReady: undefined,
        gsWorldId: undefined,
        gsJoinedAt: undefined,
        updatedAt: 0,
      });
      const remaining = (await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect())
        .filter((member) => member.isDeparted !== true)
        .sort((left, right) => left._creationTime - right._creationTime);
      if (remaining.length > 0 && room.hostPlayerId === caller._id) {
        await ctx.db.patch(roomId, {
          hostPlayerId: remaining[0].playerId,
          lastActivity: Date.now(),
        });
      } else {
        await ctx.db.patch(roomId, { lastActivity: Date.now() });
      }
      return;
    }
    if (mine) await ctx.db.delete(mine._id);
    const rest = await ctx.db.query("presence").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    if (rest.length === 0) {
      await ctx.db.patch(roomId, { status: "ended", lastActivity: Date.now() });
    } else if (room.hostPlayerId === caller._id) {
      await ctx.db.patch(roomId, { hostPlayerId: rest[0].playerId, lastActivity: Date.now() });
    }
  },
});
