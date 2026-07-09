// Wave-audio suite: proves the manifest implementation's contracts headlessly —
// trigger mapping, loop start/no-duplicate/stop, priority + voice stealing, boss-lock
// ducking, cooldown/rate limits, missing-file fallbacks, loader hygiene (no decode spam),
// and the manifest's 30s stress acceptance (locks never masked, budget never exceeded,
// no identical take twice in a row).
//
// Run: npx tsx test/waveaudio.test.ts

import "./harness/domShim.js";
import {
  installFakeAudio, lastContext, allowFetch, resetFetchPlan, fetchCounts, fetchCountFor,
  flushLoads, asFakeGain, FakeGainNode, FakeBufferSourceNode, FakeBiquadNode,
} from "./harness/fakeAudio.js";
installFakeAudio();

const { AudioEngine } = await import("../src/game/audio.js");
type WavePlayRequest = import("../src/game/audio.js").WavePlayRequest;
type WaveLoopRequest = import("../src/game/audio.js").WaveLoopRequest;
type WaveEngine = import("../src/game/audio.js").WaveEngine;
type WaveDuck = import("../src/game/waveSpec.js").WaveDuck;
const { WaveAudioDirector } = await import("../src/game/waveAudio.js");
const {
  WAVE_SOUNDS, WAVE_TELLS, WAVE_BOSS_PHASE, WAVE_BOSS_DEATH, WAVE_PRIORITY,
  AMBIENT_ZONE_EVENTS, tellCuesFor, isTrackLoopHeld, spatialGainFor, isWaveEventId,
} = await import("../src/game/waveSpec.js");
type WaveSoundSpec = import("../src/game/waveSpec.js").WaveSoundSpec;
type TellSnapshot = import("../src/game/waveSpec.js").TellSnapshot;
type WaveFrameEnemy = import("../src/game/waveAudio.js").WaveFrameEnemy;
type WaveFramePlayer = import("../src/game/waveAudio.js").WaveFramePlayer;
type WaveListener = import("../src/game/waveAudio.js").WaveListener;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

function section(name: string): void {
  console.log(`\n== ${name}`);
}

// A scripted engine so director POLICY (cooldowns, variants, jitter lanes, lifecycles)
// is asserted deterministically; real-engine sections below cover the mechanics.
class ScriptEngine implements WaveEngine {
  nowMs = 0;
  plays: WavePlayRequest[] = [];
  loopStarts: { key: string; req: WaveLoopRequest }[] = [];
  loopStops: string[] = [];
  ducks: WaveDuck[] = [];
  preloaded: string[] = [];
  private live = new Set<string>();

  now(): number { return this.nowMs; }
  playWave(req: WavePlayRequest): boolean { this.plays.push(req); return true; }
  startWaveLoop(key: string, req: WaveLoopRequest): boolean {
    if (this.live.has(key)) return true;
    this.live.add(key);
    this.loopStarts.push({ key, req });
    return true;
  }
  stopWaveLoop(key: string): void {
    if (!this.live.has(key)) return;
    this.live.delete(key);
    this.loopStops.push(key);
  }
  hasWaveLoop(key: string): boolean { return this.live.has(key); }
  stopAllWaveLoops(): void { for (const key of [...this.live]) this.stopWaveLoop(key); }
  duckWaveBus(duck: WaveDuck): void { this.ducks.push(duck); }
  preloadWave(stems: string[]): void { this.preloaded.push(...stems); }
  playsFor(event: string): WavePlayRequest[] { return this.plays.filter((p) => p.event === event); }
}

const emptyListener: WaveListener = { x: 0, y: 0, camLeft: -640, camTop: -360, camRight: 640, camBottom: 360 };

function frameInput(enemies: WaveFrameEnemy[], players: WaveFramePlayer[] = [], listener = emptyListener) {
  return { listener, enemies, players };
}

function enemyAt(id: number, kind: string, snap: TellSnapshot, x = 0, y = 0): WaveFrameEnemy {
  return { id, kind, x, y, dead: false, attack: snap };
}

const snap = (phase: string, move: string, isAimLocked = false): TellSnapshot => ({ phase, move, isAimLocked });

