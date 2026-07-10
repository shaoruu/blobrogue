// Wave-audio suite: proves the manifest implementation's contracts headlessly —
// trigger mapping, loop start/no-duplicate/stop, priority + voice stealing, boss-lock
// ducking, cooldown/rate limits, loader hygiene (no decode spam), the manifest's 30s
// stress acceptance, and the AUTHORED-ONLY acceptance from the playtest audio audit:
//   - user-facing play produces ZERO OscillatorNode.start calls and zero programmatic
//     buffers (no runtime synthesis of any kind, even with every audio file missing);
//   - a first trigger never plays a synth stand-in: it is the decoded authored file, the
//     decoded authored safe-reuse fallback, or silence;
//   - every derived-sample rate sits inside the safe band (0.85–1.15) with jitter ≤5%;
//   - variant counts never advertise files that are not actually shipped (all-or-nothing
//     per stem), and every safe-reuse fallback points at a shipped authored sample.
//
// Run: npx tsx test/waveaudio.test.ts

import "./harness/domShim.js";
import {
  installFakeAudio, lastContext, allowFetch, resetFetchPlan, fetchCounts, fetchCountFor,
  flushLoads, asFakeGain, FakeGainNode, FakeBufferSourceNode, FakeBiquadNode,
} from "./harness/fakeAudio.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
installFakeAudio();

const { AudioEngine, SAMPLES } = await import("../src/game/audio.js");
type SfxName = import("../src/game/audio.js").SfxName;
type SampleSpec = import("../src/game/audio.js").SampleSpec;
type WavePlayRequest = import("../src/game/audio.js").WavePlayRequest;
type WaveLoopRequest = import("../src/game/audio.js").WaveLoopRequest;
type WaveEngine = import("../src/game/audio.js").WaveEngine;
type WaveDuck = import("../src/game/waveSpec.js").WaveDuck;
const { WaveAudioDirector } = await import("../src/game/waveAudio.js");
const {
  WAVE_SOUNDS, WAVE_TELLS, WAVE_BOSS_PHASE, WAVE_BOSS_DEATH, WAVE_PRIORITY,
  AMBIENT_ZONE_EVENTS, HAZARD_WAVE_EVENTS, ALWAYS_REACHABLE_EVENTS,
  SAFE_DERIVE_RATE_MIN, SAFE_DERIVE_RATE_MAX,
  BURROW_EMITTER, BURROW_THUD_EVENT, DEEP_EMITTER,
  SELECTED_BURROW_TAKES, SELECTED_DEEP_TAKES, takeStemsOf,
  tellCuesFor, isBurrowUnderground, spatialGainFor, isWaveEventId,
} = await import("../src/game/waveSpec.js");
type WaveSoundSpec = import("../src/game/waveSpec.js").WaveSoundSpec;
type WaveEventId = import("../src/game/waveSpec.js").WaveEventId;
type TellSnapshot = import("../src/game/waveSpec.js").TellSnapshot;
type WaveFrameEnemy = import("../src/game/waveAudio.js").WaveFrameEnemy;
type WaveFramePlayer = import("../src/game/waveAudio.js").WaveFramePlayer;
type WaveListener = import("../src/game/waveAudio.js").WaveListener;

const AUDIO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");

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
  preloadedSamples: SfxName[] = [];
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
  preloadSamples(samples: readonly SfxName[]): void { this.preloadedSamples.push(...samples); }
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

// Variant file stems of a wave spec (selection-driven takes, else derived _vN naming).
function stemsOf(spec: WaveSoundSpec): readonly string[] {
  return takeStemsOf(spec);
}

function sampleStemsOf(spec: SampleSpec): string[] {
  if (spec.variants <= 1) return [spec.id];
  const out: string[] = [];
  for (let v = 1; v <= spec.variants; v++) out.push(`${spec.id}_v${v}`);
  return out;
}

function isSampleShipped(spec: SampleSpec): boolean {
  return sampleStemsOf(spec).every((s) => existsSync(join(AUDIO_ROOT, "sfx", `${s}.ogg`)));
}

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
  for (const [event, spec] of entries) {
    if (spec.variants < 1 || spec.gain <= 0 || spec.gain > 1 || spec.priority < 1 || spec.priority > 100 || spec.jitter < 0 || spec.jitter > 0.06) {
      isAllSane = false;
      console.log(`    bad row: ${event}`);
    }
    for (const file of stemsOf(spec)) {
      if (!/^[a-z]+\/[a-z0-9_]+$/.test(file)) { isStemFormatOk = false; console.log(`    bad stem: ${event} ${file}`); }
      if (stems.has(file)) { hasDuplicateStem = true; console.log(`    duplicate stem: ${file}`); }
      stems.add(file);
    }
    if (spec.priority >= WAVE_PRIORITY.bossLock && !(spec.jitter === 0 && spec.isOffCameraUncapped === true)) isLockLawOk = false;
  }
  check("every row sane (variants/gain/priority/jitter lanes)", isAllSane);
  check("stems are generation-pipeline paths (dir/snake_case)", isStemFormatOk);
  check("no two events share a file stem", !hasDuplicateStem);
  check("boss locks: zero jitter + off-camera uncapped", isLockLawOk);
  check("all six zone loops registered in ladder order", AMBIENT_ZONE_EVENTS.length === 6
    && WAVE_SOUNDS["ambient.verdant"].stem === "amb/verdant_loop"
    && WAVE_SOUNDS["ambient.null"].stem === "amb/null_loop");

  const lock = WAVE_SOUNDS["marrow.aimLock"];
  check("marrow.aimLock matches manifest row", lock.stem === "boss/marrow_lock" && lock.gain === 1.0
    && lock.priority === 100 && lock.duck?.[0].to === 0.35 && lock.duck[0].hold === 0.15 && lock.duck[0].recover === 0.45);
  const block = WAVE_SOUNDS["shielder.block"];
  check("shielder.block derives parry with 120ms limit", block.cooldownMs === 120
    && block.fallback?.sample === "parry" && block.fallback.lowpassHz === 5000);
  check("legacy cue names never collide with wave ids", !isWaveEventId("dash") && !isWaveEventId("enemyHit") && !isWaveEventId("bossSpawn"));
  check("every boss kind maps phase + death", ["marrow", "choir", "weaver", "gilded"].every(
    (k) => WAVE_BOSS_PHASE[k] !== undefined && WAVE_BOSS_DEATH[k] !== undefined));
}

