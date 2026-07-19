// ?dev=arena — the LOCAL-ONLY arena capture harness. Boots the REAL online client
// (the exact WSTransport netcode + presentation the arena ships) against an in-page scripted
// socket that replays authoritative snapshots we author from the pure sim. The client selects
// arena presentation from the authoritative world id (pvp:) + snapshot. Reachable only behind
// ?dev, which is code-split out of the play bundle.
//
// Scenes (?scene=): live-hearth, live-contested, live-tar, live-gust, live-spark,
// live-ult-salvo, live-ult-triage, live-ult-shove, live-ult-slip.

import { Game } from "../game/game.js";
import { createWorld, spawnPlayerInWorld } from "../sim/world.js";
import type { WorldState, PlayerSim } from "../sim/world.js";
import { TILE } from "../sim/types.js";
import { buildSnapshot, jsonCodec } from "../net/protocol.js";
import type { RosterWire, ServerMsg, WireEvent } from "../net/protocol.js";
import { pvpWorldIdForRoomCode } from "../net/worldId.js";
import type { SocketLike } from "../client/wsTransport.js";
import {
  ARENA_SALVO, ARENA_SHOVE, ARENA_SLIP, ARENA_TRIAGE, WEATHER,
  arenaUltCastSpacingTicks, arenaUltTellTicks,
  pvpHearthArmTicks, pvpHearthEmberWindowTicks, pvpMatchTimeTicks,
  pvpWeatherGustActiveTicks, pvpWeatherTarLifeTicks, pvpWeatherSparkTellTicks,
} from "../sim/pvp.js";
import type { ArenaUltKind, ArenaUltKit } from "../sim/pvp.js";

export type ArenaScene =
  | "live-hearth"
  | "live-contested"
  | "live-tar"
  | "live-gust"
  | "live-spark"
  | "live-ult-salvo"
  | "live-ult-triage"
  | "live-ult-shove"
  | "live-ult-slip";

export const ARENA_SCENES: readonly ArenaScene[] = [
  "live-hearth", "live-contested", "live-tar", "live-gust", "live-spark",
  "live-ult-salvo", "live-ult-triage", "live-ult-shove", "live-ult-slip",
];

interface ArenaDebug {
  hazards: string[];
  wk: string;
  wp: string;
  wd: number;
  hc: boolean;
  auk: string;
  ultArena: string;
  ultT: number;
  ultFx: number;
  ultFxT: number;
  ultEvents: number;
}

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

