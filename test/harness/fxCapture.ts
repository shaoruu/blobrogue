// Captures the ordered FX "atoms" a Game produces per tick (particles/puffs/gibs/sparks/
// dmg numbers/decals/trauma/freeze/sfx) by wrapping the Game's own FX methods + the audio
// sfx sink. Used to build the pre-extraction FX oracle AND to check that the refactored
// client's handleSimEvents replays the exact same FX. Comparison is per-tick multiset
// (sorted), so harmless intra-tick ordering never causes false diffs — what matters is
// that the same FX fire, at the same positions/values, in the same counts.

import { Game } from "../../src/game/game.js";
import { audio } from "../../src/game/audio.js";
import { waveAudio } from "../../src/game/waveAudio.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function r(n: number): string {
  return (Math.round((typeof n === "number" ? n : 0) * 100) / 100).toString();
}
function r3(n: number): string {
  return (Math.round((typeof n === "number" ? n : 0) * 1000) / 1000).toString();
}

let sink: string[] = [];
let installed = false;

export function installFxCapture(): void {
  if (installed) return;
  installed = true;
  const P: any = Game.prototype;
  const wrap = (name: string, fmt: (args: any[]) => string) => {
    const orig = P[name];
    P[name] = function (this: unknown, ...args: any[]) {
      sink.push(fmt(args));
      return orig.apply(this, args);
    };
  };
  wrap("spawnParticles", (a) => `particles ${r(a[0])} ${r(a[1])} ${a[2]} ${a[3]}`);
  wrap("spawnPuff", (a) => `puff ${r(a[0])} ${r(a[1])} ${a[2]} ${a[3]}`);
  wrap("spawnGibs", (a) => `gibs ${r(a[0])} ${r(a[1])} ${a[2]} ${a[3]}`);
  wrap("spawnSparks", (a) => `sparks ${r(a[0])} ${r(a[1])} ${a[2]}`);
  wrap("spawnShell", (a) => `shell ${r(a[0])} ${r(a[1])} ${r(a[2])}`);
  wrap("spawnSparkFlash", (a) => `sparkfx ${r(a[0])} ${r(a[1])} ${a[2]}`);
  wrap("spawnEmber", (a) => `ember ${r(a[0]?.x ?? a[0])} ${r(a[0]?.y ?? a[1])}`);
  wrap("spawnEmberAt", (a) => `ember ${r(a[0])} ${r(a[1])}`);
  wrap("spawnSlashWind", (a) => `slashwind ${a[4] ?? a[1]}`);
  wrap("spawnDmgNumber", (a) => `dmg ${r(a[0])} ${r(a[1])} ${Math.max(1, Math.round(a[2]))} ${a[3]?.crit ? 1 : 0} ${a[3]?.color ?? ""}`);
  wrap("addDecal", (a) => `decal ${r(a[0])} ${r(a[1])} ${a[2]} ${r(a[3])} ${a[4]}`);
  wrap("addTrauma", (a) => `trauma ${r3(a[0])}`);
  wrap("addFreeze", (a) => `freeze ${r3(a[0])}`);

  // Wave-routed semantic cues (the bestiary audio contract's hurt/death/block/tell
  // channel) are FX atoms too: record the deterministic routing decision (event + spot),
  // then let the real cueAt run (inert against the shimmed AudioContext).
  const origCueAt = waveAudio.cueAt.bind(waveAudio);
  waveAudio.cueAt = (name: string, x: number, y: number, entityId?: number) => {
    const isRouted = origCueAt(name, x, y, entityId);
    if (isRouted) sink.push(`wavecue ${name} ${r(x)} ${r(y)}`);
    return isRouted;
  };

  // sfx is a module-level sink on the audio singleton; record instead of playing.
  (audio as any).unlock = () => {};
  (audio as any).setMusic = () => {};
  (audio as any).sfx = (name: string, opts?: { rate?: number; gain?: number }) => {
    sink.push(`sfx ${name} ${r3(opts?.rate ?? 1)} ${r3(opts?.gain ?? 1)}`);
  };
}

export function beginTick(): void {
  sink = [];
}

export function takeTick(): string[] {
  const out = sink.slice().sort();
  sink = [];
  return out;
}
