// PVP WAVE 2 · PILLAR B — Ring Weather director (PROTOCOL 48) sim suite.
//
// Proves the Quill FINAL levers for the arena weather director, all in the PURE sim + the wire:
//   - Director cadence: one event at a time on the seeded rotation (tar -> gust -> spark -> repeat),
//     first event at live + 8.0s, then a 10.0s idle gap; sudden death tightens the gap x 0.70
//     (cadence ONLY — never damage/drift).
//   - B2 tar_bloom: 1-2 patches on the forced chokepoints ONLY (never hearth/spawns/pits, H1),
//     hard cap 2, radius 40, life 3.5s, walk x 0.70, ZERO damage.
//   - B1 cinder_gust: 0.75s tell then 1.80s active drift (55 px/s) on mid-band bodies, sheltered by
//     upwind cover (H3); ownerless (never hijacks pit attribution — the Wave 1 env credit window).
//   - B3 spark_mine: annulus 72-110 from the hearth, 0.55s tell, blast r 36, a flat 12 chip + a
//     micro 60 knockback; never under spawn grace/shield, never a one-shot (H2).
//   - Co-op is byte-inert: no weather ever spawns, the director never runs (C1/H4).
//   - Public kill-switch stays OFF (H4); the whole director is private_draft-only, behind isPvp (H5).
//
// Run: npm run test:pvpwave2weather  (or: tsx test/pvp_wave2_weather.test.ts)

import {
  createWorld, stepWorld, spawnPlayerInWorld, isPvp, devSpawnProp,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import {
  PVP, PIT_TILES,
  WEATHER, PVP_WEATHER_ORDER, PVP_WEATHER_CARDINALS,
  pvpWeatherFirstEventTicks, pvpWeatherIdleGapTicks, pvpWeatherGustTellTicks,
  pvpWeatherGustActiveTicks, pvpWeatherTarLifeTicks, pvpWeatherSparkTellTicks,
  pvpWeatherStartCursor,
} from "../src/sim/pvp.js";
import type { PvpWeatherKind } from "../src/sim/pvp.js";
import type { Vec2, Hazard } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";
import { buildSnapshot, jsonCodec, PROTOCOL_VERSION } from "../src/net/protocol.js";
import type { ServerMsg } from "../src/net/protocol.js";
import { PVP_PUBLIC_ENABLED } from "../src/net/pvpFlag.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " \u2014 " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " \u2014 " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " \u2014 " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const DT = 1 / 20;
const TPS = 20;

function inp(over: Partial<InputCmd>): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, ...over };
}

function pvpWorld(seed: number, ids: string[]): WorldState {
  const w = createWorld(seed, 1, { mode: "pvp", isShared: true, skipLocalPlayer: true });
  for (const id of ids) spawnPlayerInWorld(w, id);
  return w;
}

function clearProtection(p: PlayerSim): void {
  p.invuln = 0;
  p.spawnGraceT = 0;
  p.spawnShieldT = 0;
  p.spawnProtectionStartedTick = 0;
  p.spawnHardGraceEndsAtTick = 0;
  p.spawnShieldEndsAtTick = 0;
  p.isSpawnOffenseLatched = false;
  p.dashInvuln = 0;
}

// Advance to LIVE and return the tick the whistle fired on (the tick the director armed against).
function advanceToLive(w: WorldState): number {
  let guard = 0;
  while (w.match !== null && w.match.phase !== "live" && guard++ < 5000) stepWorld(w, new Map(), DT);
  return w.tick;
}

function weatherHazards(w: WorldState, kind: "tar" | "spark"): Hazard[] {
  return w.hazards.filter((h) => h.kind === kind);
}

// Force the director to begin a specific event on the NEXT step (deterministic scene scripting:
// the director's SCHEDULE is set, then the real sim resolves the event off the real seed/geometry).
function forceEvent(w: WorldState, kind: PvpWeatherKind): void {
  const wr = w.match!.weather;
  wr.kind = null;
  wr.phase = "idle";
  wr.cursor = PVP_WEATHER_ORDER.indexOf(kind);
  wr.phaseEndTick = w.tick;
  stepWorld(w, new Map(), DT);
}

function snapOf(w: WorldState, selfPid: string): Extract<ServerMsg, { t: "snap" }> {
  return buildSnapshot(w, selfPid, 0, [], 0, true, { worldId: "arena-1", sseq: 1 }) as Extract<ServerMsg, { t: "snap" }>;
}

