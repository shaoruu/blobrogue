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
import { internal } from "./_generated/api";
import { mintGsTicket, worldIdForRoomCode, pvpWorldIdForRoomCode, type GsTicketClaims } from "./gsTicketCore";
import { isKitId, isKitUnlocked, masteryLevelForXp } from "./masteryCore";
import { assertPvpModeAllowed } from "./pvpFlag";

const TICKET_TTL_SECS = 120;

export const mint = action({
  args: {
    clientId: v.string(),
    guestCapability: v.optional(v.string()),
    roomCode: v.string(),
  },
  handler: async (ctx, { clientId, guestCapability, roomCode }): Promise<{ ticket: string; playerId: string }> => {
    const secret = process.env.GS_AUTH_SECRET;
    if (!secret) throw new Error("GS_AUTH_SECRET is not configured on this deployment");
    if (clientId.trim().length === 0 || clientId.length > 128) throw new Error("clientId required");
    const snapshot = await ctx.runQuery(internal.rooms.ticketSnapshot, {
      clientId,
      guestCapability,
      code: roomCode,
    });
    const playerId = snapshot.playerId;

    const claims: GsTicketClaims = {};
    claims.name = snapshot.name;
    claims.colorIndex = snapshot.colorIndex;
    if (snapshot.hat !== null) claims.hat = snapshot.hat;
    if (snapshot.face !== null) claims.face = snapshot.face;
    const masteryLevel = masteryLevelForXp(snapshot.masteryXp);
    claims.masteryLevel = masteryLevel;
    if (!isKitId(snapshot.kitId) || snapshot.kitId === "none" || !isKitUnlocked(snapshot.kitId, masteryLevel)) {
      throw new Error("the confirmed room kit is no longer unlocked");
    }
    claims.kit = snapshot.kitId;
    if (snapshot.petId !== null) claims.pet = snapshot.petId;
    claims.isPetChoiceMade = true;
    // TEMP kill switch: never mint a pvp-prefixed world id while PVP is disabled.
    const mode = snapshot.mode;
    assertPvpModeAllowed(mode);
    claims.worldId = mode === "pvp"
      ? pvpWorldIdForRoomCode(snapshot.roomCode, snapshot.generation)
      : worldIdForRoomCode(snapshot.roomCode, snapshot.generation);

    const ticket = await mintGsTicket(secret, playerId, TICKET_TTL_SECS, Date.now(), claims);
    return { ticket, playerId };
  },
});
