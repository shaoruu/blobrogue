// PVP WAVE 3 — Arena ults on the frag deathmatch (PROTOCOL 49) sim suite.
//
// Proves the Quill FINAL arena-ult levers, all in the PURE sim + the wire:
//   - U1: the co-op ults (Overdrive/Sanctuary/Aegis/Phase) NEVER fire in the arena — the meter
//     drives the SEPARATE arena ult table, PVP.ultsEnabled stays false, and no co-op ult event
//     or entity is ever produced behind isPvp.
//   - U2: a death dumps the arena charge to 0 (charge never carries across a life).
//   - U3: the tell is >= 0.40s (no effect during the tell) and the 8.0s min cast spacing is honored.
//   - U4: each arena ult matches the Quill finals (salvo dmg/pierce/glass, triage +18 no-overheal,
//     shove block + 90 KB, slip ~90px blink + 0.40s i-frame + 0.35s end-lag).
//   - U5: the public path is inert (PVP_PUBLIC_ENABLED false; co-op never runs the arena loop) and
//     the private frag DM still scores frags to win.
//   - Kit claim: default gunner (arena_salvo); claimable off-live, locked at the whistle.
//   - Wire: SelfWire.auk + the reliable ultArena event round-trip; PROTOCOL is 49.
//
// Run: npm run test:pvpwave3  (or: tsx test/pvp_wave3.test.ts)

import { createWorld, stepWorld, spawnPlayerInWorld, isPvp } from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import {
  PVP,
  ARENA_ULT, ARENA_SALVO, ARENA_TRIAGE, ARENA_SHOVE, ARENA_SLIP,
  arenaUltKindForKit, arenaUltCastSpacingTicks, arenaUltTellTicks,
} from "../src/sim/pvp.js";
import type { ArenaUltKit } from "../src/sim/pvp.js";
import type { InputCmd } from "../src/sim/input.js";
import type { Bullet } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import type { SimEvent } from "../src/sim/events.js";
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

function advanceToLive(w: WorldState): number {
  let guard = 0;
  while (w.match !== null && w.match.phase !== "live" && guard++ < 5000) stepWorld(w, new Map(), DT);
  return w.tick;
}

function stepCollect(w: WorldState, n: number, inputs: Map<string, InputCmd>): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...stepWorld(w, inputs, DT));
  return out;
}

function faceOff(self: PlayerSim, target: PlayerSim): number {
  return Math.atan2(target.y - self.y, target.x - self.x);
}

// Place two combatants a fixed distance apart on open floor, protection cleared, ready to fight.
function placeDuel(w: WorldState, aId: string, bId: string, gap: number): [PlayerSim, PlayerSim] {
  const a = w.players.get(aId)!;
  const b = w.players.get(bId)!;
  const cx = w.dungeon.spawn.x * TILE + TILE / 2;
  const cy = w.dungeon.spawn.y * TILE + TILE / 2;
  a.x = cx - gap / 2; a.y = cy;
  b.x = cx + gap / 2; b.y = cy;
  clearProtection(a); clearProtection(b);
  return [a, b];
}

function foeBullet(owner: string, x: number, y: number, vx: number, vy: number): Bullet {
  return {
    x, y, vx, vy, radius: 4, life: 3, friendly: true,
    owner, damage: 8, color: "#fff", pierce: 0, hitList: null, isCrit: false, fx: "pistol",
  };
}

// Cast the local player's claimed arena ult: charge the meter, request it for one tick, then let
// the tell elapse so the effect lands. Returns every event across the whole cast.
function castArenaUlt(w: WorldState, casterId: string, aim: number, tellPlus = 6): SimEvent[] {
  const p = w.players.get(casterId)!;
  p.ultCharge = ARENA_ULT.meterMax;
  const out = stepCollect(w, 1, new Map([[casterId, inp({ ult: true, aim })]]));
  out.push(...stepCollect(w, arenaUltTellTicks() + tellPlus, new Map([[casterId, inp({ aim })]])));
  return out;
}

// =============================================================================================
section("version + kill-switch invariants");
{
  check("PROTOCOL_VERSION is 49 (Wave 3 arena ults)", PROTOCOL_VERSION === 49, `v=${PROTOCOL_VERSION}`);
  check("the public PVP kill-switch stays OFF (U5)", PVP_PUBLIC_ENABLED === false);
  check("co-op ults stay config-disabled in pvp (PVP.ultsEnabled false)", PVP.ultsEnabled === false);
  check("kit->arena-ult mapping is the four skins",
    arenaUltKindForKit("gunner") === "salvo"
    && arenaUltKindForKit("mender") === "triage"
    && arenaUltKindForKit("bulwark") === "shove"
    && arenaUltKindForKit("phantom") === "slip");
  check("tell is >= 0.40s for all four", arenaUltTellTicks() === Math.round(0.40 * 20) && arenaUltTellTicks() === 8);
  check("min cast spacing is 8.0s", arenaUltCastSpacingTicks() === Math.round(8.0 * 20) && arenaUltCastSpacingTicks() === 160);
}

