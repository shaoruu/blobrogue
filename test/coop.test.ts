// Dedicated co-op experience suite (post-playtest hardening):
//   1. spectate — pure target selection/cycling + a HEADLESS CLIENT integration that boots
//      the real Game over WSTransport with a scripted socket: camera hand-off on down,
//      cycling, the spec uplink, zeroed gameplay inputs while down, camera return on revive
//   2. the party blessing gate at 2-4 players — every member (downed included) gets and
//      answers its OWN offer; early picks don't descend; disconnect + the 60s sim-clock
//      timeout release the gate; nobody can be damaged while choosing
//   3. the party-scaled weapon economy P1-P4 — per-floor opportunity counts, the floor-2
//      early guarantee (>= P before the first boss), determinism, anti-junk distinctness +
//      melee/ranged mix, prefer-unowned rolls, dealer party stock + buy flow, the boss
//      chest arsenal, placement safety, and preserved scarcity per person
//   4. same-world wire coherence for THIS branch's fields — the pending blessing party +
//      exit readiness ride every snapshot identically for every client; teammates always
//      ride snapshots; revive progress reaches the reviver; spectate-centered interest
//      keeps a downed player's view coherent. (The world-id echo / lobby-to-world
//      readiness infrastructure is the Sev-0 coherence system's — PR #39 — not duplicated
//      here.)
//
// Run: npm run test:coop

import "./harness/domShim.js";
import { domCanvas, domMinimap, domOverlay } from "./harness/domShim.js";