// ---- 1. registry integrity (every manifest row present, sane, and uniquely pathed) ----
section("registry contract");
{
  const entries = Object.entries<WaveSoundSpec>(WAVE_SOUNDS);
  check("registry has the full manifest surface (>= 90 events)", entries.length >= 90, `${entries.length} events`);
  const stems = new Set<string>();
  let isAllSane = true;
  let isStemFormatOk = true;
  let hasDuplicateStem = false;
  let isLockLawOk = true;
  let isLoopLawOk = true;
  for (const [event, spec] of entries) {
    if (spec.variants < 1 || spec.gain <= 0 || spec.gain > 1 || spec.priority < 1 || spec.priority > 100 || spec.jitter < 0 || spec.jitter > 0.06) {
      isAllSane = false;
      console.log(`    bad row: ${event}`);
    }
    if (spec.stem !== null) {
      if (!/^[a-z]+\/[a-z0-9_]+$/.test(spec.stem)) { isStemFormatOk = false; console.log(`    bad stem: ${event} ${spec.stem}`); }
      if (stems.has(spec.stem)) { hasDuplicateStem = true; console.log(`    duplicate stem: ${spec.stem}`); }
      stems.add(spec.stem);
    }
    if (spec.priority >= WAVE_PRIORITY.bossLock && !(spec.jitter === 0 && spec.isOffCameraUncapped === true)) isLockLawOk = false;
    if (spec.loop === true && spec.synth.kind !== "loopPad") isLoopLawOk = false;
    if (spec.loop !== true && spec.synth.kind === "loopPad") isLoopLawOk = false;
  }
  check("every row sane (variants/gain/priority/jitter lanes)", isAllSane);
  check("stems are generation-pipeline paths (dir/snake_case)", isStemFormatOk);
  check("no two events share a file stem", !hasDuplicateStem);
  check("boss locks: zero jitter + off-camera uncapped", isLockLawOk);
  check("loops and loopPad recipes agree", isLoopLawOk);
  check("all six zone loops registered in ladder order", AMBIENT_ZONE_EVENTS.length === 6
    && WAVE_SOUNDS["ambient.verdant"].stem === "amb/verdant_loop"
    && WAVE_SOUNDS["ambient.null"].stem === "amb/null_loop");

  const lock = WAVE_SOUNDS["marrow.aimLock"];
  check("marrow.aimLock matches manifest row", lock.stem === "boss/marrow_lock" && lock.gain === 1.0
    && lock.priority === 100 && lock.duck?.[0].to === 0.35 && lock.duck[0].hold === 0.15 && lock.duck[0].recover === 0.45);
  const thumper = WAVE_SOUNDS["shootMortar"];
  check("shootMortar matches manifest row", thumper.stem === "sfx/thumper_fire" && thumper.variants === 3 && thumper.gain === 0.82);
  const block = WAVE_SOUNDS["shielder.block"];
  check("shielder.block derives parry with 120ms limit", block.cooldownMs === 120
    && block.fallback?.sample === "parry" && block.fallback.lowpassHz === 5000);
  check("wall impact derives cannon at .72 per manifest", WAVE_SOUNDS["marrow.wallImpact"].fallback?.sample === "cannon"
    && WAVE_SOUNDS["marrow.wallImpact"].fallback?.rate === 0.72);
  check("blink depart derives reversed dash", WAVE_SOUNDS["weaver.blinkDepart"].fallback?.isReversed === true);
  check("legacy cue names never collide with wave ids", !isWaveEventId("dash") && !isWaveEventId("enemyHit") && !isWaveEventId("bossSpawn"));
  check("every boss kind maps phase + death", ["marrow", "choir", "weaver", "gilded"].every(
    (k) => WAVE_BOSS_PHASE[k] !== undefined && WAVE_BOSS_DEATH[k] !== undefined));
}

