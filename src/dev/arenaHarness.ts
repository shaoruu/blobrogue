// ?dev=arena — the LOCAL-ONLY Wave 2 arena capture harness. Boots the REAL online client
// (the exact WSTransport netcode + presentation the arena ships) against an in-page scripted
// socket that replays authoritative snapshots we author from the pure sim. Nothing here touches
// the production kill switch: the client selects arena presentation off the authoritative world
// id (pvp:) + snapshot, never off PVP_PUBLIC_ENABLED — so this renders Wave 2 visuals with the
// public path still OFF. Reachable only behind ?dev, which is code-split out of the play bundle.
//
// Scenes (?scene=): live-hearth, live-contested, live-tar, live-gust, live-spark.

import { Game } from "../game/game.js";
import { createWorld, spawnPlayerInWorld } from "../sim/world.js";
import type { WorldState, PlayerSim } from "../sim/world.js";
import { TILE } from "../sim/types.js";
import { buildSnapshot, jsonCodec } from "../net/protocol.js";
import type { RosterWire, ServerMsg } from "../net/protocol.js";
import { pvpWorldIdForRoomCode } from "../net/worldId.js";
import type { SocketLike } from "../client/wsTransport.js";
import {
  WEATHER,
  pvpHearthArmTicks, pvpHearthEmberWindowTicks, pvpMatchTimeTicks,
  pvpWeatherGustActiveTicks, pvpWeatherTarLifeTicks, pvpWeatherSparkTellTicks,
} from "../sim/pvp.js";

export type ArenaScene =
  | "live-hearth"
  | "live-contested"
  | "live-tar"
  | "live-gust"
  | "live-spark";

export const ARENA_SCENES: readonly ArenaScene[] = [
  "live-hearth", "live-contested", "live-tar", "live-gust", "live-spark",
];

const ROOM_CODE = "ARENA";
const WORLD_ID = pvpWorldIdForRoomCode(ROOM_CODE);
const SEED = 0xa11ce;
const SELF_ID = "p1";
const RIVAL_ID = "p2";
const ROSTER: RosterWire[] = [
  { pid: SELF_ID, aid: "self", nm: "You", cl: 1, st: "on" },
  { pid: RIVAL_ID, aid: "rival", nm: "Rival", cl: 4, st: "on" },
];

// The one scripted socket the client's WSTransport drives. It answers the join with nothing
// (the harness pushes snapshots directly) and opens on the next macrotask so the transport has
// its handlers wired before onopen fires.
class HarnessSocket implements SocketLike {
  static latest: HarnessSocket | null = null;
  readyState = 1;
  bufferedAmount = 0;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  onmessage: SocketLike["onmessage"] = null;

  constructor(_url: string) {
    HarnessSocket.latest = this;
    setTimeout(() => this.onopen?.(), 0);
  }

