import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { worldIdForRoomCode } from "./gsTicketCore";
import { cleanBuild } from "./leaderboard";
import { foldVerifiedRun } from "./players";
import {
  RUN_RECEIPT_VERSION,
  isRunCompletionPayload,
} from "../src/net/runReceipt.js";

const participantValidator = v.object({
  playerId: v.string(),
  floor: v.number(),
  kills: v.number(),
  coins: v.number(),
  floorsCleared: v.number(),
  bossKills: v.array(v.string()),
  isCacheArmed: v.boolean(),
  amberWindfall: v.number(),
  durationMs: v.number(),
  weapons: v.array(v.string()),
  items: v.array(v.object({ id: v.string(), count: v.number() })),
});

export const apply = internalMutation({
  args: {
    version: v.number(),
    jti: v.string(),
    runId: v.string(),
    worldId: v.string(),
    roomCode: v.string(),
    generation: v.number(),
    status: v.union(
      v.literal("completed"),
      v.literal("abandoned"),
      v.literal("server_restart"),
    ),
    issuedAt: v.number(),
    expiresAt: v.number(),
    isNoActiveSeat: v.boolean(),
    participants: v.array(participantValidator),
  },
  handler: async (ctx, payload) => {
    const now = Date.now();
    if (payload.version !== RUN_RECEIPT_VERSION || !isRunCompletionPayload(payload)) {
      throw new ConvexError({ code: "receipt_version", message: "unsupported run receipt version" });
    }
    if (payload.expiresAt < now || payload.issuedAt > now + 30_000) {
      throw new ConvexError({ code: "receipt_expired", message: "run receipt expired" });
    }
    const replay = await ctx.db.query("runReceipts")
      .withIndex("by_jti", (queryBuilder) => queryBuilder.eq("jti", payload.jti))
      .unique();
    if (replay) throw new ConvexError({ code: "receipt_replayed", message: "run receipt already consumed" });
    const repeatedRun = await ctx.db.query("runReceipts")
      .withIndex("by_run", (queryBuilder) => queryBuilder.eq("runId", payload.runId))
      .unique();
    if (repeatedRun) throw new ConvexError({ code: "receipt_replayed", message: "run receipt already consumed" });

    const room = await ctx.db.query("rooms")
      .withIndex("by_code", (queryBuilder) => queryBuilder.eq("code", payload.roomCode))
      .unique();
    if (!room || (room.kind ?? "coop") !== "online") {
      throw new ConvexError({ code: "room_missing", message: "receipt room not found" });
    }
    const generation = room.loadoutGeneration ?? 1;
    const expectedWorldId = worldIdForRoomCode(room.code, generation);
    if (room.mode === "pvp"
      || payload.generation !== generation
      || payload.worldId !== expectedWorldId
      || room.status !== "playing"
      || room.generationState !== "active"
      || payload.isNoActiveSeat !== true) {
      throw new ConvexError({ code: "generation_mismatch", message: "receipt generation is not active" });
    }

    const playerIds: Id<"players">[] = [];
    const rewardedPlayerIds: Id<"players">[] = [];
    for (const participant of payload.participants) {
      const playerId = participant.playerId as Id<"players">;
      const player = await ctx.db.get(playerId);
      if (!player) {
        throw new ConvexError({ code: "player_missing", message: "receipt player not found" });
      }
      const membership = await ctx.db.query("presence")
        .withIndex("by_room_player", (queryBuilder) => (
          queryBuilder.eq("roomId", room._id).eq("playerId", playerId)
        ))
        .unique();
      if (!membership
        || membership.loadoutGeneration !== generation
        || membership.isLoadoutConfirmed !== true) {
        throw new ConvexError({ code: "membership_mismatch", message: "receipt player was not in this generation" });
      }
      playerIds.push(playerId);
      if (membership.isDeparted !== true) rewardedPlayerIds.push(playerId);
    }

    await ctx.db.insert("runReceipts", {
      jti: payload.jti,
      runId: payload.runId,
      worldId: payload.worldId,
      roomId: room._id,
      generation,
      status: payload.status,
      playerIds,
      rewardedPlayerIds,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      consumedAt: now,
    });

    const rewarded = new Set<string>(rewardedPlayerIds);
    for (const participant of payload.participants) {
      const playerId = participant.playerId as Id<"players">;
      if (!rewarded.has(playerId)) continue;
      const player = await ctx.db.get(playerId);
      if (!player) continue;
      await foldVerifiedRun(ctx, player, {
        floor: participant.floor,
        kills: participant.kills,
        coins: participant.coins,
        floorsCleared: participant.floorsCleared,
        bossKills: participant.bossKills,
        isCacheArmed: participant.isCacheArmed,
        amberWindfall: participant.amberWindfall,
        isReturn: false,
        durationMs: participant.durationMs,
        build: cleanBuild({
          weapons: participant.weapons,
          items: participant.items,
        }),
      });
    }

    const presenceRows = await ctx.db.query("presence")
      .withIndex("by_room", (queryBuilder) => queryBuilder.eq("roomId", room._id))
      .collect();
    for (const presence of presenceRows) {
      if (presence.loadoutGeneration === generation) {
        await ctx.db.patch(presence._id, {
          gsWorldId: undefined,
          gsJoinedAt: undefined,
        });
      }
    }

    const activeRows = presenceRows
      .filter((presence) => presence.isDeparted !== true)
      .sort((left, right) => left._creationTime - right._creationTime);
    const isHostActive = activeRows.some((presence) => presence.playerId === room.hostPlayerId);
    await ctx.db.patch(room._id, {
      generationState: "completed",
      generationCompletedAt: now,
      generationCompletionJti: payload.jti,
      lastActivity: now,
      ...(activeRows.length === 0 ? { status: "ended" as const } : {}),
      ...(!isHostActive && activeRows[0] ? { hostPlayerId: activeRows[0].playerId } : {}),
    });
    if (activeRows.length === 0) {
      for (const presence of presenceRows) await ctx.db.delete(presence._id);
    }
    return {
      ok: true as const,
      roomId: room._id,
      generation,
      playerIds,
    };
  },
});

export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db.query("runReceipts")
      .withIndex("by_expiry", (queryBuilder) => queryBuilder.lt("expiresAt", Date.now()))
      .take(200);
    for (const receipt of expired) await ctx.db.delete(receipt._id);
    return expired.length;
  },
});