function resetArenaUlt(p: PlayerSim): void {
  p.arenaUltKit = "gunner";
  p.arenaUlt = {
    tellT: 0,
    kind: null,
    aim: 0,
    salvoShotsLeft: 0,
    salvoShotT: 0,
    glassT: 0,
    shoveT: 0,
    shoveAim: 0,
    endlagT: 0,
    slowImmuneT: 0,
  };
  p.ultCharge = 0;
  p.ultReadyAtTick = 0;
  p.ultInvuln = 0;
  p.fireCd = 0;
  delete p.weaponFireCooldowns[p.weapon];
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
  private eventId = 1;
  private evTo = 0;
  private ultEvent: WireEvent | null = null;
  private ultEventsAtSceneStart = 0;
  private isUltEventPending = false;
  private scene: ArenaScene = "live-hearth";
  private lastSnap: ServerMsg | null = null;
  isReady = false;

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, overlay: HTMLElement) {
    Object.defineProperty(globalThis, "WebSocket", {
      value: HarnessSocket,
      configurable: true,
      writable: true,
    });

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
    resetArenaUlt(this.self);
    this.ultEvent = null;
    this.ultEventsAtSceneStart = this.game.devArenaUltEventCount();
    this.isUltEventPending = scene.startsWith("live-ult-");
    this.isReady = false;
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
      case "live-ult-salvo": {
        const aim = -Math.PI / 2;
        this.self.x = hc.x;
        this.self.y = 5 * TILE + TILE / 2;
        this.rival.x = this.self.x;
        this.rival.y = this.self.y - 3 * TILE;
        this.armArenaUlt("gunner", "salvo", aim);
        this.self.arenaUlt.salvoShotsLeft = ARENA_SALVO.shots;
        this.self.arenaUlt.salvoShotT = 0;
        this.self.arenaUlt.glassT = ARENA_SALVO.volleySec;
        break;
      }
      case "live-ult-triage": {
        this.armArenaUlt("mender", "triage", -Math.PI / 2);
        this.self.arenaUlt.kind = null;
        this.self.arenaUlt.slowImmuneT = ARENA_TRIAGE.cleanseSec;
        const hpBefore = this.self.maxHp - ARENA_TRIAGE.healSelf * 2;
        this.self.hp = Math.min(this.self.maxHp, hpBefore + ARENA_TRIAGE.healSelf);
        break;
      }
      case "live-ult-shove": {
        const aim = -Math.PI / 2;
        this.self.x = hc.x;
        this.self.y = 5 * TILE + TILE / 2;
        this.rival.x = this.self.x;
        this.rival.y = this.self.y - 40;
        this.armArenaUlt("bulwark", "shove", aim);
        this.self.arenaUlt.shoveT = ARENA_SHOVE.wallLifeSec;
        this.self.arenaUlt.shoveAim = aim;
        break;
      }
      case "live-ult-slip": {
        const aim = -Math.PI / 2;
        this.self.x = hc.x;
        this.self.y = 5 * TILE + TILE / 2 - ARENA_SLIP.blinkPx;
        this.armArenaUlt("phantom", "slip", aim);
        this.self.arenaUlt.kind = null;
        this.self.arenaUlt.endlagT = ARENA_SLIP.endlagSec;
        this.self.ultInvuln = ARENA_SLIP.iframeSec;
        this.self.fireCd = ARENA_SLIP.endlagSec;
        this.self.weaponFireCooldowns[this.self.weapon] = this.self.fireCd;
        break;
      }
    }
    this.deliver();
  }

  private armArenaUlt(kit: ArenaUltKit, kind: ArenaUltKind, aim: number): void {
    this.self.arenaUltKit = kit;
    this.self.ultCharge = 0;
    this.self.ultReadyAtTick = this.world.tick + arenaUltCastSpacingTicks();
    this.self.aimAngle = aim;
    this.self.arenaUlt.kind = kind;
    this.self.arenaUlt.aim = aim;
  }

  private buildArenaUltEvent(): WireEvent | null {
    let kind: ArenaUltKind;
    switch (this.scene) {
      case "live-ult-salvo": kind = "salvo"; break;
      case "live-ult-triage": kind = "triage"; break;
      case "live-ult-shove": kind = "shove"; break;
      case "live-ult-slip": kind = "slip"; break;
      default: return null;
    }
    const aim = this.self.arenaUlt.aim;
    const isSlip = kind === "slip";
    const x = this.self.x - (isSlip ? Math.cos(aim) * ARENA_SLIP.blinkPx : 0);
    const y = this.self.y - (isSlip ? Math.sin(aim) * ARENA_SLIP.blinkPx : 0);
    const id = this.eventId++;
    this.evTo = id;
    return {
      id,
      e: { t: "ultArena", pid: SELF_ID, kind, x, y, aim, tellTicks: arenaUltTellTicks() },
    };
  }

  private deliver(): void {
    const socket = HarnessSocket.latest;
    if (socket === null) return;
    this.socket = socket;
    const event = this.ultEvent;
    const snap = buildSnapshot(this.world, SELF_ID, 0, event === null ? [] : [event], this.evTo, true, {
      worldId: WORLD_ID,
      roster: ROSTER,
      sseq: this.sseq++,
    });
    this.lastSnap = snap;
    socket.deliver(snap);
    this.isReady = !this.isUltEventPending && (event === null
      || this.game.devArenaUltEventCount() > this.ultEventsAtSceneStart);
  }

  // The authoritative weather/hazard/ult readout this frame. `auk` and `ultArena` prove the wire
  // state; `ultT` proves the held server-only active window that authored the frame.
  debug(): ArenaDebug {
    const snap = this.lastSnap;
    if (snap === null || snap.t !== "snap") {
      return {
        hazards: [], wk: "", wp: "", wd: 0, hc: false, auk: "",
        ultArena: "", ultT: 0, ultFx: 0, ultFxT: -1, ultEvents: 0,
      };
    }
    const ultEvent = snap.events.find((event) => event.e.t === "ultArena");
    const ultArena = ultEvent?.e.t === "ultArena" ? ultEvent.e.kind : "";
    const a = this.self.arenaUlt;
    const ultT = this.scene === "live-ult-salvo" ? a.glassT
      : this.scene === "live-ult-triage" ? a.slowImmuneT
      : this.scene === "live-ult-shove" ? a.shoveT
      : this.scene === "live-ult-slip" ? Math.max(a.endlagT, this.self.ultInvuln)
      : 0;
    return {
      hazards: snap.hzds.map((h) => h.k),
      wk: snap.match?.wk ?? "",
      wp: snap.match?.wp ?? "",
      wd: snap.match?.wd ?? 0,
      hc: snap.match?.hc ?? false,
      auk: snap.self?.auk ?? "",
      ultArena,
      ultT,
      ultFx: this.game.devArenaUltFxCount(),
      ultFxT: this.game.devArenaUltFxTime(),
      ultEvents: this.game.devArenaUltEventCount(),
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
    if (this.isUltEventPending && this.game.devIsWorldReady()) {
      this.ultEvent = this.buildArenaUltEvent();
      this.isUltEventPending = false;
    } else if (this.ultEvent !== null
      && this.game.devArenaUltEventCount() > this.ultEventsAtSceneStart
      && this.game.devArenaUltFxCount() === 0) {
      this.ultEventsAtSceneStart = this.game.devArenaUltEventCount();
      this.ultEvent = this.buildArenaUltEvent();
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
      debug: () => ArenaDebug;
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
