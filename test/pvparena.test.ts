// PVP arena END-TO-END presentation: the exact plumbing the shipped bug missed, from the
// authoritative wire to the rendered HUD. Drives the REAL WSTransport through a scripted fake
// socket (mirroring netcode.test.ts) into a PVP world, then runs the SAME path game.ts runs —
// getLatestSnapshot().match -> buildMatchHud -> Hud.update -> arena DOM — and asserts:
//   1. an arena snapshot rebuilds the client world in pvp mode (isPvp true) — the ONE predicate
//      every co-op render-chrome guard keys off (renderExit / checkFloorCleared / renderMinimap /
//      renderExitCoordination all early-return when it is true), and a co-op id stays isPvp false,
//   2. the authoritative match block flows into a real Hud as an ARENA: a frag scoreboard, the
//      match readout in the objective lane (never the co-op FLOOR/GO-DOWN banner), one HP bar
//      (never 100 heart sprites),
//   3. a co-op snapshot carries no match block and the Hud stays the co-op FLOOR banner.
//
// Run: npm run test:pvparena

import { JSDOM, VirtualConsole } from "jsdom";

// jsdom lacks a canvas backend; a silent virtual console swallows its "getContext not
// implemented" notices (pxIcon tolerates a null context).
const dom = new JSDOM("<!doctype html><html><body></body></html>", { virtualConsole: new VirtualConsole() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLImageElement: dom.window.HTMLImageElement,
  HTMLCanvasElement: dom.window.HTMLCanvasElement,
  KeyboardEvent: dom.window.KeyboardEvent,
});

const { WSTransport } = await import("../src/client/wsTransport.js");
type SocketLike = import("../src/client/wsTransport.js").SocketLike;
const { buildSnapshot, jsonCodec } = await import("../src/net/protocol.js");
type ServerMsg = import("../src/net/protocol.js").ServerMsg;
const { createWorld, spawnPlayerInWorld, isPvp } = await import("../src/sim/world.js");
type WorldState = import("../src/sim/world.js").WorldState;
type WorldMode = import("../src/sim/pvp.js").WorldMode;
const { buildMatchHud } = await import("../src/game/matchHud.js");
const { Hud } = await import("../src/game/hud.js");
const { MAX_OWNED_WEAPONS } = await import("../src/sim/constants.js");
const { settings } = await import("../src/game/settings.js");

type HudModule = typeof import("../src/game/hud.js");
type HudState = Parameters<InstanceType<HudModule["Hud"]>["update"]>[0];

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

class FakeSocket implements SocketLike {
  readyState = 1; // OPEN
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  deliver(msg: ServerMsg): void { this.onmessage?.({ data: jsonCodec.encodeServer(msg) }); }
}

interface Rig {
  transport: InstanceType<typeof WSTransport>;
  sock: FakeSocket;
  world: WorldState;
}

// A rig: a server-shaped world + a WSTransport bound to a fake socket (the netcode harness).
async function makeRig(seed: number, mode: WorldMode, pids: string[]): Promise<Rig> {
  const world = createWorld(seed, 1, { isShared: true, skipLocalPlayer: true, mode });
  for (const pid of pids) spawnPlayerInWorld(world, pid);
  world.tick = 5;
  const sock = new FakeSocket();
  let now = 100000;
  const transport = new WSTransport({
    url: "ws://fake",
    getTicket: () => Promise.resolve("dev:test"),
    socketFactory: () => sock,
    now: () => now,
  });
  transport.start();
  await Promise.resolve(); // let the async connect() bind handlers
  sock.onopen?.();
  void now;
  return { transport, sock, world };
}

// The self player id used for the arena rig (buildSnapshot's `pid` = the client's server id).
const SELF = "p1";

// A minimal co-op HudState; each test overrides only what it asserts on. weapons stays empty so
// the arena assertions don't depend on the weapon model (covered by hud.dom.test.ts).
function mkHud(over: Partial<HudState>): HudState {
  return {
    hp: 5, maxHp: 6, floor: 1, kills: 0, coins: 0, mutators: [],
    weapons: [], weaponCap: MAX_OWNED_WEAPONS, swap: null,
    isCleared: true, enemiesLeft: 0, isObjectiveHidden: false, isParty: false,
    isBossActive: false, bossHpFrac: 0, bossName: "",
    coopLabel: null, waitLabel: null, dashFill: 1,
    combo: 0, comboMult: 1, comboColor: "#fff", comboFrac: 0,
    items: [], party: [], ult: null, sig: null, match: null,
    ...over,
  };
}

// The exact match-HUD build game.ts runs: read the authoritative match off the latest snapshot,
// resolve names (YOU for the local id), and derive the presentation block.
function matchHudFromTransport(transport: InstanceType<typeof WSTransport>): HudState["match"] {
  const snap = transport.getLatestSnapshot();
  const match = snap?.match ?? null;
  if (snap === null || match === null) return null;
  return buildMatchHud(match, {
    selfId: transport.getSelfServerId(),
    tick: snap.tick,
    nameOf: (id, isSelf) => (isSelf ? "YOU" : id),
  });
}