// ---------------------------------------------------------------------------------------------
section("kill-switch + version invariants");
{
  check("PROTOCOL_VERSION is 49 (ring weather after the contested hearth)", PROTOCOL_VERSION === 49);
  check("the public PVP kill-switch stays OFF (H4)", PVP_PUBLIC_ENABLED === false);
  check("the rotation ships tar_bloom first (B2)", PVP_WEATHER_ORDER[0] === "tar");
  check("one-at-a-time rotation is exactly the three kinds", PVP_WEATHER_ORDER.join(",") === "tar,gust,spark");
}

// ---------------------------------------------------------------------------------------------
section("cadence: first event at live + 8.0s, then a 10.0s idle gap; seeded rotation");
{
  const w = pvpWorld(101, ["p1", "p2"]);
  const liveTick = advanceToLive(w);
  check("first-event window is 8.0s = 160 ticks", pvpWeatherFirstEventTicks() === 8.0 * TPS);
  check("idle gap is 10.0s = 200 ticks", pvpWeatherIdleGapTicks(false) === 10.0 * TPS);
  check("the director opens idle (nothing fires at the whistle)", w.match!.weather.kind === null && w.match!.weather.phase === "idle");

  // Step until the very first event begins; assert it is EXACTLY firstEventTicks after the whistle.
  let guard = 0;
  while (w.match!.weather.kind === null && guard++ < 5000) stepWorld(w, new Map(), DT);
  const firstEventTick = w.tick;
  check("nothing fired before live + 8.0s", firstEventTick - liveTick === pvpWeatherFirstEventTicks(),
    `delta=${firstEventTick - liveTick}`);

  // The seeded rotation: collect the kinds of the first several events in order.
  const seq: PvpWeatherKind[] = [];
  let lastOrdinal = -1;
  guard = 0;
  while (seq.length < 6 && guard++ < 20000) {
    const wr = w.match!.weather;
    if (wr.kind !== null && wr.ordinal - 1 !== lastOrdinal) { seq.push(wr.kind); lastOrdinal = wr.ordinal - 1; }
    stepWorld(w, new Map(), DT);
  }
  const start = pvpWeatherStartCursor(w.seed);
  const expected = Array.from({ length: 6 }, (_, i) => PVP_WEATHER_ORDER[(start + i) % PVP_WEATHER_ORDER.length]);
  check("events fire in the seeded rotation order (tar->gust->spark->repeat)", seq.join(",") === expected.join(","),
    `seq=${seq.join(",")} exp=${expected.join(",")}`);
}

// ---------------------------------------------------------------------------------------------
section("one-at-a-time: never two weather things live at once, across a long run");
{
  const w = pvpWorld(202, ["p1", "p2"]);
  advanceToLive(w);
  // Park both bodies on their spawns (far from the center annulus/mid-band) so weather never
  // touches them; the match runs on with no frags. Watch the whole set for overlap.
  let overlaps = 0;
  let sawTar = false, sawGust = false, sawSpark = false;
  for (let i = 0; i < 4000; i++) {
    stepWorld(w, new Map(), DT);
    const tar = weatherHazards(w, "tar").length;
    const spark = weatherHazards(w, "spark").length;
    const wr = w.match!.weather;
    const gustActive = wr.kind === "gust" && wr.phase === "active";
    if (wr.kind === "tar") sawTar = true;
    if (wr.kind === "gust") sawGust = true;
    if (wr.kind === "spark") sawSpark = true;
    // Exactly one channel may be non-empty at a time.
    const channels = (tar > 0 ? 1 : 0) + (spark > 0 ? 1 : 0) + (gustActive ? 1 : 0);
    if (channels > 1) overlaps++;
    if (tar > WEATHER.tarMaxPatches) overlaps++;         // hard cap 2 active tar patches
    if (spark > 1) overlaps++;                            // one mine at a time
    // The active kind and its hazards must agree (tar hazards only while kind==="tar", etc.).
    if (tar > 0 && wr.kind !== "tar") overlaps++;
    if (spark > 0 && wr.kind !== "spark") overlaps++;
  }
  check("never more than one weather channel active in 4000 ticks", overlaps === 0, `overlaps=${overlaps}`);
  check("the run exercised all three kinds", sawTar && sawGust && sawSpark);
}

