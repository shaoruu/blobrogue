// Remote dash sync suite (protocol v9): a HEADLESS observing client — the real Game over the
// real WSTransport with a scripted socket and a controlled clock — watches a teammate's
// authoritative dash (driven through the REAL sim step) and must render it:
//   - the dash FX (takeoff puff + ring + sfx, per-tick dust, afterimage ghost trail) fire on
//     the observing client, at the interpolated position, on the SAME frame the rendered
//     blob starts its crisp move (never early off the raw snapshot, never a smeared glide);
//   - the interpolated remote position sits EXACTLY on the dash keyframes while dashing
//     (the crisp step-through), and returns to plain lerp afterwards;
//   - the dash sfx plays exactly once per dash (rising edge — no per-snapshot double-play);
//   - the dash i-frame window (dnv) rides the wire so the remote blinks like the local blob;
//   - the client authors nothing: every rendered dash position is a server keyframe.
//
// Run: npm run test:remotedash

import "./harness/domShim.js";
import { domCanvas, domMinimap, domOverlay } from "./harness/domShim.js";

import { Game, isInvulnBlinkFrame } from "../src/game/game.js";
import { Hud } from "../src/game/hud.js";
import { Minimap } from "../src/game/minimap.js";
import { BlessingOverlay } from "../src/ui/blessing.js";
import { installFxCapture, beginTick, takeTick } from "./harness/fxCapture.js";
import { createWorld, spawnPlayerInWorld, stepPlayerPhase } from "../src/sim/world.js";
import { buildSnapshot, jsonCodec, FIXED_DT, type ServerMsg } from "../src/net/protocol.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import type { RemotePlayer } from "../src/sim/types.js";

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
}

const noop = () => {};
installFxCapture();
for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"] as const) {
  (Hud.prototype as any)[m] = noop;
}
(Minimap.prototype as any).render = noop;
(BlessingOverlay.prototype as any).show = noop;
(globalThis as any).WebSocket = ScriptedSocket;

const IDLE: InputCmd = { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };

function blinkPredicateTests(): void {
  section("the i-frame blink predicate covers BOTH sim invuln windows (post-hit and dash)");
  check("no window -> no blink", !isInvulnBlinkFrame(0, 0));
  check("post-hit invuln blinks (the pre-existing local read)", isInvulnBlinkFrame(0.10, 0));
  check("the blink alternates across the window", !isInvulnBlinkFrame(0.16, 0));
  check("the dash i-frame window blinks the same way", isInvulnBlinkFrame(0, 0.10) && !isInvulnBlinkFrame(0, 0.16));
}

