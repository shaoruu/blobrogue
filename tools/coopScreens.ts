// Headless PR/docs screenshots of the co-op UX: boots the REAL Game renderer (node-canvas
// standing in for the browser canvas, real sprite/tile PNGs from /public) against scripted
// authoritative snapshots, and writes frames for: the revive hold (both perspectives),
// spectating, the Dealer's party stock, and the boss-chest arsenal.
//
// Not part of any test gate. Run: npx tsx tools/coopScreens.ts [outDir]

import "../test/harness/domShim.js";
import { domMinimap, domOverlay } from "../test/harness/domShim.js";
import { createCanvas, Image as CanvasImage } from "canvas";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? join(ROOT, "artifacts");

// ---- swap the DOM shim's inert stubs for real raster machinery ----

// Image that loads "/sprites/x.png" style URLs synchronously from /public.
class DiskImage extends CanvasImage {
  set src(v: string | Buffer) {
    if (typeof v === "string") {
      try {
        const setter = Object.getOwnPropertyDescriptor(CanvasImage.prototype, "src")!.set!;
        setter.call(this, readFileSync(join(ROOT, "public", v)));
      } catch { /* missing art: the renderer's ready() guards fall back */ }
    } else {
      const setter = Object.getOwnPropertyDescriptor(CanvasImage.prototype, "src")!.set!;
      setter.call(this, v);
    }
  }
  get src(): string { return ""; }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const shimCreate = g.document.createElement.bind(g.document);
g.document.createElement = (tag: string) => (tag === "canvas" ? createCanvas(1, 1) : shimCreate(tag));
g.Image = DiskImage;
g.HTMLImageElement = CanvasImage;

function screenCanvas(w: number, h: number): any {
  const c: any = createCanvas(w, h);
  c.addEventListener = () => {};
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 });
  c.style = {};
  return c;
}

// Import the game AFTER the raster globals are in place (Sprites loads at construction).
const { Game } = await import("../src/game/game.js");
const { Hud } = await import("../src/game/hud.js");
const { Minimap } = await import("../src/game/minimap.js");
const { BlessingOverlay } = await import("../src/ui/blessing.js");
const { createWorld, spawnPlayerInWorld, loadFloorIntoWorld, stepWorldPhase, devSpawnEnemy } = await import("../src/sim/world.js");
const { buildSnapshot, jsonCodec } = await import("../src/net/protocol.js");
const { REVIVE } = await import("../src/sim/balance.js");
const { TILE } = await import("../src/sim/types.js");
type ServerMsg = import("../src/net/protocol.js").ServerMsg;
type WorldState = import("../src/sim/world.js").WorldState;
type PlayerIdentity = import("../src/net/protocol.js").PlayerIdentity;

const noop = () => {};
for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"]) {
  (Hud.prototype as any)[m] = noop;
}
(Minimap.prototype as any).render = function (this: unknown) { /* the top-right map frame is DOM-framed; skip */ };
(BlessingOverlay.prototype as any).show = noop;

class ScriptedSocket {
  static latest: ScriptedSocket | null = null;
  readyState = 1;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) { ScriptedSocket.latest = this; }
  send(): void {}
  close(): void { this.readyState = 3; }
  deliver(msg: ServerMsg): void { this.onmessage?.({ data: jsonCodec.encodeServer(msg) }); }
}
g.WebSocket = ScriptedSocket;

interface Scene {
  name: string;
  world: WorldState;
  selfId: string;
  identities: Map<string, PlayerIdentity>;
  ticks: number;
  setup?: (game: any) => void;
}

async function capture(scene: Scene): Promise<void> {
  const canvas = screenCanvas(1280, 720);
  const game: any = new Game(canvas, screenCanvas(160, 120), domOverlay as any, noop, noop);
  game.start({
    mode: "online",
    online: { url: "ws://scripted", getTicket: () => Promise.resolve("dev:shot"), roomCode: "LOVE" },
    profile: null,
    selfColorIndex: 1,
  });
  await new Promise((r) => setTimeout(r, 0));
  const sock = ScriptedSocket.latest!;
  sock.onopen?.();
  const deliver = (full: boolean) => {
    scene.world.tick++;
    sock.deliver(buildSnapshot(scene.world, scene.selfId, 0, [], 0, full, {
      identities: scene.identities,
    }));
  };
  deliver(true);
  game.tick(1 / 60);
  scene.setup?.(game);
  for (let i = 0; i < scene.ticks; i++) {
    deliver(false);
    game.tick(1 / 60);
  }
  game.render();
  mkdirSync(join(OUT, "screenshots"), { recursive: true });
  const file = join(OUT, "screenshots", scene.name + ".png");
  writeFileSync(file, canvas.toBuffer("image/png"));
  game.stop();
  process.stdout.write(`wrote ${file}\n`);
}