// ---------------------------------------------------------------------------------------------
section("B2 tar_bloom: chokepoints-only placement (H1 denylist), cap 2, radius/life, walk x0.70, no damage");
{
  const w = pvpWorld(303, ["p1", "p2"]);
  advanceToLive(w);
  for (const p of w.players.values()) clearProtection(p);
  const m = w.match!;
  const chokeKeys = new Set(m.forcedChokepoints.map((c) => `${c.x},${c.y}`));
  const pitKeys = new Set(PIT_TILES.map(([tx, ty]) => `${tx * 48 + 24},${ty * 48 + 24}`));
  const spawnKeys = new Set(m.spawns.map((s) => `${s.x},${s.y}`));

  // Sample many tar events; every patch must sit on a forced chokepoint and never on the denylist.
  const hearthTx = Math.floor(m.hearthCenter.x / 48), hearthTy = Math.floor(m.hearthCenter.y / 48);
  let events = 0, offChoke = 0, onHearth = 0, onSpawn = 0, onPit = 0, overCap = 0, badGeom = 0;
  for (let e = 0; e < 12; e++) {
    forceEvent(w, "tar");
    const tar = weatherHazards(w, "tar");
    events++;
    if (tar.length < WEATHER.tarMinPatches || tar.length > WEATHER.tarMaxPatches) overCap++;
    for (const h of tar) {
      const key = `${h.x},${h.y}`;
      if (!chokeKeys.has(key)) offChoke++;
      // The (9,9) hearth TILE itself is the denylist target (the chokepoints ring it, and DO sit
      // within the wider hearth ring radius — that is fine; the tile is what tar must never claim).
      if (Math.floor(h.x / 48) === hearthTx && Math.floor(h.y / 48) === hearthTy) onHearth++;
      if (spawnKeys.has(key)) onSpawn++;
      if (pitKeys.has(key)) onPit++;
      if (h.radius !== WEATHER.tarRadius || Math.abs(h.maxLife - WEATHER.tarLifeSec) > 1e-9) badGeom++;
    }
    // Let the patches fade before the next forced event so the cap check is clean.
    for (let i = 0; i < pvpWeatherTarLifeTicks() + 2; i++) stepWorld(w, new Map(), DT);
  }
  check("every tar patch sits on a forced chokepoint (never off it)", offChoke === 0, `off=${offChoke}`);
  check("H1 denylist: tar never blooms on the hearth (9,9)", onHearth === 0);
  check("H1 denylist: tar never blooms on a spawn pad", onSpawn === 0);
  check("H1 denylist: tar never blooms on a PIT_TILE", onPit === 0);
  check("tar patch count stays within [1,2] (hard cap 2)", overCap === 0);
  check("tar radius 40 + life 3.5s as authored", badGeom === 0 && events === 12);

  // Walk x0.70: single-tick displacement with a tar patch under the body vs. without, same spot.
  const spot: Vec2 = { x: 5 * 48 + 24, y: 4 * 48 + 24 }; // a clearly-open interior tile
  const mover = w.players.get("p1")!;
  function tickDisplacement(withTar: boolean): number {
    w.hazards = w.hazards.filter((h) => h.kind !== "tar" && h.kind !== "spark");
    if (withTar) w.hazards.push({ id: 999001, kind: "tar", x: spot.x, y: spot.y, radius: WEATHER.tarRadius, life: 5, maxLife: 5 });
    mover.x = spot.x; mover.y = spot.y; clearProtection(mover); mover.dashTime = 0;
    const beforeX = mover.x;
    stepWorld(w, new Map([["p1", inp({ moveX: 1, moveY: 0 })]]), DT);
    return mover.x - beforeX;
  }
  const dControl = tickDisplacement(false);
  const dTar = tickDisplacement(true);
  check("tar drags the WALK to x0.70", dControl > 0 && Math.abs(dTar / dControl - WEATHER.tarMoveMult) < 0.02,
    `ctrl=${dControl.toFixed(3)} tar=${dTar.toFixed(3)} ratio=${(dTar / dControl).toFixed(3)}`);

  // Zero damage: pin a body in a tar patch for its whole life; hp never moves.
  w.hazards = w.hazards.filter((h) => h.kind !== "tar" && h.kind !== "spark");
  w.hazards.push({ id: 999002, kind: "tar", x: spot.x, y: spot.y, radius: WEATHER.tarRadius, life: 5, maxLife: 5 });
  mover.hp = PVP.maxHp; clearProtection(mover);
  for (let i = 0; i < pvpWeatherTarLifeTicks(); i++) { mover.x = spot.x; mover.y = spot.y; stepWorld(w, new Map(), DT); }
  check("tar deals ZERO damage (ambient slow only)", mover.hp === PVP.maxHp, `hp=${mover.hp}`);
}

