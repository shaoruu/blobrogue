import { makeFunctionReference } from "convex/server";

// Typed references to the Convex functions in /convex, built with
// makeFunctionReference so the client never depends on the generated `convex/_generated`
// api module. That is what lets `tsc` pass with zero Convex deployment present.
// The arg/return shapes are mirrored here as the client's source of truth; they
// must stay in sync with the handlers in /convex.

export type RoomStatus = "lobby" | "playing" | "ended";
// Which multiplayer flow a room belongs to: classic peer-synced co-op, or a lobby for the
// authoritative game server (the room code maps to a distinct server world).
export type RoomKind = "coop" | "online";

export interface ProfileDoc {
  playerId: string;
  name: string;
  // Chosen blob tint (client palette index); null until the player picks one.
  colorIndex: number | null;
  totalKills: number;
  deepestFloor: number;
  totalCoins: number;
  gamesPlayed: number;
  unlocks: string[];
  // Present when the profile is account-backed (Google avatar URL).
  image?: string;
  // True when this stats row is linked to a signed-in account.
  isAccount: boolean;
}

export interface CurrentUserDoc {
  name: string | null;
  email: string | null;
  image: string | null;
}

// Convex Auth's sign-in/out actions live at the string references "auth:signIn" /
// "auth:signOut" once the backend (convex/auth.ts + http.ts) is deployed. Typed here
// so the vanilla auth client (src/net/auth.ts) can call them without importing the
// React-only @convex-dev/auth bindings or the generated backend module.
export type AuthSignInArgs = {
  provider?: string;
  params?: Record<string, string>;
  verifier?: string;
  refreshToken?: string;
};

export interface AuthSignInResult {
  redirect?: string;
  verifier?: string;
  tokens?: { token: string; refreshToken: string } | null;
  started?: boolean;
}

export interface RoomDoc {
  roomId: string;
  code: string;
  hostPlayerId: string;
  seed: number;
  floor: number;
  status: RoomStatus;
}

export interface PresenceDoc {
  playerId: string;
  name: string;
  x: number; y: number; facing: number;
  hp: number; maxHp: number;
  weapon: string;
  floor: number;
  isDown: boolean;
  aimAngle: number;
  shotSeq: number;
  kills: number;
  colorIndex: number;
  reviveNonce: number;
  updatedAt: number;
}

// A type alias (not an interface) so it satisfies Convex's `DefaultFunctionArgs`
// (`Record<string, Value>`) constraint on function reference arguments.
export type PresenceUpdateArgs = {
  roomId: string;
  playerId: string;
  name: string;
  x: number; y: number; facing: number;
  hp: number; maxHp: number;
  weapon: string;
  floor: number;
  isDown: boolean;
  aimAngle: number;
  shotSeq: number;
  kills: number;
};

export const api = {
  players: {
    ensurePlayer: makeFunctionReference<"mutation", { clientId: string; name: string; colorIndex?: number }, ProfileDoc>("players:ensurePlayer"),
    getProfile: makeFunctionReference<"query", { clientId: string }, ProfileDoc | null>("players:getProfile"),
    currentUser: makeFunctionReference<"query", Record<string, never>, CurrentUserDoc | null>("players:currentUser"),
    recordRun: makeFunctionReference<"mutation", { clientId: string; floor: number; kills: number; coins: number }, ProfileDoc | null>("players:recordRun"),
  },
  auth: {
    signIn: makeFunctionReference<"action", AuthSignInArgs, AuthSignInResult>("auth:signIn"),
    signOut: makeFunctionReference<"action", Record<string, never>, null>("auth:signOut"),
  },
  gsTicket: {
    // Trusted mint for the authoritative game-server join ticket (HMAC over GS_AUTH_SECRET).
    // With a roomCode, the mint verifies room membership and binds the room's world id into
    // the ticket, so friends sharing a code land in the same isolated server world.
    mint: makeFunctionReference<"action", { clientId: string; roomCode?: string }, { ticket: string; playerId: string }>("gsTicket:mint"),
  },
  rooms: {
    create: makeFunctionReference<"mutation", { playerId: string; kind?: RoomKind; colorIndex?: number }, { roomId: string; code: string; seed: number; floor: number }>("rooms:create"),
    quickPlay: makeFunctionReference<"mutation", { playerId: string; kind?: RoomKind; colorIndex?: number }, { roomId: string; code: string; seed: number; floor: number; status: RoomStatus; joined?: boolean }>("rooms:quickPlay"),
    join: makeFunctionReference<"mutation", { code: string; playerId: string; kind?: RoomKind; colorIndex?: number }, { roomId: string; code: string; seed: number; floor: number; status: RoomStatus }>("rooms:join"),
    get: makeFunctionReference<"query", { roomId: string }, RoomDoc | null>("rooms:get"),
    start: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:start"),
    reopen: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:reopen"),
    heartbeat: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:heartbeat"),
    descend: makeFunctionReference<"mutation", { roomId: string; floor: number }, null>("rooms:descend"),
    leave: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:leave"),
  },
  presence: {
    update: makeFunctionReference<"mutation", PresenceUpdateArgs, null>("presence:update"),
    list: makeFunctionReference<"query", { roomId: string }, PresenceDoc[]>("presence:list"),
    revive: makeFunctionReference<"mutation", { roomId: string; targetPlayerId: string }, null>("presence:revive"),
  },
};
