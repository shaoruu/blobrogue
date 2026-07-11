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
  // Equipped visual-only cosmetic loadout; null slots render the classic blob.
  cosmetics: { hat: string | null; face: string | null; body: string | null; title: string | null };
  totalKills: number;
  deepestFloor: number;
  totalCoins: number;
  gamesPlayed: number;
  // The persistent currency (banked by the premium economy's cache/windfall at run end).
  amber: number;
  // Earned cosmetic/unlock ids (recordRun) + owned Amber Camp node ids + boss-kill flags (buyNode
  // / first-boss grants). Disjoint namespaces; starter cosmetics are owned implicitly.
  unlocks: string[];
  // The equipped cosmetic COMPANION pet id (WAVE 1, META spec §3), or null for none.
  equippedPet: string | null;
  // Account MASTERY (KIT/XP spec §4): the persistent ACCESS track (lifetime XP + derived level)
  // the lobby reads to gate kit selection. Optional so an older backend still decodes.
  masteryXp?: number;
  masteryLevel?: number;
  // Present when the profile is account-backed (Google avatar URL).
  image?: string;
  // True when this stats row is linked to a signed-in account.
  isAccount: boolean;
}

// One public leaderboard entry: a player's best run plus the appearance snapshot AS WORN
// for that run (later re-equips never rewrite it; only the display name stays current).
// Privacy-safe by construction — name/appearance/run data only, no ids of any kind.
export interface LeaderboardEntryDoc {
  name: string;
  colorIndex: number | null;
  hat: string | null;
  face: string | null;
  body: string | null;
  title: string | null;
  floor: number;
  kills: number;
  coins: number;
  durationMs: number;
  weapons: string[];
  items: Array<{ id: string; count: number }>;
  achievedAt: number;
}

// The run-build subset recordRun persists for the leaderboard profile (ids only).
export type RunBuildArg = {
  weapons: string[];
  items: Array<{ id: string; count: number }>;
};

// recordRun args: the authoritative run FACTS the server banks Amber from (never a client
// amber number). bossKills are boss kinds defeated this run; outcome drives the bank fraction.
export type RecordRunArgs = {
  clientId: string;
  floor: number;
  kills: number;
  coins: number;
  floorsCleared?: number;
  bossKills?: string[];
  isCacheArmed?: boolean;
  amberWindfall?: number;
  outcome?: "death" | "return";
  durationMs?: number;
  build?: RunBuildArg;
};

// The buyNode / equipPet result: the (possibly-unchanged) profile plus a success flag and a
// rejection reason, so the optimistic UI can reconcile and surface a clear note on failure.
export type CampMutationResult = { ok: boolean; reason?: string; profile: ProfileDoc };