async function observerDashTests(): Promise<void> {
  section("observing client: a teammate's authoritative dash renders crisp, juiced, and once");

  // The authoritative world: the observer (s0) plus the dasher (s1), driven by the real sim.
  const world = createWorld(0xDA5B0B, 1, { isShared: true, skipLocalPlayer: true });
  const self = spawnPlayerInWorld(world, "s0");
  const mate = spawnPlayerInWorld(world, "s1");
  mate.x = self.x + 120; mate.y = self.y;

  const game: any = new Game(domCanvas as any, domMinimap as any, domOverlay as any, noop, noop);
  game.start({
    mode: "online",
    online: {
      url: "ws://scripted", getTicket: () => Promise.resolve("dev:test"), roomCode: "ABCD",
      expectedWorldId: null, selfPlayerId: null, party: null,
    },
    profile: null,
    selfColorIndex: 1,
  });
  await new Promise((r) => setTimeout(r, 0));
  const sock = ScriptedSocket.latest!;
  sock.onopen?.();

  // A controlled transport clock: snapshots land on the exact 50ms cadence and the interp
  // render clock advances 60Hz-frame by frame, so timing assertions are deterministic.
  let fakeNow = Date.now();
  game.wsTransport.now = () => fakeNow;

  const deliverSnap = (full = false): void => {
    world.tick++;
    sock.deliver(buildSnapshot(world, "s0", 0, [], 0, full, { worldId: "room:ABCD" }));
  };

  // Per-frame observations of the remote as the client renders it. The remote is sampled at
  // the SAME clock instant game.tick rendered with (before the frame advances), and every
  // afterimage alive this frame is accumulated (ghosts fade in 0.28s — a run-end read would
  // miss them by design).
  interface FrameObs { isDashing: boolean; x: number; y: number; dnv: number; blink: boolean; atoms: string[] }
  const frames: FrameObs[] = [];
  const ghostsSeen = new Map<string, string | null>();
  const frame = (): void => {
    beginTick();
    game.tick(1 / 60);
    const atoms = takeTick();
    const r: RemotePlayer | undefined = game.remotes()[0];
    frames.push({
      isDashing: r?.isDashing ?? false,
      x: r?.x ?? 0, y: r?.y ?? 0,
      dnv: r?.dashInvuln ?? 0,
      blink: r ? isInvulnBlinkFrame(r.invuln, r.dashInvuln) : false,
      atoms,
    });
    for (const g of game.afterimages as Array<{ x: number; y: number; color: string | null }>) {
      ghostsSeen.set(`${g.x},${g.y}`, g.color);
    }
    fakeNow += 1000 / 60;
  };
  // One authoritative server tick: step the DASHER through the real sim, snapshot, then
  // render three 60Hz client frames (the exact 50ms cadence).
  const dashKeyframes: Array<{ x: number; y: number }> = [];
  const serverTick = (cmd: InputCmd): void => {
    stepPlayerPhase(world, mate, cmd, FIXED_DT, [] as SimEvent[]);
    if (mate.dashTime > 0) dashKeyframes.push({ x: mate.x, y: mate.y });
    deliverSnap();
    for (let i = 0; i < 3; i++) frame();
  };

  deliverSnap(true);
  for (let i = 0; i < 3; i++) frame();
  check("world revealed from the authoritative snapshot", game.isWorldRevealed === true);

  // Warm the interpolation buffer, then dash: one authoritative dash input, held movement.
  for (let i = 0; i < 6; i++) serverTick(IDLE);
  const preDashX = mate.x;
  serverTick({ ...IDLE, moveX: 1, dash: true });
  check("the sim actually dashed", dashKeyframes.length === 1 && mate.dashTime > 0);
  while (mate.dashTime > 0) serverTick({ ...IDLE, moveX: 1 });
  check("the dash covered real ground over multiple keyframes",
    dashKeyframes.length >= 2 && mate.x - preDashX > 60, `${(mate.x - preDashX).toFixed(0)}px over ${dashKeyframes.length} keyframes`);
  // Let the render delay drain + the trail settle.
  for (let i = 0; i < 10; i++) serverTick(IDLE);

  const isDashAtom = (a: string): boolean => a === "sfx dash 1 0.5" || a.includes("#ffd27a");
  const firstDashFrame = frames.findIndex((f) => f.isDashing);
  const firstFxFrame = frames.findIndex((f) => f.atoms.some(isDashAtom));
  check("the observer rendered the dash", firstDashFrame >= 0);
  check("no dash FX play before the rendered blob starts moving (interp-aligned, never early)",
    firstFxFrame === firstDashFrame, `fx@${firstFxFrame} dash@${firstDashFrame}`);

  // Crisp, authoritative movement: EVERY rendered dash position is exactly a server dash
  // keyframe — the client authored nothing and smeared nothing.
  const dashFrames = frames.filter((f) => f.isDashing);
  const isKeyframe = (f: FrameObs): boolean => dashKeyframes.some((k) => Math.abs(k.x - f.x) < 1e-6 && Math.abs(k.y - f.y) < 1e-6);
  check("every rendered dash pose sits EXACTLY on an authoritative keyframe (crisp, not a smear)",
    dashFrames.length > 0 && dashFrames.every(isKeyframe));
  const distinctXs = new Set(dashFrames.map((f) => f.x));
  check("the dash stepped through multiple keyframes (a fast move, not one teleport)",
    distinctXs.size >= 2, `steps=${distinctXs.size}`);

  const allAtoms = frames.flatMap((f) => f.atoms);
  const dashSfx = allAtoms.filter((a) => a === "sfx dash 1 0.5");
  check("the dash sfx played EXACTLY once (rising edge — no per-snapshot double-play)", dashSfx.length === 1, `n=${dashSfx.length}`);
  const takeoff = allAtoms.filter((a) => a.startsWith("particles") && a.endsWith(" 10 #ffd27a"));
  const ring = allAtoms.filter((a) => a.startsWith("decal") && a.endsWith(" 16 ring"));
  check("the takeoff puff + ring decal fired once each", takeoff.length === 1 && ring.length === 1, `puff=${takeoff.length} ring=${ring.length}`);
  const r2 = (n: number): string => (Math.round(n * 100) / 100).toString();
  const k0 = dashKeyframes[0];
  check("the takeoff juice landed on the first rendered dash keyframe",
    takeoff[0] === `particles ${r2(k0.x)} ${r2(k0.y)} 10 #ffd27a`, takeoff[0]);
  const dust = allAtoms.filter((a) => a.startsWith("particles") && a.endsWith(" 1 #ffd27a"));
  check("the trail dust followed (one mote per authoritative tick)", dust.length >= 2, `n=${dust.length}`);

  // The afterimage ghost trail rides the shared afterimage pipeline, tinted as the REMOTE
  // player (color set) — the local blob never dashed, so no self ghosts exist.
  const ghosts = [...ghostsSeen.entries()].map(([key, color]) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y, color };
  });
  check("remote afterimages spawned along the dash", ghosts.filter((g) => g.color !== null).length >= 2, `n=${ghosts.length}`);
  check("every ghost is the remote's (the local player never dashed)", ghosts.every((g) => g.color !== null));
  check("ghost positions are authoritative dash keyframes",
    ghosts.length > 0 && ghosts.every((g) => dashKeyframes.some((k) => Math.abs(k.x - g.x) < 1e-6 && Math.abs(k.y - g.y) < 1e-6)));

  // The dash i-frame window rides the wire and drives the same blink the local blob renders.
  check("the dash i-frame window (dnv) reached the observer", dashFrames.some((f) => f.dnv > 0));
  check("the remote blinked through its i-frames", frames.some((f) => f.isDashing && f.blink));

  // After the dash: back to plain interpolation, and the juice stays quiet.
  const tail = frames.slice(frames.length - 12);
  check("the dash ended cleanly on the observer", tail.every((f) => !f.isDashing));
  check("no dash FX linger after the dash", tail.every((f) => !f.atoms.some(isDashAtom)));

  game.stop();
}

async function main(): Promise<void> {
  blinkPredicateTests();
  await observerDashTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll remote dash sync assertions passed.\n");
}

void main();