// ---------------------------------------------------------------------------------------------
section("B1 cinder_gust: 0.75s tell -> 1.80s active drift, mid-band only, cover shelters (H3), ownerless");
{
  const w = pvpWorld(404, ["p1", "p2"]);
  advanceToLive(w);
  const m = w.match!;
  forceEvent(w, "gust");
  check("gust opens on a 0.75s tell (no push yet)", m.weather.kind === "gust" && m.weather.phase === "tell");
  check("gust tell is 0.75s = 15 ticks", pvpWeatherGustTellTicks() === Math.round(0.75 * TPS));

  // A body in the mid band during the TELL must not drift (tell is harmless).
  const p1 = w.players.get("p1")!;
  p1.x = m.hearthCenter.x; p1.y = m.hearthCenter.y; clearProtection(p1);
  const tellBeforeX = p1.x, tellBeforeY = p1.y;
  stepWorld(w, new Map(), DT);
  check("no drift during the gust tell", Math.hypot(p1.x - tellBeforeX, p1.y - tellBeforeY) < 1e-6);

  // Advance to ACTIVE; read the seeded cardinal.
  let guard = 0;
  while (m.weather.phase === "tell" && guard++ < 100) stepWorld(w, new Map(), DT);
  check("gust becomes active for 1.80s = 36 ticks", m.weather.phase === "active" && pvpWeatherGustActiveTicks() === Math.round(1.80 * TPS));
  const dir = PVP_WEATHER_CARDINALS[m.weather.gustDir];

  // Mid-band, unsheltered: one tick drifts ~55 px/s in the cardinal.
  p1.x = m.hearthCenter.x; p1.y = m.hearthCenter.y; clearProtection(p1);
  w.props = w.props.filter((prop) => Math.hypot(prop.x - p1.x, prop.y - p1.y) > WEATHER.gustCoverProbePx + 20);
  const bx = p1.x, by = p1.y;
  stepWorld(w, new Map(), DT);
  const drift = (p1.x - bx) * dir.x + (p1.y - by) * dir.y;
  const perTick = WEATHER.gustDriftPxPerSec * DT;
  check("mid-band body drifts ~55 px/s toward the cardinal", Math.abs(drift - perTick) < 0.3, `drift=${drift.toFixed(3)} exp=${perTick.toFixed(3)}`);

  // Outside the mid band (dist > 128): no drift.
  const far = w.players.get("p2")!;
  far.x = m.hearthCenter.x + WEATHER.gustMidBandDist + 40; far.y = m.hearthCenter.y; clearProtection(far);
  const fbx = far.x, fby = far.y;
  stepWorld(w, new Map(), DT);
  check("a body outside the mid band is untouched by the gust", Math.hypot(far.x - fbx, far.y - fby) < 1e-6);

  // Cover shelters (H3): a crate one step UPWIND breaks the gust line — no drift.
  p1.x = m.hearthCenter.x; p1.y = m.hearthCenter.y; clearProtection(p1);
  const crate = devSpawnProp(w, "crate", p1.x - dir.x * 24, p1.y - dir.y * 24);
  const sbx = p1.x, sby = p1.y;
  stepWorld(w, new Map(), DT);
  const shelteredDrift = (p1.x - sbx) * dir.x + (p1.y - sby) * dir.y;
  check("H3: upwind cover shelters a body from the gust", shelteredDrift < 1e-6, `drift=${shelteredDrift.toFixed(4)}`);
  w.props = w.props.filter((prop) => prop.id !== crate.id);

  // Ownerless: the gust never sets a knockback source, so a pit fall keeps the Wave 1 credit window.
  p1.lastPvpKnockbackBy = "p2"; p1.lastPvpKnockbackTick = w.tick;
  p1.x = m.hearthCenter.x; p1.y = m.hearthCenter.y; clearProtection(p1);
  stepWorld(w, new Map(), DT);
  check("gust never hijacks pit attribution (env->pit stays on the recent attacker)", p1.lastPvpKnockbackBy === "p2");
}