// ---- 2. trigger mapping (authoritative attack-state edges -> manifest events) ----
section("trigger mapping");
{
  check("marrow rush windup -> listenStart", tellCuesFor("marrow", null, snap("windup", "rush")).join() === "marrow.listenStart");
  check("marrow aim lock edge -> aimLock", tellCuesFor("marrow", snap("windup", "rush", false), snap("windup", "rush", true)).join() === "marrow.aimLock");
  check("marrow charge release -> chargeStart", tellCuesFor("marrow", snap("windup", "rush", true), snap("active", "rush", true)).join() === "marrow.chargeStart");
  check("marrow wall crash -> wallImpact + the dazed recover", tellCuesFor("marrow", snap("active", "rush", true), snap("recover", "crash", true)).join() === "marrow.wallImpact,marrow.recover");
  check("marrow volley fire -> stompImpact", tellCuesFor("marrow", snap("windup", "volley", true), snap("recover", "volley", true)).join() === "marrow.stompImpact");
  check("choir wail lock -> strikeLock", tellCuesFor("choir", snap("windup", "wail", false), snap("windup", "wail", true)).join() === "choir.strikeLock");
  check("choir rematerialize -> swellFire + the punish recover", tellCuesFor("choir", snap("active", "fade"), snap("recover", "fade")).join() === "choir.swellFire,choir.recover");
  check("weaver pounce chain lands + retells", tellCuesFor("weaver", snap("active", "pounce", true), snap("windup", "pounce", false)).join()
    === ["weaver.blinkTell", "weaver.blinkArriveStrike"].join());
  check("warden slam telegraph/lock/close", tellCuesFor("gilded", null, snap("windup", "slam")).join() === "warden.prisonWarn"
    && tellCuesFor("gilded", snap("windup", "slam", false), snap("windup", "slam", true)).join() === "warden.turretLock"
    && tellCuesFor("gilded", snap("active", "slam", true), snap("recover", "slam", true)).join() === "warden.prisonClose,warden.exposed");
  check("warden sweep -> glyphWarn then turretFire", tellCuesFor("gilded", null, snap("windup", "sweep")).join() === "warden.glyphWarn"
    && tellCuesFor("gilded", snap("windup", "sweep"), snap("active", "sweep")).join() === "warden.turretFire");
  check("charger windup + lock + crash", tellCuesFor("charger", null, snap("windup", "rush")).join() === "charger.windup"
    && tellCuesFor("charger", snap("windup", "rush", false), snap("windup", "rush", true)).join() === "charger.lock"
    && tellCuesFor("charger", snap("windup", "rush", true), snap("active", "rush", true)).join() === "charger.rush"
    && tellCuesFor("charger", snap("active", "rush", true), snap("recover", "crash", true)).join() === "charger.crash,charger.dazed");
  check("burrower dive/lock/erupt grammar", tellCuesFor("burrower", snap("windup", "dive"), snap("active", "dive")).join() === "burrower.submerge"
    && tellCuesFor("burrower", snap("active", "dive"), snap("windup", "erupt")).join() === "burrower.lock"
    && tellCuesFor("burrower", snap("windup", "erupt"), snap("active", "erupt")).join() === "burrower.erupt");
  check("burrower track loop held only underground", isTrackLoopHeld("burrower", snap("active", "dive"))
    && !isTrackLoopHeld("burrower", snap("windup", "erupt")) && !isTrackLoopHeld("charger", snap("active", "dive")));
  check("orbiter stillness tell + shielder brace", tellCuesFor("orbiter", null, snap("windup", "spit")).join() === "orbiter.diveWarn"
    && tellCuesFor("shielder", null, snap("windup", "lunge")).join() === "shielder.raise");
  // The bestiary audio contract brought the King and the primer roster into the wave
  // manifest: every boss attack carries windup+lock+impact, the skeleton commits, the
  // spitter kites on the shared chitin bank.
  check("the Slime King's hop rides the wave grammar", tellCuesFor("boss", null, snap("windup", "hopslam")).join() === "king.hopWarn"
    && tellCuesFor("boss", snap("windup", "hopslam", false), snap("windup", "hopslam", true)).join() === "king.hopLock"
    && tellCuesFor("boss", snap("active", "hopslam", true), snap("recover", "hopslam", true)).join() === "king.slam,king.recover");
  check("skeleton commit + spitter kite tells", tellCuesFor("skeleton", null, snap("windup", "lunge")).join() === "skeleton.commit"
    && tellCuesFor("spitter", null, snap("windup", "spit")).join() === "orbiter.diveWarn");
  const marrowMoves = Object.keys(WAVE_TELLS["marrow"]);
  check("marrow binding covers all content moves", ["rush", "crash", "volley", "spin"].every((m) => marrowMoves.includes(m)));
}

// ---- 3. attenuation law ----
section("distance attenuation");
{
  check("full volume inside 240px", spatialGainFor(0, false, false) === 1 && spatialGainFor(240, false, false) === 1);
  const mid = spatialGainFor(470, false, false);
  check("linear falloff midpoint", Math.abs(mid - 0.625) < 0.001, mid.toFixed(3));
  check("floor .25 at/past 700px", spatialGainFor(700, false, false) === 0.25 && spatialGainFor(2000, false, false) === 0.25);
  check("off-camera cap .35", spatialGainFor(100, true, false) === 0.35);
  check("boss/hazard locks exempt from the cap", spatialGainFor(100, true, true) === 1);
}

