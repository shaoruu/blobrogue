// Production auth-ticket minter for the authoritative game server (WS join). The game server
// verifies every join ticket with GS_AUTH_SECRET (server/src/auth.ts verifyTicket); this action
// is the trusted party that MINTS those tickets, signing with the SAME shared secret, set as a
// Convex environment variable:
//
//   npx convex env set GS_AUTH_SECRET <the game server's GS_AUTH_SECRET>
//
// Identity: accounts and guests both mint for their server-resolved players row. The
// player's display name + chosen blob color ride as verified `nm`/`cl` claims.
//
// The mint requires a started room, current-generation membership, and a confirmed combined
// loadout. The generation is part of `wld`, so an old ticket cannot enter a later run.

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mintGsTicket, worldIdForRoomCode, pvpWorldIdForRoomCode, type GsTicketClaims } from "./gsTicketCore";
import { isKitId, isKitUnlocked, masteryLevelForXp } from "./masteryCore";
import { assertPvpModeAllowed } from "./pvpFlag";

const TICKET_TTL_SECS = 120;

export const mint = action({
  args: { clientId: v.string(), roomCode: v.string() },
  handler: async (ctx, { clientId, roomCode }): Promise<{ ticket: string; playerId: string }> => {
    const secret = process.env.GS_AUTH_SECRET;
    if (!secret) throw new Error("GS_AUTH_SECRET is not configured on this deployment");
    const trimmed = clientId.trim().slice(0, 48);
    if (trimmed.length === 0) throw new Error("clientId required");
    // getProfile resolves account-first (authenticated userId), else the guest clientId row.
    const profile = await ctx.runQuery(api.players.getProfile, { clientId: trimmed });
    if (!profile) throw new Error("join the room before requesting a room ticket");
    const playerId = profile.playerId;

    const claims: GsTicketClaims = {};
    claims.name = profile.name;
    // The color claim is always explicit for a known profile.
    claims.colorIndex = profile.colorIndex ?? 0;
    if (profile.cosmetics.hat !== null) claims.hat = profile.cosmetics.hat;
    if (profile.cosmetics.face !== null) claims.face = profile.cosmetics.face;
    const masteryLevel = masteryLevelForXp(profile.masteryXp ?? 0);
    claims.masteryLevel = masteryLevel;
    const memberId = profile.playerId as Id<"players">;
    const membership = await ctx.runQuery(api.rooms.membership, { code: roomCode, playerId: memberId });
    const { isMember, mode } = membership;
    if (!isMember) throw new Error("you are not in that room");
    if (!membership.isRunLocked) throw new Error("the room has not started");
    if (!membership.isLoadoutConfirmed || membership.kitId === null) {
      throw new Error("confirm KIT + PET before requesting a room ticket");
    }
    if (!isKitId(membership.kitId) || membership.kitId === "none" || !isKitUnlocked(membership.kitId, masteryLevel)) {
      throw new Error("the confirmed room kit is no longer unlocked");
    }
    claims.kit = membership.kitId;
    if (membership.petId !== null) claims.pet = membership.petId;
    claims.isPetChoiceMade = true;
    // TEMP kill switch: never mint a pvp-prefixed world id while PVP is disabled.
    assertPvpModeAllowed(mode);
    claims.worldId = mode === "pvp"
      ? pvpWorldIdForRoomCode(roomCode, membership.loadoutGeneration)
      : worldIdForRoomCode(roomCode, membership.loadoutGeneration);

    const ticket = await mintGsTicket(secret, playerId, TICKET_TTL_SECS, Date.now(), claims);
    return { ticket, playerId };
  },
});
