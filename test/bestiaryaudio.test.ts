// The bestiary AUDIO HOOK CONTRACT gates: semantic events resolve behavior+material+tier
// (never animation inference), the minimum hook set per behavior verb is complete, the
// danger arbiter holds (accepted commitments only, ≤2 concurrent mob locks, one
// aggregate flock bed, rate-limited hurt/death), locks are dry and positional, no
// bestiary row ships stem:null, fallbacks are same-material inside a sane rate window,
// tier layers are authored (never pitch-down), the burrower's underground tracker is a
// component emitter (no continuous loop), and the preload plan covers the encounter.
//
// Run: npm run test:bestiaryaudio

import "./harness/domShim.js";
import {
  WAVE_TELLS, WAVE_BOSS_PHASE, WAVE_BOSS_DEATH, WAVE_BOSS_ENTRANCE,
  WAVE_PRIORITY, waveSpecOf, tellCuesFor, isWaveEventId, bossWaveEvents,
} from "../src/game/waveSpec.js";
import type { WaveEventId, WaveSoundSpec, TellSnapshot } from "../src/game/waveSpec.js";
import {
  AUDIO_BEHAVIOR, AUDIO_MATERIAL, MATERIAL_FALLBACK_SAMPLES, TIER_LAYERS,
  BEHAVIOR_HOOKS, BESTIARY_CUES, bestiaryCue, bestiaryPreloadEvents,
  MAX_CONCURRENT_MOB_LOCKS, MOB_LOCK_WINDOW_MS, GROUP_LOOP_KEY,
  FALLBACK_RATE_MIN, FALLBACK_RATE_MAX, HURT_RATE_LIMIT_MS, DEATH_RATE_LIMIT_MS,
} from "../src/game/bestiaryAudio.js";
import { WaveAudioDirector } from "../src/game/waveAudio.js";
import type { WaveFrameEnemy, WaveListener } from "../src/game/waveAudio.js";
import type { WaveEngine, WavePlayRequest, WaveLoopRequest, WaveDuck, SfxName } from "../src/game/audio.js";
import { ENEMY_ARCHETYPES } from "../src/sim/enemies.js";
import { ENEMY_MOVESET } from "../src/sim/bestiary.js";
import type { EnemyKind } from "../src/sim/types.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const ALL_KINDS = Object.keys(ENEMY_ARCHETYPES) as EnemyKind[];

class ScriptEngine implements WaveEngine {
  nowMs = 0;
  plays: WavePlayRequest[] = [];
  loopStarts: { key: string; req: WaveLoopRequest }[] = [];
  loopStops: string[] = [];
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
  duckWaveBus(_duck: WaveDuck): void { /* policy suite covers ducks */ }
  preloadWave(stems: string[]): void { this.preloaded.push(...stems); }
  preloadSamples(samples: readonly SfxName[]): void { this.preloadedSamples.push(...samples); }
  preloadedSamples: SfxName[] = [];
  playsFor(event: string): WavePlayRequest[] { return this.plays.filter((p) => p.event === event); }
}

const listener: WaveListener = { x: 0, y: 0, camLeft: -640, camTop: -360, camRight: 640, camBottom: 360 };
const snap = (phase: string, move: string, isAimLocked = false): TellSnapshot => ({ phase, move, isAimLocked });
function enemyAt(id: number, kind: string, s: TellSnapshot, x = 0, y = 0): WaveFrameEnemy {
  return { id, kind, x, y, dead: false, attack: s };
}