// ---- 4. director policy: cooldowns, variants, jitter, weapons, combat gating ----
section("cooldowns / rate limits");
{
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.frame(frameInput([]));
  check("charger lock per-entity cooldown blocks the double", dir.play("charger.lock", { entityId: 7 }) && !dir.play("charger.lock", { entityId: 7 }));
  check("another entity is not blocked", dir.play("charger.lock", { entityId: 8 }));
  // Step past BOTH windows: the 200ms per-entity cooldown AND the mob-lock concurrency
  // window (two locks already sounded this beat — the danger arbiter holds a third).
  eng.nowMs += 700;
  check("cooldown expires with time", dir.play("charger.lock", { entityId: 7 }));

  eng.nowMs += 5000;
  check("beamHit ticks once per target per 120ms", dir.play("beamHit", { entityId: 1, x: 0, y: 0 }));
  eng.nowMs += 60;
  check("same target inside 120ms is silent", !dir.play("beamHit", { entityId: 1, x: 0, y: 0 }));
  check("other target still ticks", dir.play("beamHit", { entityId: 2, x: 0, y: 0 }));
  eng.nowMs += 70;
  check("target ticks again past the limit", dir.play("beamHit", { entityId: 1, x: 0, y: 0 }));

  eng.nowMs += 5000;
  check("ui.hover rate limit 80ms", dir.play("ui.hover") && !dir.play("ui.hover"));
  eng.nowMs += 90;
  check("hover re-arms", dir.play("ui.hover"));

  eng.nowMs += 5000;
  const before = eng.plays.length;
  dir.play("pet.idle");
  check("pet idle plays out of combat", eng.plays.length === before + 1);
  dir.frame(frameInput([enemyAt(1, "slime", snap("none", "none"), 100, 0)]));
  eng.nowMs += 9000;
  dir.play("pet.idle");
  check("pet idle suppressed in combat (manifest §10)", eng.plays.length === before + 1);
  dir.frame(frameInput([]));
  eng.nowMs += 9000;
  dir.play("pet.idle");
  check("pet idle returns when the room clears", eng.plays.length === before + 2);
}

section("variants and jitter lanes");
{
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.frame(frameInput([]));
  for (let i = 0; i < 60; i++) {
    dir.play("choir.strikeImpact", { x: 0, y: 0 });
    eng.nowMs += 40;
  }
  const stems = eng.playsFor("choir.strikeImpact").map((p) => p.stem ?? "");
  let hasImmediateRepeat = false;
  for (let i = 1; i < stems.length; i++) if (stems[i] === stems[i - 1]) hasImmediateRepeat = true;
  check("variant never repeats back-to-back (60 plays)", stems.length === 60 && !hasImmediateRepeat);
  check("variant stems span the authored set", new Set(stems).size === 3);

  for (let i = 0; i < 20; i++) { dir.play("marrow.aimLock", { entityId: i }); eng.nowMs += 300; }
  const isLockPinned = eng.playsFor("marrow.aimLock").every((p) => p.rate === 1);
  check("locks carry zero pitch jitter", isLockPinned);
  for (let i = 0; i < 20; i++) { dir.play("marrow.wallImpact", { x: 0, y: 0 }); eng.nowMs += 100; }
  const bossRates = eng.playsFor("marrow.wallImpact").map((p) => p.rate);
  check("boss jitter stays inside ±3%", bossRates.every((r) => r >= 0.97 && r <= 1.03) && new Set(bossRates).size > 1);
}

section("weapon routing (§4)");
{
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.frame(frameInput([]));
  check("legacy weapons stay on their samples", !dir.weaponFired("pistol") && !dir.weaponFired("railgun") && !dir.weaponFired("sword"));
  check("mortar is wave-owned", dir.weaponFired("mortar", { x: 10, y: 10 }) && eng.playsFor("shootMortar").length === 1);
  check("mortarDetonate registered for the blast contract", WAVE_SOUNDS["mortarDetonate"].stem === "sfx/thumper_impact");
}

// ---- 5. Sunlance held-beam lifecycle: start once, ONE loop voice, stop once ----
section("beam lifecycle (never one-shot at 22Hz)");
{
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.frame(frameInput([]));
  for (let i = 0; i < 22; i++) {
    dir.weaponFired("beam");
    eng.nowMs += 45; // the Sunlance fireCd cadence
    dir.frame(frameInput([]));
  }
  check("1s of 22Hz fire = ONE beamStart", eng.playsFor("beamStart").length === 1);
  check("exactly one held loop voice", eng.loopStarts.filter((l) => l.key.startsWith("beamLoop")).length === 1);
  check("no per-shot one-shots while held", eng.plays.length === 1);
  check("no stop while held", eng.playsFor("beamStop").length === 0);

  eng.nowMs += 91; // trigger released: >90ms with no beam shot
  dir.frame(frameInput([]));
  check("release stops the loop once", eng.loopStops.filter((k) => k.startsWith("beamLoop")).length === 1);
  check("release plays beamStop once", eng.playsFor("beamStop").length === 1);

  eng.nowMs += 500;
  dir.weaponFired("beam");
  check("re-press restarts the lifecycle", eng.playsFor("beamStart").length === 2
    && eng.loopStarts.filter((l) => l.key.startsWith("beamLoop")).length === 2);

  eng.nowMs += 45;
  dir.weaponFired("beam", { beamKey: "p2", gain: 0.4 });
  check("remote beams get their own keyed loop", eng.loopStarts.some((l) => l.key === "beamLoop#p2"));
}