// ---- 1b. authored-only registry laws (playtest audio audit) ----
section("authored-only registry laws (safe rates, shipped variants, shipped fallbacks)");
{
  const entries = Object.entries<WaveSoundSpec>(WAVE_SOUNDS);

  // Safe-derive band: every fallback rate inside [0.85, 1.15]; jitter never widens the
  // effective play rate beyond band × ±5%.
  let isRateLawOk = true;
  let isFallbackShipped = true;
  for (const [event, spec] of entries) {
    const rate = spec.fallback?.rate ?? 1;
    if (rate < SAFE_DERIVE_RATE_MIN || rate > SAFE_DERIVE_RATE_MAX) {
      isRateLawOk = false;
      console.log(`    unsafe derive rate: ${event} @ ${rate}`);
    }
    if (spec.jitter > 0.05) isRateLawOk = false;
    if (spec.fallback) {
      const target = SAMPLES[spec.fallback.sample];
      // A fallback must land on a shipped authored sample, or on a hook whose declared
      // reuse is itself shipped (revive/uiClick) — never on nothing.
      const isShipped = target !== undefined && (isSampleShipped(target)
        || (target.reuse !== undefined && SAMPLES[target.reuse.sample] !== undefined
          && isSampleShipped(SAMPLES[target.reuse.sample]!)));
      if (!isShipped) {
        isFallbackShipped = false;
        console.log(`    fallback not shipped: ${event} -> ${spec.fallback.sample}`);
      }
    }
  }
  check("every fallback rate sits inside the 0.85–1.15 safe band, jitter ≤5%", isRateLawOk);
  check("every fallback resolves to a shipped authored sample (directly or via reuse)", isFallbackShipped);

  // Variant truth: for every stem, either ZERO files are shipped (a pure pending hook)
  // or EVERY advertised variant file is shipped — a trigger never rolls a missing take.
  let isVariantTruthOk = true;
  let pendingHooks = 0;
  for (const [event, spec] of entries) {
    const files = stemsOf(spec);
    if (files.length === 0) continue;
    const present = files.filter((s) => existsSync(join(AUDIO_ROOT, `${s}.ogg`))).length;
    if (present === 0) { pendingHooks++; continue; }
    if (present !== files.length) {
      isVariantTruthOk = false;
      console.log(`    partial variants: ${event} (${present}/${files.length})`);
    }
  }
  check("no partially-shipped variant set is ever advertised", isVariantTruthOk, `${pendingHooks} pure hooks pending generation`);

  // Legacy sample library: every entry is fully shipped, or declares a shipped safe reuse
  // (the revive/uiClick asset hooks) whose rate obeys the same band.
  let isLibraryOk = true;
  for (const [name, spec] of Object.entries<SampleSpec>(SAMPLES as Record<string, SampleSpec>)) {
    if (isSampleShipped(spec)) continue;
    const reuse = spec.reuse !== undefined ? SAMPLES[spec.reuse.sample] : undefined;
    const rate = spec.reuse?.rate ?? 1;
    if (!reuse || !isSampleShipped(reuse) || rate < SAFE_DERIVE_RATE_MIN || rate > SAFE_DERIVE_RATE_MAX) {
      isLibraryOk = false;
      console.log(`    library entry neither shipped nor safely reused: ${name}`);
    }
  }
  check("every SAMPLES entry is shipped or safely reuses a shipped authored sample", isLibraryOk);
  check("revive + uiClick are explicit asset hooks with authored reuse (never oscillators)",
    SAMPLES.revive?.id === "revive" && SAMPLES.revive.reuse?.sample === "heart"
    && SAMPLES.uiClick?.id === "uiClick" && SAMPLES.uiClick.reuse?.sample === "coin");

  // No REACHABLE row is stem-less: everything the game can currently trigger carries a
  // real file hook. (Reachable = tells + boss beats + hazards + zones + weapons/co-op.)
  const reachable = new Set<WaveEventId>();
  for (const kind of Object.keys(WAVE_TELLS)) {
    for (const move of Object.values(WAVE_TELLS[kind])) {
      for (const ev of [move.windup, move.lock, move.active, move.release, move.impact]) {
        if (ev) reachable.add(ev);
      }
    }
  }
  for (const ev of Object.values(WAVE_BOSS_PHASE)) reachable.add(ev);
  for (const ev of Object.values(WAVE_BOSS_DEATH)) reachable.add(ev);
  for (const ev of HAZARD_WAVE_EVENTS) reachable.add(ev);
  for (const ev of AMBIENT_ZONE_EVENTS) reachable.add(ev);
  for (const ev of ALWAYS_REACHABLE_EVENTS) reachable.add(ev);
  reachable.add("orbiter.enterBand");
  for (const ch of BURROW_EMITTER) reachable.add(ch.event);
  reachable.add(BURROW_THUD_EVENT);
  for (const ch of DEEP_EMITTER.channels) reachable.add(ch.event);
  const stemlessReachable = [...reachable].filter((ev) => WAVE_SOUNDS[ev].stem === null
    && WAVE_SOUNDS[ev].takes === undefined && WAVE_SOUNDS[ev].isAuthoredSilence !== true);
  check("no reachable event is hookless (asset hook, take selection, or authored silence)",
    stemlessReachable.length === 0, stemlessReachable.join(","));
  check("the Deep's continuous bed is authored silence (director-decided, no file)",
    WAVE_SOUNDS["ambient.deep"].stem === null && WAVE_SOUNDS["ambient.deep"].isAuthoredSilence === true);

  // Selection manifest law (audio-gen-p0-components/selected_components.json): only
  // SELECTED takes are referenced anywhere; rejected takes and superseded files never.
  const registryText = JSON.stringify(WAVE_SOUNDS);
  const rejected = [
    "burrow_dirt_grind_v1", "burrow_pebble_v3", "burrow_underground_thud_v1",
    "burrow_track", "deep_loop",
    // The retired pre-r4 architecture take ("shift_r4_v1" does not contain this string).
    "deep_architecture_shift_v1",
  ];
  check("rejected/retired takes are referenced nowhere in the registry",
    rejected.every((r) => !registryText.includes(r)), rejected.filter((r) => registryText.includes(r)).join(","));
  check("rejected takes are not on disk",
    !existsSync(join(AUDIO_ROOT, "enemy", "burrow_dirt_grind_v1.ogg"))
    && !existsSync(join(AUDIO_ROOT, "enemy", "burrow_pebble_v3.ogg"))
    && !existsSync(join(AUDIO_ROOT, "enemy", "burrow_underground_thud_v1.ogg"))
    && !existsSync(join(AUDIO_ROOT, "enemy", "burrow_track.ogg"))
    && !existsSync(join(AUDIO_ROOT, "amb", "deep_loop.ogg"))
    && !existsSync(join(AUDIO_ROOT, "amb", "deep_architecture_shift_v1.ogg")));
  check("burrow selection: dirt v2 only, pebble v1+v2, shell v1+v2, thud underground_v2 only",
    stemsOf(WAVE_SOUNDS["burrow.dirtGrind"]).join() === "enemy/burrow_dirt_grind_v2"
    && stemsOf(WAVE_SOUNDS["burrow.pebble"]).join() === "enemy/burrow_pebble_v1,enemy/burrow_pebble_v2"
    && stemsOf(WAVE_SOUNDS["burrow.shellScrape"]).join() === "enemy/burrow_shell_v1,enemy/burrow_shell_v2"
    && stemsOf(WAVE_SOUNDS["burrow.thud"]).join() === "enemy/burrow_underground_thud_v2");
  check("deep FINAL selection: mineral v1+v2, architecture r4_v1+r4_v2, stress = resin_creak_r4_v3, drip r4 v1..v3",
    stemsOf(WAVE_SOUNDS["deep.mineralTick"]).join() === "amb/deep_mineral_tick_v1,amb/deep_mineral_tick_v2"
    && stemsOf(WAVE_SOUNDS["deep.architectureShift"]).join() === "amb/deep_architecture_shift_r4_v1,amb/deep_architecture_shift_r4_v2"
    && stemsOf(WAVE_SOUNDS["deep.resinStress"]).join() === "amb/deep_resin_creak_r4_v3"
    && stemsOf(WAVE_SOUNDS["deep.resinDrip"]).join()
      === "amb/deep_resin_drip_r4_v1,amb/deep_resin_drip_r4_v2,amb/deep_resin_drip_r4_v3");
  check("rows ride the selection arrays verbatim",
    WAVE_SOUNDS["burrow.dirtGrind"].takes === SELECTED_BURROW_TAKES.dirtGrind
    && WAVE_SOUNDS["burrow.pebble"].takes === SELECTED_BURROW_TAKES.pebble
    && WAVE_SOUNDS["burrow.thud"].takes === SELECTED_BURROW_TAKES.thud
    && WAVE_SOUNDS["deep.resinStress"].takes === SELECTED_DEEP_TAKES.resinStress
    && WAVE_SOUNDS["deep.resinDrip"].takes === SELECTED_DEEP_TAKES.resinDrip);
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
  check("burrow underground window: dive-active only", isBurrowUnderground("burrower", snap("active", "dive"))
    && !isBurrowUnderground("burrower", snap("windup", "erupt")) && !isBurrowUnderground("charger", snap("active", "dive")));
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
  check("mortarDetonate registered for the blast contract", WAVE_SOUNDS["mortarDetonate"].stem === "sfx/thumper_impact_v1");
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
  const orbiterFar = enemyAt(3, "orbiter", snap("none", "none"), 600, 0);
  dir.frame(frameInput([orbiterFar]));
  check("orbiter outside the band is silent", eng.playsFor("orbiter.enterBand").length === 0);
  dir.frame(frameInput([enemyAt(3, "orbiter", snap("none", "none"), 175, 0)]));
  dir.frame(frameInput([enemyAt(3, "orbiter", snap("none", "none"), 168, 0)]));
  check("enterBand fires once per entity (§3)", eng.playsFor("orbiter.enterBand").length === 1);
}

