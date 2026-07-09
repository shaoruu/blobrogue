// Room replay lifecycle suite (the live "can't play again / didn't bring everybody" bug),
// driven through the REAL Menu + OnlineLobby against a scripted Convex client in jsdom:
//   1. a party WIPE reopens the room (any member, idempotent) and marks the member's
//      lifecycle phase "over" — the room can never sit on a dead "playing" status
//   2. a lost CONNECTION does NOT reopen (the run may still be live for the others)
//   3. nobody is stranded at the results screen: when the host starts the next run, every
//      subscribed member launches from wherever they sit — but ONLY on a lobby->playing
//      transition (the wiped run's stale "playing" status can never relaunch anyone)
//   4. the non-host's primary action is the shared lobby (never a separate local run),
//      where they wait for the host's START
//   5. the host's START gates on the roster readiness: members still marked in-run hold it
//      (their crashed rows go stale and drop off — the explicit timeout), members at the
//      results screen do not (they follow the start automatically)
//   6. leaving updates the roster and the readiness gate immediately
//
// Run: npm run test:replay

import { JSDOM, VirtualConsole } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { virtualConsole: new VirtualConsole() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLImageElement: dom.window.HTMLImageElement,
  HTMLCanvasElement: dom.window.HTMLCanvasElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
});

const { Menu } = await import("../src/ui/menu.js");
const { OnlineLobby } = await import("../src/net/onlineLobby.js");
const { Session } = await import("../src/net/session.js");
const { api } = await import("../src/net/api.js");
type ConvexClient = import("convex/browser").ConvexClient;
type ProfileDoc = import("../src/net/api.js").ProfileDoc;
type PresenceDoc = import("../src/net/api.js").PresenceDoc;
type RoomDoc = import("../src/net/api.js").RoomDoc;
type RunResult = import("../src/game/game.js").RunResult;

/* eslint-disable @typescript-eslint/no-explicit-any */

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

// ---- a scripted Convex client: records mutations, lets the test push subscription data ----

interface MutationLogEntry { name: string; args: Record<string, unknown> }

// makeFunctionReference values are opaque; their function NAME rides in the "_name"-ish
// internals, so the fake routes by matching against the imported api refs by identity.
function refName(ref: unknown): string {
  if (ref === api.rooms.join) return "rooms:join";
  if (ref === api.rooms.create) return "rooms:create";
  if (ref === api.rooms.start) return "rooms:start";
  if (ref === api.rooms.reopen) return "rooms:reopen";
  if (ref === api.rooms.leave) return "rooms:leave";
  if (ref === api.rooms.heartbeat) return "rooms:heartbeat";
  if (ref === api.rooms.get) return "rooms:get";
  if (ref === api.presence.list) return "presence:list";
  if (ref === api.presence.setPhase) return "presence:setPhase";
  if (ref === api.players.ensurePlayer) return "players:ensurePlayer";
  return "unknown";
}

class ScriptedConvex {
  log: MutationLogEntry[] = [];
  private roomCb: ((room: RoomDoc | null) => void) | null = null;
  private presenceCb: ((rows: PresenceDoc[]) => void) | null = null;
  private profile: ProfileDoc;

  constructor(selfPlayerId: string, selfName: string) {
    this.profile = {
      playerId: selfPlayerId, name: selfName, colorIndex: 1,
      totalKills: 0, deepestFloor: 0, totalCoins: 0, gamesPlayed: 0, unlocks: [], isAccount: false,
    };
  }

  mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown> {
    const name = refName(ref);
    this.log.push({ name, args });
    if (name === "players:ensurePlayer") return Promise.resolve(this.profile);
    if (name === "rooms:join") return Promise.resolve({ roomId: "r1", code: "ABCD", seed: 7, floor: 1, status: "playing" });
    return Promise.resolve(null);
  }

  action(): Promise<unknown> {
    return Promise.resolve({ ticket: "dev:x", playerId: this.profile.playerId });
  }

  query(): Promise<unknown> {
    return Promise.resolve(null);
  }

