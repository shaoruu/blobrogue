// Room-scoped world suite: the lobby -> ticket -> join -> world binding that turns the single
// global arena into isolated per-room worlds. Drives REAL WSTransport bots against an
// in-process server with tickets minted exactly like the production Convex minter (same
// claims, same bytes — locked by ticket.test.ts) and asserts:
//   1. two clients whose tickets carry the SAME room world land in ONE shared world and see
//      each other (names + colors riding the verified ticket identity onto the wire)
//   2. different room codes are fully isolated (separate worlds, no cross-visibility)
//   3. claimless tickets remain available only to dev/test servers; production rejects them
//   4. a signed-but-junk world claim REJECTS the join (never misroutes)
//   5. an emptied room world is released from the registry (no per-code leak)
//   6. ended generation ids are tombstoned while the next generation remains joinable
//   7. the local /dev-ticket endpoint mints the same claims (two-tab dev proof)
// Run: npm run test:rooms (in server/).

import { startTestServer, Bot, idle, waitUntil, sleep, TEST_SECRET } from "../harness/lib.js";
import { mintTicket } from "../src/auth.js";
import { DEFAULT_WORLD_ID } from "../src/messageRouter.js";
import { jsonCodec, PROTOCOL_VERSION } from "../../src/net/protocol.js";
import { WebSocket as WsClient } from "ws";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  try { await fn(); }
  catch (err) { failed++; failures.push(`${name} threw: ${String(err)}`); process.stdout.write(`  FAIL ${name} threw ${String(err)}\n`); }
}