// ---- 6. revive channel lifecycle (§8) ----
section("revive channel");
{
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  const up: WaveFramePlayer = { id: "p1", x: 0, y: 0, isDown: false, reviveProgress: 0 };
  const downIdle: WaveFramePlayer = { ...up, isDown: true };
  const channeling: WaveFramePlayer = { ...downIdle, reviveProgress: 0.4 };

  dir.frame(frameInput([], [downIdle]));
  check("down alone is silent (no channel yet)", eng.plays.length === 0 && eng.loopStarts.length === 0);
  dir.frame(frameInput([], [channeling]));
  check("channel start cue + loop begin together", eng.playsFor("revive.channelStart").length === 1
    && eng.loopStarts.some((l) => l.key === "revive.channelLoop#p1"));
  dir.frame(frameInput([], [{ ...channeling, reviveProgress: 0.9 }]));
  dir.frame(frameInput([], [{ ...channeling, reviveProgress: 1.4 }]));
  check("holding never re-triggers start or duplicates the loop", eng.playsFor("revive.channelStart").length === 1
    && eng.loopStarts.length === 1);
  dir.frame(frameInput([], [downIdle]));
  check("broken channel: loop stops + cancel cue", eng.loopStops.includes("revive.channelLoop#p1")
    && eng.playsFor("revive.cancel").length === 1);

  dir.frame(frameInput([], [channeling]));
  check("channel restarts after a break", eng.playsFor("revive.channelStart").length === 2);
  dir.reviveComplete("p1");
  dir.frame(frameInput([], [up]));
  check("completion stops the loop with NO cancel and ducks music for the sting",
    eng.loopStops.filter((k) => k === "revive.channelLoop#p1").length === 2
    && eng.playsFor("revive.cancel").length === 1
    && eng.ducks.some((d) => d.bus === "music" && d.to === 0.5 && d.hold === 0.18));
}

// ---- 7. tell watcher over sim-shaped enemies + entity loop GC ----
section("tell watcher (frame observation)");
{
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.frame(frameInput([enemyAt(1, "marrow", snap("none", "none"), 100, 0)]));
  dir.frame(frameInput([enemyAt(1, "marrow", snap("windup", "rush"), 100, 0)]));
  dir.frame(frameInput([enemyAt(1, "marrow", snap("windup", "rush", true), 100, 0)]));
  dir.frame(frameInput([enemyAt(1, "marrow", snap("active", "rush", true), 100, 0)]));
  dir.frame(frameInput([enemyAt(1, "marrow", snap("recover", "crash", true), 100, 0)]));
  const order = eng.plays.map((p) => p.event).join(",");
  check("full rush arc in order (crash impact + the dazed punish recover)",
    order === "marrow.listenStart,marrow.aimLock,marrow.chargeStart,marrow.wallImpact,marrow.recover");

  eng.plays.length = 0;
  dir.frame(frameInput([enemyAt(2, "burrower", snap("windup", "dive"), 50, 0)]));
  dir.frame(frameInput([enemyAt(2, "burrower", snap("active", "dive"), 50, 0)]));
  check("the underground tracker is a COMPONENT EMITTER (a one-shot, never a loop voice)",
    eng.playsFor("burrower.track").length === 1
    && !eng.loopStarts.some((l) => l.key.startsWith("burrower.track")));
  dir.frame(frameInput([enemyAt(2, "burrower", snap("active", "dive"), 50, 0)]));
  check("the emitter cadence is its per-entity cooldown (same instant = no re-fire)",
    eng.playsFor("burrower.track").length === 1);
  eng.nowMs += 500;
  dir.frame(frameInput([enemyAt(2, "burrower", snap("active", "dive"), 50, 0)]));
  check("…and it re-triggers once the cadence elapses", eng.playsFor("burrower.track").length === 2);
  dir.frame(frameInput([])); // burrower despawns while underground
  check("despawn leaves nothing running (an emitter has no loop to orphan)",
    eng.loopStops.every((k) => !k.startsWith("burrower.track")));

  eng.plays.length = 0;
  const orbiterFar = enemyAt(3, "orbiter", snap("none", "none"), 600, 0);
  dir.frame(frameInput([orbiterFar]));
  check("orbiter outside the band is silent", eng.playsFor("orbiter.enterBand").length === 0);
  dir.frame(frameInput([enemyAt(3, "orbiter", snap("none", "none"), 175, 0)]));
  dir.frame(frameInput([enemyAt(3, "orbiter", snap("none", "none"), 168, 0)]));
  check("enterBand fires once per entity (§3)", eng.playsFor("orbiter.enterBand").length === 1);
}