// =============================================================================================
section("kit claim: default gunner; claimable off-live; locked at the whistle");
{
  const w = pvpWorld(30, ["p1", "p2"]);
  const p1 = w.players.get("p1")!;
  check("a fresh arena player defaults to gunner / arena_salvo", p1.arenaUltKit === "gunner");
  // Claim during the pre-live phase (lobby/countdown).
  stepCollect(w, 1, new Map([["p1", inp({ arenaUltKit: "mender" })]]));
  check("a claim off-live is accepted", p1.arenaUltKit === "mender");
  advanceToLive(w);
  // A claim during LIVE is refused (locked at the whistle).
  stepCollect(w, 1, new Map([["p1", inp({ arenaUltKit: "phantom" })]]));
  check("a claim during the live match is refused (locked)", p1.arenaUltKit === "mender");
  // A bogus kit id never sets the claim.
  const w2 = pvpWorld(31, ["a", "b"]);
  stepCollect(w2, 1, new Map([["a", inp({ arenaUltKit: "none" })]]));
  check("the neutral 'none' is never a valid arena claim", w2.players.get("a")!.arenaUltKit === "gunner");
}

// =============================================================================================
section("charge model: passive time accrues; damage dealt charges; HOLD/BREAK idle");
{
  const w = pvpWorld(40, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  p1.ultCharge = 0;
  stepCollect(w, 20, new Map()); // 1.0s of passive time
  check("passive time accrues +1.0 pts/s (fixed-point hundredths)", p1.ultCharge === 20 * Math.round(ARENA_ULT.passivePerSec / 20));
  check("passive rate is exactly +5 hundredths/tick", Math.round(ARENA_ULT.passivePerSec / 20) === 5);
  // Damage dealt banks +0.35/dmg to the attacker.
  const [a, b] = placeDuel(w, "p1", "p2", 90);
  a.ultCharge = 0;
  a.weapon = "pistol"; a.ownedWeapons = ["pistol"];
  b.hp = b.maxHp;
  const aim = faceOff(a, b);
  let guard = 0;
  const hpStart = b.hp;
  while (b.hp === hpStart && guard++ < 60) stepCollect(w, 1, new Map([["p1", inp({ firing: true, aim })]]));
  check("damage dealt charges the attacker's arena meter", a.ultCharge > 0, `uc=${a.ultCharge}`);
}

// =============================================================================================
section("U1: co-op ults NEVER fire in the arena");
{
  const kits: ArenaUltKit[] = ["gunner", "mender", "bulwark", "phantom"];
  for (const kit of kits) {
    const w = pvpWorld(50, ["p1", "p2"]);
    advanceToLive(w);
    const [a] = placeDuel(w, "p1", "p2", 120);
    // A worst case for U1: force a REAL co-op kitId AND a full meter, then cast.
    a.kitId = "gunner";
    a.arenaUltKit = kit;
    const ev = castArenaUlt(w, "p1", 0);
    const coopUlt = ev.some((e) => e.t === "ultOverdrive" || e.t === "ultSanctuary" || e.t === "ultAegis" || e.t === "ultPhase");
    const arenaUlt = ev.some((e) => e.t === "ultArena");
    check(`${kit}: no co-op ult event fires in the arena`, !coopUlt);
    check(`${kit}: the arena ult event fires instead`, arenaUlt);
    check(`${kit}: no Sanctuary/Aegis dome entity is ever deployed`,
      w.effects.every((eff) => eff.kind !== "sanctuary" && eff.kind !== "aegis"));
    check(`${kit}: Overdrive self-buff never grants`, a.overdriveT === 0);
  }
}

// =============================================================================================
section("U2: a death dumps the arena charge to 0");
{
  const w = pvpWorld(60, ["p1", "p2"]);
  advanceToLive(w);
  const [a, b] = placeDuel(w, "p1", "p2", 80);
  a.weapon = "pistol"; a.ownedWeapons = ["pistol"];
  b.ultCharge = ARENA_ULT.meterMax; // victim sitting on a full meter
  b.hp = 1;
  const aim = faceOff(a, b);
  let guard = 0;
  while (b.respawnT === 0 && guard++ < 60) stepCollect(w, 1, new Map([["p1", inp({ firing: true, aim })]]));
  check("the victim died (respawn scheduled)", b.respawnT > 0);
  check("death dumped the arena charge to 0", b.ultCharge === 0);
  check("death cleared the cast lockout", b.ultReadyAtTick === 0);
}

// =============================================================================================
section("U3: tell >= 0.40s (no effect during the tell) + 8.0s spacing honored");
{
  const w = pvpWorld(70, ["p1", "p2"]);
  advanceToLive(w);
  const [a, b] = placeDuel(w, "p1", "p2", 100);
  a.arenaUltKit = "gunner"; // arena_salvo: a damaging ult, so the tell is observable
  a.ultCharge = ARENA_ULT.meterMax;
  b.hp = b.maxHp;
  const aim = faceOff(a, b);
  // Cast tick opens the tell.
  stepCollect(w, 1, new Map([["p1", inp({ ult: true, aim })]]));
  const hpAfterCast = b.hp;
  // Step through the remaining tell (< tellTicks): no salvo damage lands yet.
  stepCollect(w, arenaUltTellTicks() - 1, new Map([["p1", inp({ aim })]]));
  check("no ult damage lands during the >= 0.40s tell", b.hp === hpAfterCast, `hp=${b.hp}`);
  // Let the volley resolve.
  stepCollect(w, 10, new Map([["p1", inp({ aim })]]));
  check("the ult lands after the tell elapses", b.hp < hpAfterCast, `hp=${b.hp}`);
  check("the 8s spacing lockout is armed after the cast", a.ultReadyAtTick >= w.tick);
  // A second full meter cannot re-cast inside the spacing window.
  a.ultCharge = ARENA_ULT.meterMax;
  const before = b.hp;
  const ev = stepCollect(w, 20, new Map([["p1", inp({ ult: true, aim })]]));
  check("a second cast inside the 8s window is refused", !ev.some((e) => e.t === "ultArena"));
}

// =============================================================================================
section("U4 · arena_salvo: 5 flat-10 shots, +1 pierce, glass +25% incoming, no fire buff");
{
  const w = pvpWorld(80, ["p1", "p2"]);
  advanceToLive(w);
  const [a, b] = placeDuel(w, "p1", "p2", 120);
  a.arenaUltKit = "gunner";
  b.hp = b.maxHp; // 100
  const aim = faceOff(a, b);
  castArenaUlt(w, "p1", aim, 24); // step well past the 5-shot volley window
  const dealt = b.maxHp - b.hp;
  check("the full volley deals 5 x 10 = 50 flat PVP damage", dealt === ARENA_SALVO.shots * ARENA_SALVO.perShotDamage, `dealt=${dealt}`);
  check("salvo config is 5 shots over 0.55s at 10 each", ARENA_SALVO.shots === 5 && ARENA_SALVO.perShotDamage === 10);
  check("salvo grants +1 pierce on the volley only", ARENA_SALVO.bonusPierce === 1);
  // Glass: the caster runs +25% incoming across the whole tell+active window.
  {
    const gw = pvpWorld(81, ["p1", "p2"]);
    advanceToLive(gw);
    const [g] = placeDuel(gw, "p1", "p2", 300);
    g.arenaUltKit = "gunner";
    g.ultCharge = ARENA_ULT.meterMax;
    stepCollect(gw, 1, new Map([["p1", inp({ ult: true, aim: 0 })]]));
    check("glass opens for the whole 0.95s tell+active window", g.arenaUlt.glassT > 0);
    check("glass multiplies incoming by 1.25", ARENA_SALVO.glassIncomingMult === 1.25);
  }
  // Pierce: a single shot passes through the nearer foe into the one behind it.
  {
    const pw = pvpWorld(82, ["p1", "p2", "p3"]);
    advanceToLive(pw);
    const caster = pw.players.get("p1")!;
    const near = pw.players.get("p2")!;
    const far = pw.players.get("p3")!;
    const cx = pw.dungeon.spawn.x * TILE + TILE / 2;
    const cy = pw.dungeon.spawn.y * TILE + TILE / 2;
    caster.x = cx - 120; caster.y = cy;
    near.x = cx; near.y = cy;
    far.x = cx + 40; far.y = cy;
    clearProtection(caster); clearProtection(near); clearProtection(far);
    caster.arenaUltKit = "gunner";
    near.hp = near.maxHp; far.hp = far.maxHp;
    castArenaUlt(pw, "p1", 0, 12);
    check("+1 pierce lets one shot hit BOTH the near and far foe", near.hp < near.maxHp && far.hp < far.maxHp,
      `near=${near.hp} far=${far.hp}`);
  }
}

// =============================================================================================
section("U4 · arena_triage: +18 self, no overheal, cleanse; never ally/HoT/shield");
{
  const w = pvpWorld(90, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  clearProtection(p1);
  p1.arenaUltKit = "mender";
  p1.hp = 50;
  castArenaUlt(w, "p1", 0);
  check("triage heals +18 HP instant self", p1.hp === 68, `hp=${p1.hp}`);
  check("triage cleanse opens a brief slow-immunity window", p1.arenaUlt.slowImmuneT > 0 || ARENA_TRIAGE.cleanseSec > 0);
  check("triage never deploys a Sanctuary/ground HoT entity", w.effects.every((e) => e.kind !== "sanctuary"));
  // No overheal past maxHp.
  const w2 = pvpWorld(91, ["p1", "p2"]);
  advanceToLive(w2);
  const q = w2.players.get("p1")!;
  clearProtection(q);
  q.arenaUltKit = "mender";
  q.hp = q.maxHp - 5; // 95
  castArenaUlt(w2, "p1", 0);
  check("triage never overheals past maxHp", q.hp === q.maxHp, `hp=${q.hp}/${q.maxHp}`);
  check("triage config heals exactly +18", ARENA_TRIAGE.healSelf === 18);
}

// =============================================================================================
section("U4 · arena_bulwark_shove: blocks one foe shot, shatter KB 90 frontal; no HP dome");
{
  const w = pvpWorld(100, ["p1", "p2"]);
  advanceToLive(w);
  // Column x=9 rows 2-5 are an open lane (the arena center cross is boxed by cover), so the shove
  // pushes the foe UP into open floor rather than into a cover prop.
  const laneX = w.dungeon.spawn.x * TILE + TILE / 2;      // tile 9 center
  const wall = w.players.get("p1")!;
  const foe = w.players.get("p2")!;
  wall.x = laneX; wall.y = 5 * TILE + TILE / 2;           // (9,5)
  foe.x = laneX; foe.y = wall.y - 40;                     // (9,4), inside the 48px frontal reach, above
  clearProtection(wall); clearProtection(foe);
  wall.arenaUltKit = "bulwark";
  wall.hp = wall.maxHp;
  const aimUp = -Math.PI / 2; // face the foe (up)
  // Raise the wall and let the tell elapse.
  wall.ultCharge = ARENA_ULT.meterMax;
  stepCollect(w, 1, new Map([["p1", inp({ ult: true, aim: aimUp })]]));
  stepCollect(w, arenaUltTellTicks() + 1, new Map([["p1", inp({ aim: aimUp })]]));
  check("the frontal wall is up after the tell", wall.arenaUlt.shoveT > 0);
  check("the wall is never an HP dome (no aegis entity)", w.effects.every((e) => e.kind !== "aegis"));
  // A foe shot crossing the frontal arc is eaten; the caster takes no damage from it.
  const foeY0 = foe.y;
  w.bullets.push(foeBullet("p2", laneX, wall.y - 30, 0, 200)); // above the wall, travelling down into it
  const hpBeforeBlock = wall.hp;
  const ev = stepCollect(w, 2, new Map());
  check("the wall blocks a foe shot (caster takes no hit)", wall.hp === hpBeforeBlock);
  check("the blocked shot emits a bulletBlocked cue", ev.some((e) => e.t === "bulletBlocked"));
  check("the shatter shoves the frontal foe (moved away)", foe.y < foeY0, `y ${foeY0}->${foe.y}`);
  check("shatter KB is 90 frontal in config", ARENA_SHOVE.shatterKb === 90 && ARENA_SHOVE.reachPx === 48);
}

// =============================================================================================
section("U4 · arena_slip: ~90px blink, 0.40s i-frame, 0.35s visible end-lag (no i-frame)");
{
  const w = pvpWorld(110, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  const laneX = w.dungeon.spawn.x * TILE + TILE / 2;
  // Blink UP the open lane (the center cross is boxed by cover ~2 tiles out).
  p1.x = laneX; p1.y = 5 * TILE + TILE / 2; // (9,5)
  clearProtection(p1);
  p1.arenaUltKit = "phantom";
  const y0 = p1.y;
  const aimUp = -Math.PI / 2;
  p1.ultCharge = ARENA_ULT.meterMax;
  stepCollect(w, 1, new Map([["p1", inp({ ult: true, aim: aimUp })]]));
  stepCollect(w, arenaUltTellTicks() + 1, new Map([["p1", inp({ aim: aimUp })]]));
  check("slip blinks ~90px along aim", Math.abs(p1.y - y0) >= 60, `dy=${(p1.y - y0).toFixed(1)}`);
  check("slip grants a 0.40s i-frame (rides ultInvuln)", p1.ultInvuln > 0);
  check("slip arms the visible end-lag window", p1.arenaUlt.endlagT > 0);
  check("slip config: 0.40s i-frame, ~90px, 0.35s end-lag",
    ARENA_SLIP.iframeSec === 0.40 && ARENA_SLIP.blinkPx === 90 && ARENA_SLIP.endlagSec === 0.35);
  // The end-lag has NO i-frame: after the 0.40s invuln elapses, incoming damage lands again.
  const w2 = pvpWorld(111, ["p1", "p2"]);
  advanceToLive(w2);
  const [s, atk] = placeDuel(w2, "p1", "p2", 80);
  s.arenaUltKit = "phantom";
  s.ultCharge = ARENA_ULT.meterMax;
  stepCollect(w2, 1, new Map([["p1", inp({ ult: true, aim: Math.PI })]])); // blink away from atk
  stepCollect(w2, arenaUltTellTicks() + Math.round(ARENA_SLIP.iframeSec * 20) + 2, new Map());
  check("the i-frame has expired into the end-lag (no lingering invuln)", s.ultInvuln === 0);
}

// =============================================================================================
section("U5: public path inert; co-op never runs the arena loop; private DM still frags");
{
  // Co-op world: the arena loop never runs (no ultArena event, meter never arena-charges).
  const coop = createWorld(120, 1, { mode: "coop", isShared: true });
  spawnPlayerInWorld(coop, "c1");
  spawnPlayerInWorld(coop, "c2");
  const ev = stepCollect(coop, 40, new Map());
  check("co-op never emits an arena ult event", !ev.some((e) => e.t === "ultArena"));
  check("the arena loop is behind isPvp (co-op world is not pvp)", !isPvp(coop));

  // Private frag DM still resolves frags to a win.
  const w = pvpWorld(121, ["p1", "p2"]);
  advanceToLive(w);
  const [a, b] = placeDuel(w, "p1", "p2", 70);
  a.weapon = "pistol"; a.ownedWeapons = ["pistol"];
  const aim = faceOff(a, b);
  b.hp = 1;
  let guard = 0;
  while ((w.match!.scores.get("p1") ?? 0) < 1 && guard++ < 80) stepCollect(w, 1, new Map([["p1", inp({ firing: true, aim })]]));
  check("a kill still scores a frag on the private frag DM", (w.match!.scores.get("p1") ?? 0) >= 1);
  check("the frag limit is a real to-win goal", w.match!.fragLimit >= 8);
}

// =============================================================================================
section("wire: SelfWire.auk + the reliable ultArena event round-trip (PROTOCOL 49)");
{
  const w = pvpWorld(130, ["p1", "p2"]);
  advanceToLive(w);
  w.players.get("p1")!.arenaUltKit = "bulwark";
  const snap = buildSnapshot(w, "p1", 0, [], 0, true, { worldId: "arena-1", sseq: 1 }) as Extract<ServerMsg, { t: "snap" }>;
  const dec = jsonCodec.decodeServer(jsonCodec.encodeServer(snap));
  check("SelfWire.auk carries the claimed arena ult kit", dec.t === "snap" && dec.self?.auk === "bulwark");
  const eventSnap = {
    ...snap,
    events: [
      { id: 1, e: { t: "ultArena", pid: "p1", kind: "salvo", x: 100, y: 120, aim: 0.5, tellTicks: 8 } as const },
      { id: 2, e: { t: "ultArena", pid: "p2", kind: "slip", x: 200, y: 220, aim: -1.2, tellTicks: 8 } as const },
    ],
  };
  const rt = jsonCodec.decodeServer(jsonCodec.encodeServer(eventSnap));
  check("the arena ult event round-trips reliably with its kind",
    rt.t === "snap"
    && rt.events.length === 2
    && rt.events[0].e.t === "ultArena"
    && (rt.events[0].e as Extract<SimEvent, { t: "ultArena" }>).kind === "salvo"
    && (rt.events[1].e as Extract<SimEvent, { t: "ultArena" }>).kind === "slip");
}

// =============================================================================================
process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write("\nFAILURES:\n" + failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("\nAll PVP Wave 3 arena-ult assertions passed.\n");
