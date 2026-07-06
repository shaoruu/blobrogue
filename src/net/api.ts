import { makeFunctionReference } from "convex/server";

// Typed references to the Convex functions in /convex, built with
// makeFunctionReference so the client never depends on the generated `convex/_generated`
// api module. That is what lets `tsc` pass with zero Convex deployment present.
// The arg/return shapes are mirrored here as the client's source of truth; they
// must stay in sync with the handlers in /convex.

export type RoomStatus = "lobby" | "playing" | "ended";

export interface ProfileDoc {
  playerId: string;
  name: string;
  totalKills: number;
  deepestFloor: number;
  totalCoins: number;
  gamesPlayed: number;
  unlocks: string[];
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
    ensurePlayer: makeFunctionReference<"mutation", { clientId: string; name: string }, ProfileDoc>("players:ensurePlayer"),
    getProfile: makeFunctionReference<"query", { clientId: string }, ProfileDoc | null>("players:getProfile"),
    recordRun: makeFunctionReference<"mutation", { clientId: string; floor: number; kills: number; coins: number }, ProfileDoc | null>("players:recordRun"),
  },
  rooms: {
    create: makeFunctionReference<"mutation", { playerId: string }, { roomId: string; code: string; seed: number; floor: number }>("rooms:create"),
    quickPlay: makeFunctionReference<"mutation", { playerId: string }, { roomId: string; code: string; seed: number; floor: number; status: RoomStatus; joined?: boolean }>("rooms:quickPlay"),
    join: makeFunctionReference<"mutation", { code: string; playerId: string }, { roomId: string; code: string; seed: number; floor: number; status: RoomStatus }>("rooms:join"),
    get: makeFunctionReference<"query", { roomId: string }, RoomDoc | null>("rooms:get"),
    start: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:start"),
    descend: makeFunctionReference<"mutation", { roomId: string; floor: number }, null>("rooms:descend"),
    leave: makeFunctionReference<"mutation", { roomId: string; playerId: string }, null>("rooms:leave"),
  },
  presence: {
    update: makeFunctionReference<"mutation", PresenceUpdateArgs, null>("presence:update"),
    list: makeFunctionReference<"query", { roomId: string }, PresenceDoc[]>("presence:list"),
    revive: makeFunctionReference<"mutation", { roomId: string; targetPlayerId: string }, null>("presence:revive"),
  },
};