import {
  createWorld, spawnPlayerInWorld, removePlayerFromWorld, loadFloorIntoWorld, devSpawnEnemy,
  stepWorldPhase, chooseBlessingInWorld, acquireWeaponInWorld, playersAtExit,
  claimBossWeaponInWorld, rerollBossWeaponsInWorld, skipBossWeaponInWorld, isPickPaused,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { Bullet, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";
import {
  REVIVE, WEAPON_ECONOMY,
  pedestalWeaponsFor, dealerWeaponStockFor, dealerWeaponPriceFor, bossWeaponChoicesFor,
} from "../src/sim/balance.js";
import { ITEMS } from "../src/sim/items.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import * as C from "../src/sim/constants.js";
import {
  buildSnapshot, jsonCodec, eventScope, type ServerMsg,
} from "../src/net/protocol.js";
import { livingTeammates, resolveSpectateTarget, cycleSpectateTarget } from "../src/game/spectate.js";
import { Game } from "../src/game/game.js";
import { Hud } from "../src/game/hud.js";
import { Minimap } from "../src/game/minimap.js";
import { BlessingOverlay } from "../src/ui/blessing.js";

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

const DT = 1 / 20;

// ---- shared scaffolding ----

// A shared world with `size` players and the floor REBUILT with the party present, so the
// encounter snapshot (encounterPlayers) — and everything the economy keys off it — is real.
function partyWorld(seed: number, floor: number, size: number): { w: WorldState; ps: PlayerSim[] } {
  const w = createWorld(seed, floor, { isShared: true, skipLocalPlayer: true });
  const ps: PlayerSim[] = [];
  for (let i = 0; i < size; i++) ps.push(spawnPlayerInWorld(w, "p" + i));
  loadFloorIntoWorld(w, floor);
  return { w, ps };
}

function partyAtExit(seed: number, size: number): { w: WorldState; ps: PlayerSim[] } {
  const { w, ps } = partyWorld(seed, 1, size);
  w.enemies = [];
  w.pendingSpawns = [];
  const ex = w.dungeon.exit.x * TILE + TILE / 2, ey = w.dungeon.exit.y * TILE + TILE / 2;
  for (const p of ps) { p.x = ex; p.y = ey; }
  return { w, ps };
}

function plantEnemyBullet(w: WorldState, victim: PlayerSim, damage: number): void {
  w.bullets.push({
    x: victim.x, y: victim.y, vx: 0, vy: 0, radius: 6, life: 1, friendly: false,
    owner: null, damage, color: "#f00", pierce: 0, hitList: null, isCrit: false,
  });
}

function plantKillBullet(w: WorldState, owner: string, x: number, y: number, radius: number): Bullet {
  const b: Bullet = {
    x, y, vx: 1, vy: 0, radius, life: 1, friendly: true,
    owner, damage: 100000, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
  return b;
}

// Kill the floor's boss instantly through the real strike path. The anti-burst transition
// floor would otherwise catch a one-shot, so the test marks both phase beats as already
// paid — the arsenal/chest logic under test is downstream of the kill.
function killBoss(w: WorldState, by: string): void {
  const boss = w.enemies.find((e) => e.kind === "boss")!;
  boss.hp = 1;
  boss.boss!.transitionsDone = 2;
  plantKillBullet(w, by, boss.x, boss.y, boss.radius + 6);
  stepWorldPhase(w, DT, []);
}

function chestWeaponCount(w: WorldState): number {
  return w.chests.reduce((n, c) => n + (c.weapons?.length ?? 0), 0);
}

function stockedKinds(w: WorldState): WeaponId[] {
  const out: WeaponId[] = [];
  for (const c of w.chests) if (c.weapons) out.push(...c.weapons);
  return out;
}

const isMelee = (id: WeaponId): boolean => WEAPONS[id].melee !== undefined;

// ---- 1a. spectate target selection (pure) ----

function spectateSelectionTests(): void {
  section("spectate: living ring is stable-ordered; selection keeps/hands off/releases");
  const remotes = [
    { playerId: "p9", isDown: false },
    { playerId: "p2", isDown: true },
    { playerId: "p5", isDown: false },
    { playerId: "p3", isDown: false },
  ];
  check("living ring filters the downed and sorts by id",
    livingTeammates(remotes).map((r) => r.playerId).join(",") === "p3,p5,p9");
  check("no current target acquires the ring's first", resolveSpectateTarget(null, remotes) === "p3");
  check("a living current target is KEPT (no drift while watching)", resolveSpectateTarget("p5", remotes) === "p5");
  check("a downed current target hands off to the first living", resolveSpectateTarget("p2", remotes) === "p3");
  check("a departed current target hands off too", resolveSpectateTarget("gone", remotes) === "p3");
  check("nobody living -> null (the run is ending)", resolveSpectateTarget("p3", [{ playerId: "p1", isDown: true }]) === null);

  section("spectate: cycling walks the living ring both ways and wraps");
  check("cycle +1 advances", cycleSpectateTarget("p3", remotes, 1) === "p5");
  check("cycle +1 wraps at the end", cycleSpectateTarget("p9", remotes, 1) === "p3");
  check("cycle -1 goes back", cycleSpectateTarget("p5", remotes, -1) === "p3");
  check("cycle -1 wraps at the start", cycleSpectateTarget("p3", remotes, -1) === "p9");
  check("cycling from a stale target lands on the ring's first", cycleSpectateTarget("p2", remotes, 1) === "p3");
  check("cycling with nobody living -> null", cycleSpectateTarget("p3", [], 1) === null);

  section("spectate: a RECONNECTING teammate (coherence-system roster status) is neither dead nor gone");
  // isAbsent is PR #39's reconnect-grace roster bit; this module consumes it the moment it
  // rides RemotePlayer. A ghost is skippable while anyone present plays; it becomes the
  // last-resort watch target when the whole party is mid-outage (no wipe fires in grace).
  const withGhost = [
    { playerId: "p9", isDown: false },
    { playerId: "p5", isDown: false, isAbsent: true },
    { playerId: "p3", isDown: false },
  ];
  check("the ring prefers PRESENT living teammates (ghost excluded)",
    livingTeammates(withGhost).map((r) => r.playerId).join(",") === "p3,p9");
  check("a watched teammate dropping into the grace hands the camera off", resolveSpectateTarget("p5", withGhost) === "p3");
  check("cycling skips the reconnecting ghost", cycleSpectateTarget("p3", withGhost, 1) === "p9" && cycleSpectateTarget("p9", withGhost, 1) === "p3");
  const allGhosts = [
    { playerId: "p9", isDown: false, isAbsent: true },
    { playerId: "p3", isDown: false, isAbsent: true },
    { playerId: "p2", isDown: true },
  ];
  check("everyone mid-outage: the ghosts become the watchable ring (never a dead screen)",
    resolveSpectateTarget(null, allGhosts) === "p3" && cycleSpectateTarget("p3", allGhosts, 1) === "p9");
  check("a downed reconnecting body is still never a target",
    resolveSpectateTarget(null, [{ playerId: "p1", isDown: true, isAbsent: true }]) === null);
}

// ---- 1b. spectate + revive + mismatch: the REAL client, headless ----

// A scripted server-side socket standing in for the browser WebSocket: the test builds
// authoritative snapshots from a server-shaped world and delivers them to the real Game.
class ScriptedSocket {
  static latest: ScriptedSocket | null = null;
  readyState = 1;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { ScriptedSocket.latest = this; }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  deliver(msg: ServerMsg): void { this.onmessage?.({ data: jsonCodec.encodeServer(msg) }); }
  sentOfType(t: string): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((m) => m.t === t);
  }
}

const noop = () => {};
for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"] as const) {
  (Hud.prototype as any)[m] = noop;
}
(Minimap.prototype as any).render = noop;
(BlessingOverlay.prototype as any).show = noop;
(globalThis as any).WebSocket = ScriptedSocket;

async function headlessClientSpectateTests(): Promise<void> {
  section("headless client: down hands the camera to a teammate; revive returns it (real Game + WSTransport)");

  // The authoritative world: self (s0) + two living teammates, far apart so camera motion
  // is unambiguous.
  const world = createWorld(0x5EC7A7E, 1, { isShared: true, skipLocalPlayer: true });
  const self = spawnPlayerInWorld(world, "s0");
  const mateA = spawnPlayerInWorld(world, "s1");
  const mateB = spawnPlayerInWorld(world, "s2");
  mateA.x = self.x + 500; mateA.y = self.y + 60;
  mateB.x = self.x - 380; mateB.y = self.y + 220;

  let exits = 0;
  const game: any = new Game(domCanvas as any, domMinimap as any, domOverlay as any, noop, () => { exits++; });
  game.start({
    mode: "online",
    online: { url: "ws://scripted", getTicket: () => Promise.resolve("dev:test"), roomCode: "ABCD" },
    profile: null,
    selfColorIndex: 1,
  });
  // Let the async connect() bind the scripted socket, then open it.
  await new Promise((r) => setTimeout(r, 0));
  const sock = ScriptedSocket.latest!;
  sock.onopen?.();
  check("client sent the versioned join", sock.sentOfType("join").length === 1);

  const deliverSnap = (full = false): void => {
    world.tick++;
    sock.deliver(buildSnapshot(world, "s0", 0, [], 0, full, {}));
  };
  deliverSnap(true);
  for (let i = 0; i < 3; i++) game.tick(1 / 60);
  check("world revealed from the authoritative snapshot", game.isWorldRevealed === true);
  check("alive: no spectate target", game.spectateId === null);

  // Interact intent rides the input stream while alive (context-gated controller path).
  game.input.keyDown("e");
  const heldInput: InputCmd = game.buildInput();
  check("held E maps to the interact input bit", heldInput.interact === true && heldInput.firing === false);
  game.input.keyUp("e");

  // Down the local player authoritatively.
  self.isDown = true; self.hp = 0;
  deliverSnap();
  for (let i = 0; i < 3; i++) game.tick(1 / 60);
  check("down flips the input context to spectate", game.input.context === "spectate", `ctx=${game.input.context}`);
  check("down acquires the first living teammate (stable order)", game.spectateId === "s1", `target=${game.spectateId}`);
  check("the spec uplink named the target", sock.sentOfType("spec").some((m) => m.target === "s1"));

  // Gameplay inputs are zeroed at the source while down (the spectate context samples idle).
  game.input.keyDown("w"); game.input.keyDown("d"); game.input.mouseDown(0);
  const downInput: InputCmd = game.buildInput();
  check("downed input carries no movement/fire/dash/interact",
    downInput.moveX === 0 && downInput.moveY === 0 && !downInput.firing && !downInput.dash && downInput.interact !== true);
  game.input.releaseAll();

  // The camera eases toward the watched teammate.
  for (let i = 0; i < 90; i++) game.tick(1 / 60);
  const wantX = mateA.x - (domCanvas as any).width / 2;
  check("camera focus reached the spectated teammate", Math.abs(game.cam.x - wantX) < 24, `cam.x=${game.cam.x.toFixed(0)} want=${wantX.toFixed(0)}`);

  // Cycling: the E key lands on cycleSpectate through the context-gated controller (the
  // same action Q/arrows/wheel — and a controller's bumpers — dispatch).
  game.input.keyDown("e");
  game.input.keyUp("e");
  for (let i = 0; i < 2; i++) game.tick(1 / 60);
  check("cycle advanced to the next living teammate", game.spectateId === "s2", `target=${game.spectateId}`);
  check("the new target rode the spec uplink", sock.sentOfType("spec").some((m) => m.target === "s2"));

  // The watched teammate goes down: the camera hands off to whoever still lives.
  mateB.isDown = true; mateB.hp = 0;
  deliverSnap();
  for (let i = 0; i < 2; i++) game.tick(1 / 60);
  check("watched teammate going down hands the camera off", game.spectateId === "s1", `target=${game.spectateId}`);

  // Revive: the camera comes home and gameplay inputs return.
  self.isDown = false; self.hp = REVIVE.hp;
  deliverSnap();
  for (let i = 0; i < 2; i++) game.tick(1 / 60);
  check("revive releases the spectate target", game.spectateId === null);
  check("revive returns the input context to gameplay", game.input.context === "gameplay", `ctx=${game.input.context}`);
  game.input.keyDown("d");
  check("movement input returns after the revive", (game.buildInput() as InputCmd).moveX === 1);
  game.input.releaseAll();
  for (let i = 0; i < 120; i++) game.tick(1 / 60);
  check("camera returned to the local player", Math.abs(game.cam.x - (self.x - (domCanvas as any).width / 2)) < 24, `cam.x=${game.cam.x.toFixed(0)}`);

  // The party blessing readout reads from the authoritative pending set.
  world.pendingBlessings.set("s1", 30);
  deliverSnap();
  game.tick(1 / 60);
  const wait: string | null = game.blessingWaitLabel();
  check("WAITING readout names the still-picking teammate", wait !== null && wait.includes("WAITING FOR 1/3 PLAYER"), wait ?? "null");
  world.pendingBlessings.clear();

  // Exit coordination readout: authoritative exr drives both perspectives of the label.
  world.enemies = [];
  world.pendingSpawns = [];
  const exitX = world.dungeon.exit.x * 48 + 24, exitY = world.dungeon.exit.y * 48 + 24;
  mateA.x = exitX; mateA.y = exitY; // the living teammate stages on the stairs; self is away
  deliverSnap();
  game.tick(1 / 60);
  const stragglerLabel: string | null = game.exitWaitLabel();
  check("straggler reads STAND ON THE STAIRS with the staged count",
    stragglerLabel !== null && stragglerLabel.includes("WAITING AT EXIT \u00b7 1/2") && stragglerLabel.includes("STAND ON THE STAIRS"),
    stragglerLabel ?? "null");
  self.x = exitX; self.y = exitY;
  mateA.x = exitX - 400; mateA.y = exitY;
  deliverSnap();
  game.tick(1 / 60);
  const stagedLabel: string | null = game.exitWaitLabel();
  check("staged player reads WAITING FOR the missing teammate",
    stagedLabel !== null && stagedLabel.includes("WAITING AT EXIT \u00b7 1/2") && stagedLabel.includes("WAITING FOR"),
    stagedLabel ?? "null");
  mateA.x = exitX; mateA.y = exitY;
  deliverSnap();
  game.tick(1 / 60);
  check("a satisfied gate clears the exit readout (the blessing gate takes over)", game.exitWaitLabel() === null);

  check("no exit fired during the whole down/spectate/revive/exit pass", exits === 0);
  game.stop();
}

// ---- 2. the party blessing gate at 2-4 players ----

function blessingGateTests(): void {
  for (const size of [2, 3, 4]) {
    section(`blessing gate (P${size}): every member offered; early picks hold; the last pick descends`);
    const { w, ps } = partyAtExit(0xB1E50 + size, size);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, DT, ev);
    const offers = ev.filter((e) => e.t === "offerBlessing");
    check(`all ${size} members got their own offer`, offers.length === size
      && new Set(offers.map((o) => (o as { pid: string }).pid)).size === size, `offers=${offers.length}`);
    check("pending set tracks the whole party", w.pendingBlessings.size === size);

    // Nobody can be damaged while choosing — a stray glob crosses every chooser.
    for (const p of ps) { p.invuln = 0; plantEnemyBullet(w, p, 3); }
    stepWorldPhase(w, DT, []);
    check("no damage lands on ANY player mid-pick", ps.every((p) => p.hp === p.maxHp));

    // Members pick one at a time; the descend waits for the very last.
    for (let i = 0; i < size - 1; i++) {
      chooseBlessingInWorld(w, ps[i].id, ITEMS[i % ITEMS.length]);
      stepWorldPhase(w, DT, []);
      check(`descend still held after ${i + 1}/${size} picked`, w.floor === 1, `floor=${w.floor}`);
    }
    chooseBlessingInWorld(w, ps[size - 1].id, ITEMS[0]);
    stepWorldPhase(w, DT, []);
    check("descend fires once the LAST pick resolves", w.floor === 2, `floor=${w.floor}`);
  }

  section("blessing gate: a DOWNED member gets an offer, picks it, and rides the descend rescue");
  {
    const { w, ps } = partyAtExit(0xB1E60, 3);
    const downed = ps[2];
    downed.x -= TILE; // down, one tile off the exit (the gate only needs the LIVING there)
    downed.invuln = 0; downed.hp = 1;
    plantEnemyBullet(w, downed, 5);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, DT, ev); // downs the member AND raises the exit-gate offers this tick
    check("member downed at the gate", downed.isDown);
    const offers = ev.filter((e) => e.t === "offerBlessing").map((e) => (e as { pid: string }).pid);
    check("the downed member is offered like everyone else", offers.length === 3 && offers.includes(downed.id), offers.join(","));
    chooseBlessingInWorld(w, ps[0].id, ITEMS[0]);
    chooseBlessingInWorld(w, ps[1].id, ITEMS[1]);
    stepWorldPhase(w, DT, []);
    check("descend waits for the downed member's pick too", w.floor === 1, `floor=${w.floor}`);
    chooseBlessingInWorld(w, downed.id, ITEMS[2]);
    stepWorldPhase(w, DT, []);
    check("downed member's pick releases the gate", w.floor === 2, `floor=${w.floor}`);
    check("the descend rescued them at the revive HP", !downed.isDown && downed.hp === REVIVE.hp, `hp=${downed.hp}`);
    check("their pick actually applied", downed.ownedItemIds.length === 1);
  }

  section("blessing gate: a mid-pick DISCONNECT releases the gate for the rest");
  {
    const { w, ps } = partyAtExit(0xB1E61, 4);
    stepWorldPhase(w, DT, []);
    check("four offers pending", w.pendingBlessings.size === 4);
    chooseBlessingInWorld(w, ps[0].id, ITEMS[0]);
    chooseBlessingInWorld(w, ps[1].id, ITEMS[1]);
    removePlayerFromWorld(w, ps[2].id); // rage-quit mid-pick
    stepWorldPhase(w, DT, []);
    check("gate still held by the remaining unanswered pick", w.floor === 1);
    chooseBlessingInWorld(w, ps[3].id, ITEMS[2]);
    stepWorldPhase(w, DT, []);
    check("disconnect + final pick released the descend", w.floor === 2, `floor=${w.floor}`);
  }

  section("blessing gate: the 60s sim-clock timeout releases an AFK member's hold");
  {
    const { w, ps } = partyAtExit(0xB1E62, 3);
    stepWorldPhase(w, DT, []);
    chooseBlessingInWorld(w, ps[0].id, ITEMS[0]);
    chooseBlessingInWorld(w, ps[1].id, ITEMS[1]);
    let ticks = 0;
    const maxTicks = Math.ceil(C.BLESSING_OFFER_TTL / DT) + 4;
    while (w.floor === 1 && ticks < maxTicks) { stepWorldPhase(w, DT, []); ticks++; }
    check("the unanswered offer expired and the party descended", w.floor === 2, `after ${(ticks * DT).toFixed(1)}s`);
    check("the AFK member got nothing from the lapsed offer", ps[2].ownedItemIds.length === 0);
    check("timeout matches the 60s contract", C.BLESSING_OFFER_TTL === 60);
  }
}

