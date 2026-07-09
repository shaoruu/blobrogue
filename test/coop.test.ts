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
  stepWorldPhase, chooseBlessingInWorld, acquireWeaponInWorld, playersAtExit, buyFromShopInWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { Bullet, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";
import {
  REVIVE, SHOP,
  pedestalWeaponRolls, bossWeaponChoices,
} from "../src/sim/balance.js";
import { ITEMS } from "../src/sim/items.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import * as C from "../src/sim/constants.js";
import {
  buildSnapshot, jsonCodec, eventScope, toShopWire, type ServerMsg,
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
  return w.chests.reduce((n, c) => n + (c.weapon !== undefined ? 1 : 0), 0);
}

function stockedKinds(w: WorldState): WeaponId[] {
  const out: WeaponId[] = [];
  for (const c of w.chests) if (c.weapon !== undefined) out.push(c.weapon);
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
    online: {
      url: "ws://scripted", getTicket: () => Promise.resolve("dev:test"), roomCode: "ABCD",
      expectedWorldId: null, selfPlayerId: null, party: null,
    },
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
    sock.deliver(buildSnapshot(world, "s0", 0, [], 0, full, { worldId: "room:ABCD" }));
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

  // F toggles follow mode: watch the teammate <-> watch your own body (see who's coming).
  game.input.keyDown("f");
  game.input.keyUp("f");
  game.tick(1 / 60);
  const focusBody: { x: number; y: number } = game.cameraFocus();
  check("F flips the camera focus to your own body", game.isSpectatingBody === true && Math.abs(focusBody.x - self.x) < 1);
  game.input.keyDown("f");
  game.input.keyUp("f");
  game.tick(1 / 60);
  check("F again returns to the watched teammate", game.isSpectatingBody === false);

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

  // The party blessing readout reads from the authoritative pending set (UI Director copy)
  // WITH the server's expiry countdown riding the snapshot.
  world.pendingBlessings.set("s1", 30);
  deliverSnap();
  game.tick(1 / 60);
  const wait: string | null = game.blessingWaitLabel();
  check("WAITING FOR NAME TO CHOOSE · Ns carries the authoritative countdown",
    wait !== null && wait.includes("WAITING FOR S1 TO CHOOSE \u00b7 30s"), wait ?? "null");
  // NO client-only timeout: 35s of pure CLIENT time (past the fake 30s TTL) with no new
  // snapshots changes NOTHING — the countdown, the label, and the gate hold exactly as the
  // last authoritative frame said. Only a snapshot may resolve, count down, or release.
  for (let i = 0; i < 2100; i++) game.tick(1 / 60);
  const held: string | null = game.blessingWaitLabel();
  check("35s of client time WITHOUT snapshots releases nothing (no client-only expiry)",
    held !== null && held.includes("WAITING FOR S1 TO CHOOSE \u00b7 30s"), held ?? "null");
  // The authoritative drain is the ONLY release.
  world.pendingBlessings.clear();
  deliverSnap();
  game.tick(1 / 60);
  check("only the authoritative snapshot clears the wait state", game.blessingWaitLabel() === null);
  world.pendingBlessings.clear();

  // Exit coordination readout (UI Director copy): the authoritative exr drives the ready
  // count, and the checklist names each missing member WITH their distance to the stairs.
  world.enemies = [];
  world.pendingSpawns = [];
  const exitX = world.dungeon.exit.x * 48 + 24, exitY = world.dungeon.exit.y * 48 + 24;
  mateA.x = exitX; mateA.y = exitY; // the living teammate stages on the stairs; self is away
  deliverSnap();
  game.tick(1 / 60);
  const stragglerLabel: string | null = game.exitWaitLabel();
  check("straggler reads the ready count + YOU with a distance",
    stragglerLabel !== null && stragglerLabel.includes("1/2 READY TO GO DOWN") && /YOU \d+m/.test(stragglerLabel),
    stragglerLabel ?? "null");
  self.x = exitX; self.y = exitY;
  mateA.x = exitX - 400; mateA.y = exitY;
  deliverSnap();
  game.tick(1 / 60);
  const stagedLabel: string | null = game.exitWaitLabel();
  check("staged player reads the missing teammate + distance in the checklist",
    stagedLabel !== null && stagedLabel.includes("1/2 READY TO GO DOWN") && /S1 \d+m/.test(stagedLabel),
    stagedLabel ?? "null");
  mateA.x = exitX; mateA.y = exitY;
  deliverSnap();
  game.tick(1 / 60);
  check("a satisfied gate clears the exit readout (the blessing gate takes over)", game.exitWaitLabel() === null);

  // Co-op reward overlays BLOCK gameplay input (UI Part4): a delivered offer flips the
  // input context, so movement/fire/interact sample dead at the source while it is up —
  // and the semantic contextual action yields even with a revivable body in range.
  mateA.isDown = true; mateA.hp = 0;
  mateA.x = self.x + 10; mateA.y = self.y;
  deliverSnap();
  game.tick(1 / 60);
  const preClaim = game.contextualAction();
  check("a revivable body in range exposes the SEMANTIC action (data, not presentation)",
    preClaim !== null && preClaim.action === "revive" && preClaim.targetName === "s1" && preClaim.progress === null,
    JSON.stringify(preClaim));
  sock.deliver({ t: "offer", id: 1, choices: ["glass_cannon", "hair_trigger", "split_shot"] });
  game.tick(1 / 60);
  check("a reward overlay flips the input context to blessing", game.input.context === "blessing", `ctx=${game.input.context}`);
  game.input.keyDown("w");
  game.input.keyDown("e");
  game.input.mouseDown();
  const claimInput: InputCmd = game.buildInput();
  check("the overlay blocks movement/fire/interact at the sample source",
    claimInput.moveY === 0 && !claimInput.firing && claimInput.interact !== true);
  check("the contextual action yields under the pick overlay", game.contextualAction() === null);
  game.input.releaseAll();
  game.isChoosing = false;
  game.syncInputContext();
  check("dismissing the overlay restores the contextual action", game.contextualAction() !== null);

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
    const snapA = buildSnapshot(w, ps[0].id, 0, [], 0, false, { worldId: "room:TEST" });
    const snapB = buildSnapshot(w, ps[size - 1].id, 0, [], 0, false, { worldId: "room:TEST" });
    check("exr rides both wires identically (and matches pnd's party)",
      snapA.t === "snap" && snapB.t === "snap"
      && snapA.exr.slice().sort().join(",") === snapB.exr.slice().sort().join(",")
      && snapA.exr.length === size && snapA.wait.length === size);
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

  section("economy: pedestal rolls follow the gate exactly — max(1, ceil(P/2)) distinct per floor");
  {
    let countBreaks = 0, dupes = 0, cells = 0;
    for (const seed of gateSeeds) {
      for (let floor = 2; floor <= 6; floor++) {
        if (floor === 5) continue; // boss floor: the reward is the chest's choice set
        for (const size of [1, 2, 3, 4]) {
          const { w } = partyWorld(seed, floor, size);
          if (w.dungeon.rooms.length <= 2) continue;
          cells++;
          const kinds = stockedKinds(w);
          if (kinds.length !== pedestalWeaponRolls(size)) countBreaks++;
          if (new Set(kinds).size !== kinds.length) dupes++;
        }
      }
    }
    check("every cell stocks exactly pedestalWeaponRolls(P) weapons (P1-2: 1, P3-4: 2)",
      cells >= 100 && countBreaks === 0, `cells=${cells} breaks=${countBreaks}`);
    check("stocked kinds are distinct when the pool permits", dupes === 0, `dupes=${dupes}`);
  }

  section("economy: identical (seed, floor, P) builds an identical arsenal (no per-client divergence)");
  {
    const build = (size: number): string => {
      const { w } = partyWorld(0xF100D, 3, size);
      return JSON.stringify({
        chests: w.chests.map((c) => [c.x, c.y, c.weapon ?? null]),
        shop: w.shop ? toShopWire(w.shop) : null,
      });
    };
    for (const size of [1, 2, 4]) {
      check(`P${size} rebuild is byte-identical`, build(size) === build(size));
    }
  }

  section("economy: Patch's shop room stalls 2 shared weapons + 1 personal blessing on 12/18/24");
  {
    for (const size of [1, 2, 3, 4]) {
      const { w } = partyWorld(0xDEA1, 3, size);
      const weapons = w.shop!.slots.filter((s) => s.kind === "weapon");
      const blessings = w.shop!.slots.filter((s) => s.kind === "blessing");
      const hearts = w.shop!.slots.filter((s) => s.kind === "heart");
      check(`P${size}: 2 weapon pedestals + 1 blessing pedestal + 1 heart station`,
        weapons.length === SHOP.weaponPedestals && blessings.length === 1 && hearts.length === 1);
      check(`P${size}: weapon kinds distinct, pedestal prices ride the unchanged ladder`,
        new Set(weapons.map((s) => s.weapon)).size === weapons.length
        && weapons.every((s, i) => s.price === SHOP.pedestalPrices[i])
        && blessings[0].price === SHOP.pedestalPrices[SHOP.weaponPedestals],
        weapons.map((s) => `${s.weapon}@${s.price}`).join(","));
    }
    // The P2 buy flow (the accepted ownership call): a shared weapon claims ONCE with an
    // honest SOLD for the teammate; the personal blessing serves both without depleting.
    const { w, ps } = partyWorld(0xDEA1, 3, 2);
    w.enemies = []; w.pendingSpawns = [];
    const stall = w.shop!.slots.find((s) => s.kind === "weapon")!;
    const merch = stall.weapon!;
    const price = stall.price;
    const [a, b] = ps;
    a.coins = 0;
    a.x = stall.x; a.y = stall.y;
    check("a broke buy is rejected without consuming",
      buyFromShopInWorld(w, a.id, stall.id, []) === "broke" && !a.ownedWeapons.includes(merch) && stall.soldTo === null);
    a.coins = price;
    check("a funded buy claims the SHARED pedestal (weapon granted, coins paid, slot claimed)",
      buyFromShopInWorld(w, a.id, stall.id, []) === "ok" && a.ownedWeapons.includes(merch) && a.coins === 0
      && stall.soldTo === a.id,
      `owned=${a.ownedWeapons.join(",")} coins=${a.coins}`);
    a.coins = price;
    check("an owner never rebuys their own claim", buyFromShopInWorld(w, a.id, stall.id, []) === "owned" && a.coins === price);
    b.coins = price;
    b.x = stall.x; b.y = stall.y;
    check("the teammate reads the honest SOLD — exactly one winner, coins untouched",
      buyFromShopInWorld(w, b.id, stall.id, []) === "sold" && !b.ownedWeapons.includes(merch) && b.coins === price);
    const blessing = w.shop!.slots.find((s) => s.kind === "blessing")!;
    a.coins = blessing.price; b.coins = blessing.price;
    a.x = blessing.x; a.y = blessing.y; b.x = blessing.x; b.y = blessing.y;
    check("the FOR-YOU blessing pedestal serves BOTH buyers (personal, never depletes)",
      buyFromShopInWorld(w, a.id, blessing.id, []) === "ok" && buyFromShopInWorld(w, b.id, blessing.id, []) === "ok"
      && a.ownedItemIds.includes(blessing.itemId!) && b.ownedItemIds.includes(blessing.itemId!));
  }

  section("economy: the heart station — an invalid BUY never consumes, and touch never buys");
  {
    const { w, ps } = partyWorld(0xDEA1, 3, 2);
    w.enemies = []; w.pendingSpawns = [];
    const heart = w.shop!.slots.find((s) => s.kind === "heart")!;
    const [a] = ps;
    // Full health with plenty of coins: standing on the station AND buying must both be
    // inert (the loose-heart full-HP coin conversion never applies to the shop).
    a.coins = 50;
    a.x = heart.x; a.y = heart.y;
    stepWorldPhase(w, DT, []);
    check("FULL HEALTH: the touch consumes nothing", a.coins === 50 && a.hp === a.maxHp);
    check("FULL HEALTH: the buy is rejected without consuming",
      buyFromShopInWorld(w, a.id, heart.id, []) === "fullHealth" && a.coins === 50);
    a.hp = 1;
    a.coins = SHOP.heartPrice - 1;
    check("broke: the buy is rejected without consuming",
      buyFromShopInWorld(w, a.id, heart.id, []) === "broke" && a.coins === SHOP.heartPrice - 1 && a.hp === 1);
    a.coins = SHOP.heartPrice;
    stepWorldPhase(w, DT, []);
    check("standing on the station with exact coins still buys NOTHING (regression)",
      a.coins === SHOP.heartPrice && a.hp === 1);
    check("the explicit buy pays the price for exactly +1 HP",
      buyFromShopInWorld(w, a.id, heart.id, []) === "ok" && a.coins === 0 && a.hp === 2);
  }

  section("economy: the boss reward is min(P+1,5) personal CHOICES via pedestals (gate §4)");
  {
    for (const size of [1, 2, 3, 4]) {
      const { w, ps } = partyWorld(0xB055, 3, size);
      w.enemies = []; w.pendingSpawns = [];
      // A signature-bearing boss chest (every real boss drop carries one).
      w.chests.push({ id: w.nextChestId++, kind: "boss", x: ps[0].x + 40, y: ps[0].y, radius: 18, opened: false, weapon: "mortar" });
      ps[0].x += 40;
      stepWorldPhase(w, DT, []);
      const choices = w.pickups.filter((p) => p.isBossChoice);
      check(`P${size}: the chest spills ${bossWeaponChoices(size)} distinct choices, signature first`,
        choices.length === bossWeaponChoices(size)
        && choices.some((p) => p.weapon === "mortar")
        && new Set(choices.map((p) => p.weapon)).size === choices.length,
        choices.map((p) => p.weapon).join(","));
      const rare = w.pendingBlessings.size;
      check(`P${size}: every member got the Rare pick from the boss chest`, rare === size, `pending=${rare}`);
    }
  }

  section("economy: boss claims are personal — no depletion, one each, owned claims reroll");
  {
    const { w, ps } = partyWorld(0xC1A1, 3, 3);
    w.enemies = []; w.pendingSpawns = [];
    // Park the teammates far from the spill so nobody auto-claims by standing in the fan.
    ps[1].x += 600; ps[2].y += 600;
    w.chests.push({ id: w.nextChestId++, kind: "boss", x: ps[0].x + 40, y: ps[0].y, radius: 18, opened: false, weapon: "mortar" });
    ps[0].x += 40;
    stepWorldPhase(w, DT, []);
    for (const p of ps) chooseBlessingInWorld(w, p.id, ITEMS[0]); // resolve picks; pedestals are the subject
    const choices = w.pickups.filter((p) => p.isBossChoice);
    check("P3 spilled 4 choice pedestals", choices.length === 4, String(choices.length));
    const [a, b, c] = ps;
    // A stands clear first (the opener may be inside the fan already), then claims one.
    a.x -= 300;
    stepWorldPhase(w, DT, []);
    const isPreClaimed = a.hasClaimedBossChoice;
    a.x = choices[0].x; a.y = choices[0].y;
    stepWorldPhase(w, DT, []);
    check("a claim grants personally and flips the one-claim flag",
      a.hasClaimedBossChoice && (isPreClaimed || a.ownedWeapons.includes(choices[0].weapon!)));
    check("every pedestal still stands for teammates (no depletion)",
      w.pickups.filter((p) => p.isBossChoice).length === 4);
    const ownedBefore = a.ownedWeapons.length;
    a.x = choices[1].x; a.y = choices[1].y;
    stepWorldPhase(w, DT, []);
    check("a second touch grants nothing (one personal claim per player)", a.ownedWeapons.length === ownedBefore);
    // An owned duplicate claim grants a seeded REROLL — never coins, never nothing.
    acquireWeaponInWorld(w, b.id, choices[1].weapon!);
    const bOwned = b.ownedWeapons.length;
    b.x = choices[1].x; b.y = choices[1].y;
    stepWorldPhase(w, DT, []);
    check("claiming an OWNED choice grants a rerolled weapon instead (never coins)",
      b.hasClaimedBossChoice && b.ownedWeapons.length === bOwned + 1
      && !b.ownedWeapons.slice(0, bOwned).includes(b.ownedWeapons[bOwned]),
      b.ownedWeapons.join(","));
    c.x = choices[2].x; c.y = choices[2].y;
    stepWorldPhase(w, DT, []);
    stepWorldPhase(w, DT, []);
    check("all living claimed -> the pedestals clear", w.pickups.filter((p) => p.isBossChoice).length === 0);
  }

  section("economy: options scale, scarcity holds — the measured §4 table");
  {
    // Weapon opportunities PER PERSON: chest pedestals + shared shop pedestals are one
    // object each; the personal blessing/heart slots instance per player, so they count
    // P times in the party total.
    const total = (size: number): number => {
      let n = 0;
      for (const seed of seeds) {
        for (let floor = 2; floor <= 6; floor++) {
          const { w } = partyWorld(seed, floor, size);
          n += chestWeaponCount(w);
          if (w.shop) {
            n += w.shop.slots.filter((s) => s.kind === "weapon").length;
            n += w.shop.slots.filter((s) => !s.isShared && s.kind !== "reroll").length * size;
          }
          if (floor === 5) n += bossWeaponChoices(size);
        }
      }
      return n;
    };
    const t1 = total(1), t2 = total(2), t3 = total(3), t4 = total(4);
    check("P4 offers stay well under 4x solo (per-person scarcity)", t4 < 4 * t1, `P1=${t1} P4=${t4}`);
    check("P4 offers meaningfully exceed solo (the playtest fix)", t4 > t1 + 10, `P1=${t1} P4=${t4}`);
    process.stdout.write(`  measured §4 offers (pedestals + shop slots + boss choices, floors 2-6 x ${seeds.length} seeds): P1=${t1} P2=${t2} P3=${t3} P4=${t4}\n`);
    process.stdout.write(`  per person: P1=${t1.toFixed(1)} P2=${(t2 / 2).toFixed(1)} P3=${(t3 / 3).toFixed(1)} P4=${(t4 / 4).toFixed(1)}\n`);
  }
}

// ---- 4. same-world wire coherence (this branch's fields; the world-id echo is PR #39's) ----

function wireCoherenceTests(): void {
  section("wire: the pending party rides every snapshot identically, WITH the expiry countdown");
  {
    const { w, ps } = partyAtExit(0x51D0, 2);
    stepWorldPhase(w, DT, []); // raises both exit-gate offers
    const snapA = buildSnapshot(w, ps[0].id, 0, [], 0, false, { worldId: "room:TEST" });
    const snapB = buildSnapshot(w, ps[1].id, 0, [], 0, false, { worldId: "room:TEST" });
    if (snapA.t !== "snap" || snapB.t !== "snap") { check("snapshots built", false); return; }
    const key = (s: typeof snapA): string => s.wait.map((p) => `${p.pid}:${p.s}`).sort().join(",");
    check("both clients read the same pending party + seconds",
      key(snapA) === key(snapB) && snapA.wait.length === 2, key(snapA));
    check("the countdown is the sim's authoritative TTL (fresh offers ride at the full window)",
      snapA.wait.every((p) => p.s === Math.ceil(C.BLESSING_OFFER_TTL)), key(snapA));
    const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snapA));
    check("wait survives the codec round trip", decoded.t === "snap" && decoded.wait.length === 2 && decoded.wait.every((p) => p.s > 0));
    // The countdown DECREASES as the sim clock advances — server truth, not client time
    // (a one-second margin absorbs the TTL's repeated-subtraction float error).
    for (let i = 0; i < Math.ceil(3 / DT); i++) stepWorldPhase(w, DT, []);
    const later = buildSnapshot(w, ps[0].id, 0, [], 0, false, { worldId: "room:TEST" });
    check("the countdown falls with the SIM clock only", later.t === "snap"
      && later.wait.every((p) => p.s <= Math.ceil(C.BLESSING_OFFER_TTL) - 2 && p.s > C.BLESSING_OFFER_TTL - 10),
      later.t === "snap" ? key(later) : "?");
    chooseBlessingInWorld(w, ps[0].id, ITEMS[0]);
    const after = buildSnapshot(w, ps[0].id, 0, [], 0, false, { worldId: "room:TEST" });
    check("a resolved pick leaves the pending set", after.t === "snap" && after.wait.length === 1 && after.wait[0].pid === ps[1].id);
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
    const snap = buildSnapshot(w, "pRev", 0, [], 0, false, { worldId: "room:TEST" });
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