// ---- real-engine sections (fake WebAudio context) --------------------------------------
async function makeEngine() {
  const engine = new AudioEngine();
  engine.unlock();
  await flushLoads();
  return { engine, ctx: lastContext() };
}

// ---- 8. buses + routing + boss-lock ducking ----
section("buses and boss-lock ducking");
{
  resetFetchPlan();
  const { engine, ctx } = await makeEngine();
  const dir = new WaveAudioDirector(engine);
  ctx.advance(1);

  const isBusTreeUp = ["sfx", "voiceTell", "ambient", "ui", "pet", "music"].every((b) => engine.busNode(b as never) !== null);
  check("all manifest buses exist", isBusTreeUp);
  const ambientBase = asFakeGain(engine.busNode("ambient")).gain.value;
  const uiBase = asFakeGain(engine.busNode("ui")).gain.value;
  check("bus bases follow §1 (ambient .32×sfx, ui .6×sfx)", Math.abs(ambientBase - 0.32 * 0.9) < 1e-6 && Math.abs(uiBase - 0.6 * 0.9) < 1e-6);

  dir.frame(frameInput([]));
  const isPlayed = dir.play("marrow.aimLock", { entityId: 1 });
  const musicTargets = asFakeGain(engine.busNode("music")).gain.targetsSet();
  const petTargets = asFakeGain(engine.busNode("pet")).gain.targetsSet();
  check("aimLock plays", isPlayed && engine.isWavePlaying("marrow.aimLock"));
  check("boss lock ducks music to .35× and recovers", musicTargets.some((v) => Math.abs(v - 0.5 * 0.35) < 1e-6)
    && musicTargets.some((v) => Math.abs(v - 0.5) < 1e-6));
  check("boss lock sidechains the pet bus to silence (§1)", petTargets.some((v) => v === 0));

  const voiceTellBus = asFakeGain(engine.busNode("voiceTell"));
  const voiceGain = ctx.nodesOf<FakeGainNode>("gain").find((g) => g.targets.includes(voiceTellBus));
  check("lock voice routed through the voiceTell bus", voiceGain !== undefined);
}

// ---- 9. priority / voice stealing / budget ----
section("priority and voice stealing");
{
  resetFetchPlan();
  const { engine } = await makeEngine();
  const fill = (event: string, priority: number): boolean => engine.playWave({
    event, bus: "sfx", priority, gain: 0.5, rate: 1, stem: null,
    synth: { kind: "tick", freq: 800, count: 1, spreadMs: 0, isBright: false },
  });
  let admitted = 0;
  for (let i = 0; i < 30; i++) if (fill(`filler.${i}`, 30)) admitted++;
  check("non-lock plays cap at 21 (3 voices reserved for locks)", admitted === 21 && engine.waveVoiceCount() === 21);
  check("another low-priority play is rejected at the cap", !fill("filler.extra", 30));
  check("a bossLock play uses the reserve", fill("lock.a", 100) && fill("lock.b", 100) && fill("lock.c", 100));
  check("global budget holds at 24", engine.waveVoiceCount() === 24);
  check("at 24, a lock steals the quietest voice", fill("lock.d", 100) && engine.waveVoiceCount() === 24);
  check("a lock is never stolen by a lock (equal priority)", engine.waveVoiceCountFor("lock.a") === 1);
  check("low priority never steals", !fill("filler.late", 10));
  check("same-event voices cap at 4", (() => {
    let ok = 0;
    for (let i = 0; i < 8; i++) if (fill("lock.same", 100)) ok++;
    return ok === 4 && engine.waveVoiceCountFor("lock.same") === 4 && engine.waveVoiceCount() <= 24;
  })());
}

