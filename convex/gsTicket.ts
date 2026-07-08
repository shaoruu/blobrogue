// Production auth-ticket minter for the authoritative game server (WS join). The game server
// verifies every join ticket with GS_AUTH_SECRET (server/src/auth.ts verifyTicket); this action
// is the trusted party that MINTS those tickets, signing with the SAME shared secret, set as a
// Convex environment variable:
//
//   npx convex env set GS_AUTH_SECRET <the game server's GS_AUTH_SECRET>
//
// Identity: a signed-in account mints for its players-row id (the same identity the profile
// system uses); a guest mints for a "guest:<clientId>" id. The ticket only ASSERTS identity to
// the game server — all gameplay authority stays in the server simulation.

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { mintGsTicket } from "./gsTicketCore";

const TICKET_TTL_SECS = 120;

export const mint = action({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }): Promise<{ ticket: string; playerId: string }> => {
    const secret = process.env.GS_AUTH_SECRET;
    if (!secret) throw new Error("GS_AUTH_SECRET is not configured on this deployment");
    const trimmed = clientId.trim().slice(0, 48);
    if (trimmed.length === 0) throw new Error("clientId required");
    // getProfile resolves account-first (authenticated userId), else the guest clientId row.
    const profile = await ctx.runQuery(api.players.getProfile, { clientId: trimmed });
    const playerId = profile?.playerId ?? "guest:" + trimmed;
    const ticket = await mintGsTicket(secret, playerId, TICKET_TTL_SECS);
    return { ticket, playerId };
  },
});