// ---- 7b. burrow underground emitter (audio director FINAL: no loop) ----
section("burrow underground emitter (deterministic authored components, no loop)");
{
  const runDig = (): ScriptEngine => {
    const eng = new ScriptEngine();
    const dir = new WaveAudioDirector(eng);
    eng.nowMs = 0;
    dir.frame(frameInput([enemyAt(9, "burrower", snap("windup", "dive"), 60, 0)]));
    for (let t = 50; t <= 10000; t += 50) {
      eng.nowMs = t;
      dir.frame(frameInput([enemyAt(9, "burrower", snap("active", "dive"), 60, 0)]));
    }
    return eng;
  };
  const eng = runDig();
  check("NO loop voice ever starts for a burrowing body", eng.loopStarts.length === 0);

  let isCadenceOk = true;
  const counts: Record<string, number> = {};
  for (const ch of BURROW_EMITTER) {
    const plays = eng.playsFor(ch.event);
    counts[ch.event] = plays.length;
    // Gap law: consecutive plays sit inside [minGap, maxGap] (+one 50ms frame of slack).
    // Play times are unavailable on the request, so bound via counts over the 10s dig.
    const minCount = Math.floor(10 / ch.maxGapSec) - 1;
    const maxCount = Math.ceil(10 / ch.minGapSec) + 1;
    if (plays.length < minCount || plays.length > maxCount) {
      isCadenceOk = false;
      console.log(`    ${ch.event}: ${plays.length} plays outside [${minCount}, ${maxCount}]`);
    }
    if (!plays.every((p) => p.gain === WAVE_SOUNDS[ch.event].gain)) isCadenceOk = false;
  }
  check("each component channel holds its authored cadence and gain over a 10s dig", isCadenceOk,
    Object.entries(counts).map(([k, v]) => `${k.split(".")[1]}=${v}`).join(" "));
  check("pebble ticks faster than dirt, dirt faster than shell scrape",
    counts["burrow.pebble"] > counts["burrow.dirtGrind"] && counts["burrow.dirtGrind"] > counts["burrow.shellScrape"]);
  let hasVariantRepeat = false;
  let isSelectionOnly = true;
  for (const ch of BURROW_EMITTER) {
    const played = eng.playsFor(ch.event).map((p) => p.stem ?? "");
    const allowed = new Set(stemsOf(WAVE_SOUNDS[ch.event]));
    if (!played.every((s) => allowed.has(s))) isSelectionOnly = false;
    for (let i = 1; i < played.length; i++) if (played[i] === played[i - 1] && allowed.size > 1) hasVariantRepeat = true;
  }
  check("deterministic variants never repeat back-to-back (multi-take selections)", !hasVariantRepeat);
  check("only SELECTED takes ever play", isSelectionOnly);
  check("burrow jitter capped at ±3%", BURROW_EMITTER.every((ch) => WAVE_SOUNDS[ch.event].jitter <= 0.03)
    && WAVE_SOUNDS[BURROW_THUD_EVENT].jitter <= 0.03
    && eng.plays.filter((p) => p.event.startsWith("burrow.")).every((p) => p.rate >= 0.97 && p.rate <= 1.03));
  check("no thud while tunnelling (thud is edge-only)", eng.playsFor("burrow.thud").length === 0);

  const eng2 = runDig();
  check("the dig is fully deterministic (two runs, identical sequences)",
    JSON.stringify(eng.plays.map((p) => [p.event, p.stem])) === JSON.stringify(eng2.plays.map((p) => [p.event, p.stem])));

  // Direction-lock: the thud fires exactly once, and the component channels stop.
  const eng3 = new ScriptEngine();
  const dir3 = new WaveAudioDirector(eng3);
  eng3.nowMs = 0;
  dir3.frame(frameInput([enemyAt(9, "burrower", snap("windup", "dive"), 60, 0)]));
  for (let t = 50; t <= 3000; t += 50) {
    eng3.nowMs = t;
    dir3.frame(frameInput([enemyAt(9, "burrower", snap("active", "dive"), 60, 0)]));
  }
  const playsUnderground = eng3.plays.length;
  eng3.nowMs += 50;
  dir3.frame(frameInput([enemyAt(9, "burrower", snap("windup", "erupt"), 60, 0)]));
  check("direction-lock fires the underground thud exactly once (with the lock tell)",
    eng3.playsFor("burrow.thud").length === 1 && eng3.playsFor("burrower.lock").length === 1);
  const playsAtLock = eng3.plays.length;
  for (let t = 0; t <= 4000; t += 50) {
    eng3.nowMs += 50;
    dir3.frame(frameInput([enemyAt(9, "burrower", snap("windup", "erupt"), 60, 0)]));
  }
  check("the emitter stops on erupt (no components after the lock)",
    eng3.plays.length === playsAtLock && playsUnderground > 0);

  // Despawn mid-dig: scheduling stops with the body.
  const eng4 = new ScriptEngine();
  const dir4 = new WaveAudioDirector(eng4);
  eng4.nowMs = 0;
  dir4.frame(frameInput([enemyAt(4, "burrower", snap("windup", "dive"), 60, 0)]));
  for (let t = 50; t <= 2000; t += 50) {
    eng4.nowMs = t;
    dir4.frame(frameInput([enemyAt(4, "burrower", snap("active", "dive"), 60, 0)]));
  }
  const beforeDespawn = eng4.plays.length;
  for (let t = 2050; t <= 6000; t += 50) {
    eng4.nowMs = t;
    dir4.frame(frameInput([]));
  }
  check("despawn stops the emitter (no orphaned scheduling)", eng4.plays.length === beforeDespawn && beforeDespawn > 0);
}

