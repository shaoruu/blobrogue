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
import { worldIdForRoomCode, pvpWorldIdForRoomCode } from "../src/net/protocol.js";
import {
  PvpDisabledError,
  PVP_DISABLED_MESSAGE,
  PVP_PUBLIC_DISABLED_CODE,
  PVP_PUBLIC_ENABLED,
  PVP_PRIVATE_ENABLED,
} from "../src/net/pvpFlag.js";
import type { RunLoadout } from "../src/net/kitSelection.js";

let passed = 0, failed = 0;
const failures: string[] = [];
const LOADOUT: RunLoadout = { kitId: "gunner", petId: null };
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
  let draftKitId = "gunner";
  let draftPetId: string | null = null;
  let editRevision = 0;
  const respond = (fn: string, args: Record<string, unknown>): unknown => {
    switch (fn) {
      case "players:ensurePlayer":
        return {
          playerId: "player-1", name: "Ada", colorIndex: profileColor,
          cosmetics: { hat: null, face: null, body: null, title: null },
          totalKills: 0, deepestFloor: 0, totalCoins: 0, gamesPlayed: 0,
          unlocks: [], equippedPet: null, lastKitId: "gunner",
          masteryXp: 0, masteryLevel: 1, isAccount: false,
          guestCapability: "guest-capability",
          guestRefreshCapability: "guest-refresh-capability",
        };
      case "rooms:create":
        return {
          roomId: "room-doc-1", code: "ABCD", seed: 1, floor: 1,
          mode: args.mode ?? "coop", loadoutGeneration: 1,
          kitId: args.kitId, petId: args.petId,
        };
      case "rooms:join":
        return {
          roomId: "room-doc-1", code: "ABCD", seed: 1, floor: 1,
          status: "lobby", mode: opts.joinMode ?? "coop", loadoutGeneration: 1,
          kitId: args.kitId, petId: args.petId,
        };
      case "rooms:quickPlay":
        return {
          roomId: "room-doc-1", code: "ABCD", seed: 1, floor: 1,
          status: "playing", mode: args.mode ?? "coop", joined: false,
          loadoutGeneration: 1, kitId: args.kitId, petId: args.petId,
        };
      case "rooms:confirmLoadout":
        return {
          ok: true,
          generation: args.generation,
          kitId: draftKitId,
          petId: draftPetId,
        };
      case "rooms:beginLoadoutEdit":
        editRevision++;
        return { ok: true, editRevision };
      case "rooms:chooseDraftKit":
        draftKitId = String(args.kitId);
        return { ok: true };
      case "rooms:chooseDraftPet":
        draftPetId = typeof args.petId === "string" ? args.petId : null;
        return { ok: true };
      case "rooms:reopen":
        return { loadoutGeneration: 2, isReopened: true };
      case "rooms:start":
      case "presence:setReady":
        return { ok: true };
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
    await lobby.create("coop", LOADOUT);
    const names = callNames(calls);
    const flushIdx = names.indexOf("players:ensurePlayer");
    const createIdx = names.indexOf("rooms:create");
    check("ensurePlayer precedes rooms:create", flushIdx !== -1 && createIdx !== -1 && flushIdx < createIdx, names.join(" -> "));
    const createArgs = calls[createIdx].args;
    check("the room row is created with the chosen color", createArgs.colorIndex === 4, JSON.stringify(createArgs));
    check("online authority is bound by clientId, never a caller-supplied playerId",
      createArgs.clientId === session.clientId
      && createArgs.guestCapability === "guest-capability"
      && !("playerId" in createArgs), JSON.stringify(createArgs));
    check("explicit No Pet carries null plus both deliberate choice bits",
      createArgs.petId === null
      && createArgs.isKitChoiceMade === true
      && createArgs.isPetChoiceMade === true,
      JSON.stringify(createArgs));
    check("the flush carried the chosen color", calls[flushIdx].args.colorIndex === 4);
    lobby.leave();
  }

  section("mintTicket: identity flush precedes the mint; the mint names THIS room");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create("coop", LOADOUT);
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
    check("the mint carries the scoped guest capability", mintArgs.guestCapability === "guest-capability");
    check("the ticket request carries no browser-authored kit or pet", !("kit" in mintArgs) && !("petId" in mintArgs));
    lobby.leave();
  }

  section("heartbeat carries the CURRENT identity (a lobby color change reaches the roster)");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    session.setColorIndex(1);
    const lobby = new OnlineLobby(client, session);
    await lobby.create("coop", LOADOUT);
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
    await lobby.create("coop", LOADOUT);
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
    await lobby.create("coop", LOADOUT);
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
    await lobby.create("coop", LOADOUT);
    check("expectedWorldId includes the confirmed generation",
      lobby.expectedWorldId() === worldIdForRoomCode("ABCD", 1) && lobby.expectedWorldId() === "room:ABCD:g1",
      lobby.expectedWorldId());
    lobby.leave();
  }

  section("PVP ROLLOUT (private ON, public OFF): private room-code arena is LIVE end-to-end; the public pool stays dark; co-op is untouched");
  {
    check("this build ships PRIVATE arena ON, PUBLIC pool OFF", PVP_PRIVATE_ENABLED === true && PVP_PUBLIC_ENABLED === false);

    // CREATE: a PRIVATE pvp room is created — the client private guard passes and the backend is
    // reached with mode "pvp" (Convex selects the signed policy; the client only sends the mode).
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const lobby = new OnlineLobby(client, new Session(client));
    await lobby.create("pvp", LOADOUT);
    const createCall = calls.find((c) => c.fn === "rooms:create");
    check("create('pvp') reaches the backend (no client-side refusal)", createCall !== undefined);
    check("...sending mode 'pvp' and never a client-authored policy",
      createCall?.args.mode === "pvp" && !("pvpPolicy" in (createCall?.args ?? {})), JSON.stringify(createCall?.args));
    check("...and the lobby adopts pvp with the generation-bound pvp world id",
      lobby.mode === "pvp" && lobby.expectedWorldId() === pvpWorldIdForRoomCode("ABCD", 1)
      && lobby.expectedWorldId() === "pvp:room:ABCD:g1", lobby.expectedWorldId());
    lobby.leave();

    // QUICK PLAY: the PUBLIC pool is still dark, so a pvp quick play is refused UP FRONT with the
    // typed public_disabled error — the public matchmaking mutation is never reached.
    const qcalls: Call[] = [];
    const qclient = fakeConvex(qcalls);
    const qlobby = new OnlineLobby(qclient, new Session(qclient));
    let quickErr: unknown = null;
    try { await qlobby.quickPlay("pvp", LOADOUT); } catch (e) { quickErr = e; }
    check("quickPlay('pvp') throws the public-disabled PvpDisabledError",
      quickErr instanceof PvpDisabledError && quickErr.code === PVP_PUBLIC_DISABLED_CODE);
    check("...carrying the clean player-facing copy", quickErr instanceof Error && quickErr.message === PVP_DISABLED_MESSAGE, PVP_DISABLED_MESSAGE);
    check("no rooms:quickPlay reached the backend for a pvp room", qcalls.every((c) => c.fn !== "rooms:quickPlay"), callNames(qcalls).join(" -> "));
    qlobby.leave();

    // JOIN CODE: joining an existing PRIVATE pvp room succeeds — the client private guard passes
    // and the joiner ADOPTS the room's server-decided pvp mode (never a silent co-op fallback).
    const jcalls: Call[] = [];
    const jclient = fakeConvex(jcalls, { joinMode: "pvp" });
    const jlobby = new OnlineLobby(jclient, new Session(jclient));
    await jlobby.join("ABCD", LOADOUT);
    check("join() of a private pvp room reaches the backend", jcalls.some((c) => c.fn === "rooms:join"));
    check("...and the joiner adopts the room's pvp mode with the pvp world id",
      jlobby.mode === "pvp" && jlobby.expectedWorldId() === "pvp:room:ABCD:g1", jlobby.expectedWorldId());
    jlobby.leave();

    // CO-OP is fully unchanged: create resolves, binds the co-op world id, hits the backend.
    const ccalls: Call[] = [];
    const cclient = fakeConvex(ccalls);
    const clobby = new OnlineLobby(cclient, new Session(cclient));
    await clobby.create("coop", LOADOUT);
    check("co-op create still reaches the backend", ccalls.some((c) => c.fn === "rooms:create"));
    check("a co-op room keeps its generation-bound co-op world id",
      clobby.mode === "coop" && clobby.expectedWorldId() === worldIdForRoomCode("ABCD", 1)
      && clobby.expectedWorldId() === "room:ABCD:g1");
    clobby.leave();

    // CO-OP join + quickPlay are likewise unchanged.
    const cj: Call[] = [];
    const cjClient = fakeConvex(cj, { joinMode: "coop" });
    const cjLobby = new OnlineLobby(cjClient, new Session(cjClient));
    await cjLobby.join("ABCD", LOADOUT);
    check("co-op join still succeeds and adopts co-op", cjLobby.mode === "coop" && cj.some((c) => c.fn === "rooms:join"));
    cjLobby.leave();

    const cq: Call[] = [];
    const cqClient = fakeConvex(cq);
    const cqLobby = new OnlineLobby(cqClient, new Session(cqClient));
    await cqLobby.quickPlay("coop", LOADOUT);
    check("co-op quickPlay still reaches the backend", cq.some((c) => c.fn === "rooms:quickPlay"));
    cqLobby.leave();
  }

  section("setReady: the lobby consent toggle reaches the roster row");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create("coop", LOADOUT);
    calls.length = 0;
    lobby.setReady(true);
    lobby.setReady(false);
    await Promise.resolve();
    const readies = calls.filter((c) => c.fn === "presence:setReady");
    check("ready ON is bound to this browser session", readies[0] !== undefined
      && readies[0].args.isReady === true && readies[0].args.clientId === session.clientId,
      JSON.stringify(readies[0]?.args));
    check("ready OFF recorded", readies[1] !== undefined && readies[1].args.isReady === false);
    lobby.leave();
  }

  section("heartbeat measures and publishes the lobby ping");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create("coop", LOADOUT); // first beat fires inside create's subscribe (no ping yet)
    await sleep(10);
    calls.length = 0;
    await (lobby as unknown as { startHeartbeat(): void }).startHeartbeat(); // second beat carries the measured RTT
    await sleep(10);
    const beat = calls.find((c) => c.fn === "rooms:heartbeat");
    check("a later beat publishes the measured round trip", beat !== undefined && typeof beat.args.pingMs === "number" && (beat.args.pingMs as number) >= 0,
      JSON.stringify(beat?.args));
    lobby.leave();
  }

  section("combined lobby confirmation is generation-bound and reopen invalidates it");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create("coop", LOADOUT);
    calls.length = 0;
    const editError = await lobby.beginLoadoutEdit(1);
    const isAuthorityCleared = editError === null && lobby.selfLoadout === null;
    lobby.chooseDraftKit("mender", 1);
    lobby.chooseDraftPet(null, 1);
    const error = await lobby.confirmLoadout({ kitId: "mender", petId: null }, 1);
    check("editing clears combined authority before either draft choice", isAuthorityCleared);
    const draftCalls = calls.filter((call) => call.fn === "rooms:chooseDraftKit" || call.fn === "rooms:chooseDraftPet");
    check("KIT and explicit No Pet are distinct generation-bound draft writes",
      draftCalls.length === 2
      && draftCalls[0]?.fn === "rooms:chooseDraftKit"
      && draftCalls[0].args.kitId === "mender"
      && draftCalls[0].args.editRevision === 1
      && draftCalls[1]?.fn === "rooms:chooseDraftPet"
      && draftCalls[1].args.petId === null
      && draftCalls[1].args.editRevision === 1);
    check("draft writes do not persist profile convenience or mint a ticket",
      calls.every((call) => call.fn !== "players:confirmRunLoadout" && call.fn !== "gsTicket:mint"));
    check("generation-1 combined confirm succeeds", error === null);
    const confirm = calls.find((call) => call.fn === "rooms:confirmLoadout");
    check("confirm carries only generation, edit revision, and caller capability",
      confirm?.args.generation === 1
      && confirm.args.editRevision === 1
      && confirm.args.clientId === session.clientId
      && !("kitId" in confirm.args)
      && !("petId" in confirm.args)
      && !("playerId" in confirm.args),
      JSON.stringify(confirm?.args));
    check("the lobby exposes the exact confirmed pair", lobby.selfLoadout?.kitId === "mender" && lobby.selfLoadout.petId === null);
    await lobby.reopen();
    check("reopen advances generation and invalidates local run authority",
      lobby.loadoutGeneration === 2 && lobby.selfLoadout === null && !lobby.isSelfLoadoutConfirmed);
    lobby.leave();
  }

  section("reportWorld: the authoritative join/leave is mirrored onto the presence row");
  {
    const calls: Call[] = [];
    const client = fakeConvex(calls);
    const session = new Session(client);
    const lobby = new OnlineLobby(client, session);
    await lobby.create("coop", LOADOUT);
    calls.length = 0;
    lobby.reportWorld("room:ABCD");
    lobby.reportWorld(null);
    await Promise.resolve();
    const reports = calls.filter((c) => c.fn === "presence:reportWorld");
    check("join mirror is bound to this browser session", reports[0] !== undefined
      && reports[0].args.worldId === "room:ABCD"
      && reports[0].args.generation === 1
      && reports[0].args.clientId === session.clientId,
      JSON.stringify(reports[0]?.args));
    check("leave mirrored with null", reports[1] !== undefined && reports[1].args.worldId === null);
    lobby.leave();
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll online-lobby contract assertions passed.\n");
}

void main();
