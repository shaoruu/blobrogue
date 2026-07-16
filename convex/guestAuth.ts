import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  isGuestRefreshAuthorized,
  isGuestSessionAuthorized,
} from "./guestCapabilityCore";
import type { GuestScope } from "./guestCapabilityCore";

export type { GuestScope } from "./guestCapabilityCore";
type ReadCtx = QueryCtx | MutationCtx;

const GUEST_SESSION_TTL_MS = 24 * 60 * 60_000;
const GUEST_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const ALL_GUEST_SCOPES: GuestScope[] = ["profile", "room", "ticket", "economy"];

export interface GuestSessionCredentials {
  guestCapability: string;
  guestRefreshCapability: string;
}

async function playerByUserId(ctx: ReadCtx, userId: Doc<"users">["_id"]): Promise<Doc<"players"> | null> {
  return await ctx.db.query("players")
    .withIndex("by_userId", (queryBuilder) => queryBuilder.eq("userId", userId))
    .unique();
}

export async function resolveAuthorizedPlayer(
  ctx: ReadCtx,
  clientId: string,
  guestCapability: string | undefined,
  scope: GuestScope,
): Promise<Doc<"players">> {
  const userId = await getAuthUserId(ctx);
  if (userId) {
    const account = await playerByUserId(ctx, userId);
    if (!account) throw new ConvexError({ code: "player_missing", message: "player profile not found" });
    return account;
  }
  if (!guestCapability) {
    throw new ConvexError({ code: "guest_capability_required", message: "guest session expired — refresh" });
  }
  const session = await ctx.db.query("guestSessions")
    .withIndex("by_token", (queryBuilder) => queryBuilder.eq("token", guestCapability))
    .unique();
  const player = session ? await ctx.db.get(session.playerId) : null;
  if (!session
    || !player
    || !isGuestSessionAuthorized(
      session,
      {
        playerId: player._id,
        clientId: player.clientId,
        isAccount: player.userId !== undefined,
      },
      clientId,
      guestCapability,
      scope,
      Date.now(),
    )) {
    throw new ConvexError({ code: "guest_capability_invalid", message: "guest session expired — refresh" });
  }
  return player;
}

export async function mintGuestSession(
  ctx: MutationCtx,
  player: Doc<"players">,
  clientId: string,
): Promise<GuestSessionCredentials> {
  if (player.userId !== undefined || player.clientId !== clientId) {
    throw new ConvexError({ code: "guest_only", message: "cannot issue a guest session for an account" });
  }
  const now = Date.now();
  const existing = await ctx.db.query("guestSessions")
    .withIndex("by_client", (queryBuilder) => queryBuilder.eq("clientId", clientId))
    .collect();
  for (const session of existing) {
    if (session.revokedAt === undefined) await ctx.db.patch(session._id, { revokedAt: now });
  }
  const token = `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const refreshToken = `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  await ctx.db.insert("guestSessions", {
    token,
    refreshToken,
    clientId,
    playerId: player._id,
    scopes: ALL_GUEST_SCOPES,
    createdAt: now,
    expiresAt: now + GUEST_SESSION_TTL_MS,
    refreshExpiresAt: now + GUEST_REFRESH_TTL_MS,
  });
  return {
    guestCapability: token,
    guestRefreshCapability: refreshToken,
  };
}

export async function refreshGuestSession(
  ctx: MutationCtx,
  player: Doc<"players">,
  clientId: string,
  refreshToken: string | undefined,
): Promise<GuestSessionCredentials> {
  const session = refreshToken
    ? await ctx.db.query("guestSessions")
      .withIndex("by_refresh", (queryBuilder) => queryBuilder.eq("refreshToken", refreshToken))
      .unique()
    : null;
  if (!session
    || !isGuestRefreshAuthorized(
      session,
      {
        playerId: player._id,
        clientId: player.clientId,
        isAccount: player.userId !== undefined,
      },
      clientId,
      refreshToken ?? "",
      Date.now(),
    )) {
    throw new ConvexError({
      code: "guest_refresh_invalid",
      message: "guest session expired — start a new guest",
    });
  }
  return await mintGuestSession(ctx, player, clientId);
}

export async function revokePlayerGuestSessions(
  ctx: MutationCtx,
  playerId: Doc<"players">["_id"],
): Promise<void> {
  const now = Date.now();
  const sessions = await ctx.db.query("guestSessions")
    .withIndex("by_player", (queryBuilder) => queryBuilder.eq("playerId", playerId))
    .collect();
  for (const session of sessions) {
    if (session.revokedAt === undefined) await ctx.db.patch(session._id, { revokedAt: now });
  }
}

export async function activeGuestSession(
  ctx: QueryCtx | MutationCtx,
  playerId: Doc<"players">["_id"],
): Promise<Doc<"guestSessions"> | null> {
  const sessions = await ctx.db.query("guestSessions")
    .withIndex("by_player", (queryBuilder) => queryBuilder.eq("playerId", playerId))
    .collect();
  return sessions.find((session) => session.revokedAt === undefined && session.expiresAt > Date.now()) ?? null;
}