  onUpdate(ref: unknown, _args: Record<string, unknown>, cb: (v: never) => void): () => void {
    const name = refName(ref);
    if (name === "rooms:get") this.roomCb = cb as unknown as (room: RoomDoc | null) => void;
    if (name === "presence:list") this.presenceCb = cb as unknown as (rows: PresenceDoc[]) => void;
    return () => {};
  }

  pushRoom(room: Partial<RoomDoc>): void {
    this.roomCb?.({ roomId: "r1", code: "ABCD", hostPlayerId: "pl_host", seed: 7, floor: 1, status: "playing", ...room });
  }

  pushPresence(rows: Array<Partial<PresenceDoc> & { playerId: string; name: string }>): void {
    this.presenceCb?.(rows.map((r) => ({
      x: 0, y: 0, facing: 1, hp: 6, maxHp: 6, weapon: "pistol", floor: 1, isDown: false,
      aimAngle: 0, shotSeq: 0, kills: 0, colorIndex: 0, reviveNonce: 0, updatedAt: Date.now(), phase: "lobby",
      ...r,
    })));
  }

  countOf(name: string): number {
    return this.log.filter((m) => m.name === name).length;
  }
  lastPhase(): string | null {
    const m = [...this.log].reverse().find((x) => x.name === "presence:setPhase");
    return m ? String(m.args.phase) : null;
  }
}

interface Rig {
  convex: ScriptedConvex;
  lobby: OnlineLobby;
  menu: Menu;
  overlay: HTMLElement;
  launches: OnlineLobby[];
}

// A joined member's client (self = pl_self), with the Menu's host hooks spied.
async function makeRig(selfId = "pl_self"): Promise<Rig> {
  const convex = new ScriptedConvex(selfId, "gf");
  const overlay = document.createElement("div");
  document.body.appendChild(overlay);
  const session = new Session(convex as unknown as ConvexClient);
  await session.login("gf");
  const lobby = new OnlineLobby(convex as unknown as ConvexClient, session);
  await lobby.join("ABCD");
  const launches: OnlineLobby[] = [];
  const menu = new Menu(overlay, session, convex as unknown as ConvexClient, null, {
    startSolo: () => { failures.push("startSolo must never fire from the replay flow"); failed++; },
    startCoop: () => { failures.push("startCoop must never fire from the replay flow"); failed++; },
    startOnline: (l) => launches.push(l),
  });
  return { convex, lobby, menu, overlay, launches };
}

const RESULT: RunResult = { floor: 3, kills: 12, coins: 30, durationMs: 61000 };

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