  send(_data: string): void {
    // The harness is the authority; client inputs are intentionally ignored.
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  deliver(message: ServerMsg): void {
    this.onmessage?.({ data: jsonCodec.encodeServer(message) });
  }
}

// Strip the fresh-spawn protection windows so the big spawn shell/ring never masks the Wave 2
// visuals — a settled, living body on the hearth is what each scene wants to show.
function settleBody(p: PlayerSim, tick: number): void {
  p.hp = p.maxHp;
  p.respawnT = 0;
  p.spawnGraceT = 0;
  p.spawnShieldT = 0;
  p.spawnProtectionStartedTick = 0;
  p.spawnHardGraceEndsAtTick = tick - 1;
  p.spawnShieldEndsAtTick = tick - 1;
  p.isSpawnOffenseLatched = false;
  p.hearthFavorT = 0;
  p.hearthEmberT = 0;
  p.hearthAwayT = 0;
}

function idleWeather(world: WorldState): void {
  const m = world.match;
  if (m === null) return;
  m.weather = { kind: null, phase: "idle", phaseEndTick: 0, cursor: 0, ordinal: 0, gustDir: 0 };
  world.hazards = world.hazards.filter((h) => h.kind !== "tar" && h.kind !== "spark");
}

function pushHazard(
  world: WorldState,
  kind: "tar" | "spark",
  x: number,
  y: number,
  radius: number,
  life: number,
  maxLife: number,
): void {
  world.hazards.push({ id: world.nextHazardId++, kind, x, y, radius, life, maxLife });
}

class ArenaHarness {
  readonly game: Game;
  private world: WorldState;
  private self: PlayerSim;
  private rival: PlayerSim;
  private socket: HarnessSocket | null = null;
  private sseq = 1;
  private scene: ArenaScene = "live-hearth";
  private lastSnap: ServerMsg | null = null;
  isReady = false;

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, overlay: HTMLElement) {
    (globalThis as { WebSocket?: unknown }).WebSocket = HarnessSocket;

    this.world = createWorld(SEED, 1, { isShared: true, skipLocalPlayer: true, mode: "pvp" });
    this.self = spawnPlayerInWorld(this.world, SELF_ID);
    this.rival = spawnPlayerInWorld(this.world, RIVAL_ID);
    if (this.world.match === null) throw new Error("arena harness: pvp world has no match state");
    this.world.tick = 1200;
    this.world.match.phase = "live";
    this.world.match.fragLimit = 5;
    this.world.match.scores.set(SELF_ID, 2);
    this.world.match.scores.set(RIVAL_ID, 1);
    this.world.match.phaseEndTick = this.world.tick + pvpMatchTimeTicks();

    this.game = new Game(
      canvas, minimap, overlay,
      () => { /* arena run "over" is never entered in the harness */ },
      () => { window.location.href = window.location.pathname; },
    );
    this.game.start({
      mode: "online",
      online: {
        url: "ws://arena-harness",
        getTicket: () => Promise.resolve("dev:arena"),
        roomCode: ROOM_CODE,
        expectedWorldId: WORLD_ID,
        selfPlayerId: SELF_ID,
        party: null,
      },
      profile: null,
    });

    this.applyScene(this.scene);
    // The one snapshot pump: keep the authoritative frame fresh (advancing tick) so the client
    // stays revealed, the HUD updates, and interpolation/animation runs for a live-looking shot.
    window.setInterval(() => this.pump(), 50);
  }

  private hearth(): { x: number; y: number } {
    return this.world.match!.hearthCenter;
  }

  scenes(): readonly ArenaScene[] {
    return ARENA_SCENES;
  }

  currentScene(): ArenaScene {
    return this.scene;
  }

  setScene(scene: ArenaScene): void {
    this.scene = scene;
    this.applyScene(scene);
  }