async function arenaPipelineTests(): Promise<void> {
  section("an arena snapshot rebuilds the client world in pvp mode (the render-chrome guard)");
  const rig = await makeRig(0x9911, "pvp", ["p1", "p2"]);
  // A live match: p1 (self) 3 frags alive, p2 5 frags DEAD (mid-respawn), 90s left.
  const m = rig.world.match!;
  m.phase = "live";
  m.phaseEndTick = rig.world.tick + 1800; // 90s at the 20Hz step
  m.scores.set("p1", 3);
  m.scores.set("p2", 5);
  rig.world.players.get("p2")!.hp = 0; // dead -> alive flag false on the wire
  rig.sock.deliver(buildSnapshot(rig.world, SELF, 0, [], 0, true, { worldId: "pvp:room:ARENA" }));

  const pw = rig.transport.poll().state;
  // isPvp(this.world) is the ONE predicate renderExit / checkFloorCleared / renderMinimap /
  // renderExitCoordination all early-return on — a true reading here is what suppresses every
  // co-op world-chrome path in the arena.
  check("the client rebuilt the world in pvp mode (isPvp true suppresses co-op chrome)", isPvp(pw) === true, `mode=${pw.mode}`);
  const snap = rig.transport.getLatestSnapshot()!;
  check("the authoritative snapshot carries a match block", snap.match !== null);
  check("the client's self id resolved from the snapshot", rig.transport.getSelfServerId() === SELF, rig.transport.getSelfServerId() ?? "null");

  section("the authoritative match flows into a real Hud as an ARENA");
  settings.setHpDisplay("both");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  const match = matchHudFromTransport(rig.transport);
  check("buildMatchHud produced a match block from the wire", match !== null);
  // Feed the Hud exactly as game.ts.updateHud does: authoritative HP off SelfWire, the derived
  // match block, and (arena) an empty party.
  hud.update(mkHud({ hp: snap.self!.hp, maxHp: snap.self!.mhp, party: [], match }));

  const objective = root.querySelector<HTMLElement>("[data-objective]")!;
  check("the objective lane is the ARENA match readout (90s left, 3 frags)",
    objective.textContent === "ARENA \u00b7 1:30 \u00b7 3 FRAGS", objective.textContent ?? "");
  check("the lane NEVER shows the co-op FLOOR/GO-DOWN banner (the shipped bug)",
    !/FLOOR|GO DOWN|CLEAR/.test(objective.textContent ?? ""));

  const hearts = root.querySelector<HTMLElement>("[data-hearts]")!;
  const hpbar = root.querySelector<HTMLElement>("[data-hpbar]")!;
  check("HP renders as ONE bar (authoritative 100-HP pool)", !hpbar.classList.contains("hidden") && hearts.classList.contains("hidden"));
  check("NO heart sprites render for a 100-HP pool", hearts.childElementCount === 0, `hearts=${hearts.childElementCount}`);

  const board = root.querySelector<HTMLElement>("[data-matchboard]")!;
  const rows = [...board.querySelectorAll(".mb-row")];
  check("the frag scoreboard renders a row per player, id-sorted", rows.length === 2
    && rows[0].querySelector(".mb-name")?.textContent === "YOU"
    && rows[1].querySelector(".mb-name")?.textContent === "p2", rows.map((r) => r.querySelector(".mb-name")?.textContent).join(","));
  check("the local player's row is highlighted, the dead opponent's dimmed",
    rows[0].classList.contains("me") && rows[1].classList.contains("dead"));
  check("the scoreboard shows the authoritative frags", rows[0].querySelector(".mb-frags")?.textContent === "3" && rows[1].querySelector(".mb-frags")?.textContent === "5");
  root.remove();
  rig.transport.stop();
}

async function coopControlTests(): Promise<void> {
  section("control: a co-op snapshot carries NO match block and the Hud stays co-op");
  const rig = await makeRig(0x1111, "coop", ["p1"]);
  rig.sock.deliver(buildSnapshot(rig.world, SELF, 0, [], 0, true, { worldId: "room:COOP" }));
  const pw = rig.transport.poll().state;
  check("the client stays co-op (isPvp false — every co-op chrome path stays live)", isPvp(pw) === false, `mode=${pw.mode}`);
  check("a co-op snapshot has no match block", rig.transport.getLatestSnapshot()?.match == null);

  const root = document.createElement("div");
  document.body.appendChild(root);
  const hud = new Hud(root);
  const match = matchHudFromTransport(rig.transport);
  check("no match block derived in co-op", match === null);
  settings.setHpDisplay("both");
  hud.update(mkHud({ hp: 4, maxHp: 6, floor: 2, isCleared: true, enemiesLeft: 0, match }));
  const objective = root.querySelector<HTMLElement>("[data-objective]")!;
  check("co-op keeps the FLOOR · CLEAR · GO DOWN banner", objective.textContent === "FLOOR 2 \u00b7 CLEAR \u00b7 GO DOWN", objective.textContent ?? "");
  const hearts = root.querySelector<HTMLElement>("[data-hearts]")!;
  const hpbar = root.querySelector<HTMLElement>("[data-hpbar]")!;
  check("co-op renders heart sprites, no HP bar", hearts.querySelectorAll("canvas").length === 6 && hpbar.classList.contains("hidden"));
  check("co-op renders no frag scoreboard", root.querySelector<HTMLElement>("[data-matchboard]")!.classList.contains("hidden"));
  root.remove();
  rig.transport.stop();
}

async function main(): Promise<void> {
  await arenaPipelineTests();
  await coopControlTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll PVP arena end-to-end presentation assertions passed.\n");
}

void main();