async function main(): Promise<void> {
  section("wipe: any member reopens the room and marks itself at the results screen");
  {
    const { convex, lobby, menu, overlay } = await makeRig();
    convex.pushRoom({ status: "playing" }); // the (now dead) run's stale status
    menu.showGameOver(RESULT, null, { wasCoop: false, isNewBest: false, online: lobby, isPartyWiped: true });
    await flush();
    check("the wipe reopened the room (idempotent, any member)", convex.countOf("rooms:reopen") === 1);
    check("the member marked its lifecycle phase 'over'", convex.lastPhase() === "over");
    check("the results screen is showing", overlay.textContent!.includes("YOU DIED"));
    lobby.leave();
  }

  section("lost connection: the room is left alone (the run may still be live for the party)");
  {
    const { convex, lobby, menu } = await makeRig();
    menu.showGameOver(RESULT, null, { wasCoop: false, isNewBest: false, online: lobby, isPartyWiped: false });
    await flush();
    check("no reopen on a mere disconnect", convex.countOf("rooms:reopen") === 0);
    lobby.leave();
  }

  section("nobody stranded: the host's next START pulls a member off the results screen");
  {
    const { convex, lobby, menu, launches } = await makeRig();
    menu.showGameOver(RESULT, null, { wasCoop: false, isNewBest: false, online: lobby, isPartyWiped: true });
    await flush();
    // The stale "playing" status of the WIPED run must never relaunch anyone.
    convex.pushRoom({ status: "playing" });
    check("stale playing status did not relaunch", launches.length === 0);
    // The reopen lands (status lobby), then the host starts the NEXT run.
    convex.pushRoom({ status: "lobby" });
    check("seeing the lobby is not a launch either", launches.length === 0);
    convex.pushRoom({ status: "playing" });
    check("the lobby->playing transition launches the member into the new run", launches.length === 1);
    check("the launch marked the member's phase 'playing'", convex.lastPhase() === "playing");
    lobby.leave();
  }

  section("non-host: the primary action is the SHARED lobby, waiting for the host");
  {
    const { convex, lobby, menu, overlay, launches } = await makeRig();
    convex.pushRoom({ status: "playing", hostPlayerId: "pl_host" }); // self (pl_self) is NOT host
    menu.showGameOver(RESULT, null, { wasCoop: false, isNewBest: false, online: lobby, isPartyWiped: true });
    await flush();
    const primaryBtn = [...overlay.querySelectorAll("button")].find((b) => b.textContent!.includes("back to lobby"));
    check("non-host primary reads 'back to lobby' (never a separate run)", primaryBtn !== undefined);
    convex.pushRoom({ status: "lobby", hostPlayerId: "pl_host" });
    primaryBtn!.click();
    await flush();
    convex.pushPresence([
      { playerId: "pl_host", name: "ian", phase: "lobby" },
      { playerId: "pl_self", name: "gf", phase: "lobby" },
    ]);
    check("the shared lobby is showing (same room code)", overlay.textContent!.includes("ROOM ABCD"));
    check("non-host waits for the host — no START control", overlay.textContent!.includes("waiting for the host")
      && ![...overlay.querySelectorAll("button")].some((b) => b.textContent!.includes("START RUN")));
    check("entering the lobby marked the phase 'lobby'", convex.lastPhase() === "lobby");
    check("still no launch without the host", launches.length === 0);
    lobby.leave();
  }

  section("host: START gates on members still marked in-run; results-screen members don't hold it");
  {
    const { convex, lobby, menu, overlay } = await makeRig("pl_host"); // self IS the host
    convex.pushRoom({ status: "lobby", hostPlayerId: "pl_host" });
    menu.showOnlineLobby(lobby, null);
    convex.pushPresence([
      { playerId: "pl_host", name: "ian", phase: "lobby" },
      { playerId: "pl_gf", name: "gf", phase: "playing" }, // crashed / still returning
    ]);
    const waitingBtn = [...overlay.querySelectorAll("button")].find((b) => b.textContent!.includes("to return"));
    check("START is held while a member is still marked in-run", waitingBtn !== undefined && waitingBtn.disabled);
    check("the roster explains who the gate waits for", overlay.textContent!.includes("returning from the last run"));
    // Their client lands in the lobby (or their stale row drops off) — the gate releases.
    convex.pushPresence([
      { playerId: "pl_host", name: "ian", phase: "lobby" },
      { playerId: "pl_gf", name: "gf", phase: "over" },
    ]);
    const startBtn = [...overlay.querySelectorAll("button")].find((b) => b.textContent!.includes("START RUN"));
    check("a member at the results screen does not hold the gate (they follow the start)",
      startBtn !== undefined && !startBtn.disabled);
    check("their state still reads honestly in the roster", overlay.textContent!.includes("at the results screen"));
    startBtn!.click();
    await flush();
    check("the host's START flipped the room", convex.countOf("rooms:start") === 1);
    lobby.leave();
  }

  section("leave: the roster and gate update the moment a member departs");
  {
    const { convex, lobby, menu, overlay } = await makeRig("pl_host");
    convex.pushRoom({ status: "lobby", hostPlayerId: "pl_host" });
    menu.showOnlineLobby(lobby, null);
    convex.pushPresence([
      { playerId: "pl_host", name: "ian", phase: "lobby" },
      { playerId: "pl_gf", name: "gf", phase: "playing" },
    ]);
    check("gate held by the in-run member", [...overlay.querySelectorAll("button")].some((b) => b.textContent!.includes("to return")));
    convex.pushPresence([{ playerId: "pl_host", name: "ian", phase: "lobby" }]); // gf left / went stale
    check("departed member released the gate", [...overlay.querySelectorAll("button")].some((b) => b.textContent!.includes("START RUN")));
    check("roster shrank to the remaining member", overlay.textContent!.includes("1 player in the room"));
    lobby.leave();
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll room replay lifecycle assertions passed.\n");
  process.exit(0); // the lobby heartbeat interval would otherwise keep the process alive
}

void main();
