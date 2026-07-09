// Dedicated co-op experience suite (post-playtest hardening):
//   1. spectate — pure target selection/cycling + a HEADLESS CLIENT integration that boots
//      the real Game over WSTransport with a scripted socket: camera hand-off on down,
//      cycling, the spec uplink, zeroed gameplay inputs while down, camera return on
//      revive, and the Sev-0 world-mismatch bail-to-lobby
//   2. the party blessing gate at 2-4 players — every member (downed included) gets and
//      answers its OWN offer; early picks don't descend; disconnect + the 60s sim-clock
//      timeout release the gate; nobody can be damaged while choosing
//   3. the party-scaled weapon economy P1-P4 — per-floor opportunity counts, the floor-2
//      early guarantee (>= P before the first boss), determinism, anti-junk distinctness +
//      melee/ranged mix, prefer-unowned rolls, dealer party stock + buy flow, the boss
//      chest arsenal, placement safety, and preserved scarcity per person
//   4. same-world wire coherence — snapshots carry the authoritative world id + the pending
//      blessing party; teammates always ride snapshots; revive progress reaches the
//      reviver; spectate-centered interest keeps a downed player's view coherent; the
//      client's expected room->world mapping agrees byte-for-byte with the Convex minter
//
// Run: npm run test:coop

import "./harness/domShim.js";
import { domCanvas, domMinimap, domOverlay } from "./harness/domShim.js";