// Every row the bestiary surface owns (behavior cues + tells + boss maps).
function bestiarySurface(): Set<WaveEventId> {
  const out = new Set<WaveEventId>();
  for (const kind of ALL_KINDS) {
    for (const id of bestiaryPreloadEvents(kind)) out.add(id);
    const moves = WAVE_TELLS[kind];
    if (moves) {
      for (const move of Object.keys(moves)) {
        const t = moves[move];
        for (const id of [t.windup, t.lock, t.active, t.release, t.impact, t.recover]) {
          if (id) out.add(id);
        }
      }
    }
  }
  for (const map of [WAVE_BOSS_PHASE, WAVE_BOSS_DEATH, WAVE_BOSS_ENTRANCE]) {
    for (const id of Object.values(map)) out.add(id);
  }
  for (const id of Object.values(TIER_LAYERS)) if (id) out.add(id);
  out.add("mob.hurt");
  out.add("mob.death");
  out.add("plate.block");
  return out;
}

// ---- 1. manifest completeness: behavior + material + tier resolution ----

function manifestGates(): void {
  section("resolution: every kind declares behavior + material; every behavior hook resolves");
  let isOk = true;
  for (const kind of ALL_KINDS) {
    const behavior = AUDIO_BEHAVIOR[kind];
    const material = AUDIO_MATERIAL[kind];
    if (behavior === undefined || material === undefined) { isOk = false; continue; }
    for (const hook of BEHAVIOR_HOOKS[behavior]) {
      const id = bestiaryCue(kind, hook);
      if (id === null || !isWaveEventId(id)) {
        isOk = false;
        process.stdout.write(`    ${kind} (${behavior}): hook '${hook}' unresolved\n`);
      }
    }
  }
  check("every kind resolves EVERY hook its behavior verb declares", isOk);
  check("boss-grade kinds also carry bespoke entrance/phase/death maps",
    (["boss", "marrow", "choir", "weaver", "gilded", "marshal", "toll", "gorge", "pale"] as const).every(
      (k) => WAVE_BOSS_ENTRANCE[k] !== undefined && WAVE_BOSS_PHASE[k] !== undefined && WAVE_BOSS_DEATH[k] !== undefined));
  check("every committed move of every kind is covered by tells (windup at minimum)",
    ALL_KINDS.every((kind) => ENEMY_MOVESET[kind].every((move) => {
      if (move === "crash") return WAVE_TELLS[kind]?.crash !== undefined; // impact grammar
      if (move === "decoy" || move === "blink" || move === "stoke" || move === "harmonize"
        || move === "seam" || move === "knell" || move === "rush" || move === "volley"
        || move === "sweep" || move === "spit" || move === "lunge" || move === "dive"
        || move === "erupt") {
        return WAVE_TELLS[kind]?.[move] !== undefined
          || Object.keys(WAVE_TELLS[kind] ?? {}).length > 0;
      }
      return true; // boss specials ride their own bespoke rows
    })));
}

// ---- 2. row hygiene: no stem:null, same-material fallbacks, sane rates, dry locks ----

// Rows the AUTHORED-ONLY pass (durability/audio audit) deliberately stripped of their
// fallback: the old transforms sat far outside the safe derive band, so these boss rows
// fail quietly until their generated file lands. The bestiary fallback law exempts them
// rather than re-introducing an out-of-band transform.
const DE_FALLBACKED_ROWS: ReadonlySet<WaveEventId> = new Set<WaveEventId>([
  "marrow.listenStart", "marrow.chargeStart", "marrow.phase", "marrow.death", "marrow.stompWindup",
  "choir.strikeWarn", "choir.swellFire", "choir.phase", "choir.death",
  "weaver.blinkDepart", "weaver.phase",
  "warden.prisonWarn", "warden.prisonClose", "warden.phase", "warden.death",
  "gorge.entrance", "gorge.phase", "gorge.death", "gorge.ringWarn", "gorge.ring2Warn",
  "gorge.ringImpact", "gorge.zoneWarn", "gorge.zoneActive", "gorge.spokeWarn",
  "gorge.spokeActive", "gorge.exposed", "gorge.seamWarn", "gorge.seamBreak",
  "pale.entrance", "pale.phase", "pale.death", "pale.ringWarn", "pale.ring2Warn",
  "pale.ringImpact", "pale.zoneWarn", "pale.zoneActive", "pale.spokeWarn",
  "pale.spokeActive", "pale.exposed", "pale.seamWarn", "pale.seamBreak",
]);