function rawSocket(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function main(): Promise<void> {
  await test("same room code -> one shared world; identity (name/color) rides the wire", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "ada-auth", world: "room:AAAA", name: "Ada", colorIndex: 2, script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "bob-auth", world: "room:AAAA", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);

      const world = s.server.getWorld("room:AAAA");
      check("both players bound to the room's world", world?.playerCount === 2, `players=${world?.playerCount}`);
      check("the default world was never created", s.server.getWorld(DEFAULT_WORLD_ID) === undefined);

      // Each side sees exactly the other (same spawn area, full interest coverage).
      await waitUntil(() => (a.transport.getLatestSnapshot()?.players.length ?? 0) === 1
        && (b.transport.getLatestSnapshot()?.players.length ?? 0) === 1, 3000);
      const seenByB = b.transport.getLatestSnapshot()?.players[0];
      const seenByA = a.transport.getLatestSnapshot()?.players[0];
      check("B sees A with A's ticket identity", seenByB?.nm === "Ada" && seenByB?.cl === 2, `nm=${seenByB?.nm} cl=${seenByB?.cl}`);
      check("A sees B as a guest (id-as-name fallback, no color claim)",
        seenByA !== undefined && seenByA.nm === seenByA.id && seenByA.cl === null, `nm=${seenByA?.nm} cl=${seenByA?.cl}`);
      const remote = b.transport.remotePlayers()[0];
      check("client surfaces the name for rendering (name label above the blob)", remote?.name === "Ada");
      check("client surfaces the chosen color for tinting", remote?.colorIndex === 2, `color=${remote?.colorIndex}`);
      const guestRemote = a.transport.remotePlayers()[0];
      check("a claimless teammate surfaces NO color — the renderer's neutral placeholder, never a client-side guess",
        guestRemote !== undefined && guestRemote.colorIndex === null, `color=${guestRemote?.colorIndex}`);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  await test("late join: the newcomer's verified color reaches the room and the room's reaches the newcomer", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "late-a", world: "room:LATE", name: "Ada", colorIndex: 2, script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "late-b", world: "room:LATE", name: "Bob", colorIndex: 5, script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);

      // The room is already live when Cye joins (the drop-in / rejoin shape).
      const cye = new Bot({
        url: s.url,
        secret: s.secret,
        playerId: "late-c",
        world: "room:LATE",
        name: "Cye",
        colorIndex: 3,
        kit: "phantom",
        masteryLevel: 5,
        pet: "doggie",
        isPetChoiceMade: true,
        script: () => idle(),
      });
      cye.start();
      await waitUntil(() => cye.transport.isReady(), 3000);
      await waitUntil(() => a.transport.remotePlayers().length === 2 && cye.transport.remotePlayers().length === 2, 3000);

      const cyeSeenByA = a.transport.remotePlayers().find((r) => r.name === "Cye");
      check("existing members see the late joiner's ACTUAL color", cyeSeenByA?.colorIndex === 3, `color=${cyeSeenByA?.colorIndex}`);
      check("late join safely spawns with the validated kit + cosmetic pet pair",
        s.server.getWorld("room:LATE")?.state.players.get(cye.transport.getSelfServerId()!)?.kitId === "phantom"
        && cyeSeenByA?.pet === "doggie");
      const seenByCye = new Map(cye.transport.remotePlayers().map((r) => [r.name, r.colorIndex]));
      check("the late joiner sees everyone's ACTUAL colors", seenByCye.get("Ada") === 2 && seenByCye.get("Bob") === 5,
        JSON.stringify([...seenByCye]));
      const roster = cye.transport.getWorldRoster();
      check("the authoritative roster agrees for all three members",
        roster.find((r) => r.aid === "late-a")?.cl === 2
        && roster.find((r) => r.aid === "late-b")?.cl === 5
        && roster.find((r) => r.aid === "late-c")?.cl === 3,
        JSON.stringify(roster.map((r) => [r.aid, r.cl])));

      a.stop(); b.stop(); cye.stop();
    } finally { await s.close(); }
  });

  await test("different room codes are isolated worlds; claimless tickets keep the public default", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "a1", world: "room:AAAA", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "b1", world: "room:BBBB", script: () => idle() });
      const c = new Bot({ url: s.url, secret: s.secret, playerId: "c1", script: () => idle() }); // no world claim
      a.start(); b.start(); c.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady() && c.transport.isReady(), 3000);

      check("room A world holds only its player", s.server.getWorld("room:AAAA")?.playerCount === 1);
      check("room B world holds only its player", s.server.getWorld("room:BBBB")?.playerCount === 1);
      check("claimless ticket binds the default/public world", s.server.getWorld(DEFAULT_WORLD_ID)?.playerCount === 1);
      check("three isolated worlds exist", s.server.health().worlds === 3, `worlds=${s.server.health().worlds}`);

      await sleep(400);
      check("no cross-room visibility (A sees nobody)", (a.transport.getLatestSnapshot()?.players.length ?? -1) === 0);
      check("no cross-room visibility (B sees nobody)", (b.transport.getLatestSnapshot()?.players.length ?? -1) === 0);
      check("public-pool player sees nobody from the rooms", (c.transport.getLatestSnapshot()?.players.length ?? -1) === 0);

      // Isolation is state-deep, not just filtering: each room runs its OWN dungeon seed.
      const seedA = s.server.getWorld("room:AAAA")?.state.seed;
      const seedB = s.server.getWorld("room:BBBB")?.state.seed;
      check("rooms run independent runs (own seeds)", seedA !== undefined && seedB !== undefined && seedA !== seedB, `a=${seedA} b=${seedB}`);

      a.stop(); b.stop(); c.stop();
    } finally { await s.close(); }
  });

  await test("a signed ticket with a junk world claim is REJECTED (never misrouted)", async () => {
    const s = await startTestServer();
    try {
      const before = s.server.health().counters.joinsRejected;
      const ws = await rawSocket(s.url);
      let isRejected = false;
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString("utf8")) as { t?: string; code?: string };
        if (msg.t === "error" && msg.code === "auth") isRejected = true;
      });
      // mintTicket doesn't validate claims (the verifier does) — forge a bad world id.
      ws.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "sneaky", 120, Date.now(), { worldId: "room:../../etc" }), protocol: PROTOCOL_VERSION }));
      await waitUntil(() => isRejected, 2000);
      check("join rejected with an auth error", isRejected);
      check("rejection counted", s.server.health().counters.joinsRejected === before + 1);
      check("no world was created for the junk id", s.server.health().worlds === 0);
    } finally { await s.close(); }
  });

  await test("production joins require a generation-bound combined loadout ticket", async () => {
    const s = await startTestServer({ auth: { secret: TEST_SECRET, allowDev: false } });
    try {
      const ws = await rawSocket(s.url);
      let rejectCode = "";
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString("utf8")) as { t?: string; code?: string };
        if (msg.t === "error") rejectCode = msg.code ?? "";
      });
      ws.send(jsonCodec.encodeClient({
        t: "join",
        ticket: mintTicket(s.secret, "legacy", 120),
        protocol: PROTOCOL_VERSION,
      }));
      await waitUntil(() => rejectCode !== "", 2000);
      check("claimless/default tickets are rejected outside dev", rejectCode === "loadout_required", rejectCode);
      check("an ungated default world is never created", s.server.getWorld(DEFAULT_WORLD_ID) === undefined);
      ws.close();

      const confirmed = new Bot({
        url: s.url,
        secret: s.secret,
        playerId: "confirmed",
        world: "room:PROD:g1",
        kit: "gunner",
        masteryLevel: 1,
        isPetChoiceMade: true,
        script: () => idle(),
      });
      confirmed.start();
      check("a complete signed pair joins normally",
        await waitUntil(() => confirmed.transport.isReady(), 3000));
      confirmed.stop();
    } finally { await s.close(); }
  });

  await test("an emptied room world is released (rooms don't accumulate server-side)", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "leaver-a", world: "room:GONE", script: () => idle() });
      a.start();
      await waitUntil(() => a.transport.isReady(), 3000);
      check("room world exists while occupied", s.server.getWorld("room:GONE") !== undefined);
      a.stop();
      const released = await waitUntil(() => s.server.getWorld("room:GONE") === undefined, 2000);
      check("room world released when the last player left", released);
      check("registry is empty again", s.server.health().worlds === 0, `worlds=${s.server.health().worlds}`);

      // A returning party gets a FRESH run under the same code (new world, floor 1).
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "leaver-b", world: "room:GONE", script: () => idle() });
      b.start();
      await waitUntil(() => b.transport.isReady(), 3000);
      const world = s.server.getWorld("room:GONE");
      check("rejoin recreates the world fresh", world !== undefined && world.state.floor === 1 && world.playerCount === 1);
      b.stop();
    } finally { await s.close(); }
  });

  await test("an ended generation is tombstoned while the next generation can start", async () => {
    const s = await startTestServer();
    try {
      const first = new Bot({
        url: s.url, secret: s.secret, playerId: "gen-a",
        world: "room:GENS:g1", kit: "gunner", masteryLevel: 1,
        script: () => idle(),
      });
      first.start();
      await waitUntil(() => first.transport.isReady(), 3000);
      first.stop();
      await waitUntil(() => s.server.getWorld("room:GENS:g1") === undefined, 2000);

      const stale = new Bot({
        url: s.url, secret: s.secret, playerId: "gen-stale",
        world: "room:GENS:g1", kit: "gunner", masteryLevel: 1,
        script: () => idle(),
      });
      stale.start();
      await waitUntil(() => (stale.transport.lastError ?? "").includes("run_ended"), 2000);
      check("a still-valid old ticket cannot recreate its ended generation",
        s.server.getWorld("room:GENS:g1") === undefined
        && (stale.transport.lastError ?? "").includes("run_ended"));

      const next = new Bot({
        url: s.url, secret: s.secret, playerId: "gen-b",
        world: "room:GENS:g2", kit: "mender", masteryLevel: 1,
        script: () => idle(),
      });
      next.start();
      check("the next confirmed generation remains independently joinable",
        await waitUntil(() => next.transport.isReady(), 3000));
      stale.stop();
      next.stop();
    } finally { await s.close(); }
  });

  await test("/dev-ticket mints the same claims (two-tab local proof covers rooms + identity)", async () => {
    const s = await startTestServer();
    try {
      const httpBase = s.url.replace(/^ws/, "http").replace(/\/ws$/, "");
      const res = await fetch(`${httpBase}/dev-ticket?playerId=devgal&world=room:DEVX&name=DevGal&color=4`);
      check("dev-ticket endpoint responds", res.ok);
      const { ticket } = (await res.json()) as { ticket: string };

      const ws = await rawSocket(s.url);
      let isSpawned = false;
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString("utf8")) as { t?: string; self?: unknown };
        if (msg.t === "snap" && msg.self) isSpawned = true;
      });
      ws.send(jsonCodec.encodeClient({ t: "join", ticket, protocol: PROTOCOL_VERSION }));
      await waitUntil(() => isSpawned, 2000);
      check("dev ticket joins and spawns", isSpawned);
      const world = s.server.getWorld("room:DEVX");
      check("dev ticket bound its world claim", world?.playerCount === 1, `players=${world?.playerCount}`);

      // The identity claims landed on the connection (what other clients would see).
      const conn = world ? [...world.conns.values()][0] : undefined;
      check("dev ticket carried the display name", conn?.displayName === "DevGal", `name=${conn?.displayName}`);
      check("dev ticket carried the color", conn?.colorIndex === 4, `color=${conn?.colorIndex}`);
      ws.close();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll room-scoped world assertions passed.\n");
}

void main();