// Explicit per-slot loadout picks for ensurePlayer ("none" clears a slot; absent = keep).
export type CosmeticsArg = { hat?: string; face?: string; body?: string; title?: string };

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
  // ONLINE rooms: the authoritative world this member is actually connected to (mirrored
  // from the game server's snapshot after a verified join; null while in the lobby). The
  // lobby roster derives LOBBY / CONNECTING / CONNECTED TO WORLD from it.
  gsWorldId: string | null;
  gsJoinedAt: number | null;
  // ONLINE lobby readiness: the member's READY toggle + their heartbeat-measured ping.
  isReady: boolean;
  pingMs: number | null;
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
    ensurePlayer: makeFunctionReference<"mutation", { clientId: string; name: string; colorIndex?: number; cosmetics?: CosmeticsArg }, ProfileDoc>("players:ensurePlayer"),
    getProfile: makeFunctionReference<"query", { clientId: string }, ProfileDoc | null>("players:getProfile"),
    currentUser: makeFunctionReference<"query", Record<string, never>, CurrentUserDoc | null>("players:currentUser"),
    recordRun: makeFunctionReference<"mutation", RecordRunArgs, ProfileDoc | null>("players:recordRun"),
    // Set a signed-in account's chosen display-name OVERRIDE (authenticated only). Returns the
    // updated profile (name reflects the custom name), or the unchanged profile when rejected.
    setCustomName: makeFunctionReference<"mutation", { clientId: string; name: string }, ProfileDoc | null>("players:setCustomName"),
    // Progressive deepest-floor banking (fired on each descend) — raises deepestFloor +
    // charts the floor without the per-run folding recordRun does. Returns nothing.
    recordFloorProgress: makeFunctionReference<"mutation", { clientId: string; floor: number }, null>("players:recordFloorProgress"),
    // WAVE 1 Amber Camp SPEND (server-authoritative): buy an owned camp node (cost/prereqs/
    // ownership validated server-side, Amber deducted), and equip/clear the active pet.
    buyNode: makeFunctionReference<"mutation", { clientId: string; nodeId: string }, CampMutationResult | null>("players:buyNode"),
    equipPet: makeFunctionReference<"mutation", { clientId: string; petId: string | null }, CampMutationResult | null>("players:equipPet"),
  },
  leaderboard: {
    // The global top-N best runs (deepest floor, kills tie-break), public fields only.
    top: makeFunctionReference<"query", { limit?: number }, LeaderboardEntryDoc[]>("leaderboard:top"),
    // The caller's OWN charted standing (rank null = below the ranked window).
    standing: makeFunctionReference<"query", { clientId: string }, { floor: number; kills: number; rank: number | null } | null>("leaderboard:standing"),
    // The caller's OWN full charted entry + window rank (the own-profile Top Run card).
    mine: makeFunctionReference<"query", { clientId: string }, { entry: LeaderboardEntryDoc; rank: number | null } | null>("leaderboard:mine"),
  },
  auth: {
    signIn: makeFunctionReference<"action", AuthSignInArgs, AuthSignInResult>("auth:signIn"),
    signOut: makeFunctionReference<"action", Record<string, never>, null>("auth:signOut"),
  },
  gsTicket: {
    // Trusted mint for the authoritative game-server join ticket (HMAC over GS_AUTH_SECRET).
    // With a roomCode, the mint verifies room membership and binds the room's world id into
    // the ticket, so friends sharing a code land in the same isolated server world.
    mint: makeFunctionReference<"action", { clientId: string; roomCode?: string; kit?: string }, { ticket: string; playerId: string }>("gsTicket:mint"),
  },
  rooms: {
    create: makeFunctionReference<"mutation", { playerId: string; kind?: RoomKind; colorIndex?: number }, { roomId: string; code: string; seed: number; floor: number }>("rooms:create"),
    quickPlay: makeFunctionReference<"mutation", { playerId: string; kind?: RoomKind; colorIndex?: number }, { roomId: string; code: string; seed: number; floor: number; status: RoomStatus; joined?: boolean }>("rooms:quickPlay"),
    join: makeFunctionReference<"mutation", { code: string; playerId: string; kind?: RoomKind; colorIndex?: number }, { roomId: string; code: string; seed: number; floor: number; status: RoomStatus }>("rooms:join"),
    get: makeFunctionReference<"query", { roomId: string }, RoomDoc | null>("rooms:get"),
    start: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:start"),
    reopen: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:reopen"),
    heartbeat: makeFunctionReference<"mutation", { roomId: string; playerId: string; name?: string; colorIndex?: number; pingMs?: number }, null>("rooms:heartbeat"),
    descend: makeFunctionReference<"mutation", { roomId: string; floor: number }, null>("rooms:descend"),
    leave: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:leave"),
  },
  presence: {
    update: makeFunctionReference<"mutation", PresenceUpdateArgs, null>("presence:update"),
    list: makeFunctionReference<"query", { roomId: string }, PresenceDoc[]>("presence:list"),
    // Live GLOBAL count of distinct players currently connected (recent presence rows) —
    // the title screen subscribes to it for the "N playing now" indicator.
    onlineCount: makeFunctionReference<"query", Record<string, never>, number>("presence:onlineCount"),
    revive: makeFunctionReference<"mutation", { roomId: string; targetPlayerId: string }, null>("presence:revive"),
    // Mirror of the authoritative game-server connection state (ONLINE rooms): worldId after
    // a verified world join, null on leaving. Powers the lobby's per-member readiness readout.
    reportWorld: makeFunctionReference<"mutation", { roomId: string; playerId: string; worldId: string | null }, null>("presence:reportWorld"),
    // The lobby READY toggle (roster READY/NOT READY; gates the host's START).
    setReady: makeFunctionReference<"mutation", { roomId: string; playerId: string; isReady: boolean }, null>("presence:setReady"),
  },
};
