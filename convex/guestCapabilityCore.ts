export type GuestScope = "profile" | "room" | "ticket" | "economy";

export interface GuestSessionView {
  token: string;
  clientId: string;
  playerId: string;
  scopes: readonly GuestScope[];
  expiresAt: number;
  revokedAt?: number;
}

export interface GuestPlayerView {
  playerId: string;
  clientId?: string;
  isAccount: boolean;
}

export function isGuestSessionAuthorized(
  session: GuestSessionView,
  player: GuestPlayerView,
  clientId: string,
  token: string,
  scope: GuestScope,
  nowMs: number,
): boolean {
  return session.token === token
    && session.clientId === clientId
    && session.playerId === player.playerId
    && session.revokedAt === undefined
    && session.expiresAt > nowMs
    && session.scopes.includes(scope)
    && player.clientId === clientId
    && !player.isAccount;
}