// ---- 7c. the Deep's near-silent positional ambience (FINAL P0 scheduler) ----
section("the Deep: silent bed + weighted-category diegetic emitter");
{
  const byEvent = (ev: string) => DEEP_EMITTER.channels.find((c) => c.event === ev)!;
  check("global cadence: one category opportunity every 1.5–3.2s, max ONE active",
    DEEP_EMITTER.globalMinGapSec === 1.5 && DEEP_EMITTER.globalMaxGapSec === 3.2 && DEEP_EMITTER.maxOverlap === 1);
  check("category table: mineral 35% 2–4.5s .07–.11 / drip 25% 2.5–5s .06–.10 / stress 20% 3.5–6.5s .08–.12 / architecture 20% 5–9s .09–.13",
    Math.abs(DEEP_EMITTER.channels.reduce((s, c) => s + c.weight, 0) - 1) < 1e-9
    && (() => { const c = byEvent("deep.mineralTick"); return c.weight === 0.35 && c.minGapSec === 2 && c.maxGapSec === 4.5 && c.gainMin === 0.07 && c.gainMax === 0.11; })()
    && (() => { const c = byEvent("deep.resinDrip"); return c.weight === 0.25 && c.minGapSec === 2.5 && c.maxGapSec === 5 && c.gainMin === 0.06 && c.gainMax === 0.10; })()
    && (() => { const c = byEvent("deep.resinStress"); return c.weight === 0.20 && c.minGapSec === 3.5 && c.maxGapSec === 6.5 && c.gainMin === 0.08 && c.gainMax === 0.12; })()
    && (() => { const c = byEvent("deep.architectureShift"); return c.weight === 0.20 && c.minGapSec === 5 && c.maxGapSec === 9 && c.gainMin === 0.09 && c.gainMax === 0.13; })());
  check("per-take policy: drip v1 half-weighted; architecture r4_v1 gain ×.8; stress ±2% jitter",
    byEvent("deep.resinDrip").takeWeights?.join() === "0.5,1,1"
    && byEvent("deep.architectureShift").takeGainMult?.join() === "0.8,1"
    && WAVE_SOUNDS["deep.resinStress"].jitter === 0.02);
  check("diegetic placement ring is 160–520px around the camera center",
    DEEP_EMITTER.minDistPx === 160 && DEEP_EMITTER.maxDistPx === 520);

  interface DeepRun {
    eng: ScriptEngine;
    deepPlays: WavePlayRequest[];
    playTimes: number[];
    timesByEvent: Map<string, number[]>;
    candidates: Array<{ x: number; y: number }>;
  }
  const runDeep = (opts: { seed?: number; withLocks?: boolean; acceptCells?: boolean; seconds?: number } = {}): DeepRun => {
    const eng = new ScriptEngine();
    const dir = new WaveAudioDirector(eng);
    dir.setAmbientZone(2, opts.seed ?? 0xD33); // the Deep, deterministic ambient seed
    const playTimes: number[] = [];
    const timesByEvent = new Map<string, number[]>();
    const candidates: Array<{ x: number; y: number }> = [];
    const isMaterialCellAt = (x: number, y: number): boolean => {
      candidates.push({ x, y });
      return opts.acceptCells !== false;
    };
    for (let t = 0; t <= (opts.seconds ?? 60) * 1000; t += 50) {
      eng.nowMs = t;
      const before = eng.plays.length;
      if (opts.withLocks && t >= 20000 && t < 25000 && t % 100 === 0) {
        dir.play("marrow.aimLock", { entityId: t, x: 100, y: 0 }); // fresh entity: no cooldown gate
      }
      dir.frame({ listener: emptyListener, enemies: [], players: [], isMaterialCellAt });
      for (let i = before; i < eng.plays.length; i++) {
        const p = eng.plays[i];
        if (!p.event.startsWith("deep.")) continue;
        playTimes.push(t);
        const arr = timesByEvent.get(p.event) ?? [];
        arr.push(t);
        timesByEvent.set(p.event, arr);
      }
    }
    return { eng, deepPlays: eng.plays.filter((p) => p.event.startsWith("deep.")), playTimes, timesByEvent, candidates };
  };

  const quiet = runDeep();
  check("the Deep never starts a bed loop (authored silence)",
    quiet.eng.loopStarts.every((l) => !l.key.startsWith("ambient.deep")));
  check("sparse minute: roughly one event per global tick, never a stream",
    quiet.deepPlays.length >= 10 && quiet.deepPlays.length <= 40, `${quiet.deepPlays.length} events in 60s`);
  let isGlobalGapOk = true;
  for (let i = 1; i < quiet.playTimes.length; i++) {
    if (quiet.playTimes[i] - quiet.playTimes[i - 1] < DEEP_EMITTER.globalMinGapSec * 1000 - 1e-9) isGlobalGapOk = false;
  }
  check("consecutive events respect the global 1.5s floor (max one active)", isGlobalGapOk);
  let isRearmOk = true;
  for (const ch of DEEP_EMITTER.channels) {
    const times = quiet.timesByEvent.get(ch.event) ?? [];
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < ch.minGapSec * 1000 - 1e-9) isRearmOk = false;
    }
  }
  check("each category holds its own re-arm window (a blocked draw is silence, never a reroll)", isRearmOk);
  const kinds = new Set(quiet.deepPlays.map((p) => p.event));
  check("the minute draws across the full FINAL palette",
    kinds.has("deep.mineralTick") && kinds.has("deep.resinDrip")
    && kinds.has("deep.resinStress") && kinds.has("deep.architectureShift"), [...kinds].join(","));
  let isGainOk = true;
  for (const p of quiet.deepPlays) {
    const ch = byEvent(p.event);
    if (p.gain > ch.gainMax + 1e-9 || p.gain <= 0) isGainOk = false;
  }
  check("every play lands inside its category's authored gain ceiling", isGainOk);
  const archV1 = quiet.deepPlays.filter((p) => p.stem === "amb/deep_architecture_shift_r4_v1");
  check("architecture r4_v1 plays carry the ×.8 gain trim",
    archV1.every((p) => p.gain <= byEvent("deep.architectureShift").gainMax * 0.8 + 1e-9), `${archV1.length} v1 plays`);
  const dripStems = quiet.deepPlays.filter((p) => p.event === "deep.resinDrip").map((p) => p.stem);
  check("drip draws only the r4 takes, half-weighting v1",
    dripStems.every((s) => s !== null && s.startsWith("amb/deep_resin_drip_r4_v"))
    && dripStems.filter((s) => s === "amb/deep_resin_drip_r4_v1").length * 2 <= dripStems.length + 1,
    `${dripStems.length} drips, v1=${dripStems.filter((s) => s === "amb/deep_resin_drip_r4_v1").length}`);
  let isRingOk = true;
  for (const c of quiet.candidates) {
    const d = Math.hypot(c.x - emptyListener.x, c.y - emptyListener.y);
    if (d < DEEP_EMITTER.minDistPx - 1e-6 || d > DEEP_EMITTER.maxDistPx + 1e-6) isRingOk = false;
  }
  check("every placement candidate sits on the 160–520px ring (never listener-centered)",
    isRingOk && quiet.candidates.length > 0);

  const rejected = runDeep({ acceptCells: false });
  check("no valid wall/material cell -> the opportunity is silence (never non-diegetic)",
    rejected.deepPlays.length === 0 && rejected.candidates.length > 0);

  const quiet2 = runDeep();
  check("same ambient seed -> identical sequence (deterministic biome ambient RNG)",
    JSON.stringify(quiet.deepPlays.map((p) => [p.event, p.stem, p.gain]))
    === JSON.stringify(quiet2.deepPlays.map((p) => [p.event, p.stem, p.gain])));
  const otherSeed = runDeep({ seed: 0xF100D });
  check("different floor seed -> a different pattern",
    JSON.stringify(quiet.deepPlays.map((p) => [p.event, p.stem]))
    !== JSON.stringify(otherSeed.deepPlays.map((p) => [p.event, p.stem])));

  const locked = runDeep({ withLocks: true });
  // Locks land every 100ms through [20s, 25s); the mute law re-opens 250ms after the
  // LAST lock (24.9s), i.e. from 25.15s.
  const inLockWindow = locked.playTimes.filter((t) => t >= 20000 && t < 25150).length;
  check("lock/critical cues mute the emitter (±250ms law, zero events through a 5s lock storm)",
    inLockWindow === 0 && locked.playTimes.some((t) => t >= 25150), `${inLockWindow} events in the storm`);

  // Leaving the zone tears the scheduler down.
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.setAmbientZone(2, 0xD33);
  for (let t = 0; t <= 30000; t += 50) { eng.nowMs = t; dir.frame(frameInput([])); }
  const beforeLeave = eng.plays.filter((p) => p.event.startsWith("deep.")).length;
  dir.setAmbientZone(3);
  for (let t = 30050; t <= 60000; t += 50) { eng.nowMs = t; dir.frame(frameInput([])); }
  check("leaving the Deep stops the emitter", beforeLeave > 0
    && eng.plays.filter((p) => p.event.startsWith("deep.")).length === beforeLeave);
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
  allowFetch(/audio\/sfx\/meleeHit/); // the aimLock row's authored safe-reuse fallback
  const { engine, ctx } = await makeEngine();
  const dir = new WaveAudioDirector(engine);
  ctx.advance(1);
  engine.preloadSamples(["meleeHit"]);
  await flushLoads();

  const isBusTreeUp = ["sfx", "voiceTell", "ambient", "ui", "pet", "music"].every((b) => engine.busNode(b as never) !== null);
  check("all manifest buses exist", isBusTreeUp);
  const ambientBase = asFakeGain(engine.busNode("ambient")).gain.value;
  const uiBase = asFakeGain(engine.busNode("ui")).gain.value;
  check("bus bases follow §1 (ambient .32×sfx, ui .6×sfx)", Math.abs(ambientBase - 0.32 * 0.9) < 1e-6 && Math.abs(uiBase - 0.6 * 0.9) < 1e-6);

  dir.frame(frameInput([]));
  const isPlayed = dir.play("marrow.aimLock", { entityId: 1 });
  // Ducks write the category's DUCK node (a multiplier resting at 1.0), never the user
  // slider node — that separation is what keeps slider moves and ducks from clobbering
  // each other's ramps.
  const musicDuckTargets = asFakeGain(engine.duckNode("music")).gain.targetsSet();
  const petDuckTargets = asFakeGain(engine.duckNode("pet")).gain.targetsSet();
  check("aimLock plays through its decoded authored fallback", isPlayed && engine.isWavePlaying("marrow.aimLock"));
  check("boss lock ducks music to .35× and recovers to unity", musicDuckTargets.some((v) => Math.abs(v - 0.35) < 1e-6)
    && musicDuckTargets.some((v) => v === 1));
  check("boss lock sidechains the pet bus to silence (§1)", petDuckTargets.some((v) => v === 0));
  check("ducks never touch the user slider nodes", asFakeGain(engine.busNode("music")).gain.targetsSet().length === 0
    && asFakeGain(engine.busNode("pet")).gain.targetsSet().length === 0);

  const voiceTellBus = asFakeGain(engine.busNode("voiceTell"));
  const voiceGain = ctx.nodesOf<FakeGainNode>("gain").find((g) => g.targets.includes(voiceTellBus));
  check("lock voice routed through the voiceTell bus", voiceGain !== undefined);
}

