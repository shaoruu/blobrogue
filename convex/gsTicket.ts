// Production auth-ticket minter for the authoritative game server (WS join). The game server
// verifies every join ticket with GS_AUTH_SECRET (server/src/auth.ts verifyTicket); this action
// is the trusted party that MINTS those tickets, signing with the SAME shared secret, set as a
// Convex environment variable:
//
//   npx convex env set GS_AUTH_SECRET <the game server's GS_AUTH_SECRET>
//
// Identity: a signed-in account mints for its players-row id (the same identity the profile
// system uses); a guest mints for a "guest:<clientId>" id. The player's display name + chosen
// blob color ride along as verified `nm`/`cl` claims so the game server can label their blob
// for other players.
//
// Rooms: when a room code is supplied, the mint FIRST verifies the caller actually sits in
// that online room (rooms.membership), then binds the room's world id into the ticket as the
// `wld` claim. The game server binds the connection to exactly that world — this chain
// (lobby membership -> signed claim -> server bind) is what makes rooms real isolation, not a
// client-asserted string. The ticket only ASSERTS identity/authorization to the game server —
// all gameplay authority stays in the server simulation.

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mintGsTicket, worldIdForRoomCode, type GsTicketClaims } from "./gsTicketCore";

const TICKET_TTL_SECS = 120;

export const mint = action({
  args: { clientId: v.string(), roomCode: v.optional(v.string()) },
  handler: async (ctx, { clientId, roomCode }): Promise<{ ticket: string; playerId: string }> => {
    const secret = process.env.GS_AUTH_SECRET;
    if (!secret) throw new Error("GS_AUTH_SECRET is not configured on this deployment");
    const trimmed = clientId.trim().slice(0, 48);
    if (trimmed.length === 0) throw new Error("clientId required");
    // getProfile resolves account-first (authenticated userId), else the guest clientId row.
    const profile = await ctx.runQuery(api.players.getProfile, { clientId: trimmed });
    const playerId = profile?.playerId ?? "guest:" + trimmed;

    const claims: GsTicketClaims = {};
    if (profile) {
      claims.name = profile.name;
      if (profile.colorIndex !== null) claims.colorIndex = profile.colorIndex;
    }
    if (roomCode !== undefined) {
      if (!profile) throw new Error("join the room before requesting a room ticket");
      // Profile serializes the players-row id as a string; narrow it back for the query arg.
      const memberId = profile.playerId as Id<"players">;
      const { isMember } = await ctx.runQuery(api.rooms.membership, { code: roomCode, playerId: memberId });
      if (!isMember) throw new Error("you are not in that room");
      claims.worldId = worldIdForRoomCode(roomCode);
    }

    const ticket = await mintGsTicket(secret, playerId, TICKET_TTL_SECS, Date.now(), claims);
    return { ticket, playerId };
  },
});
