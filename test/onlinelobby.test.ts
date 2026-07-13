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
import { PvpDisabledError, PVP_DISABLED_CODE, PVP_DISABLED_MESSAGE, PVP_PUBLIC_ENABLED } from "../src/net/pvpFlag.js";

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

interface FakeConvexOpts {
  // The profile's saved color (null = never picked). Default mirrors the original fixture.
  profileColor?: number | null;
  // Delay every ensurePlayer resolution, so ordering tests can prove the mint truly AWAITS
  // an in-flight identity flush rather than racing past it.
  ensureDelayMs?: number;
  // The mode a rooms:join resolves to (a joiner ADOPTS the room's mode). Default "coop".
  joinMode?: "coop" | "pvp";
}

// A Convex client double that records every call in order and answers with canned rows.
function fakeConvex(calls: Call[], opts: FakeConvexOpts = {}): ConvexClient {
  const profileColor = opts.profileColor === undefined ? 4 : opts.profileColor;
  const respond = (fn: string, args: Record<string, unknown>): unknown => {
    switch (fn) {
      case "players:ensurePlayer":
        return {
          playerId: "player-1", name: "Ada", colorIndex: profileColor,
          cosmetics: { hat: null, face: null, body: null, title: null },
          totalKills: 0, deepestFloor: 0, totalCoins: 0, gamesPlayed: 0, unlocks: [], isAccount: false,
        };
      case "rooms:create":
        return { roomId: "room-doc-1", code: "ABCD", seed: 1, floor: 1, mode: args.mode ?? "coop" };
      case "rooms:join":
        return { roomId: "room-doc-1", code: "ABCD", seed: 1, floor: 1, status: "lobby", mode: opts.joinMode ?? "coop" };
      case "rooms:quickPlay":
        return { roomId: "room-doc-1", code: "ABCD", seed: 1, floor: 1, status: "playing", mode: args.mode ?? "coop", joined: false };
      case "gsTicket:mint":
        return { ticket: "signed-ticket", playerId: "player-1" };
      default:
        return null;
    }
  };
  const record = (ref: unknown, args: Record<string, unknown>): Promise<unknown> => {
    const fn = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
    calls.push({ fn, args });
    if (fn === "players:ensurePlayer" && opts.ensureDelayMs !== undefined) {
      return new Promise((resolve) => setTimeout(() => resolve(respond(fn, args)), opts.ensureDelayMs));
    }
    return Promise.resolve(respond(fn, args));
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  section("mintTicket AWAITS the in-flight background pick flush (a ticket never races a pick)");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls, { ensureDelayMs: 15 });
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create();
    calls.length = 0;
    // The exact live-playtest shape: pick a color, immediately join — the pick's own flush
    // is still in flight when the ticket is requested.
    session.setColorIndex(5);
    await lobby.mintTicket();
    const names = callNames(calls);
    const mintIdx = names.indexOf("gsTicket:mint");
    const flushes = names.slice(0, mintIdx === -1 ? 0 : mintIdx).filter((n) => n === "players:ensurePlayer").length;
    check("the mint is the LAST call — after the background pick flush AND the final flush",
      mintIdx === names.length - 1 && flushes >= 2, names.join(" -> "));
    const lastFlush = calls.filter((c) => c.fn === "players:ensurePlayer").pop();
    check("the flush the ticket reads carries the just-picked color", lastFlush?.args.colorIndex === 5, JSON.stringify(lastFlush?.args));
    lobby.leave();
  }

  section("an unpicked color joins as the explicit amber default (0) — the roster row can never be invented");
  {
    localStorage.removeItem("blobrogue.color");
    localStorage.removeItem("blobrogue.cosmetics");
    const calls: Call[] = [];
    const client = fakeConvex(calls, { profileColor: null });
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create();
    const createArgs = calls.find((c) => c.fn === "rooms:create")?.args;
    check("rooms:create carries colorIndex 0 (the amber default the player's own screen shows)",
      createArgs?.colorIndex === 0, JSON.stringify(createArgs));
    const beat = calls.find((c) => c.fn === "rooms:heartbeat");
    check("the heartbeat carries the same effective color", beat?.args.colorIndex === 0, JSON.stringify(beat?.args));
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

  section("TEMP PVP KILL SWITCH: every client pvp entry path throws the typed pvp_disabled error, never touching the backend; co-op is untouched");
  {
    // The switch is OFF in this build — the whole section asserts the disabled behavior. (If it
    // is ever re-enabled, this guard makes the intent explicit rather than silently passing.)
    check("PVP is disabled in this build (the containment default)", PVP_PUBLIC_ENABLED === false);

    // CREATE: a pvp room is refused BEFORE any backend call — no rooms:create, no identity flush.
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const lobby = new OnlineLobby(client, new Session(client));
    let createErr: unknown = null;
    try { await lobby.create("pvp"); } catch (e) { createErr = e; }
    check("create('pvp') throws the typed PvpDisabledError", createErr instanceof PvpDisabledError);
    check("...carrying the pvp_disabled code", createErr instanceof PvpDisabledError && createErr.code === PVP_DISABLED_CODE);
    check("...and the clean player-facing copy", createErr instanceof Error && createErr.message === PVP_DISABLED_MESSAGE, PVP_DISABLED_MESSAGE);
    check("no rooms:create reached the backend for a pvp room", calls.every((c) => c.fn !== "rooms:create"), callNames(calls).join(" -> "));
    lobby.leave();

    // QUICK PLAY: the pvp public pool is refused up front too — no rooms:quickPlay.
    const qcalls: Call[] = [];
    const qclient = fakeConvex(qcalls);
    const qlobby = new OnlineLobby(qclient, new Session(qclient));
    let quickErr: unknown = null;
    try { await qlobby.quickPlay("pvp"); } catch (e) { quickErr = e; }
    check("quickPlay('pvp') throws the typed PvpDisabledError", quickErr instanceof PvpDisabledError && quickErr.code === PVP_DISABLED_CODE);
    check("no rooms:quickPlay reached the backend for a pvp room", qcalls.every((c) => c.fn !== "rooms:quickPlay"), callNames(qcalls).join(" -> "));
    qlobby.leave();

    // JOIN: even if the backend (a stale cache) resolved a pvp room, the client refuses to
    // adopt it — the mode is server-decided, so this guards the stale-cache race. NEVER a
    // silent fallback to co-op.
    const jcalls: Call[] = [];
    const jclient = fakeConvex(jcalls, { joinMode: "pvp" });
    const jlobby = new OnlineLobby(jclient, new Session(jclient));
    let joinErr: unknown = null;
    try { await jlobby.join("ABCD"); } catch (e) { joinErr = e; }
    check("join() of a pvp room throws the typed PvpDisabledError (no co-op fallback)", joinErr instanceof PvpDisabledError && joinErr.code === PVP_DISABLED_CODE);
    check("the lobby never adopted the pvp room (mode stays the co-op default)", jlobby.mode === "coop");
    jlobby.leave();

    // CO-OP is fully unchanged: create resolves, binds the co-op world id, hits the backend.
    const ccalls: Call[] = [];
    const cclient = fakeConvex(ccalls);
    const clobby = new OnlineLobby(cclient, new Session(cclient));
    await clobby.create();
    check("co-op create still reaches the backend", ccalls.some((c) => c.fn === "rooms:create"));
    check("a co-op room keeps the co-op world id", clobby.mode === "coop" && clobby.expectedWorldId() === worldIdForRoomCode("ABCD") && clobby.expectedWorldId() === "room:ABCD");
    clobby.leave();

    // CO-OP join + quickPlay are likewise unchanged.
    const cj: Call[] = [];
    const cjClient = fakeConvex(cj, { joinMode: "coop" });
    const cjLobby = new OnlineLobby(cjClient, new Session(cjClient));
    await cjLobby.join("ABCD");
    check("co-op join still succeeds and adopts co-op", cjLobby.mode === "coop" && cj.some((c) => c.fn === "rooms:join"));
    cjLobby.leave();

    const cq: Call[] = [];
    const cqClient = fakeConvex(cq);
    const cqLobby = new OnlineLobby(cqClient, new Session(cqClient));
    await cqLobby.quickPlay("coop");
    check("co-op quickPlay still reaches the backend", cq.some((c) => c.fn === "rooms:quickPlay"));
    cqLobby.leave();
  }

  section("setReady: the lobby consent toggle reaches the roster row");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create();
    calls.length = 0;
    lobby.setReady(true);
    lobby.setReady(false);
    await Promise.resolve();
    const readies = calls.filter((c) => c.fn === "presence:setReady");
    check("ready ON recorded", readies[0] !== undefined && readies[0].args.isReady === true && readies[0].args.playerId === "player-1", JSON.stringify(readies[0]?.args));
    check("ready OFF recorded", readies[1] !== undefined && readies[1].args.isReady === false);
    lobby.leave();
  }

  section("heartbeat measures and publishes the lobby ping");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create(); // first beat fires inside create's subscribe (no ping yet)
    await sleep(10);
    calls.length = 0;
    await (lobby as unknown as { startHeartbeat(): void }).startHeartbeat(); // second beat carries the measured RTT
    await sleep(10);
    const beat = calls.find((c) => c.fn === "rooms:heartbeat");
    check("a later beat publishes the measured round trip", beat !== undefined && typeof beat.args.pingMs === "number" && (beat.args.pingMs as number) >= 0,
      JSON.stringify(beat?.args));
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