// ---- 9. priority / voice stealing / budget ----
section("priority and voice stealing");
{
  resetFetchPlan();
  allowFetch(/audio\/sfx\/coin/); // one decoded authored sample carries every filler voice
  const { engine } = await makeEngine();
  engine.preloadSamples(["coin"]);
  await flushLoads();
  const fill = (event: string, priority: number): boolean => engine.playWave({
    event, bus: "sfx", priority, gain: 0.5, rate: 1, stem: null,
    fallback: { sample: "coin" },
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

// ---- 10. loop lifecycle: decoded authored buffers ONLY, start/no-duplicate/stop ----
section("loop lifecycle mechanics (authored buffers only)");
{
  resetFetchPlan();
  allowFetch(/audio\/amb\/verdant_loop/);
  const { engine, ctx } = await makeEngine();
  const req: WaveLoopRequest = {
    event: "ambient.verdant", bus: "ambient", gain: 0.24, stem: "amb/verdant_loop", fadeSec: 0.1,
  };
  const sourcesBefore = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").length;
  check("a loop whose buffer is not decoded does NOT start (silent, load kicked)",
    !engine.startWaveLoop("zone", req) && !engine.hasWaveLoop("zone")
    && ctx.nodesOf<FakeBufferSourceNode>("bufferSource").length === sourcesBefore);
  await flushLoads();
  check("the loop file decoded from the kicked load", engine.isWaveBufferReady("amb/verdant_loop"));
  check("the retry starts the decoded authored loop", engine.startWaveLoop("zone", req) && engine.hasWaveLoop("zone"));
  const sourcesAfterFirst = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").length;
  check("the loop source is the decoded buffer", ctx.nodesOf<FakeBufferSourceNode>("bufferSource")[sourcesAfterFirst - 1].buffer !== null
    && ctx.nodesOf<FakeBufferSourceNode>("bufferSource")[sourcesAfterFirst - 1].loop);
  check("second start of the same key is a NO-OP (no duplicate voice)", engine.startWaveLoop("zone", req)
    && ctx.nodesOf<FakeBufferSourceNode>("bufferSource").length === sourcesAfterFirst);
  check("loop registered once", engine.hasWaveLoop("zone") && engine.waveLoopKeys().length === 1);
  engine.stopWaveLoop("zone", 0.05);
  check("stop unregisters immediately", !engine.hasWaveLoop("zone"));
  ctx.advance(0.2);
  const pad = ctx.nodesOf<FakeBufferSourceNode>("bufferSource")[sourcesAfterFirst - 1];
  check("loop source actually ends after the fade", pad.isEnded);
  engine.stopWaveLoop("zone", 0.05);
  check("double stop is harmless", !engine.hasWaveLoop("zone"));
  const nullStem: WaveLoopRequest = { event: "x", bus: "ambient", gain: 0.2, stem: null, fadeSec: 0.1 };
  check("a stem-less loop request never starts anything", !engine.startWaveLoop("null", nullStem));
}

// ---- 11. ambient zones through the director (decode-gated late start + crossfade) ----
section("ambient zone lifecycle");
{
  resetFetchPlan();
  allowFetch(/audio\/amb\//);
  const { engine } = await makeEngine();
  const dir = new WaveAudioDirector(engine);
  dir.setAmbientZone(0);
  check("zone set before its bed decoded stays silent (no synth pad)", !engine.hasWaveLoop("ambient.verdant#zone"));
  await flushLoads(); // the set kicked the decode
  dir.frame(frameInput([]));
  check("the frame retry starts the decoded bed late (never mid-loop swapped)", engine.hasWaveLoop("ambient.verdant#zone"));
  dir.setAmbientZone(0);
  check("same zone re-set: still exactly one loop", engine.waveLoopKeys().filter((k) => k.startsWith("ambient.")).length === 1);
  dir.setAmbientZone(3);
  await flushLoads();
  dir.frame(frameInput([]));
  check("zone change crossfades: ember in, verdant unregistered", engine.hasWaveLoop("ambient.ember#zone") && !engine.hasWaveLoop("ambient.verdant#zone"));
  dir.frame(frameInput([]));
  check("frame keeps exactly one zone bed", engine.waveLoopKeys().filter((k) => k.startsWith("ambient.")).length === 1);
  dir.setAmbientZone(5);
  await flushLoads();
  dir.frame(frameInput([]));
  check("the Null (floor 26+) bed is wired", engine.hasWaveLoop("ambient.null#zone"));
  dir.reset();
  check("reset silences every loop", engine.waveLoopKeys().length === 0);
}

// ---- 12. missing-file behavior + loader hygiene (no decode spam, no first-use synth) ----
section("missing-file behavior and loader hygiene");
{
  resetFetchPlan();
  allowFetch(/audio\/sfx\/cannon/, /audio\/sfx\/barrel/); // the shipped library half of the DERIVE lane
  const { engine, ctx } = await makeEngine();
  ctx.advance(1);

  const wallReq: WavePlayRequest = {
    event: "marrow.wallImpact", bus: "sfx", priority: 90, gain: 1, rate: 1,
    stem: "boss/marrow_wall_v1",
    fallback: { sample: "cannon", rate: 0.85 },
  };
  // cannon sits in the engine's gesture-time PRELOAD list, so it is already decoded: the
  // first trigger must sound the AUTHORED fallback buffer (never a synth stand-in).
  check("first trigger sounds only a decoded authored buffer (cannon preloaded)",
    engine.playWave(wallReq)
    && ctx.nodesOf<FakeBufferSourceNode>("bufferSource").every((s) => s.startCount === 0 || s.buffer !== null));
  // A row whose fallback sample is NOT preloaded: with nothing decoded the first play is
  // pure silence — it kicks both loads and never substitutes a synth voice.
  const ventReq: WavePlayRequest = {
    event: "fire_vent.active", bus: "sfx", priority: 80, gain: 0.84, rate: 1,
    stem: "hazard/vent_blast_v1",
    fallback: { sample: "barrel", rate: 1.15 },
  };
  const voicesBefore = engine.waveVoiceCount();
  check("first play with nothing decoded is SILENT (never synth) and kicks the loads",
    !engine.playWave(ventReq) && engine.waveVoiceCount() === voicesBefore);
  await flushLoads(); // wave stems 404; cannon/barrel decode
  check("after decode, the same trigger plays the derived authored barrel",
    engine.playWave(ventReq));
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
  check("later plays land the DERIVED authored cannon at the safe rate (0.85)",
    cannonSources.some((s) => Math.abs(s.playbackRate.value - 0.85) < 1e-6));

  const stompReq: WavePlayRequest = {
    event: "marrow.stompImpact", bus: "sfx", priority: 90, gain: 0.95, rate: 1,
    stem: null,
    fallback: { sample: "cannon", rate: 0.85, lowpassHz: 1400 },
  };
  engine.playWave(stompReq);
  const lowpasses = ctx.nodesOf<FakeBiquadNode>("biquad").filter((b) => b.type === "lowpass" && b.frequency.value === 1400);
  check("fallback filter chain applied (lowpass 1400)", lowpasses.length === 1);

  const beforeCounts = fetchCountFor(/audio\/boss\/marrow_wall_v1/);
  for (let i = 0; i < 12; i++) engine.playWave(wallReq);
  await flushLoads();
  check("failed stem is NEVER refetched (no decode spam)", fetchCountFor(/audio\/boss\/marrow_wall_v1/) === beforeCounts);

  // ---- the effect-wave contract post-#45 de-synthesis: NO oscillator lane exists ----
  // A weapon row with a missing stem AND a missing DERIVE sample resolves to SILENCE
  // (never a synth beep); the same row with a SHIPPED DERIVE sample plays the fallback.
  resetFetchPlan(); // nothing allowed: the stem 404s AND the DERIVE sample 404s
  const { engine: strictEngine, ctx: strictCtx } = await makeEngine();
  strictCtx.advance(1);
  const bareReq: WavePlayRequest = {
    event: "shootLastlight", bus: "sfx", priority: 70, gain: 0.85, rate: 1,
    stem: "sfx/lastlight_fire_v1",
    fallback: { sample: "cannon", rate: 1.1 },
  };
  const firstTry = strictEngine.playWave(bareReq);
  await flushLoads(); // both lanes fail
  const beforeVoices = strictEngine.waveVoiceCount();
  const retry = strictEngine.playWave(bareReq);
  check("a weapon row with nothing on disk is SILENCE, never a beep",
    !firstTry && !retry && strictEngine.waveVoiceCount() === beforeVoices);
  const isLoopStarted = strictEngine.startWaveLoop("halo.loop#self", {
    event: "halo.loop", bus: "sfx", gain: 0.3, stem: "sfx/halo_loop", fadeSec: 0.06,
  });
  check("a contract loop never pad-synths (silent until the stem lands)",
    !isLoopStarted && !strictEngine.hasWaveLoop("halo.loop#self"));
  // (The authored-or-DERIVE play path — a missing stem falling to a SHIPPED sample — is
  // proven by the marrow.wallImpact DERIVE-cannon assertions above.)

  resetFetchPlan();
  allowFetch(/audio\/boss\/choir_strike/);
  const strikeReq = (v: number): WavePlayRequest => ({
    event: "choir.strikeImpact", bus: "sfx", priority: 90, gain: 0.86, rate: 1,
    stem: `boss/choir_strike_v${v}`,
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

// ---- 13. preload plan (§10 + first-trigger contract) ----
section("preload plan");
{
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.preloadForFloor(1, "marrow", ["skeleton", "charger", "burrower", "marrow"]);
  const stems = new Set(eng.preloaded);
  const samples = new Set(eng.preloadedSamples);
  check("zone bed preloaded", stems.has("amb/sunless_loop"));
  check("hazard warns preloaded", stems.has("hazard/spikes_warn_v1") && stems.has("hazard/rift_warn_v2"));
  check("the floor's boss kit preloaded", stems.has("boss/marrow_lock") && stems.has("boss/marrow_death") && stems.has("boss/marrow_wall_v3"));
  check("the floor's spawned archetype tells preloaded", stems.has("enemy/charger_warn_v1")
    && stems.has("enemy/charger_crash"));
  check("the burrow emitter's SELECTED takes preloaded (never rejected takes or the track loop)",
    stems.has("enemy/burrow_dirt_grind_v2") && stems.has("enemy/burrow_pebble_v1")
    && stems.has("enemy/burrow_pebble_v2") && stems.has("enemy/burrow_shell_v1")
    && stems.has("enemy/burrow_underground_thud_v2")
    && !stems.has("enemy/burrow_dirt_grind_v1") && !stems.has("enemy/burrow_pebble_v3")
    && !stems.has("enemy/burrow_underground_thud_v1") && !stems.has("enemy/burrow_track"));
  check("player-driven weapon/co-op cues always preloaded", stems.has("sfx/thumper_fire_v1")
    && stems.has("sfx/sunlance_loop") && stems.has("coop/revive_loop"));
  check("authored fallback samples decoded ahead of the first trigger", samples.has("meleeHit")
    && samples.has("cannon") && samples.has("ricochet"));
  check("UI/pets stay lazy", ![...stems].some((s) => s.startsWith("ui/") || s.startsWith("pet/")));

  const deepEng = new ScriptEngine();
  const deepDir = new WaveAudioDirector(deepEng);
  deepDir.preloadForFloor(2, null); // zone 2 = the Deep
  const deepStems = new Set(deepEng.preloaded);
  check("the Deep preloads exactly its FINAL selected takes, never a bed loop or retired take",
    deepStems.has("amb/deep_mineral_tick_v1") && deepStems.has("amb/deep_mineral_tick_v2")
    && deepStems.has("amb/deep_architecture_shift_r4_v1") && deepStems.has("amb/deep_architecture_shift_r4_v2")
    && deepStems.has("amb/deep_resin_creak_r4_v3")
    && deepStems.has("amb/deep_resin_drip_r4_v1") && deepStems.has("amb/deep_resin_drip_r4_v3")
    && !deepStems.has("amb/deep_architecture_shift_v1") && !deepStems.has("amb/deep_loop"));
}

// ---- 14. manifest §11 stress acceptance: 30s, two players, locks never masked ----
section("stress acceptance (30s, two players)");
{
  resetFetchPlan();
  allowFetch(/audio\//); // every authored file shipped: the healthy steady state
  const { engine, ctx } = await makeEngine();
  const dir = new WaveAudioDirector(engine);
  ctx.advance(1);
  dir.preloadForFloor(1, "marrow", ["charger", "shielder"]);
  await flushLoads();
  dir.frame(frameInput([]));

  let lockPlays = 0, lockWins = 0, maxVoices = 0;
  const players: WaveFramePlayer[] = [
    { id: "p1", x: 0, y: 0, isDown: false, reviveProgress: 0 },
    { id: "p2", x: 60, y: 0, isDown: false, reviveProgress: 0 },
  ];
  for (let step = 0; step < 600; step++) { // 600 × 50ms = 30s
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
    if (step === 0) await flushLoads(); // the first triggers kicked the remaining decodes
  }
  check("boss locks NEVER masked or culled under stress", lockPlays >= 33 && lockWins === lockPlays, `${lockWins}/${lockPlays}`);
  check("voice budget holds for 30s", maxVoices <= 24, `peak ${maxVoices}`);
  check("beam stayed one held loop through the stress", engine.hasWaveLoop("beamLoop#self"));
  await flushLoads();
  const dupes = [...fetchCounts.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) console.log("    duplicate fetches:", dupes.slice(0, 8));
  check("every URL fetched at most once across 30s (no decode spam)", dupes.length === 0, `${fetchCounts.size} urls`);
}

// ---- 15. AUTHORED-ONLY acceptance: zero oscillators, zero synthesis, worst case ----
section("authored-only acceptance (zero oscillators even with every file missing)");
{
  resetFetchPlan(); // EVERY fetch 404s: the absolute worst case — a fresh CDN-less checkout
  const { engine, ctx } = await makeEngine();
  const dir = new WaveAudioDirector(engine);
  ctx.advance(1);
  dir.frame(frameInput([]));

  const allSfx: SfxName[] = [
    "shootPistol", "shootShotgun", "shootRapid", "smg", "cannon", "burst", "ricochet",
    "homing", "tesla", "meleeSwing", "meleeHit", "heavySwing", "parry", "crit", "levelup",
    "blessing", "enemyAttack", "enemyHit", "enemyDeath", "playerHurt", "dash", "coin",
    "chest", "barrel", "heart", "weapon", "descend", "floorClear", "bossSpawn", "gameOver",
    "revive", "uiClick",
  ];
  for (const name of allSfx) engine.sfx(name);
  engine.setMusic("dungeon");
  await flushLoads();
  engine.setMusic("boss"); // both tracks 404 -> both stay silent
  await flushLoads();
  for (const name of allSfx) { engine.sfx(name); ctx.advance(0.05); }

  const events = Object.keys(WAVE_SOUNDS) as WaveEventId[];
  for (const event of events) {
    const spec = WAVE_SOUNDS[event];
    if (spec.loop) dir.startLoop(event, "acceptance");
    else dir.play(event, { x: 10, y: 10, entityId: 1 });
    ctx.advance(0.02);
  }
  await flushLoads();
  for (const event of events) {
    const spec = WAVE_SOUNDS[event];
    if (spec.loop) dir.startLoop(event, "acceptance2");
    else dir.play(event, { x: 10, y: 10, entityId: 2 });
    ctx.advance(0.02);
  }
  dir.frame(frameInput([enemyAt(1, "marrow", snap("windup", "rush"), 100, 0)]));
  dir.frame(frameInput([enemyAt(1, "marrow", snap("windup", "rush", true), 100, 0)]));

  check("ZERO OscillatorNode created across every event, twice, with all files 404",
    ctx.nodesOf("oscillator").length === 0);
  check("ZERO programmatic buffers created (no runtime noise/synthesis)",
    ctx.locallyCreatedBuffers === 0);
  const started = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").filter((s) => s.startCount > 0);
  check("every started source carries a DECODED buffer (here: none, so total silence)",
    started.every((s) => s.buffer !== null) && started.length === 0, `${started.length} sources`);
  check("no loop ever started without its authored file", engine.waveLoopKeys().length === 0);
}

// ---- 16. authored-only acceptance: healthy path plays decoded files on first trigger ----
section("authored-only acceptance (preloaded first trigger plays the decoded file)");
{
  resetFetchPlan();
  allowFetch(/audio\//);
  const { engine, ctx } = await makeEngine();
  const dir = new WaveAudioDirector(engine);
  ctx.advance(1);
  dir.preloadForFloor(0, null, ["charger"]);
  await flushLoads();

  const before = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").filter((s) => s.startCount > 0).length;
  check("preloaded shipped cue decoded ahead of play", engine.isWaveBufferReady("enemy/charger_warn_v1"));
  check("the FIRST trigger plays", dir.play("charger.windup", { x: 0, y: 0, entityId: 1 }));
  const sources = ctx.nodesOf<FakeBufferSourceNode>("bufferSource").filter((s) => s.startCount > 0);
  check("…from the decoded authored buffer (no fallback, no synth)",
    sources.length === before + 1 && sources[sources.length - 1].buffer !== null);
  check("zero oscillators on the healthy path too", ctx.nodesOf("oscillator").length === 0
    && ctx.locallyCreatedBuffers === 0);
}

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("Wave-audio manifest implementation holds.");