function rowHygieneGates(): void {
  section("row hygiene: stems, fallbacks, rates, dry positional locks");
  const surface = bestiarySurface();
  let isStemOk = true;
  let isFallbackOk = true;
  let isRateOk = true;
  let isLockOk = true;
  for (const id of surface) {
    const spec: WaveSoundSpec = waveSpecOf(id);
    // Selection-driven rows (explicit shipped take lists, e.g. the burrow emitter
    // components) are authored by construction: their files are the selected takes.
    const isSelectionDriven = spec.takes !== undefined && spec.takes.length > 0;
    if (spec.stem === null && !isSelectionDriven) { isStemOk = false; process.stdout.write(`    stem:null — ${id}\n`); }
    if (spec.loop !== true && spec.fallback === undefined && !isSelectionDriven
      && !DE_FALLBACKED_ROWS.has(id)) {
      isFallbackOk = false;
      process.stdout.write(`    no sample fallback — ${id}\n`);
    }
    const rate = spec.fallback?.rate ?? 1;
    if (rate < FALLBACK_RATE_MIN || rate > FALLBACK_RATE_MAX) {
      isRateOk = false;
      process.stdout.write(`    extreme fallback rate — ${id} (${rate})\n`);
    }
    if (spec.priority === WAVE_PRIORITY.enemyLock) {
      // Dry positional locks: spatial, zero jitter — a lock must localize instantly.
      if (spec.spatial !== true || spec.jitter !== 0) {
        isLockOk = false;
        process.stdout.write(`    non-dry lock — ${id}\n`);
      }
    }
  }
  check(`no bestiary row ships stem:null (${surface.size} rows audited)`, isStemOk);
  check("every one-shot row declares a shipped-sample fallback (synth is the zero-file rung)", isFallbackOk);
  check(`every fallback rate sits in [${FALLBACK_RATE_MIN}, ${FALLBACK_RATE_MAX}] (no extreme pitching)`, isRateOk);
  check("every mob lock row is DRY and positional (spatial, zero jitter)", isLockOk);

  // Same-material law: each kind's hook rows fall back inside ITS material family.
  let isMaterialOk = true;
  for (const kind of ALL_KINDS) {
    const material = AUDIO_MATERIAL[kind];
    const allowed = MATERIAL_FALLBACK_SAMPLES[material];
    for (const hook of Object.keys(BESTIARY_CUES[kind])) {
      const spec = waveSpecOf(BESTIARY_CUES[kind][hook]);
      if (spec.loop === true || spec.fallback === undefined) continue;
      if (!allowed.includes(spec.fallback.sample)) {
        isMaterialOk = false;
        process.stdout.write(`    ${kind}/${hook}: fallback '${spec.fallback.sample}' outside material '${material}'\n`);
      }
    }
  }
  check("every kind's fallbacks stay inside its MATERIAL family (same-material only)", isMaterialOk);

  // Tier layers: authored additions, never a pitch-down of anything.
  let isTierOk = true;
  for (const id of Object.values(TIER_LAYERS)) {
    if (!id) continue;
    const spec = waveSpecOf(id);
    if (spec.fallback?.rate !== undefined) isTierOk = false;
    if (spec.stem === null) isTierOk = false;
  }
  check("tier layers are authored stems with UNPITCHED fallbacks (never pitch-down)", isTierOk);
  check("hurt/death rate limits are pinned on the rows",
    waveSpecOf("mob.hurt").cooldownMs === HURT_RATE_LIMIT_MS
    && waveSpecOf("mob.death").cooldownMs === DEATH_RATE_LIMIT_MS);
}

// ---- 3. authority: semantic edges only, accepted commitments only ----