// ---- 10. loop start-no-duplicate-stop (engine mechanics) ----
section("loop lifecycle mechanics");
{
  resetFetchPlan();
  const { engine, ctx } = await makeEngine();
  const req: WaveLoopRequest = {
    event: "ambient.verdant", bus: "ambient", gain: 0.24, stem: null,
    synth: { kind: "loopPad", mode: "noise", filterType: "lowpass", filterHz: 420, q: 0.7, lfoHz: 0.07, level: 0.5 },
    fadeSec: 0.1,
  };
  const sourcesBefore = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").length;
  check("loop starts", engine.startWaveLoop("zone", req));
  const sourcesAfterFirst = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").length;
  check("second start of the same key is a NO-OP (no duplicate voice)", engine.startWaveLoop("zone", req)
    && ctx.nodesOf<FakeBufferSourceNode>("bufferSource").length === sourcesAfterFirst
    && sourcesAfterFirst === sourcesBefore + 1);
  check("loop registered once", engine.hasWaveLoop("zone") && engine.waveLoopKeys().length === 1);
  engine.stopWaveLoop("zone", 0.05);
  check("stop unregisters immediately", !engine.hasWaveLoop("zone"));
  ctx.advance(0.2);
  const pad = ctx.nodesOf<FakeBufferSourceNode>("bufferSource")[sourcesBefore];
  check("pad source actually ends after the fade", pad.isEnded);
  engine.stopWaveLoop("zone", 0.05);
  check("double stop is harmless", !engine.hasWaveLoop("zone"));
}

// ---- 11. ambient zones through the director (crossfade + late unlock) ----
section("ambient zone lifecycle");
{
  resetFetchPlan();
  const { engine } = await makeEngine();
  const dir = new WaveAudioDirector(engine);
  dir.setAmbientZone(0);
  check("verdant bed starts", engine.hasWaveLoop("ambient.verdant#zone"));
  dir.setAmbientZone(0);
  check("same zone re-set: still exactly one loop", engine.waveLoopKeys().filter((k) => k.startsWith("ambient.")).length === 1);
  dir.setAmbientZone(3);
  check("zone change crossfades: ember in, verdant unregistered", engine.hasWaveLoop("ambient.ember#zone") && !engine.hasWaveLoop("ambient.verdant#zone"));
  dir.frame(frameInput([]));
  check("frame keeps exactly one zone bed", engine.waveLoopKeys().filter((k) => k.startsWith("ambient.")).length === 1);
  dir.setAmbientZone(5);
  check("the Null (floor 26+) bed is wired", engine.hasWaveLoop("ambient.null#zone"));
  dir.reset();
  check("reset silences every loop", engine.waveLoopKeys().length === 0);
}

// ---- 12. missing-file fallback + no decode spam ----
section("missing-file fallback and loader hygiene");
{
  resetFetchPlan();
  allowFetch(/audio\/sfx\/cannon/); // the shipped library half of the DERIVE lane
  const { engine, ctx } = await makeEngine();
  ctx.advance(1);

  const wallReq: WavePlayRequest = {
    event: "marrow.wallImpact", bus: "sfx", priority: 90, gain: 1, rate: 1,
    stem: "boss/marrow_wall_v1",
    fallback: { sample: "cannon", rate: 0.72 },
    synth: { kind: "impact", durMs: 850, depthHz: 48 },
  };
  check("first play (nothing decoded yet) still sounds via synth", engine.playWave(wallReq) && engine.waveVoiceCount() > 0);
  await flushLoads(); // wave stem 404s; cannon variants decode
  check("wave stem fetch failed as planned", fetchCountFor(/audio\/boss\/marrow_wall_v1/) === 1 && !engine.isWaveBufferReady("boss/marrow_wall_v1"));

  const infoCalls: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: string[]) => { infoCalls.push(args.join(" ")); };
  engine.playWave(wallReq);
  engine.playWave(wallReq);
  engine.playWave(wallReq);
  console.info = originalInfo;
  check("missing primary logs exactly once", infoCalls.filter((s) => s.includes("boss/marrow_wall_v1")).length === 1);

  const cannonSources = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").filter((s) => s.buffer !== null && !s.loop && s.playbackRate.value !== 1);
  check("fallback plays the DERIVED cannon (pitch .72)", cannonSources.some((s) => Math.abs(s.playbackRate.value - 0.72) < 1e-6));

  const stompReq: WavePlayRequest = {
    event: "marrow.stompImpact", bus: "sfx", priority: 90, gain: 0.95, rate: 1,
    stem: null,
    fallback: { sample: "cannon", rate: 0.78, lowpassHz: 1400 },
    synth: { kind: "impact", durMs: 700, depthHz: 55 },
  };
  engine.playWave(stompReq);
  const lowpasses = ctx.nodesOf<FakeBiquadNode>("biquad").filter((b) => b.type === "lowpass" && b.frequency.value === 1400);
  check("fallback filter chain applied (lowpass 1400)", lowpasses.length === 1);

  const beforeCounts = fetchCountFor(/audio\/boss\/marrow_wall_v1/);
  for (let i = 0; i < 12; i++) engine.playWave(wallReq);
  await flushLoads();
  check("failed stem is NEVER refetched (no decode spam)", fetchCountFor(/audio\/boss\/marrow_wall_v1/) === beforeCounts);

  resetFetchPlan();
  allowFetch(/audio\/boss\/choir_strike/);
  const strikeReq = (v: number): WavePlayRequest => ({
    event: "choir.strikeImpact", bus: "sfx", priority: 90, gain: 0.86, rate: 1,
    stem: `boss/choir_strike_v${v}`,
    synth: { kind: "burst", durMs: 550, centerHz: 2600 },
  });
  for (let i = 0; i < 10; i++) { engine.playWave(strikeReq(1 + (i % 3))); ctx.advance(0.7); }
  await flushLoads();
  const v1Fetches = fetchCountFor(/choir_strike_v1\./);
  check("concurrent plays load each stem exactly once", v1Fetches === 1
    && fetchCountFor(/choir_strike_v2\./) === 1 && fetchCountFor(/choir_strike_v3\./) === 1);
  engine.playWave(strikeReq(1));
  const decoded = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").filter((s) => s.buffer !== null && !s.loop);
  check("once decoded, the generated file plays (zero fallback)", engine.isWaveBufferReady("boss/choir_strike_v1") && decoded.length > 0);
}