// A shared server-shaped world with named party members, floor rebuilt with the party.
function partyScene(seed: number, floor: number, ids: string[]): { w: WorldState; identities: Map<string, PlayerIdentity> } {
  const w = createWorld(seed, floor, { isShared: true, skipLocalPlayer: true });
  for (const id of ids) spawnPlayerInWorld(w, id);
  loadFloorIntoWorld(w, floor);
  const identities = new Map<string, PlayerIdentity>();
  identities.set(ids[0], { name: "ian", colorIndex: 1 });
  if (ids[1]) identities.set(ids[1], { name: "gf", colorIndex: 3 });
  if (ids[2]) identities.set(ids[2], { name: "blob3", colorIndex: 4 });
  if (ids[3]) identities.set(ids[3], { name: "blob4", colorIndex: 5 });
  return { w, identities };
}

async function main(): Promise<void> {
  // 1. The reviver's perspective: gf is down, ian stands in the ring holding E at 62%.
  {
    const { w, identities } = partyScene(0x5EED1, 2, ["s0", "s1"]);
    const ian = w.players.get("s0")!;
    const gf = w.players.get("s1")!;
    gf.x = ian.x + 34; gf.y = ian.y - 6;
    gf.isDown = true; gf.hp = 0; gf.reviveProgress = REVIVE.channel * 0.62;
    devSpawnEnemy(w, "slime", ian.x + 240, ian.y + 90);
    devSpawnEnemy(w, "bat", ian.x - 200, ian.y + 140);
    await capture({
      name: "revive-hold", world: w, selfId: "s0", identities, ticks: 8,
      setup: (game) => { game.input.mouseMove(760, 300); game.input.keyDown("e"); },
    });
  }

  // 2. The downed player's perspective: spectating gf mid-fight, camera on her.
  {
    const { w, identities } = partyScene(0x5EED2, 3, ["s0", "s1"]);
    const me = w.players.get("s0")!;
    const gf = w.players.get("s1")!;
    me.isDown = true; me.hp = 0;
    gf.x = me.x + 420; gf.y = me.y + 150;
    for (let i = 0; i < 3; i++) devSpawnEnemy(w, "slime", gf.x + 90 + i * 40, gf.y + (i - 1) * 60);
    devSpawnEnemy(w, "spitter", gf.x - 130, gf.y - 80);
    await capture({ name: "spectating", world: w, selfId: "s0", identities, ticks: 150 });
  }

  // 3. The Dealer's party stock (P2): hearts on the top row, priced weapons below.
  {
    const { w, identities } = partyScene(0xDEA1, 3, ["s0", "s1"]);
    const stall = w.pickups.find((p) => p.kind === "dealer_weapon");
    const me = w.players.get("s0")!;
    const mate = w.players.get("s1")!;
    if (stall) { me.x = stall.x - 70; me.y = stall.y + 40; mate.x = stall.x + 80; mate.y = stall.y + 46; }
    me.coins = 14;
    await capture({
      name: "dealer-party-stock", world: w, selfId: "s0", identities, ticks: 40,
      setup: (game) => game.input.mouseMove(700, 340),
    });
  }

  // 4. The down limit (gate §1): gf spent her three downs — her body is OUT, unrevivable,
  // and the world says exactly what the party's move is (the stairs), with no stand-here
  // ring inviting a channel the sim would refuse.
  {
    const { w, identities } = partyScene(0x0071, 4, ["s0", "s1"]);
    const me = w.players.get("s0")!;
    const gf = w.players.get("s1")!;
    gf.x = me.x + 120; gf.y = me.y + 30;
    gf.isDown = true; gf.hp = 0; gf.downsThisFloor = REVIVE.downsPerFloor + 1;
    devSpawnEnemy(w, "skeleton", me.x + 300, me.y - 60);
    devSpawnEnemy(w, "bat", me.x - 180, me.y + 160);
    await capture({
      name: "down-limit-out", world: w, selfId: "s0", identities, ticks: 8,
      setup: (game) => game.input.mouseMove(760, 340),
    });
  }

  // 5. Party exit coordination: ian staged on the cleared stairs, gf still looting — the
  // chevron points at her and the authoritative exr drives the WAITING AT EXIT readout.
  {
    const { w, identities } = partyScene(0xE817, 2, ["s0", "s1"]);
    w.enemies = [];
    w.pendingSpawns = [];
    const me = w.players.get("s0")!;
    const gf = w.players.get("s1")!;
    const ex = w.dungeon.exit.x * TILE + TILE / 2, ey = w.dungeon.exit.y * TILE + TILE / 2;
    me.x = ex; me.y = ey;
    gf.x = ex - 380; gf.y = ey + 140;
    await capture({
      name: "exit-waiting", world: w, selfId: "s0", identities, ticks: 40,
      setup: (game) => game.input.mouseMove(560, 320),
    });
  }

  // Also snap tile x TILE alignment sanity so the shots always frame something real.
  process.stdout.write(`done (TILE=${TILE})\n`);
}

void main();
