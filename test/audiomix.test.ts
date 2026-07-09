// Audio mix contracts: the perceptual volume curve, the v1->v2 stored-volume migration,
// and the duck-vs-slider separation on the real engine's bus graph.
//   - CURVE: sliders store a POSITION 0..1; audible gain = position² (0 -> true silence,
//     0.5 -> 0.25). The curve is applied exactly once, at the settings->gain boundary:
//     the UI reads raw positions, the audio engine reads only the curved *Gain getters.
//   - MIGRATION: legacy blobrogue.vol.* values were raw GAINS. First construction after
//     the curve converts once via sqrt into the .v2 position keys, so an existing
//     player's audible mix is IDENTICAL across the update. Fresh installs get positions
//     equal to sqrt of the shipped effective gains (.7 / .5 / .9, music under sfx).
//   - DUCK vs SLIDER: each duckable category is user node (slider) -> duck node
//     (automation resting at 1.0). A slider move mid-duck must land on the NEW curved
//     volume once the duck recovers — the old single-node design ramped back to the old
//     volume because both writers clobbered the same AudioParam.
//
// Run: npx tsx test/audiomix.test.ts

import "./harness/domShim.js";
import { installFakeAudio, lastContext, resetFetchPlan, asFakeGain, flushLoads, FakeGainNode } from "./harness/fakeAudio.js";
installFakeAudio();

const { Settings, volumeGain, settings } = await import("../src/game/settings.js");
const { AudioEngine } = await import("../src/game/audio.js");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

function section(name: string): void {
  console.log(`\n== ${name}`);
}

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

const VOL_KEYS = [
  "blobrogue.vol.master", "blobrogue.vol.music", "blobrogue.vol.sfx",
  "blobrogue.vol.master.v2", "blobrogue.vol.music.v2", "blobrogue.vol.sfx.v2",
];
function clearVolumeStorage(): void {
  for (const k of VOL_KEYS) localStorage.removeItem(k);
}

// ---- 1. perceptual curve ----
section("perceptual curve: gain = position², snapped to true silence at 0");
{
  check("position 0 is EXACTLY silent", volumeGain(0) === 0);
  check("position 0.5 is 0.25 gain", volumeGain(0.5) === 0.25);
  check("position 1 is unity", volumeGain(1) === 1);
  check("out-of-range positions clamp", volumeGain(-0.5) === 0 && volumeGain(1.5) === 1);

  clearVolumeStorage();
  const s = new Settings();
  s.setMusicVol(0.5);
  check("settings exposes the RAW position for the UI", s.musicVol === 0.5);
  check("…and the curved gain for the engine", s.musicGain === 0.25);
  s.setMusicVol(0);
  check("slider at 0 -> gain exactly 0", s.musicGain === 0);
}

// ---- 2. stored-volume migration ----
section("migration: legacy raw gains convert once (sqrt) into .v2 position keys");
{
  clearVolumeStorage();
  const fresh = new Settings();
  check("fresh install: shipped effective gains hold (.7/.5/.9)",
    near(fresh.masterGain, 0.7) && near(fresh.musicGain, 0.5) && near(fresh.sfxGain, 0.9));
  check("fresh install: default POSITIONS are the sqrt of those gains",
    near(fresh.masterVol, Math.sqrt(0.7)) && near(fresh.musicVol, Math.sqrt(0.5)) && near(fresh.sfxVol, Math.sqrt(0.9)));
  check("music stays intentionally under sfx", fresh.musicGain < fresh.sfxGain);

  clearVolumeStorage();
  localStorage.setItem("blobrogue.vol.master", "0.7");
  localStorage.setItem("blobrogue.vol.music", "0.5");
  localStorage.setItem("blobrogue.vol.sfx", "0.9");
  const migrated = new Settings();
  check("legacy gains reload as sqrt positions", near(migrated.musicVol, Math.sqrt(0.5))
    && near(migrated.masterVol, Math.sqrt(0.7)) && near(migrated.sfxVol, Math.sqrt(0.9)));
  check("…so the audible mix is IDENTICAL across the update (no silent halving)",
    near(migrated.masterGain, 0.7) && near(migrated.musicGain, 0.5) && near(migrated.sfxGain, 0.9));
  check("the convert persists to the .v2 key immediately (one-time)",
    near(Number(localStorage.getItem("blobrogue.vol.music.v2")), Math.sqrt(0.5)));

  localStorage.setItem("blobrogue.vol.music.v2", "0.8");
  const v2Wins = new Settings();
  check("an existing .v2 position always wins over the legacy key", v2Wins.musicVol === 0.8);

  v2Wins.setMusicVol(0.6);
  check("setters write the .v2 key", localStorage.getItem("blobrogue.vol.music.v2") === "0.6");
  check("…and never touch the legacy key", localStorage.getItem("blobrogue.vol.music") === "0.5");
}

// ---- 3. duck vs slider on the real engine ----
section("duck vs slider: separate series nodes, a mid-duck slider move lands on the NEW volume");
{
  clearVolumeStorage();
  resetFetchPlan();
  settings.setMuted(false);
  settings.setMusicVol(Math.sqrt(0.5));
  settings.setSfxVol(Math.sqrt(0.9));
  settings.setMasterVol(Math.sqrt(0.7));

  const engine = new AudioEngine();
  engine.unlock();
  await flushLoads();
  const ctx = lastContext();
  ctx.advance(1);

  const musicUser = asFakeGain(engine.busNode("music"));
  const musicDuck = asFakeGain(engine.duckNode("music"));
  check("music routes user node -> duck node", musicUser.targets.includes(musicDuck));
  check("the duck node rests at unity", musicDuck.gain.value === 1 && musicDuck.gain.calls.length === 0);
  check("user node boots at the CURVED music gain", near(musicUser.gain.value, 0.5));

  engine.sfx("playerHurt"); // hardcoded duck: music dips to 0.5× for the hit
  const duckTargets = musicDuck.gain.targetsSet();
  check("the duck dips the duck node (0.5×) and schedules recovery to 1.0",
    duckTargets.some((v) => v === 0.5) && duckTargets[duckTargets.length - 1] === 1);
  check("the duck never writes the user slider node", musicUser.gain.targetsSet().length === 0);

  settings.setMusicVol(0.9); // mid-duck slider move
  const userTargets = musicUser.gain.targetsSet();
  check("the slider write hits the user node with the NEW curved gain", near(userTargets[userTargets.length - 1], 0.81));
  check("slider writes ramp via setTargetAtTime (no zipper setValueAtTime)",
    musicUser.gain.calls.every((c) => c.method === "setTargetAtTime"));
  const finalDuck = musicDuck.gain.targetsSet();
  check("the duck still recovers to unity — the product ends at the NEW volume, not the old",
    finalDuck[finalDuck.length - 1] === 1 && near(musicUser.gain.value * 1, 0.81));
}

// ---- 4. mute stays a master-bus override ----
section("mute: forces master to 0 without overwriting the stored master position");
{
  const engine = new AudioEngine();
  engine.unlock();
  await flushLoads();
  const masterBefore = settings.masterVol;
  settings.setMuted(true);
  const masterNode = asFakeGain(lastContext().nodesOf<FakeGainNode>("gain")[0]);
  check("mute ramps the master bus to 0", masterNode.gain.targetsSet().includes(0));
  check("…without touching the master slider position", settings.masterVol === masterBefore);
  settings.setMuted(false);
  const targets = masterNode.gain.targetsSet();
  check("unmute restores the CURVED master gain", near(targets[targets.length - 1], volumeGain(masterBefore)));
}

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("Audio mix contracts hold.");
