// Headless PR/docs screenshots of multiplayer IDENTITY: boots the REAL Game renderer
// (@napi-rs/canvas standing in for the browser canvas, real sprite/tile PNGs from /public)
// against scripted authoritative snapshots and captures how teammates read on screen:
//   roster       — a four-blob party with distinct verified names + colors
//   unresolved   — a teammate whose color claim has not resolved (neutral grey ring + "…")
//   legacy       — the pre-fix identity shape (everyone named "blob", no color claims);
//                  run this against the old code for the "before" shot
//
// Not part of any test gate. Run: npx tsx tools/identityScreens.ts [outDir] [sceneName]

import "../test/harness/domShim.js";
import { domOverlay } from "../test/harness/domShim.js";
import { createCanvas, Image as CanvasImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? join(ROOT, "artifacts");
const ONLY = process.argv[3];

// ---- swap the DOM shim's inert stubs for real raster machinery ----

// Image that loads "/sprites/x.png" style URLs synchronously from /public.
class DiskImage extends CanvasImage {
  set src(v: string | Buffer) {
    const setter = Object.getOwnPropertyDescriptor(CanvasImage.prototype, "src")!.set!;
    if (typeof v === "string") {
      try { setter.call(this, readFileSync(join(ROOT, "public", v))); } catch { /* missing art: ready() guards fall back */ }
    } else {
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
const { createWorld, spawnPlayerInWorld, loadFloorIntoWorld } = await import("../src/sim/world.js");
const { buildSnapshot, jsonCodec } = await import("../src/net/protocol.js");
const { TILE } = await import("../src/sim/types.js");
type ServerMsg = import("../src/net/protocol.js").ServerMsg;
type WorldState = import("../src/sim/world.js").WorldState;
type PlayerIdentity = import("../src/net/protocol.js").PlayerIdentity;

const noop = () => {};
for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"]) {
  (Hud.prototype as any)[m] = noop;
}
(Minimap.prototype as any).render = noop;

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
  selfColorIndex: number | null;
  identities: Map<string, PlayerIdentity>;
  ticks: number;
}

async function capture(scene: Scene): Promise<void> {
  const canvas = screenCanvas(1280, 720);
  const game: any = new Game(canvas, screenCanvas(160, 120), domOverlay as any, noop, noop);
  game.start({
    mode: "online",
    online: { url: "ws://scripted", getTicket: () => Promise.resolve("dev:shot"), roomCode: "LOVE", expectedWorldId: null, selfPlayerId: null, party: null },
    profile: null,
    selfColorIndex: scene.selfColorIndex,
  });
  await new Promise((r) => setTimeout(r, 0));
  const sock = ScriptedSocket.latest!;
  sock.onopen?.();
  const deliver = (full: boolean) => {
    scene.world.tick++;
    sock.deliver(buildSnapshot(scene.world, scene.selfId, 0, [], 0, full, {
      worldId: "room:LOVE",
      identities: scene.identities,
    }));
  };
  deliver(true);
  game.tick(1 / 60);
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

// A shared server-shaped world with the party spread readably around the spawn room.
function partyWorld(seed: number, ids: string[]): WorldState {
  const w = createWorld(seed, 1, { isShared: true, skipLocalPlayer: true });
  for (const id of ids) spawnPlayerInWorld(w, id);
  loadFloorIntoWorld(w, 1);
  const self = w.players.get(ids[0])!;
  const spots = [
    [0, 0],
    [TILE * 1.6, -TILE * 0.4],
    [-TILE * 1.4, TILE * 0.8],
    [TILE * 0.5, TILE * 1.4],
  ];
  ids.forEach((id, i) => {
    const p = w.players.get(id)!;
    p.x = self.x + (spots[i]?.[0] ?? 0);
    p.y = self.y + (spots[i]?.[1] ?? 0);
  });
  w.enemies = [];
  w.pendingSpawns = [];
  return w;
}

async function main(): Promise<void> {
  const scenes: Scene[] = [];

  // The fixed roster: every teammate wears their ACTUAL verified name + color.
  {
    const ids = ["s0", "s1", "s2", "s3"];
    const identities = new Map<string, PlayerIdentity>([
      ["s0", { name: "ian", colorIndex: 1 }],
      ["s1", { name: "BraveBlob", colorIndex: 2 }],
      ["s2", { name: "SnugBlob47", colorIndex: 5 }],
      ["s3", { name: "MossyBlob", colorIndex: 3 }],
    ]);
    scenes.push({ name: "identity-roster", world: partyWorld(0x1D0201, ids), selfId: "s0", selfColorIndex: 1, identities, ticks: 8 });
  }

  // One teammate's color claim has not resolved: the neutral grey ring + "…" placeholder.
  {
    const ids = ["s0", "s1", "s2"];
    const identities = new Map<string, PlayerIdentity>([
      ["s0", { name: "ian", colorIndex: 1 }],
      ["s1", { name: "BraveBlob", colorIndex: 2 }],
      // s2: no identity entry — a claimless join (nm falls back to the id, cl null).
    ]);
    scenes.push({ name: "identity-unresolved", world: partyWorld(0x1D0202, ids), selfId: "s0", selfColorIndex: 1, identities, ticks: 8 });
  }

  // The pre-fix identity shape (run against the OLD code for the before shot): everyone's
  // profile fell back to the literal "blob" and nobody's ticket carried a color claim.
  {
    const ids = ["s0", "s1", "s2", "s3"];
    const identities = new Map<string, PlayerIdentity>([
      ["s0", { name: "blob", colorIndex: null }],
      ["s1", { name: "blob", colorIndex: null }],
      ["s2", { name: "blob", colorIndex: null }],
      ["s3", { name: "blob", colorIndex: null }],
    ]);
    scenes.push({ name: "identity-legacy", world: partyWorld(0x1D0201, ids), selfId: "s0", selfColorIndex: null, identities, ticks: 8 });
  }

  for (const scene of scenes) {
    if (ONLY && scene.name !== ONLY) continue;
    await capture(scene);
  }
}

await main();