// ---- 2b. party exit readiness (the descend gate's own predicate, on the wire) ----

function exitReadinessTests(): void {
  const exitOf = (w: WorldState) => ({ ex: w.dungeon.exit.x * TILE + TILE / 2, ey: w.dungeon.exit.y * TILE + TILE / 2 });

  for (const size of [2, 3, 4]) {
    section(`exit readiness (P${size}): exr counts stage-ins exactly; no descend until everyone`);
    const { w, ps } = partyWorld(0xE817 + size, 1, size);
    const { ex, ey } = exitOf(w);
    // The exit is unusable while enemies remain: nobody reads as staged even ON the tile.
    for (const p of ps) { p.x = ex; p.y = ey; }
    check("uncleared floor stages nobody", playersAtExit(w).length === 0);
    w.enemies = [];
    w.pendingSpawns = [];
    // Stage members one at a time; the count and the gate must track exactly.
    for (const p of ps) { p.x = ex - 300; p.y = ey; }
    for (let i = 0; i < size; i++) {
      ps[i].x = ex; ps[i].y = ey;
      const staged = playersAtExit(w);
      check(`staged ${i + 1}/${size} reads exactly that`, staged.length === i + 1 && staged.includes(ps[i].id), staged.join(","));
      if (i < size - 1) {
        stepWorldPhase(w, DT, []);
        check(`no offers/descend at ${i + 1}/${size}`, w.floor === 1 && w.pendingBlessings.size === 0, `floor=${w.floor}`);
      }
    }
    // Everyone staged: the gate raises the offers, then the picks release the descend.
    const ev: SimEvent[] = [];
    stepWorldPhase(w, DT, ev);
    check("all-at-exit raises every member's offer", ev.filter((e) => e.t === "offerBlessing").length === size);
    const snapA = buildSnapshot(w, ps[0].id, 0, [], 0, false, {});
    const snapB = buildSnapshot(w, ps[size - 1].id, 0, [], 0, false, {});
    check("exr rides both wires identically (and matches pnd's party)",
      snapA.t === "snap" && snapB.t === "snap"
      && snapA.exr.slice().sort().join(",") === snapB.exr.slice().sort().join(",")
      && snapA.exr.length === size && snapA.pnd.length === size);
    for (let i = 0; i < size; i++) chooseBlessingInWorld(w, ps[i].id, ITEMS[i % ITEMS.length]);
    stepWorldPhase(w, DT, []);
    check("picks resolved -> the party descends", w.floor === 2, `floor=${w.floor}`);
  }

  section("exit readiness: a member LEAVING releases the gate for the rest");
  {
    const { w, ps } = partyWorld(0xE830, 1, 3);
    const { ex, ey } = exitOf(w);
    w.enemies = []; w.pendingSpawns = [];
    ps[0].x = ex; ps[0].y = ey;
    ps[1].x = ex; ps[1].y = ey;
    ps[2].x = ex - 300; ps[2].y = ey; // never shows up
    stepWorldPhase(w, DT, []);
    check("gate held while the straggler is connected", w.floor === 1 && w.pendingBlessings.size === 0);
    removePlayerFromWorld(w, ps[2].id); // rage-quit / disconnect
    const ev: SimEvent[] = [];
    stepWorldPhase(w, DT, ev);
    check("the departure re-scopes the gate to the remaining party",
      ev.filter((e) => e.t === "offerBlessing").length === 2 && playersAtExit(w).length === 2);
    chooseBlessingInWorld(w, ps[0].id, ITEMS[0]);
    chooseBlessingInWorld(w, ps[1].id, ITEMS[1]);
    stepWorldPhase(w, DT, []);
    check("the remaining pair descends", w.floor === 2, `floor=${w.floor}`);
  }

  section("exit readiness: a DOWNED member is neither required nor listed — and rides the rescue");
  {
    const { w, ps } = partyWorld(0xE831, 1, 3);
    const { ex, ey } = exitOf(w);
    w.enemies = []; w.pendingSpawns = [];
    const downed = ps[2];
    downed.x = ex; downed.y = ey; // down ON the stairs — still never listed as staged
    downed.invuln = 0; downed.hp = 1;
    plantEnemyBullet(w, downed, 5);
    stepWorldPhase(w, DT, []);
    check("member downed on the exit tile", downed.isDown);
    check("a downed body is not exit-ready even on the stairs", !playersAtExit(w).includes(downed.id));
    ps[0].x = ex; ps[0].y = ey;
    ps[1].x = ex; ps[1].y = ey;
    const ev: SimEvent[] = [];
    stepWorldPhase(w, DT, ev);
    check("the LIVING pair satisfies the gate; every member (downed too) gets the offer",
      ev.filter((e) => e.t === "offerBlessing").length === 3);
    for (let i = 0; i < 3; i++) chooseBlessingInWorld(w, ps[i].id, ITEMS[i]);
    stepWorldPhase(w, DT, []);
    check("descend fires and rescues the downed member at the revive HP",
      w.floor === 2 && !downed.isDown && downed.hp === REVIVE.hp, `floor=${w.floor} hp=${downed.hp}`);
  }
}

