import "./harness/domShim.js";
import { domMinimap, domOverlay } from "./harness/domShim.js";

import { Game } from "../src/game/game.js";
import { Hud, type HudState } from "../src/game/hud.js";
import { Minimap, type MinimapView } from "../src/game/minimap.js";
import { BlessingOverlay } from "../src/ui/blessing.js";
import { createWorld, spawnPlayerInWorld } from "../src/sim/world.js";
import { buildSnapshot, FIXED_DT, jsonCodec, type RosterWire, type ServerMsg } from "../src/net/protocol.js";
import type { SocketLike } from "../src/client/wsTransport.js";
import { PVP_PUBLIC_ENABLED } from "../src/net/pvpFlag.js";
import { beginTick, installFxCapture, takeTick } from "./harness/fxCapture.js";

interface CanvasLog {
  texts: string[];
  arcCalls: number;
  drawImageCalls: number;
}

interface ArenaGameAccess {
  isArena: boolean;
  isClearCelebrated: boolean;
  tick(dt: number): void;
  updateHud(): void;
  renderExit(): void;
  renderMinimap(): void;
  checkFloorCleared(): void;
  exitWaitLabel(): string | null;
  stop(): void;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
const noop = (): void => {};

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` \u2014 ${detail}` : ""}\n`);
    return;
  }
  failed++;
  failures.push(name + (detail ? ` \u2014 ${detail}` : ""));
  process.stdout.write(`  FAIL ${name}${detail ? ` \u2014 ${detail}` : ""}\n`);
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function recordingCanvas(log: CanvasLog): HTMLCanvasElement {
  const context = new Proxy({}, {
    get: (_target, property) => {
      if (property === "createLinearGradient" || property === "createRadialGradient" || property === "createPattern") {
        return () => ({ addColorStop: noop });
      }
      if (property === "measureText") return () => ({ width: 0 });
      if (property === "getImageData" || property === "createImageData") {
        return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      }
      if (property === "fillText") {
        return (text: string) => { log.texts.push(text); };
      }
      if (property === "arc") {
        return () => { log.arcCalls++; };
      }
      if (property === "drawImage") {
        return () => { log.drawImageCalls++; };
      }
      return noop;
    },
    set: () => true,
  }) as object as CanvasRenderingContext2D;
  const canvas = {
    width: 1280,
    height: 720,
    style: {},
    getContext: () => context,
    addEventListener: noop,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 1280,
      bottom: 720,
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
    }),
  };
  return canvas as object as HTMLCanvasElement;
}

class ScriptedSocket implements SocketLike {
  static latest: ScriptedSocket | null = null;
  readyState = 1;
  bufferedAmount = 0;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  onmessage: SocketLike["onmessage"] = null;
  sent: string[] = [];

  constructor(_url: string) {
    ScriptedSocket.latest = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  deliver(message: ServerMsg): void {
    this.onmessage?.({ data: jsonCodec.encodeServer(message) });
  }
}

let latestHudState: HudState | null = null;
const banners: string[] = [];
let latestMinimapView: MinimapView | null = null;

Hud.prototype.update = (state: HudState): void => { latestHudState = state; };
Hud.prototype.setVisible = noop;
Hud.prototype.showBanner = (text: string): void => { banners.push(text); };
Hud.prototype.tick = noop;
Hud.prototype.showStats = noop;
Hud.prototype.hideStats = noop;
Hud.prototype.clear = noop;
Hud.prototype.showControlsHint = noop;
Minimap.prototype.render = (view: MinimapView): void => { latestMinimapView = view; };
BlessingOverlay.prototype.show = noop;
Object.assign(globalThis, { WebSocket: ScriptedSocket });
installFxCapture();

function currentHudState(): HudState {
  if (latestHudState === null) throw new Error("HUD state was not captured");
  return latestHudState;
}

function currentMinimapView(): MinimapView {
  if (latestMinimapView === null) throw new Error("minimap view was not captured");
  return latestMinimapView;
}

async function main(): Promise<void> {
  section("real Game + WSTransport consumes the latest authoritative arena snapshot");
  const canvasLog: CanvasLog = { texts: [], arcCalls: 0, drawImageCalls: 0 };
  const gameInstance = new Game(
    recordingCanvas(canvasLog),
    domMinimap as object as HTMLCanvasElement,
    domOverlay as object as HTMLElement,
    noop,
    noop,
  );
  gameInstance.start({
    mode: "online",
    online: {
      url: "ws://scripted",
      getTicket: () => Promise.resolve("dev:test"),
      roomCode: "ABCD",
      expectedWorldId: "pvp:room:ABCD",
      selfPlayerId: null,
      party: null,
    },
    profile: null,
  });
  await Promise.resolve();
  await Promise.resolve();
  const socket = ScriptedSocket.latest;
  if (socket === null) throw new Error("scripted socket was not created");
  socket.onopen?.();

  const world = createWorld(0xA11CE, 1, {
    isShared: true,
    skipLocalPlayer: true,
    mode: "pvp",
  });
  const self = spawnPlayerInWorld(world, "p1");
  const rival = spawnPlayerInWorld(world, "p2");
  if (world.match === null) throw new Error("pvp world has no match state");
  world.tick = 100;
  world.match.phase = "live";
  world.match.phaseEndTick = 6080;
  world.match.scores.set("p1", 3);
  world.match.scores.set("p2", 1);
  const exitX = world.dungeon.exit.x * 48 + 24;
  const exitY = world.dungeon.exit.y * 48 + 24;
  self.x = exitX;
  self.y = exitY;
  rival.x = exitX + 240;
  rival.y = exitY;
  const roster: RosterWire[] = [
    { pid: "p1", aid: "a1", nm: "Self", cl: 1, st: "on" },
    { pid: "p2", aid: "a2", nm: "Rival", cl: 2, st: "on" },
  ];
  socket.deliver(buildSnapshot(world, "p1", 0, [], 0, true, {
    worldId: "pvp:room:ABCD",
    roster,
  }));

  const game = gameInstance as object as ArenaGameAccess;
  game.tick(FIXED_DT);
  game.updateHud();
  const hudState = currentHudState();
  check("authoritative world identity selects arena presentation", game.isArena && hudState.isArena);
  check("HUD phase, timer, score, and roster names come from the latest match snapshot",
    hudState.arenaMatch?.phase === "live"
    && hudState.arenaMatch.secondsLeft === 299
    && hudState.arenaMatch.selfFrags === 3
    && hudState.arenaMatch.scores.find((score) => score.id === "p2")?.name === "Rival");
  check("arena status strip is not labeled as a co-op connection",
    hudState.coopLabel === "ARENA \u00b7 ABCD \u00b7 2 PLAYERS", hudState.coopLabel ?? "");
  check("arena floor-clear truth cannot enter the HUD objective path",
    !hudState.isCleared && hudState.waitLabel === null && hudState.party.length === 0);
  check("arena reveal emitted no floor banner",
    banners.every((banner) => !/FLOOR|CLEAR|GO DOWN/.test(banner)), banners.join("|"));

  section("all floor and exit presentation paths are inert in arena mode");
  check("exit coordination returns no READY TO GO DOWN copy", game.exitWaitLabel() === null);
  banners.length = 0;
  game.isClearCelebrated = false;
  beginTick();
  game.checkFloorCleared();
  const floorClearFx = takeTick();
  check("floor-clear fanfare, flash, trauma, and sparkle do not fire",
    floorClearFx.length === 0 && banners.length === 0, floorClearFx.join("|"));

  canvasLog.texts.length = 0;
  canvasLog.arcCalls = 0;
  canvasLog.drawImageCalls = 0;
  game.renderExit();
  check("central stairs and GO DOWN exit render nothing",
    canvasLog.texts.length === 0 && canvasLog.arcCalls === 0 && canvasLog.drawImageCalls === 0);

  game.renderMinimap();
  const minimapView = currentMinimapView();
  check("arena minimap keeps geometry but has no exit marker",
    minimapView.dungeon.w === 19 && minimapView.dungeon.h === 19
    && minimapView.exit === null && !minimapView.isCleared);

  section("presentation work leaves the production kill switch off");
  check("PVP remains disabled", PVP_PUBLIC_ENABLED === false);
  game.stop();

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll arena presentation integration assertions passed.\n");
}

void main();
