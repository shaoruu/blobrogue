// Regression: the kit HUD readiness/cooldown readouts must read the AUTHORITATIVE snapshot
// tick online, not the local render world's tick. Online, ultReadyAtTick / pulseReadyAtTick are
// reconciled as server-absolute ticks while the local render world's tick is never stepped
// against the server clock — so comparing them to world.tick left the Mender's Sanctuary meter
// stuck empty on a permanent "8s" lockout (and the pulse verb dark) even when the server meter
// was full and castable. This drives a real Game + WSTransport with a co-op snapshot whose tick
// is far ahead of the local world tick and asserts the ult/pulse HUD reports truth.
//
// Run: npm run test:ulthudtick

import "./harness/domShim.js";
import { domMinimap, domOverlay } from "./harness/domShim.js";

import { Game } from "../src/game/game.js";
import { Hud, type HudState } from "../src/game/hud.js";
import { Minimap, type MinimapView } from "../src/game/minimap.js";
import { BlessingOverlay } from "../src/ui/blessing.js";
import { createWorld, spawnPlayerInWorld, setPlayerKit } from "../src/sim/world.js";
import { ULT } from "../src/sim/kits.js";
import { buildSnapshot, FIXED_DT, jsonCodec, type RosterWire, type ServerMsg } from "../src/net/protocol.js";
import type { SocketLike } from "../src/client/wsTransport.js";

const noop = (): void => {};

// The narrow slice of Game the harness drives — the same shape pvpArenaPresentation.test.ts uses,
// plus a read of the local render world's tick so the test can prove it genuinely lags the
// authoritative snapshot (the online condition that produced the stuck meter).
interface UltHudGameAccess {
  tick(dt: number): void;
  updateHud(): void;
  stop(): void;
  world: { tick: number };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

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

Hud.prototype.update = (state: HudState): void => { latestHudState = state; };
Hud.prototype.setVisible = noop;
Hud.prototype.showBanner = noop;
Hud.prototype.tick = noop;
Hud.prototype.showStats = noop;
Hud.prototype.hideStats = noop;
Hud.prototype.clear = noop;
Hud.prototype.showControlsHint = noop;
Minimap.prototype.render = (_view: MinimapView): void => {};
BlessingOverlay.prototype.show = noop;
Object.assign(globalThis, { WebSocket: ScriptedSocket });

function currentHudState(): HudState {
  if (latestHudState === null) throw new Error("HUD state was not captured");
  return latestHudState;
}

const WORLD_ID = "coop:room:ABCD";
const ROSTER: RosterWire[] = [{ pid: "p1", aid: "a1", nm: "Self", cl: 1, st: "on" }];

// A co-op online world whose self player (p1) is a full-charge Mender. `serverTick` is the
// authoritative tick the snapshot rides; `ultReadyAtTick` / `pulseReadyAtTick` are set relative
// to it by each scenario. The local render world's tick stays at 0 (online never steps it).
function menderWorld(serverTick: number, ultReadyAtTick: number, pulseReadyAtTick: number) {
  const world = createWorld(0xA11CE, 1, { isShared: true, skipLocalPlayer: true });
  const self = spawnPlayerInWorld(world, "p1");
  setPlayerKit(world, "p1", "mender");
  self.ultCharge = ULT.meterMax; // meter full server-side
  self.ultReadyAtTick = ultReadyAtTick;
  self.pulseReadyAtTick = pulseReadyAtTick;
  world.tick = serverTick;
  return world;
}

async function main(): Promise<void> {
  section("online Mender ult HUD reads the authoritative snapshot tick, not the lagging world tick");
  const gameInstance = new Game(
    domMinimap as object as HTMLCanvasElement,
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
      expectedWorldId: WORLD_ID,
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

  const game = gameInstance as object as UltHudGameAccess;

  // Scenario 1: meter full and the lockout expired well in the server's past. With the local
  // world tick far behind (the online reality), the old world.tick math read the ready-at tick as
  // still 300 ticks in the future — a permanent empty bar + "8s". The snapshot tick is past it.
  const READY_SERVER_TICK = 500;
  const READY_AT = 300;
  const PULSE_READY_AT = 200;
  socket.deliver(buildSnapshot(menderWorld(READY_SERVER_TICK, READY_AT, PULSE_READY_AT), "p1", 0, [], 0, true, {
    worldId: WORLD_ID,
    roster: ROSTER,
  }));
  game.tick(FIXED_DT);
  game.updateHud();
  const readyHud = currentHudState();

  check("the scenario genuinely exercises the online lag: the local render world tick trails the ready-at tick",
    game.world.tick < READY_AT, `localTick=${game.world.tick} readyAt=${READY_AT}`);
  check("the Mender ult meter renders (Sanctuary), never hidden by a stale tick",
    readyHud.ult !== null && readyHud.ult.kit === "mender" && readyHud.ult.name === "Sanctuary",
    JSON.stringify(readyHud.ult));
  check("a full server meter past its lockout reports READY (not stuck 8s empty)",
    readyHud.ult?.isReady === true);
  check("the fill reads a full charge (1), never the empty lockout visual",
    readyHud.ult?.charge === 1, `charge=${readyHud.ult?.charge}`);
  check("no residual lockout fraction once the authoritative tick is past ready-at",
    readyHud.ult?.cd === 0, `cd=${readyHud.ult?.cd}`);
  check("the Mender pulse signature reports ready from the authoritative tick, not the lagging clock",
    readyHud.sig?.pulse?.isReady === true && readyHud.sig?.pulse?.cd === 0,
    JSON.stringify(readyHud.sig?.pulse));

  // Scenario 2: mid-lockout (a fresh cast). The ready-at tick sits AHEAD of the snapshot tick by
  // half the lockout, so the countdown must read a real remaining fraction (~0.5 -> 4s), never
  // the stuck full "8s" the lagging world tick produced.
  section("online Mender ult HUD shows the real post-cast countdown, not a frozen 8s");
  const LOCKOUT_SERVER_TICK = 900;
  const MID_READY_AT = LOCKOUT_SERVER_TICK + ULT.lockoutTicks / 2; // 80 ticks remaining of 160
  socket.deliver(buildSnapshot(menderWorld(LOCKOUT_SERVER_TICK, MID_READY_AT, LOCKOUT_SERVER_TICK - 50), "p1", 0, [], 0, true, {
    worldId: WORLD_ID,
    roster: ROSTER,
  }));
  game.tick(FIXED_DT);
  game.updateHud();
  const lockoutHud = currentHudState();

  check("mid-lockout is not castable yet (past-tick math would falsely read ready)",
    lockoutHud.ult?.isReady === false);
  check("the lockout fraction is the real remaining half, not a frozen full bar",
    lockoutHud.ult != null && Math.abs(lockoutHud.ult.cd - 0.5) < 1e-6, `cd=${lockoutHud.ult?.cd}`);
  check("the countdown is strictly less than the full 8s stuck readout",
    lockoutHud.ult != null && lockoutHud.ult.cd < 1);

  game.stop();

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll ult HUD authoritative-tick assertions passed.\n");
}

void main();