// ---- 3. the party weapon economy P1-P4 (studio balance gate §4, tested per §7.6) ----

function weaponEconomyTests(): void {
  const seeds = [0xF100D, 0x1234, 0xBEEF, 0xC0FFE];
  // The §7.6 sweep, scaled for CI: the gate's opportunity formulas hold EXACTLY on every
  // (seed, floor, P) cell — a wide deterministic net rather than a statistical claim.
  const gateSeeds = [...seeds, 0x51ab, 0x9e3d, 0x77aa01, 0x00d1ce, 0xfeed5, 0xabc123, 0x31415, 0x27182];

  section("economy: pedestal counts stay the solo cadence; each pedestal holds exactly max(1, ceil(P/2))");
  {
    let cadenceBreaks = 0, contentBreaks = 0, cells = 0;
    for (const seed of gateSeeds) {
      for (let floor = 2; floor <= 6; floor++) {
        if (floor === 5) continue; // boss floor: the reward is the claim set, not pedestals
        const soloPedestals = partyWorld(seed, floor, 1).w.chests.filter((c) => c.weapons !== undefined).length;
        for (const size of [1, 2, 3, 4]) {
          cells++;
          const pedestals = partyWorld(seed, floor, size).w.chests.filter((c) => c.weapons !== undefined);
          if (pedestals.length !== soloPedestals) cadenceBreaks++;
          if (!pedestals.every((c) => c.weapons!.length === pedestalWeaponsFor(size))) contentBreaks++;
        }
      }
    }
    check("pedestal COUNT identical to solo on every cell (party scales contents, not chests)",
      cells >= 100 && cadenceBreaks === 0, `cells=${cells} breaks=${cadenceBreaks}`);
    check("every pedestal holds exactly ceil(P/2) weapons (P1-2: 1, P3-4: 2)",
      contentBreaks === 0, `breaks=${contentBreaks}`);
  }

  section("economy: every non-boss floor from 2 up offers a weapon opportunity (nobody starves)");
  {
    let dryFloors = 0;
    for (const seed of gateSeeds) {
      for (let floor = 2; floor <= 8; floor++) {
        if (floor === 5) continue;
        const { w } = partyWorld(seed, floor, 4);
        const hasPedestal = w.chests.some((c) => c.weapons !== undefined);
        const hasDealer = w.pickups.some((p) => p.kind === "dealer_weapon");
        if (!hasPedestal && !hasDealer) dryFloors++;
      }
    }
    check("no dry non-boss floor anywhere in the sweep (gate: never >2 consecutive)", dryFloors === 0, `dry=${dryFloors}`);
  }

  section("economy: the starvation guard force-stocks after 2 consecutive dry floors");
  {
    // Floor 1 stocks nothing by cadence — repeated floor-1 rebuilds walk the drought
    // counter up; at 2 the guard forces a pedestal even where the cadence says none.
    const w = createWorld(0xD10, 1, { isShared: true, skipLocalPlayer: true });
    spawnPlayerInWorld(w, "p0");
    spawnPlayerInWorld(w, "p1");
    check("floor 1 stocks no pedestal (cadence) and counts drought 1", chestWeaponCount(w) === 0 && w.weaponDrought === 1);
    loadFloorIntoWorld(w, 1);
    check("second dry floor counts drought 2", chestWeaponCount(w) === 0 && w.weaponDrought === 2);
    loadFloorIntoWorld(w, 1);
    check("the third floor is FORCE-stocked and the drought resets",
      chestWeaponCount(w) >= 1 && w.weaponDrought === 0, `stock=${chestWeaponCount(w)}`);
  }

  section("economy: identical (seed, floor, P) builds an identical arsenal (no per-client divergence)");
  {
    const build = (size: number): string => {
      const { w } = partyWorld(0xF100D, 3, size);
      return JSON.stringify({
        chests: w.chests.map((c) => [c.x, c.y, ...(c.weapons ?? [])]),
        dealer: w.pickups.filter((p) => p.kind === "dealer_weapon").map((p) => [p.x, p.y, p.weapon, p.value]),
      });
    };
    for (const size of [1, 2, 4]) {
      check(`P${size} rebuild is byte-identical`, build(size) === build(size));
    }
  }

  section("economy: party floors never stock duplicate junk, and big sets mix melee + ranged");
  {
    let dupes = 0, badMix = 0, setsChecked = 0;
    for (const seed of seeds) {
      for (let floor = 2; floor <= 6; floor++) {
        for (const size of [2, 3, 4]) {
          const kinds = stockedKinds(partyWorld(seed, floor, size).w);
          if (kinds.length < 2) continue;
          setsChecked++;
          if (new Set(kinds).size !== kinds.length) dupes++;
          if (kinds.every(isMelee)) badMix++;
          if (kinds.length >= 3 && !kinds.some(isMelee)) badMix++;
        }
      }
    }
    check("no duplicate kinds within any party floor's stock", setsChecked >= 30 && dupes === 0, `sets=${setsChecked} dupes=${dupes}`);
    check("no all-melee pairs and no melee-free 3+ sets", badMix === 0, `badMix=${badMix}`);
  }

  section("economy: weapon chests land on open floor, off props, never stacked (safe placement)");
  {
    let placed = 0, onWall = 0, onProp = 0, stackedTiles = 0;
    for (const seed of seeds) {
      for (let floor = 2; floor <= 6; floor++) {
        const { w } = partyWorld(seed, floor, 4);
        const tiles = new Set<number>();
        for (const c of w.chests) {
          placed++;
          const tx = Math.floor(c.x / TILE), ty = Math.floor(c.y / TILE);
          if (w.dungeon.tiles[ty * w.dungeon.w + tx] !== 0) onWall++;
          const key = ty * w.dungeon.w + tx;
          if (tiles.has(key)) stackedTiles++;
          tiles.add(key);
          for (const p of w.props) {
            if (!p.dead && Math.hypot(c.x - p.x, c.y - p.y) < c.radius + p.radius) onProp++;
          }
        }
      }
    }
    check("every P4 chest sits on an open floor tile", placed >= 30 && onWall === 0, `placed=${placed} onWall=${onWall}`);
    check("no chest overlaps a live prop", onProp === 0, `onProp=${onProp}`);
    check("no two chests share a tile", stackedTiles === 0, `stacked=${stackedTiles}`);
  }

  section("economy: every party-stocked pedestal is openable and its FULL contents collectible");
  {
    let opened = 0, stockedCount = 0, uncollected = 0;
    for (const seed of seeds) {
      const { w, ps } = partyWorld(seed, 3, 4);
      const a = ps[0];
      w.enemies = [];
      w.pendingSpawns = [];
      for (const chest of w.chests.filter((c) => c.weapons !== undefined)) {
        const contents = chest.weapons!.slice();
        stockedCount += contents.length;
        a.x = chest.x + 1; a.y = chest.y;
        stepWorldPhase(w, DT, []);
        if (!chest.opened) continue;
        opened++;
        // Walk to every ejected weapon (a P3-4 pedestal spills two).
        for (const id of contents) {
          const drop = w.pickups.find((pk) => pk.kind === "weapon" && pk.weapon === id);
          if (drop) {
            a.x = drop.x; a.y = drop.y;
            stepWorldPhase(w, DT, []);
          }
          if (!a.ownedWeapons.includes(id)) uncollected++;
        }
      }
    }
    check("every stocked pedestal opened and its whole contents collected",
      opened >= 4 && stockedCount >= 8 && uncollected === 0,
      `opened=${opened} stocked=${stockedCount} uncollected=${uncollected}`);
  }

  section("economy: the Dealer stocks max(2,P) distinct stalls at 12/18/24 — purchases PERSONAL");
  {
    for (const size of [1, 2, 3, 4]) {
      const { w } = partyWorld(0xDEA1, 3, size);
      const stock = w.pickups.filter((p) => p.kind === "dealer_weapon");
      const hearts = w.pickups.filter((p) => p.kind === "dealer_heart");
      check(`P${size}: dealer stocks ${dealerWeaponStockFor(size)} stall(s) + ${size} heart(s)`,
        stock.length === dealerWeaponStockFor(size) && hearts.length === size,
        `weapons=${stock.length} hearts=${hearts.length}`);
      check(`P${size}: stall kinds distinct, slot prices 12/18/24`,
        new Set(stock.map((s) => s.weapon)).size === stock.length
        && stock.every((s, i) => s.value === dealerWeaponPriceFor(i)),
        stock.map((s) => `${s.weapon}@${s.value}`).join(","));
      for (const s of stock) {
        const tx = Math.floor(s.x / TILE), ty = Math.floor(s.y / TILE);
        check(`P${size}: stall on open floor`, w.dungeon.tiles[ty * w.dungeon.w + tx] === 0);
      }
    }
    // Personal-purchase flow on a P2 world: broke walks past; a buyer pays and the stall
    // STAYS; the buyer can't rebuy (owns it); a teammate buys the SAME stall.
    const { w, ps } = partyWorld(0xDEA1, 3, 2);
    w.enemies = []; w.pendingSpawns = [];
    const stall = w.pickups.find((p) => p.kind === "dealer_weapon")!;
    const merch = stall.weapon!;
    const price = stall.value!;
    const [a, b] = ps;
    a.coins = 0;
    a.x = stall.x; a.y = stall.y;
    stepWorldPhase(w, DT, []);
    check("broke player walks past the stall", w.pickups.includes(stall) && !a.ownedWeapons.includes(merch));
    a.coins = price;
    stepWorldPhase(w, DT, []);
    check("a funded buyer pays the slot price and the stall STAYS (personal purchase)",
      w.pickups.includes(stall) && a.ownedWeapons.includes(merch) && a.coins === 0,
      `owned=${a.ownedWeapons.join(",")} coins=${a.coins}`);
    // Exactly the first stall's price: a rebuy would spend it, and the pricier neighbor
    // stall (18) stays out of reach — so unchanged coins prove the ownership block.
    a.coins = price;
    stepWorldPhase(w, DT, []);
    check("an owner never rebuys their own stall", a.coins === price, `coins=${a.coins}`);
    b.coins = price;
    b.x = stall.x; b.y = stall.y;
    stepWorldPhase(w, DT, []);
    check("a teammate buys the SAME stall (no depletion race)",
      w.pickups.includes(stall) && b.ownedWeapons.includes(merch) && b.coins === 0);
  }

  section("economy: the boss reward is min(P+1,5) CHOICES, claimed personally (gate §4)");
  {
    for (const size of [1, 2, 3, 4]) {
      const { w, ps } = partyWorld(0xB055, 5, size);
      killBoss(w, ps[0].id);
      const chest = w.chests.find((c) => c.kind === "boss")!;
      check(`P${size}: the boss chest bakes NO floor weapons (the reward is the claim set)`, chest.weapons === undefined);
      // Open from afar (a planted bullet) so the spill stays on the floor to count.
      const opener = ps[0];
      opener.x = chest.x + 400; opener.y = chest.y + 300;
      plantKillBullet(w, opener.id, chest.x, chest.y, 6);
      const ev: SimEvent[] = [];
      stepWorldPhase(w, DT, ev);
      check(`P${size}: opening ejected the tuned heart + 5 coins (no weapon spill)`,
        chest.opened
        && w.pickups.filter((p) => p.kind === "weapon").length === 0
        && w.pickups.filter((p) => p.kind === "heart").length === 1
        && w.pickups.filter((p) => p.kind === "coin").length === 5);
      const rare = ev.filter((e) => e.t === "offerBlessing");
      check(`P${size}: every member got the Rare pick from the boss chest`,
        rare.length === size && rare.every((o) => o.t === "offerBlessing" && o.rare)
        && new Set(rare.map((o) => (o as { pid: string }).pid)).size === size,
        `offers=${rare.length}`);
      const want = bossWeaponChoicesFor(size);
      const claims = w.weaponClaims!;
      const wofferEv = ev.filter((e) => e.t === "offerWeapons");
      check(`P${size}: every member holds a personal claim over ${want} distinct choices`,
        claims.pending.size === size && wofferEv.length === size
        && claims.choices.length === want && new Set(claims.choices).size === want,
        claims.choices.join(","));
      if (want >= 3) check(`P${size}: the choice set mixes melee + ranged`, claims.choices.some(isMelee) && !claims.choices.every(isMelee));
    }
  }

  section("economy: claims grant personally, never deplete, reject dupes, reroll exactly once");
  {
    const { w, ps } = partyWorld(0xC1A1, 5, 3);
    killBoss(w, ps[0].id);
    const chest = w.chests.find((c) => c.kind === "boss")!;
    ps[0].x = chest.x + 1; ps[0].y = chest.y;
    stepWorldPhase(w, DT, []);
    const claims = w.weaponClaims!;
    const base = claims.choices.slice();
    check("a claim inside the view grants the weapon personally",
      claimBossWeaponInWorld(w, ps[0].id, base[0]) && ps[0].ownedWeapons.includes(base[0]));
    check("teammates keep the FULL choice set after a claim (no depletion)",
      claims.pending.get(ps[1].id)!.view.join(",") === base.join(","));
    check("claiming twice rejects (one personal claim each)", !claimBossWeaponInWorld(w, ps[0].id, base[1]));
    check("a choice outside the view rejects",
      !claimBossWeaponInWorld(w, ps[1].id, PICKUP_WEAPONS.find((id) => !base.includes(id))!));
    acquireWeaponInWorld(w, ps[1].id, base[1]);
    check("an owned duplicate rejects (dupes route to the reroll, never coins)",
      !claimBossWeaponInWorld(w, ps[1].id, base[1]));
    const rerolled = rerollBossWeaponsInWorld(w, ps[1].id)!;
    check("the reroll is a fresh personal view of the same size, off the base set",
      rerolled.length === base.length && rerolled.every((id) => !base.includes(id)),
      rerolled.join(","));
    check("the reroll is personal — a teammate's view is still the base set",
      w.weaponClaims!.pending.get(ps[2].id)!.view.join(",") === base.join(","));
    check("a second reroll rejects (exactly one)", rerollBossWeaponsInWorld(w, ps[1].id) === null);
    check("claiming from the rerolled view grants", claimBossWeaponInWorld(w, ps[1].id, rerolled[0]));
    check("mid-claim members are pick-paused and shielded", isPickPaused(w, ps[2].id));
    skipBossWeaponInWorld(w, ps[2].id);
    check("a skip resolves the last claim and releases the state", w.weaponClaims === null);
    check("the boss chest's blessing pick still pauses independently of the claim",
      isPickPaused(w, ps[2].id) && w.pendingBlessings.has(ps[2].id));
  }

  section("economy: an unanswered claim expires on the sim clock; a disconnect releases immediately");
  {
    const { w, ps } = partyWorld(0xC1A2, 5, 2);
    killBoss(w, ps[0].id);
    const chest = w.chests.find((c) => c.kind === "boss")!;
    ps[0].x = chest.x + 1; ps[0].y = chest.y;
    stepWorldPhase(w, DT, []);
    check("both claims open", w.weaponClaims!.pending.size === 2);
    removePlayerFromWorld(w, ps[1].id);
    check("a disconnect resolves that member's claim", w.weaponClaims!.pending.size === 1);
    const ticks = Math.ceil(WEAPON_ECONOMY.claimTtl / DT) + 2;
    for (let t = 0; t < ticks; t++) stepWorldPhase(w, DT, []);
    check("the AFK claim expired on the sim clock (the descend gate always drains)", w.weaponClaims === null);
  }

  section("economy: reroll views are deterministic per (seed, floor, player)");
  {
    const build = (): string => {
      const { w, ps } = partyWorld(0xC1A3, 5, 2);
      killBoss(w, ps[0].id);
      const chest = w.chests.find((c) => c.kind === "boss")!;
      ps[0].x = chest.x + 1; ps[0].y = chest.y;
      stepWorldPhase(w, DT, []);
      return (rerollBossWeaponsInWorld(w, ps[0].id) ?? []).join(",");
    };
    check("identical reroll on a rebuilt world", build() === build() && build().length > 0, build());
  }

  section("economy: rolls prefer weapons NOBODY owns; family coverage tracks what's equipped");
  {
    const { w, ps } = partyWorld(0x0A11, 5, 2);
    // The party owns 12 of the 15 pickup kinds — three remain fresh.
    const fresh: WeaponId[] = ["flamer", "spear", "sword"];
    for (const p of ps) for (const id of PICKUP_WEAPONS) if (!fresh.includes(id)) acquireWeaponInWorld(w, p.id, id);
    killBoss(w, ps[0].id);
    const chest = w.chests.find((c) => c.kind === "boss")!;
    ps[0].x = chest.x + 1; ps[0].y = chest.y;
    stepWorldPhase(w, DT, []);
    const choices = w.weaponClaims!.choices;
    check("the P2 choice set is drawn from the unowned kinds",
      choices.length === 3 && choices.every((id) => fresh.includes(id)), choices.join(","));
    // Family coverage: a party wielding ONLY melee still sees a ranged option (and vice
    // versa there's ≥1 melee-compatible pick when someone holds melee).
    const { w: w2, ps: ps2 } = partyWorld(0x0A12, 5, 2);
    for (const p of ps2) { acquireWeaponInWorld(w2, p.id, "sword"); p.weapon = "sword"; }
    killBoss(w2, ps2[0].id);
    const chest2 = w2.chests.find((c) => c.kind === "boss")!;
    ps2[0].x = chest2.x + 1; ps2[0].y = chest2.y;
    stepWorldPhase(w2, DT, []);
    const set2 = w2.weaponClaims!.choices;
    check("an all-melee party's set still carries >=1 melee-compatible AND >=1 ranged pick",
      set2.some(isMelee) && set2.some((id) => !isMelee(id)), set2.join(","));
  }

  section("economy: solo-local keeps the tuned baseline (no dealer stalls, no boss claims)");
  {
    const w = createWorld(0xB055, 5, {});
    const local = w.players.values().next().value!;
    killBoss(w, local.id);
    const chest = w.chests.find((c) => c.kind === "boss")!;
    local.x = chest.x + 1; local.y = chest.y;
    stepWorldPhase(w, DT, []);
    check("local boss chest: heart + coins, no weapons, no claim state",
      chest.opened && chest.weapons === undefined && w.weaponClaims === null);
    const w3 = createWorld(0xDEA1, 3, {});
    check("local dealer floor: hearts only, no weapon stalls",
      w3.pickups.some((p) => p.kind === "dealer_heart") && !w3.pickups.some((p) => p.kind === "dealer_weapon"));
  }

  section("economy: options scale, scarcity holds — the measured §4 table");
  {
    const total = (size: number): number => {
      let n = 0;
      for (const seed of seeds) {
        for (let floor = 2; floor <= 6; floor++) {
          const { w } = partyWorld(seed, floor, size);
          n += chestWeaponCount(w);
          n += w.pickups.filter((p) => p.kind === "dealer_weapon").length;
          if (floor === 5) n += bossWeaponChoicesFor(size);
        }
      }
      return n;
    };
    const t1 = total(1), t2 = total(2), t3 = total(3), t4 = total(4);
    check("P4 offers stay well under 4x solo (per-person scarcity)", t4 < 4 * t1, `P1=${t1} P4=${t4}`);
    check("P4 offers meaningfully exceed solo (the playtest fix)", t4 > t1 + 10, `P1=${t1} P4=${t4}`);
    process.stdout.write(`  measured §4 offers (pedestal slots + stalls + boss choices, floors 2-6 x ${seeds.length} seeds): P1=${t1} P2=${t2} P3=${t3} P4=${t4}\n`);
    process.stdout.write(`  per person: P1=${t1.toFixed(1)} P2=${(t2 / 2).toFixed(1)} P3=${(t3 / 3).toFixed(1)} P4=${(t4 / 4).toFixed(1)}\n`);
  }
}