  private applyScene(scene: ArenaScene): void {
    const world = this.world;
    const tick = world.tick;
    settleBody(this.self, tick);
    settleBody(this.rival, tick);
    idleWeather(world);
    const hc = this.hearth();
    // Default: self settled on the hearth, rival parked well outside the ring.
    this.self.x = hc.x;
    this.self.y = hc.y;
    this.rival.x = hc.x;
    this.rival.y = hc.y + 6 * TILE;

    switch (scene) {
      case "live-hearth": {
        // A lone uncontested stand that has fully armed one ember_edge charge: full Favor pips
        // plus a live ember window (the HUD reads EMBER, the ring warms).
        this.self.hearthFavorT = pvpHearthArmTicks();
        this.self.hearthEmberT = pvpHearthEmberWindowTicks();
        break;
      }
      case "live-contested": {
        // Two living bodies inside the ring -> contested (dashed hot ring + HEARTH CONTESTED).
        this.rival.x = hc.x + 30;
        this.rival.y = hc.y;
        break;
      }
      case "live-tar": {
        // tar_bloom active: slow patches on two forced chokepoints adjacent to the hearth.
        world.match!.weather = {
          kind: "tar", phase: "active",
          phaseEndTick: tick + pvpWeatherTarLifeTicks(),
          cursor: 1, ordinal: 1, gustDir: 0,
        };
        const life = pvpWeatherTarLifeTicks() * 0.5;
        pushHazard(world, "tar", hc.x, hc.y - TILE, WEATHER.tarRadius, life, life);
        pushHazard(world, "tar", hc.x - TILE, hc.y, WEATHER.tarRadius, life, life);
        break;
      }
      case "live-gust": {
        // cinder_gust active: a mid-band cardinal wind overlay (director-only, no hazard entity).
        world.match!.weather = {
          kind: "gust", phase: "active",
          phaseEndTick: tick + pvpWeatherGustActiveTicks(),
          cursor: 2, ordinal: 1, gustDir: 1,
        };
        break;
      }
      case "live-spark": {
        // spark_mine tell: a crackling telegraph fuse in the annulus around the hearth, held near
        // detonation so the ring reads at its brightest.
        world.match!.weather = {
          kind: "spark", phase: "tell",
          phaseEndTick: tick + pvpWeatherSparkTellTicks(),
          cursor: 0, ordinal: 1, gustDir: 0,
        };
        const maxLife = 0.55;
        const dist = (WEATHER.sparkAnnulusInner + WEATHER.sparkAnnulusOuter) / 2;
        pushHazard(world, "spark", hc.x, hc.y - dist, WEATHER.sparkBlastRadius, maxLife * 0.15, maxLife);
        break;
      }
    }
    this.deliver();
  }

  private deliver(): void {
    const socket = HarnessSocket.latest;
    if (socket === null) return;
    this.socket = socket;
    const snap = buildSnapshot(this.world, SELF_ID, 0, [], 0, true, {
      worldId: WORLD_ID,
      roster: ROSTER,
      sseq: this.sseq++,
    });
    this.lastSnap = snap;
    socket.deliver(snap);
    this.isReady = true;
  }

  // The authoritative weather/hazard readout on the wire this frame (harness self-check: proves
  // the Wave 2 state the client renders, independent of how subtle a dark tar patch looks).
  debug(): { hazards: string[]; wk: string; wp: string; wd: number; hc: boolean } {
    const snap = this.lastSnap;
    if (snap === null || snap.t !== "snap") {
      return { hazards: [], wk: "", wp: "", wd: 0, hc: false };
    }
    return {
      hazards: snap.hzds.map((h) => h.k),
      wk: snap.match?.wk ?? "",
      wp: snap.match?.wp ?? "",
      wd: snap.match?.wd ?? 0,
      hc: snap.match?.hc ?? false,
    };
  }

  private pump(): void {
    if (this.socket === null && HarnessSocket.latest === null) return;
    this.world.tick++;
    // Keep the hearth timers pinned so the ember window / favor never drains between frames.
    if (this.scene === "live-hearth") {
      this.self.hearthFavorT = pvpHearthArmTicks();
      this.self.hearthEmberT = pvpHearthEmberWindowTicks();
    }
    this.deliver();
  }
}

declare global {
  interface Window {
    __arena?: {
      scenes: readonly ArenaScene[];
      currentScene: () => ArenaScene;
      setScene: (scene: ArenaScene) => void;
      isReady: () => boolean;
      debug: () => { hazards: string[]; wk: string; wp: string; wd: number; hc: boolean };
    };
  }
}

export function bootArenaHarness(
  canvas: HTMLCanvasElement,
  minimap: HTMLCanvasElement,
  overlay: HTMLElement,
): void {
  const requested = new URLSearchParams(window.location.search).get("scene");
  const harness = new ArenaHarness(canvas, minimap, overlay);
  if (requested !== null && (ARENA_SCENES as readonly string[]).includes(requested)) {
    harness.setScene(requested as ArenaScene);
  }
  window.__arena = {
    scenes: harness.scenes(),
    currentScene: () => harness.currentScene(),
    setScene: (scene) => harness.setScene(scene),
    isReady: () => harness.isReady,
    debug: () => harness.debug(),
  };
}