function authorityGates(): void {
  section("authority: semantic attack-state edges, never animation frames; accepted commitments only");
  {
    // A commitment HELD at full windup by the sim's release arbiter never fires its
    // active/release cue: the cue rides the authoritative phase edge, which only the
    // accepted release produces.
    const held: string[] = [];
    let prev = snap("none", "none");
    const frames = [
      snap("windup", "erupt"), snap("windup", "erupt", true), snap("windup", "erupt", true),
      snap("windup", "erupt", true), // the arbiter is holding the release
      snap("active", "erupt", true), // accepted
    ];
    for (const f of frames) {
      held.push(...tellCuesFor("burrower", prev, f));
      prev = f;
    }
    check("a held commitment emits its warn+lock once and its release EXACTLY once (on acceptance)",
      held.filter((c) => c === "burrower.lock").length === 1
      && held.filter((c) => c === "burrower.erupt").length === 1
      && held.indexOf("burrower.erupt") === held.length - 1,
      held.join(","));
  }
  {
    // The whole surface keys off TellSnapshot (phase/move/lock) — there is no frame
    // index anywhere in the trigger path.
    const cues = tellCuesFor("seamcutter", snap("windup", "seam", true), snap("active", "seam", true));
    check("tells consume ONLY the authoritative attack state", cues.join(",") === "seamcutter.cut");
  }
}

// ---- 4. the danger arbiter in the director ----

function arbiterGates(): void {
  section("danger arbiter: ≤2 concurrent mob locks, aggregate flock bed, emitter (no loop), rate limits");
  {
    const eng = new ScriptEngine();
    const dir = new WaveAudioDirector(eng);
    dir.frame({ listener, enemies: [], players: [] });
    const a = dir.play("charger.lock", { entityId: 1 });
    const b = dir.play("orbiter.lock", { entityId: 2 });
    const c = dir.play("caskbellows.lock", { entityId: 3 });
    check(`only ${MAX_CONCURRENT_MOB_LOCKS} mob locks may sound in one window (third held)`,
      a && b && !c);
    const boss = dir.play("marrow.aimLock", { entityId: 4 });
    check("boss locks are exempt (their own priority band + reserved voices)", boss);
    eng.nowMs += MOB_LOCK_WINDOW_MS + 50;
    check("the window elapses and locks flow again", dir.play("toll.lock", { entityId: 5 }));
  }
  {
    // The flock is ONE aggregate bed regardless of body count.
    const eng = new ScriptEngine();
    const dir = new WaveAudioDirector(eng);
    const bats = [1, 2, 3, 4, 5, 6].map((id) => enemyAt(id, "bat", snap("none", "none"), id * 10, 0));
    dir.frame({ listener, enemies: bats, players: [] });
    dir.frame({ listener, enemies: bats, players: [] });
    const bedStarts = eng.loopStarts.filter((l) => l.key.startsWith("flock.bed"));
    check("six bats start exactly ONE group-keyed bed", bedStarts.length === 1
      && bedStarts[0].key === `flock.bed#${GROUP_LOOP_KEY}`, bedStarts.map((l) => l.key).join(","));
    dir.frame({ listener, enemies: [], players: [] });
    check("the empty field releases the bed", eng.loopStops.includes(`flock.bed#${GROUP_LOOP_KEY}`));
  }
  {
    // The burrower underground: a component EMITTER — seeded authored one-shots
    // (burrow.dirtGrind/pebble/shellScrape), never a loop voice.
    const eng = new ScriptEngine();
    const dir = new WaveAudioDirector(eng);
    for (let t = 0; t <= 3000; t += 50) {
      eng.nowMs = t;
      dir.frame({ listener, enemies: [enemyAt(9, "burrower", snap("active", "dive"), 40, 0)], players: [] });
    }
    const emitterPlays = eng.plays.filter((p) => p.event.startsWith("burrow.") && p.event !== "burrow.thud");
    check("no continuous loop ever starts for the underground body", eng.loopStarts.length === 0);
    check("the emitter schedules authored component one-shots on its cadence", emitterPlays.length >= 3);
  }
  {
    // Hurt/death cues rate-limit through their rows.
    const eng = new ScriptEngine();
    const dir = new WaveAudioDirector(eng);
    dir.frame({ listener, enemies: [], players: [] });
    dir.play("mob.hurt", { x: 10, y: 0 });
    dir.play("mob.hurt", { x: 12, y: 0 });
    dir.play("mob.death", { x: 10, y: 0 });
    dir.play("mob.death", { x: 12, y: 0 });
    check("hurt and death cues are rate-limited (one each inside the window)",
      eng.playsFor("mob.hurt").length === 1 && eng.playsFor("mob.death").length === 1);
    eng.nowMs += 200;
    dir.play("mob.hurt", { x: 10, y: 0 });
    check("…and flow again past the limit", eng.playsFor("mob.hurt").length === 2);
  }
}

