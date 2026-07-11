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
import { isKitUnlocked, masteryLevelForXp, type KitId } from "./masteryCore";

const TICKET_TTL_SECS = 120;

export const mint = action({
  args: { clientId: v.string(), roomCode: v.optional(v.string()), kit: v.optional(v.string()) },
  handler: async (ctx, { clientId, roomCode, kit }): Promise<{ ticket: string; playerId: string }> => {
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
      // The color claim is ALWAYS minted for a known profile: the pick when one exists,
      // else 0 — the amber default the player's own screen shows. Teammates therefore
      // always render an authoritative color, never a client-side guess; a wire null is
      // reserved for genuinely claimless (legacy/dev) tickets, which clients render as an
      // explicit neutral placeholder.
      claims.colorIndex = profile.colorIndex ?? 0;
      // Equipped overlay cosmetics ride as verified claims too (visual-only labels; the
      // profile system already validated ownership + slot at equip time). Body renders
      // from the party color at launch and titles stay off the wire, so neither claims.
      if (profile.cosmetics.hat !== null) claims.hat = profile.cosmetics.hat;
      if (profile.cosmetics.face !== null) claims.face = profile.cosmetics.face;
      // The equipped companion pet rides the same visual-only channel (META spec §3), so
      // teammates render each other's pets in-world. Ownership was validated at equip time.
      if (profile.equippedPet !== null) claims.pet = profile.equippedPet;
    }
    // KIT selection (KIT/XP spec §9.5): the account authority validates the requested kit
    // against the account's Mastery-unlocked set and signs BOTH the validated kit and the
    // account's mastery level into the ticket. The game server re-gates kt against ml and
    // downgrades a mismatch — so a client can never join with a kit it has not unlocked.
    const masteryLevel = masteryLevelForXp(profile?.masteryXp ?? 0);
    const requested = (kit ?? "gunner") as KitId;
    claims.kit = isKitUnlocked(requested, masteryLevel) ? requested : "gunner";
    claims.masteryLevel = masteryLevel;
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