import {
  createWorld, spawnPlayerInWorld, removePlayerFromWorld, loadFloorIntoWorld, devSpawnEnemy,
  stepWorldPhase, chooseBlessingInWorld, acquireWeaponInWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { Bullet, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";
import {
  REVIVE, WEAPON_ECONOMY,
  coopExtraWeaponRolls, coopWeaponRateMult, dealerWeaponStockFor, bossChestWeaponsFor,
} from "../src/sim/balance.js";
import { ITEMS } from "../src/sim/items.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import * as C from "../src/sim/constants.js";
import {
  buildSnapshot, jsonCodec, eventScope, worldIdForRoom, type ServerMsg,
} from "../src/net/protocol.js";
import { worldIdForRoomCode } from "../convex/gsTicketCore.js";
import { livingTeammates, resolveSpectateTarget, cycleSpectateTarget } from "../src/game/spectate.js";
import { Game } from "../src/game/game.js";
import type { ExitReason } from "../src/game/game.js";
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

  let exitReason: ExitReason | undefined;
  let exits = 0;
  const game: any = new Game(domCanvas as any, domMinimap as any, domOverlay as any, noop, (reason?: ExitReason) => { exits++; exitReason = reason; });
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
  check("client sent the v4 join", sock.sentOfType("join").length === 1);

  const deliverSnap = (full = false): void => {
    world.tick++;
    sock.deliver(buildSnapshot(world, "s0", 0, [], 0, full, { worldId: worldIdForRoom("ABCD") }));
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

  check("no exit fired during the whole down/spectate/revive pass", exits === 0);

  section("headless client: a snapshot from the WRONG world bails to the lobby (Sev-0 guard)");
  world.tick++;
  sock.deliver(buildSnapshot(world, "s0", 0, [], 0, false, { worldId: worldIdForRoom("ZZZZ") }));
  game.tick(1 / 60);
  check("mismatched world id exits the run", exits === 1);
  check("the exit names the mismatch (the lobby explains and regroups)", exitReason === "world_mismatch", `reason=${exitReason}`);
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

// ---- 3. the party-scaled weapon economy P1-P4 ----

function weaponEconomyTests(): void {
  const seeds = [0xF100D, 0x1234, 0xBEEF, 0xC0FFE];

  section("economy: per-floor chest opportunities scale exactly +1 per extra member");
  {
    let mismatches = 0, floorsChecked = 0;
    for (const seed of seeds) {
      for (let floor = 2; floor <= 6; floor++) {
        const solo = chestWeaponCount(partyWorld(seed, floor, 1).w);
        if (solo === 0) continue; // a degenerate layout can forfeit; not the contract under test
        floorsChecked++;
        for (const size of [2, 3, 4]) {
          const count = chestWeaponCount(partyWorld(seed, floor, size).w);
          if (count !== solo + coopExtraWeaponRolls(size)) mismatches++;
        }
      }
    }
    check("chest stock == solo + (P-1) across seeds x floors 2-6", floorsChecked >= 16 && mismatches === 0,
      `floors=${floorsChecked} mismatches=${mismatches}`);
  }

  section("economy: floor 2 alone guarantees an early weapon opportunity per member (before the first boss)");
  {
    let shortfalls = 0;
    for (const seed of seeds) {
      for (const size of [1, 2, 3, 4]) {
        if (chestWeaponCount(partyWorld(seed, 2, size).w) < size) shortfalls++;
      }
    }
    check("floor-2 stock >= P for every party size", shortfalls === 0, `shortfalls=${shortfalls}`);
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
    check("every P4 chest sits on an open floor tile", placed > 40 && onWall === 0, `placed=${placed} onWall=${onWall}`);
    check("no chest overlaps a live prop", onProp === 0, `onProp=${onProp}`);
    check("no two chests share a tile", stackedTiles === 0, `stacked=${stackedTiles}`);
  }

  section("economy: every party-stocked weapon is openable and collectible where it lands");
  {
    let opened = 0, uncollected = 0;
    for (const seed of seeds.slice(0, 2)) {
      const { w, ps } = partyWorld(seed, 2, 4);
      const a = ps[0];
      w.enemies = [];
      w.pendingSpawns = [];
      for (const chest of w.chests.filter((c) => c.weapons !== undefined)) {
        const contents = chest.weapons![0];
        a.x = chest.x + 1; a.y = chest.y;
        stepWorldPhase(w, DT, []);
        if (!chest.opened) continue;
        opened++;
        const drop = w.pickups.find((pk) => pk.kind === "weapon" && pk.weapon === contents);
        if (drop) {
          a.x = drop.x; a.y = drop.y;
          stepWorldPhase(w, DT, []);
        }
        if (!a.ownedWeapons.includes(contents)) uncollected++;
      }
    }
    check("every stocked chest opened and its weapon collected", opened >= 8 && uncollected === 0, `opened=${opened} uncollected=${uncollected}`);
  }

  section("economy: the Dealer stocks party weapons — priced, standable, first-come");
  {
    for (const size of [1, 2, 3, 4]) {
      const { w } = partyWorld(0xDEA1, 3, size);
      const stock = w.pickups.filter((p) => p.kind === "dealer_weapon");
      const hearts = w.pickups.filter((p) => p.kind === "dealer_heart");
      check(`P${size}: dealer stocks ${dealerWeaponStockFor(size)} weapon(s) + ${size} heart(s)`,
        stock.length === dealerWeaponStockFor(size) && hearts.length === size,
        `weapons=${stock.length} hearts=${hearts.length}`);
      for (const s of stock) {
        const tx = Math.floor(s.x / TILE), ty = Math.floor(s.y / TILE);
        check(`P${size}: dealer weapon priced + on open floor`,
          s.value === WEAPON_ECONOMY.dealerWeaponPrice && w.dungeon.tiles[ty * w.dungeon.w + tx] === 0,
          `price=${s.value}`);
      }
    }
    // Buy flow on a P2 world: broke walks past; an owner walks past; a funded buyer takes it.
    const { w, ps } = partyWorld(0xDEA1, 3, 2);
    w.enemies = []; w.pendingSpawns = [];
    const stall = w.pickups.find((p) => p.kind === "dealer_weapon")!;
    const merch = stall.weapon!;
    const [a, b] = ps;
    a.coins = 0;
    a.x = stall.x; a.y = stall.y;
    stepWorldPhase(w, DT, []);
    check("broke player walks past the stall", w.pickups.includes(stall) && !a.ownedWeapons.includes(merch));
    acquireWeaponInWorld(w, b.id, merch);
    b.coins = 50;
    b.x = stall.x; b.y = stall.y;
    stepWorldPhase(w, DT, []);
    check("an owner never double-buys (stock stays for a teammate)", w.pickups.includes(stall) && b.coins === 50);
    a.coins = WEAPON_ECONOMY.dealerWeaponPrice;
    stepWorldPhase(w, DT, []);
    check("a funded buyer takes the weapon for the price",
      !w.pickups.includes(stall) && a.ownedWeapons.includes(merch) && a.coins === 0,
      `owned=${a.ownedWeapons.join(",")} coins=${a.coins}`);
  }

  section("economy: the boss chest bakes a P-sized arsenal (solo keeps the tuned heart+coins)");
  {
    for (const size of [1, 2, 3, 4]) {
      const { w, ps } = partyWorld(0xB055, 5, size);
      killBoss(w, ps[0].id);
      const chest = w.chests.find((c) => c.kind === "boss")!;
      const want = bossChestWeaponsFor(size);
      check(`P${size}: boss chest holds ${want} weapon(s)`, (chest.weapons?.length ?? 0) === want, `got=${chest.weapons?.length ?? 0}`);
      if (want > 0) {
        check(`P${size}: arsenal kinds are distinct`, new Set(chest.weapons).size === want, chest.weapons!.join(","));
        if (want >= 3) check(`P${size}: arsenal mixes melee + ranged`, chest.weapons!.some(isMelee) && !chest.weapons!.every(isMelee));
      }
      // Open from afar (a planted bullet) so the whole spill stays on the floor to count.
      const opener = ps[0];
      opener.x = chest.x + 400; opener.y = chest.y + 300;
      plantKillBullet(w, opener.id, chest.x, chest.y, 6);
      const ev: SimEvent[] = [];
      stepWorldPhase(w, DT, ev);
      check(`P${size}: opening ejected the arsenal + the tuned heart + 5 coins`,
        chest.opened
        && w.pickups.filter((p) => p.kind === "weapon").length === want
        && w.pickups.filter((p) => p.kind === "heart").length === 1
        && w.pickups.filter((p) => p.kind === "coin").length === 5,
        `weapons=${w.pickups.filter((p) => p.kind === "weapon").length}`);
      const rare = ev.filter((e) => e.t === "offerBlessing");
      check(`P${size}: every member got the Rare pick from the boss chest`,
        rare.length === size && rare.every((o) => o.t === "offerBlessing" && o.rare)
        && new Set(rare.map((o) => (o as { pid: string }).pid)).size === size,
        `offers=${rare.length}`);
    }
  }

  section("economy: party rolls prefer weapons NOBODY owns (anti-junk)");
  {
    const { w, ps } = partyWorld(0x0A11, 5, 2);
    // The party owns 13 of the 15 pickup kinds — only two remain fresh.
    const fresh: WeaponId[] = ["flamer", "spear"];
    for (const p of ps) for (const id of PICKUP_WEAPONS) if (!fresh.includes(id)) acquireWeaponInWorld(w, p.id, id);
    killBoss(w, ps[0].id);
    const chest = w.chests.find((c) => c.kind === "boss")!;
    check("the P2 arsenal is exactly the two unowned kinds",
      chest.weapons !== undefined && chest.weapons.length === 2 && fresh.every((id) => chest.weapons!.includes(id)),
      chest.weapons?.join(",") ?? "none");
  }

  section("economy: scarcity preserved — totals grow, but sub-linearly per person");
  {
    const total = (size: number): number => {
      let n = 0;
      for (const seed of seeds) for (let floor = 2; floor <= 6; floor++) n += chestWeaponCount(partyWorld(seed, floor, size).w);
      return n;
    };
    const t1 = total(1), t2 = total(2), t3 = total(3), t4 = total(4);
    check("P4 total stays under 4x the solo total (per-person scarcity)", t4 < 4 * t1, `P1=${t1} P4=${t4}`);
    check("P4 total meaningfully exceeds solo (the playtest fix)", t4 >= t1 + 50, `P1=${t1} P4=${t4}`);
    check("ambient wood-chest weapon window widens with the party",
      coopWeaponRateMult(1) === 1 && coopWeaponRateMult(4) > coopWeaponRateMult(2) && coopWeaponRateMult(2) > 1);
    process.stdout.write(`  measured chest opportunities (floors 2-6 x ${seeds.length} seeds): P1=${t1} P2=${t2} P3=${t3} P4=${t4}\n`);
    process.stdout.write(`  measured per person: P1=${(t1 / 1).toFixed(1)} P2=${(t2 / 2).toFixed(1)} P3=${(t3 / 3).toFixed(1)} P4=${(t4 / 4).toFixed(1)}\n`);
  }
}

// ---- 4. same-world wire coherence ----

function wireCoherenceTests(): void {
  section("wire: the client's expected room->world mapping agrees with the Convex minter");
  for (const code of ["ABCD", "abcd", " kLmN "]) {
    check(`worldIdForRoom(${JSON.stringify(code)}) matches the minted claim`,
      worldIdForRoom(code) === worldIdForRoomCode(code), `${worldIdForRoom(code)} vs ${worldIdForRoomCode(code)}`);
  }

  section("wire: snapshots carry the authoritative world id + the pending blessing party");
  {
    const { w, ps } = partyAtExit(0x51D0, 2);
    stepWorldPhase(w, DT, []); // raises both exit-gate offers
    const snapA = buildSnapshot(w, ps[0].id, 0, [], 0, false, { worldId: "room:ABCD" });
    const snapB = buildSnapshot(w, ps[1].id, 0, [], 0, false, { worldId: "room:ABCD" });
    if (snapA.t !== "snap" || snapB.t !== "snap") { check("snapshots built", false); return; }
    check("world id rides every snapshot", snapA.wid === "room:ABCD" && snapB.wid === snapA.wid);
    check("both clients read the same pending party",
      snapA.pnd.slice().sort().join(",") === snapB.pnd.slice().sort().join(",") && snapA.pnd.length === 2, snapA.pnd.join(","));
    const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snapA));
    check("wid + pnd survive the codec round trip", decoded.t === "snap" && decoded.wid === "room:ABCD" && decoded.pnd.length === 2);
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
  weaponEconomyTests();
  wireCoherenceTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll co-op experience assertions passed.\n");
}

void main();