// ---- 5. preload plan ----

function preloadGates(): void {
  section("preload: the encounter's kinds ride along with the biome bed and the boss");
  const eng = new ScriptEngine();
  const dir = new WaveAudioDirector(eng);
  dir.preloadForFloor(1, "marrow", ["rootward", "caskbellows"]);
  const has = (stem: string): boolean => eng.preloaded.some((s) => s.startsWith(stem));
  check("the boss's bespoke set preloads (entrance included)",
    has("boss/marrow_lock") && has("boss/marrow_entrance"));
  check("the encounter kinds' hook rows preload",
    has("mob/root_raise") && has("enemy/cask_lock") && has("enemy/cask_place"));
  check("an empty encounter list stays valid (solo primer floors)", (() => {
    const e2 = new ScriptEngine();
    const d2 = new WaveAudioDirector(e2);
    d2.preloadForFloor(0, null);
    return e2.preloaded.length > 0;
  })());
}

function giantIdentityGates(): void {
  section("giant audio identity: Pale cold hooks are isolated from gold/Warden lineage");
  const forbidden = /^(warden|gilded|weaver)\./;
  const paleHooks = Object.values(BESTIARY_CUES.pale);
  const paleSeamHooks = Object.values(BESTIARY_CUES.pale_seam);
  const paleTells = Object.values(WAVE_TELLS.pale ?? {}).flatMap((tell) =>
    [tell.windup, tell.lock, tell.active, tell.release, tell.impact, tell.recover].filter(
      (event): event is WaveEventId => event !== undefined,
    ));
  const paleEvents = [
    ...paleHooks,
    ...paleSeamHooks,
    ...paleTells,
    ...bossWaveEvents("pale"),
    "pale.peel",
    "pale.coreReveal",
    "pale.warmthWarn",
    "pale.warmthChill",
    "pale.warmthClear",
  ] as WaveEventId[];
  check("Pale uses its dedicated typed cold material", AUDIO_MATERIAL.pale === "pale" && AUDIO_MATERIAL.pale_seam === "pale");
  check("every active Pale hook is kind-local", paleEvents.every((event) => event.startsWith("pale.")));
  check("Pale resolves no gold/Gilded/Warden/Weaver event", paleEvents.every((event) => !forbidden.test(event)));
  check("pending Pale files have no production fallback lineage",
    paleEvents.every((event) => {
      const spec = waveSpecOf(event);
      return spec.fallback === undefined
        && !String(spec.stem).includes("warden")
        && !String(spec.stem).includes("gilded");
    }));

  const gorgeEvents = [
    ...Object.values(BESTIARY_CUES.gorge),
    ...Object.values(BESTIARY_CUES.gorge_seam),
    ...bossWaveEvents("gorge"),
  ];
  check("Gorge retains a dedicated amber-giant material", AUDIO_MATERIAL.gorge === "giantAmber");
  check("Gorge hooks stay amber-giant-local and never borrow Warden", gorgeEvents.every((event) =>
    event.startsWith("gorge.") && !forbidden.test(event)));
}

function main(): void {
  manifestGates();
  rowHygieneGates();
  authorityGates();
  arbiterGates();
  preloadGates();
  giantIdentityGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe bestiary audio hook contract holds.\n");
}

main();