// ---------------------------------------------------------------------------------------------
section("B3 spark_mine: annulus 72-110, 0.55s tell, blast r36 + 12 chip + micro 60 KB; no one-shot (H2)");
{
  const w = pvpWorld(505, ["p1", "p2"]);
  advanceToLive(w);
  const m = w.match!;
  const pitKeys = new Set(PIT_TILES.map(([tx, ty]) => `${tx},${ty}`));

  // Placement: sample many mines; each sits in the [72,110] annulus and never on a pit tile (H1).
  let events = 0, outOfAnnulus = 0, onPit = 0, badRadius = 0;
  for (let e = 0; e < 12; e++) {
    forceEvent(w, "spark");
    const spark = weatherHazards(w, "spark");
    if (spark.length === 1) {
      events++;
      const h = spark[0];
      const d = Math.hypot(h.x - m.hearthCenter.x, h.y - m.hearthCenter.y);
      if (d < WEATHER.sparkAnnulusInner - 1e-6 || d > WEATHER.sparkAnnulusOuter + 1e-6) outOfAnnulus++;
      if (pitKeys.has(`${Math.floor(h.x / 48)},${Math.floor(h.y / 48)}`)) onPit++;
      if (h.radius !== WEATHER.sparkBlastRadius) badRadius++;
    }
    for (let i = 0; i < pvpWeatherSparkTellTicks() + 2; i++) stepWorld(w, new Map(), DT);
  }
  check("every spark mine plants inside the 72-110 annulus", events === 12 && outOfAnnulus === 0, `events=${events} out=${outOfAnnulus}`);
  check("H1 denylist: a spark mine never plants on a pit tile", onPit === 0);
  check("spark telegraph radius is the blast radius (36)", badRadius === 0);
  check("spark tell is 0.55s = 11 ticks", pvpWeatherSparkTellTicks() === Math.round(0.55 * TPS));

  // Detonation: a full-HP foe inside the blast takes exactly the flat 12 chip + a micro shove, and
  // is NOT one-shot; a spawn-protected foe in the same blast takes nothing.
  forceEvent(w, "spark");
  const mine = weatherHazards(w, "spark")[0];
  const victim = w.players.get("p1")!;
  const guarded = w.players.get("p2")!;
  victim.x = mine.x + 8; victim.y = mine.y; victim.hp = PVP.maxHp; clearProtection(victim);
  guarded.x = mine.x - 8; guarded.y = mine.y; guarded.hp = PVP.maxHp; clearProtection(guarded);
  // Authoritative spawn grace held far into the future (the sim re-derives spawnGraceT from these
  // end-ticks every tick, so a raw spawnGraceT would be overwritten): under grace for the blast.
  guarded.spawnProtectionStartedTick = w.tick;
  guarded.spawnHardGraceEndsAtTick = w.tick + 100000;
  guarded.spawnShieldEndsAtTick = w.tick + 100000;
  const vBeforeX = victim.x, vBeforeY = victim.y;
  // Hold both bodies inside the blast through the tell; the blast lands the tick the fuse expires.
  let sparkGone = false;
  let guard = 0;
  while (!sparkGone && guard++ < 40) {
    victim.x = mine.x + 8; victim.y = mine.y; guarded.x = mine.x - 8; guarded.y = mine.y;
    stepWorld(w, new Map(), DT);
    sparkGone = weatherHazards(w, "spark").length === 0;
  }
  check("H2: the spark chip is a flat 12 (never a one-shot from full)", victim.hp === PVP.maxHp - WEATHER.sparkChipDamage && victim.hp > 0,
    `hp=${victim.hp}`);
  check("spark applies a micro knockback (0 < d <= 60)", (() => {
    const d = Math.hypot(victim.x - vBeforeX, victim.y - vBeforeY);
    return d > 0 && d <= WEATHER.sparkKnockback + 0.5;
  })());
  check("a spawn-grace body in the blast takes NOTHING (never under spawn grace/shield)", guarded.hp === PVP.maxHp, `hp=${guarded.hp}`);
}

// ---------------------------------------------------------------------------------------------
section("determinism: same seed -> identical weather placement + direction");
{
  function trace(seed: number): string {
    const w = pvpWorld(seed, ["p1", "p2"]);
    advanceToLive(w);
    const out: string[] = [];
    let lastOrdinal = -1;
    let guard = 0;
    while (out.length < 6 && guard++ < 30000) {
      const wr = w.match!.weather;
      if (wr.kind !== null && wr.ordinal - 1 !== lastOrdinal) {
        lastOrdinal = wr.ordinal - 1;
        const tar = weatherHazards(w, "tar").map((h) => `${h.x.toFixed(1)},${h.y.toFixed(1)}`).join(";");
        const spark = weatherHazards(w, "spark").map((h) => `${h.x.toFixed(1)},${h.y.toFixed(1)}`).join(";");
        out.push(`${wr.kind}|tar[${tar}]|spark[${spark}]`);
      }
      stepWorld(w, new Map(), DT);
    }
    return out.join(" / ");
  }
  const a = trace(0xabcdef);
  const b = trace(0xabcdef);
  check("two runs of the same seed produce byte-identical weather", a === b, a.slice(0, 80));
}