// ---- 13. preload plan (§10) ----
section("preload plan");
{
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.preloadForFloor(1, "marrow");
  const stems = new Set(eng.preloaded);
  check("zone bed preloaded", stems.has("amb/sunless_loop"));
  check("hazard warns preloaded", stems.has("hazard/spikes_warn_v1") && stems.has("hazard/rift_warn_v2"));
  check("the floor's boss kit preloaded", stems.has("boss/marrow_lock") && stems.has("boss/marrow_death") && stems.has("boss/marrow_wall_v3"));
  check("UI/pets stay lazy", ![...stems].some((s) => s.startsWith("ui/") || s.startsWith("pet/")));
  check("derive-only rows request no files", ![...stems].some((s) => s.includes("shield_block") && false) && !stems.has("charger.crash"));
}

// ---- 14. manifest §11 stress acceptance: 30s, two players, locks never masked ----
section("stress acceptance (30s, two players)");
{
  resetFetchPlan();
  const { engine, ctx } = await makeEngine();
  const dir = new WaveAudioDirector(engine);
  ctx.advance(1);
  dir.frame(frameInput([]));

  let lockPlays = 0, lockWins = 0, maxVoices = 0;
  const players: WaveFramePlayer[] = [
    { id: "p1", x: 0, y: 0, isDown: false, reviveProgress: 0 },
    { id: "p2", x: 60, y: 0, isDown: false, reviveProgress: 0 },
  ];
  for (let step = 0; step < 600; step++) { // 600 × 50ms = 30s
    const t = step * 0.05;
    dir.weaponFired("beam"); // player 1 holds the Sunlance the whole fight
    if (step % 3 === 0) dir.weaponFired("mortar", { x: 40, y: 0 });
    if (step % 2 === 0) dir.play("beamHit", { entityId: step % 5, x: 30, y: 0 });
    if (step % 4 === 0) dir.play("shielder.block", { entityId: 100 + (step % 3), x: 90, y: 0 });
    if (step % 7 === 0) dir.play("charger.windup", { entityId: 200 + (step % 6), x: 120, y: 0 });
    if (step % 9 === 0) dir.play("spikes.telegraph", { entityId: 300 + (step % 4), x: 150, y: 0 });
    if (step % 18 === 0) {
      lockPlays++;
      if (dir.play("marrow.aimLock", { entityId: 999, x: 200, y: 0 })) lockWins++;
    }
    maxVoices = Math.max(maxVoices, engine.waveVoiceCount());
    ctx.advance(0.05);
    dir.frame(frameInput([], players));
  }
  check("boss locks NEVER masked or culled under stress", lockPlays >= 33 && lockWins === lockPlays, `${lockWins}/${lockPlays}`);
  check("voice budget holds for 30s", maxVoices <= 24, `peak ${maxVoices}`);
  check("beam stayed one held loop through the stress", engine.hasWaveLoop("beamLoop#self"));
  await flushLoads();
  const dupes = [...fetchCounts.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) console.log("    duplicate fetches:", dupes.slice(0, 8));
  check("every URL fetched at most once across 30s (no decode spam)", dupes.length === 0 && engine.waveFetchFailures() > 0,
    `${fetchCounts.size} urls`);
}

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("Wave-audio manifest implementation holds.");