// ---- 4. same-world wire coherence (this branch's fields; the world-id echo is PR #39's) ----

function wireCoherenceTests(): void {
  section("wire: the pending blessing party rides every snapshot identically");
  {
    const { w, ps } = partyAtExit(0x51D0, 2);
    stepWorldPhase(w, DT, []); // raises both exit-gate offers
    const snapA = buildSnapshot(w, ps[0].id, 0, [], 0, false, {});
    const snapB = buildSnapshot(w, ps[1].id, 0, [], 0, false, {});
    if (snapA.t !== "snap" || snapB.t !== "snap") { check("snapshots built", false); return; }
    check("both clients read the same pending party",
      snapA.pnd.slice().sort().join(",") === snapB.pnd.slice().sort().join(",") && snapA.pnd.length === 2, snapA.pnd.join(","));
    const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snapA));
    check("pnd survives the codec round trip", decoded.t === "snap" && decoded.pnd.length === 2);
    chooseBlessingInWorld(w, ps[0].id, ITEMS[0]);
    const after = buildSnapshot(w, ps[0].id, 0, [], 0, false, {});
    check("a resolved pick leaves the pending set", after.t === "snap" && after.pnd.length === 1 && after.pnd[0] === ps[1].id);
  }

  section("wire: teammates ALWAYS ride snapshots (the party is never interest-filtered)");
  {
    const w = createWorld(0x51D1, 1, { isSandbox: true, skipLocalPlayer: true });
    const me = spawnPlayerInWorld(w, "pMe");
    const far = spawnPlayerInWorld(w, "pFar");
    me.x = 200; me.y = 200;
    far.x = 1500; far.y = 1000; // way outside any sane radius
    const snap = buildSnapshot(w, "pMe", 0, [], 0, false, { interestRadius: 300 });
    check("a far teammate still appears (spectate/roster/minimap need them)",
      snap.t === "snap" && snap.players.some((p) => p.id === "pFar"));
  }

  section("wire: authoritative revive progress reaches the reviver (PlayerWire.rv)");
  {
    const w = createWorld(0x51D2, 1, { isSandbox: true, skipLocalPlayer: true });
    const down = spawnPlayerInWorld(w, "pDown");
    const rev = spawnPlayerInWorld(w, "pRev");
    down.isDown = true; down.hp = 0;
    rev.x = down.x + 10; rev.y = down.y;
    rev.isInteracting = true;
    for (let i = 0; i < 10; i++) stepWorldPhase(w, DT, []);
    check("channel accrued under the hold", down.reviveProgress > 0.4, `progress=${down.reviveProgress.toFixed(2)}`);
    const snap = buildSnapshot(w, "pRev", 0, [], 0, false, {});
    const seen = snap.t === "snap" ? snap.players.find((p) => p.id === "pDown") : undefined;
    check("the reviver's snapshot carries the downed teammate's live progress",
      seen !== undefined && Math.abs(seen.rv - down.reviveProgress) < 1e-9, `rv=${seen?.rv}`);
    check("revive is a positional event (everyone standing at it sees the moment)",
      eventScope({ t: "revive", pid: "pDown", by: "pRev", x: 1, y: 2 }).kind === "pos");
  }

  section("wire: a downed spectator's interest view centers on the watched teammate");
  {
    const w = createWorld(0x51D3, 1, { isSandbox: true, skipLocalPlayer: true });
    const me = spawnPlayerInWorld(w, "pMe");
    const mate = spawnPlayerInWorld(w, "pMate");
    me.x = 200; me.y = 200; me.isDown = true; me.hp = 0;
    mate.x = 1300; mate.y = 900;
    const nearMate = devSpawnEnemy(w, "slime", mate.x + 60, mate.y);
    const nearCorpse = devSpawnEnemy(w, "slime", me.x + 60, me.y);
    const centered = buildSnapshot(w, "pMe", 0, [], 0, false, { interestRadius: 400, viewCenter: { x: mate.x, y: mate.y } });
    if (centered.t !== "snap") { check("snapshot built", false); return; }
    const ids = new Set(centered.enemies.map((e) => e.id));
    check("the watched teammate's surroundings are IN the spectator's snapshot", ids.has(nearMate.id));
    check("the corpse's far surroundings are OUT (the camera isn't there)", !ids.has(nearCorpse.id));
    // Radius 0 (production default): everything ships regardless of the center.
    const unfiltered = buildSnapshot(w, "pMe", 0, [], 0, false, { viewCenter: { x: mate.x, y: mate.y } });
    check("with filtering disabled the full entity set ships",
      unfiltered.t === "snap" && unfiltered.enemies.length === w.enemies.length);
  }
}

async function main(): Promise<void> {
  spectateSelectionTests();
  await headlessClientSpectateTests();
  blessingGateTests();
  exitReadinessTests();
  weaponEconomyTests();
  wireCoherenceTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll co-op experience assertions passed.\n");
}

void main();