// ---------------------------------------------------------------------------------------------
section("wire: MatchWire director projection + tar/spark hzds round-trip (v49)");
{
  const w = pvpWorld(606, ["p1", "p2"]);
  advanceToLive(w);
  const m = w.match!;

  forceEvent(w, "tar");
  const tarSnap = jsonCodec.decodeServer(jsonCodec.encodeServer(snapOf(w, "p1"))) as Extract<ServerMsg, { t: "snap" }>;
  check("MatchWire projects the active weather kind + phase", tarSnap.match !== null && tarSnap.match.wk === "tar" && tarSnap.match.wp === "active");
  check("active tar patches ride hzds on the wire", tarSnap.hzds.some((h) => h.k === "tar"));
  for (let i = 0; i < pvpWeatherTarLifeTicks() + 2; i++) stepWorld(w, new Map(), DT);

  forceEvent(w, "gust");
  let guard = 0;
  while (m.weather.phase === "tell" && guard++ < 100) stepWorld(w, new Map(), DT);
  const gustSnap = jsonCodec.decodeServer(jsonCodec.encodeServer(snapOf(w, "p1"))) as Extract<ServerMsg, { t: "snap" }>;
  check("MatchWire carries the active gust + its cardinal for the wind VFX",
    gustSnap.match !== null && gustSnap.match.wk === "gust" && gustSnap.match.wp === "active" && gustSnap.match.wd === m.weather.gustDir);
  check("the gust is director-only (no hazard entity on hzds)", !gustSnap.hzds.some((h) => h.k === "gust"));
  for (let i = 0; i < pvpWeatherGustActiveTicks() + 2; i++) stepWorld(w, new Map(), DT);

  forceEvent(w, "spark");
  const sparkSnap = jsonCodec.decodeServer(jsonCodec.encodeServer(snapOf(w, "p1"))) as Extract<ServerMsg, { t: "snap" }>;
  check("MatchWire projects the spark tell + its phase-end tick", sparkSnap.match !== null && sparkSnap.match.wk === "spark" && sparkSnap.match.wp === "tell" && sparkSnap.match.we > 0);
  check("the spark telegraph rides hzds on the wire", sparkSnap.hzds.some((h) => h.k === "spark"));
}

// ---------------------------------------------------------------------------------------------
section("sudden death: idle gap x 0.70 (cadence only — no damage/drift bump)");
{
  const w = pvpWorld(707, ["p1", "p2"]);
  advanceToLive(w);
  const w2 = w.match!;
  check("idle gap tightens to 7.0s in sudden death", pvpWeatherIdleGapTicks(true) === Math.round(10.0 * WEATHER.suddenDeathIdleMult * TPS));
  check("sudden death touches ONLY the cadence (drift/chip/tar-slow constants unchanged)",
    WEATHER.gustDriftPxPerSec === 55 && WEATHER.sparkChipDamage === 12 && WEATHER.tarMoveMult === 0.70);

  // Drive an event to its close under sudden death; the next idle gap must be the tightened one.
  w2.isSuddenDeath = true;
  forceEvent(w, "spark");
  let guard = 0;
  while (w.match!.weather.phase !== "idle" && guard++ < 100) stepWorld(w, new Map(), DT);
  const gapTicks = w.match!.weather.phaseEndTick - w.tick;
  check("the post-event idle gap uses the x0.70 cadence", gapTicks === pvpWeatherIdleGapTicks(true), `gap=${gapTicks}`);
}

// ---------------------------------------------------------------------------------------------
section("C1/H4/H5: co-op is byte-inert — the director never runs off the pvp path");
{
  const coop = createWorld(808, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(coop, "c1"); spawnPlayerInWorld(coop, "c2");
  check("co-op has no match state (no director)", coop.match === null && !isPvp(coop));
  let weatherHz = 0;
  for (let i = 0; i < 400; i++) {
    stepWorld(coop, new Map(), DT);
    weatherHz += coop.hazards.filter((h) => h.kind === "tar" || h.kind === "spark").length;
  }
  check("co-op never spawns a tar/spark weather hazard (C1)", weatherHz === 0);
}

// ---------------------------------------------------------------------------------------------
process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("\nAll PVP Wave 2 ring-weather assertions passed.\n");
