// OnlineLobby contract suite (headless, fake Convex): locks the client half of the identity
// trust chain that the Sev-0 mitigations introduced and this fix depends on:
//   - identity (name + color pick) is FLUSHED to the profile BEFORE every room operation and
//     BEFORE every ticket mint — a fast CREATE -> START can never mint a ticket carrying a
//     stale color/name (the remote-color regression)
//   - mintTicket() binds THIS room's code into the request (membership-verified server-side)
//   - expectedWorldId() is the shared room-code -> world-id mapping the client asserts on
//   - reportWorld() mirrors the authoritative world join/leave onto the presence row
// Run: npm run test:onlinelobby

import "./harness/domShim.js";
import { getFunctionName } from "convex/server";
import type { ConvexClient } from "convex/browser";

import { OnlineLobby } from "../src/net/onlineLobby.js";
import { Session } from "../src/net/session.js";
import { worldIdForRoomCode } from "../src/net/protocol.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

interface Call { fn: string; args: Record<string, unknown> }

// A Convex client double that records every call in order and answers with canned rows.
function fakeConvex(calls: Call[]): ConvexClient {
  const respond = (fn: string): unknown => {
    switch (fn) {
      case "players:ensurePlayer":
        return { playerId: "player-1", name: "Ada", colorIndex: 4, totalKills: 0, deepestFloor: 0, totalCoins: 0, gamesPlayed: 0, unlocks: [], isAccount: false };
      case "rooms:create":
        return { roomId: "room-doc-1", code: "ABCD", seed: 1, floor: 1 };
      case "rooms:join":
        return { roomId: "room-doc-1", code: "ABCD", seed: 1, floor: 1, status: "lobby" };
      case "gsTicket:mint":
        return { ticket: "signed-ticket", playerId: "player-1" };
      default:
        return null;
    }
  };
  const record = (ref: unknown, args: Record<string, unknown>): Promise<unknown> => {
    const fn = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
    calls.push({ fn, args });
    return Promise.resolve(respond(fn));
  };
  const fake = {
    mutation: record,
    action: record,
    query: record,
    onUpdate: () => () => {},
  };
  return fake as unknown as ConvexClient;
}

function callNames(calls: Call[]): string[] {
  return calls.map((c) => c.fn);
}

async function main(): Promise<void> {
  section("create: identity flush lands BEFORE the room exists (color rides the roster row)");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    session.setColorIndex(4);
    calls.length = 0; // setColorIndex fires a background login of its own — not under test
    const lobby = new OnlineLobby(client, session);
    await lobby.create();
    const names = callNames(calls);
    const flushIdx = names.indexOf("players:ensurePlayer");
    const createIdx = names.indexOf("rooms:create");
    check("ensurePlayer precedes rooms:create", flushIdx !== -1 && createIdx !== -1 && flushIdx < createIdx, names.join(" -> "));
    const createArgs = calls[createIdx].args;
    check("the room row is created with the chosen color", createArgs.colorIndex === 4, JSON.stringify(createArgs));
    check("the flush carried the chosen color", calls[flushIdx].args.colorIndex === 4);
    lobby.leave();
  }

  section("mintTicket: identity flush precedes the mint; the mint names THIS room");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create();
    calls.length = 0;
    const ticket = await lobby.mintTicket();
    check("mint returns the signed ticket", ticket === "signed-ticket");
    const names = callNames(calls);
    const flushIdx = names.indexOf("players:ensurePlayer");
    const mintIdx = names.indexOf("gsTicket:mint");
    check("ensurePlayer precedes gsTicket:mint (no stale-identity ticket)", flushIdx !== -1 && mintIdx !== -1 && flushIdx < mintIdx, names.join(" -> "));
    const mintArgs = calls[mintIdx].args;
    check("the mint is bound to this room's code", mintArgs.roomCode === "ABCD", JSON.stringify(mintArgs));
    check("the mint carries this browser's clientId", mintArgs.clientId === session.clientId);
    lobby.leave();
  }

  section("heartbeat carries the CURRENT identity (a lobby color change reaches the roster)");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    session.setColorIndex(1);
    const lobby = new OnlineLobby(client, session);
    await lobby.create();
    const first = calls.find((c) => c.fn === "rooms:heartbeat");
    check("the join-time beat carries the current pick", first !== undefined && first.args.colorIndex === 1, JSON.stringify(first?.args));
    lobby.leave();
  }

  section("expectedWorldId: the client-side assertion target matches the shared mapping");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create();
    check("expectedWorldId is worldIdForRoomCode(code)", lobby.expectedWorldId() === worldIdForRoomCode("ABCD") && lobby.expectedWorldId() === "room:ABCD", lobby.expectedWorldId());
    lobby.leave();
  }

  section("reportWorld: the authoritative join/leave is mirrored onto the presence row");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create();
    calls.length = 0;
    lobby.reportWorld("room:ABCD");
    lobby.reportWorld(null);
    await Promise.resolve();
    const reports = calls.filter((c) => c.fn === "presence:reportWorld");
    check("join mirrored with the world id", reports[0] !== undefined && reports[0].args.worldId === "room:ABCD" && reports[0].args.playerId === "player-1", JSON.stringify(reports[0]?.args));
    check("leave mirrored with null", reports[1] !== undefined && reports[1].args.worldId === null);
    lobby.leave();
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll online-lobby contract assertions passed.\n");
}

void main();
