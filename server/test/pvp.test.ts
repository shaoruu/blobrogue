// PVP room orchestration over REAL sockets: the P3 server wiring. Two clients join a pvp world
// (a pvp-prefixed world id minted only for a pvp room), and the suite asserts the server spins it
// up in pvp mode, seats both players with the FIXED symmetric loadout, runs the frag-limit match
// state machine to the live phase, and publishes the match block + FFA team on every wire. The
// kill/frag/respawn MECHANICS are exhaustively covered by the pure-sim suite (root test/pvp.test.ts);
// this proves the authoritative server plumbs the same sim end-to-end AND — the adversarial E2E —
// drives two real sockets all the way through a live duel: authoritative damage on the wire, the
// reliable pvpKill / pvpMatchOver delivered EXACTLY ONCE to both clients, respawn continuity, and a
// disconnect/reconnect grace case (scoreboard reads the absent seat not-alive, the match pauses,
// the seat resumes) — so a dropped snapshot never loses a kill and an outage never desyncs a match.
//
// TEMP kill switch: PVP entry is disabled by default (config.pvpPublicEnabled mirrors the shared
// build flag). This suite proves the PVP plumbing is intact + un-deleted by starting the server
// with it explicitly ENABLED; the DISABLED reject is covered by test/pvpdisabled.test.ts.
//
// Run: npm run test:pvp (in server/)

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { PVP, pvpSpawnHardGraceTicks, pvpSpawnShieldTicks } from "../../src/sim/pvp.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  try { await fn(); }
  catch (err) { failed++; failures.push(`${name} threw: ${String(err)}`); process.stdout.write(`  FAIL ${name} threw ${String(err)}\n`); }
}

async function main(): Promise<void> {
  await test("a pvp-prefixed world id spins up a deathmatch world and publishes the match block", async () => {
    const s = await startTestServer({ pvpPublicEnabled: true });
    try {
      const world = "pvp:room:ARENA";
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "a", world, name: "aaa", colorIndex: 1, script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "b", world, name: "bbb", colorIndex: 3, script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 4000);
      await sleep(300);

      const gw = s.server.getWorld(world);
      check("the server created the world in pvp mode", gw?.state.mode === "pvp");
      check("both players are seated in the one pvp world", gw?.playerCount === 2);
      check("the sim built a match", gw?.state.match !== null);

      const sa = a.transport.getLatestSnapshot()!;
      check("the wire carries a non-null match block", sa.match !== null);
      check("every player gets the FIXED 100 HP pool", sa.self !== null && sa.self.mhp === PVP.maxHp, `mhp=${sa.self?.mhp}`);
      check("authoritative two-stage protection rides the local wire",
        sa.self?.sgr === pvpSpawnHardGraceTicks() && sa.self.ssh === pvpSpawnShieldTicks());
      check("authoritative two-stage protection rides observer wires",
        sa.players.every((p) => p.sgr === pvpSpawnHardGraceTicks() && p.ssh === pvpSpawnShieldTicks()));
      check("FFA team rides PlayerWire.tm", sa.players.every((p) => p.tm === 0));
      check("the scoreboard lists both seats", (sa.match?.sc.length ?? 0) === 2);

      // The tick-based match machine advances lobby -> countdown -> live over the wire.
      const reachedLive = await waitUntil(() => {
        const snap = a.transport.getLatestSnapshot();
        return snap?.match?.ph === "live";
      }, 6000);
      check("the match reaches the live phase (lobby -> countdown -> live)", reachedLive);
      check("no co-op wipe/game-over fires in a live deathmatch", a.transport.getLatestSnapshot()?.over === false);

      a.stop(); b.stop();
    } finally {
      await s.close();
    }
  });

  await test("a co-op room stays co-op (no match block) — the mode is the world identity", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "c", world: "room:COOP", name: "ccc", colorIndex: 2, script: () => idle() });
      a.start();
      await waitUntil(() => a.transport.isReady(), 4000);
      await sleep(200);
      const gw = s.server.getWorld("room:COOP");
      check("a plain room id creates a co-op world", gw?.state.mode === "coop");
      check("co-op snapshot carries a null match block", a.transport.getLatestSnapshot()?.match === null);
      a.stop();
    } finally {
      await s.close();
    }
  });

  await test("real-socket hard grace preserves control while suppressing authoritative attacks", async () => {
    const s = await startTestServer({ pvpPublicEnabled: true });
    try {
      const world = "pvp:room:SAFE";
      const movingFire = () => ({
        seq: 0,
        moveX: 1,
        moveY: 0,
        aim: Math.PI / 2,
        firing: true,
        dash: true,
      });
      const actor = new Bot({
        url: s.url,
        secret: s.secret,
        playerId: "safe",
        world,
        name: "safe",
        colorIndex: 1,
        script: movingFire,
      });
      const rival = new Bot({
        url: s.url,
        secret: s.secret,
        playerId: "rival",
        world,
        name: "rival",
        colorIndex: 2,
        script: () => idle(),
      });
      actor.start();
      rival.start();
      await waitUntil(() => actor.transport.isReady() && rival.transport.isReady(), 4000);
      const gw = s.server.getWorld(world)!;
      await waitUntil(() => gw.state.match?.phase === "live", 6000);
      const actorId = actor.transport.getSelfServerId()!;
      const rivalId = rival.transport.getSelfServerId()!;
      const player = gw.state.players.get(actorId)!;
      const other = gw.state.players.get(rivalId)!;
      player.x = 300;
      player.y = 216;
      player.fireCd = 0;
      player.spawnGraceT = pvpSpawnHardGraceTicks();
      player.spawnShieldT = pvpSpawnShieldTicks();
      other.x = 700;
      other.y = 700;
      gw.state.bullets = gw.state.bullets.filter((bullet) => bullet.owner !== actorId);
      gw.state.effects = gw.state.effects.filter((effect) => effect.owner !== actorId);
      const startX = player.x;
      const startShotSeq = player.shotSeq;

      await sleep(800);
      check("move, aim, and dash inputs change authoritative state during hard grace",
        player.x > startX && player.aimAngle === Math.PI / 2 && player.dashCd > 0);
      check("held attack creates zero authoritative bullets/effects/shots during hard grace",
        player.shotSeq === startShotSeq
        && gw.state.bullets.every((bullet) => bullet.owner !== actorId)
        && gw.state.effects.every((effect) => effect.owner !== actorId));

      const isFirstLegalAttack = await waitUntil(
        () => player.spawnGraceT === 0 && player.shotSeq > startShotSeq,
        2000,
      );
      check("the first legal post-grace attack fires and breaks shield", isFirstLegalAttack && player.spawnShieldT === 0);
      const isWireUpdated = await waitUntil(
        () => actor.transport.getLatestSnapshot()?.self?.sgr === 0
          && actor.transport.getLatestSnapshot()?.self?.ssh === 0,
        1000,
      );
      check("the authoritative break is visible on the client wire", isWireUpdated);

      actor.stop();
      rival.stop();
    } finally {
      await s.close();
    }
  });

  await test("adversarial E2E: two real sockets through damage -> exact-once pvpKill -> respawn -> match-over", async () => {
    const s = await startTestServer({ pvpPublicEnabled: true });
    try {
      const world = "pvp:room:E2E";
      // The shooter holds the trigger every frame (aim right); the countdown freeze means no round
      // exists until the live whistle. The victim idles. Both are REAL WSTransport clients.
      const fireRight = () => ({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
      const shooter = new Bot({ url: s.url, secret: s.secret, playerId: "sh", world, name: "sh", colorIndex: 1, script: fireRight });
      const victim = new Bot({ url: s.url, secret: s.secret, playerId: "vic", world, name: "vic", colorIndex: 2, script: () => idle() });
      shooter.start(); victim.start();
      await waitUntil(() => shooter.transport.isReady() && victim.transport.isReady(), 4000);
      const gw = s.server.getWorld(world)!;
      const shPid = shooter.transport.getSelfServerId()!;
      const vicPid = victim.transport.getSelfServerId()!;
      const isLive = await waitUntil(() => gw.state.match?.phase === "live", 6000);
      check("the match reaches live over real sockets", isLive);

      // Stage a point-blank duel on the authoritative world (the pure sim proves the mechanics;
      // this proves the server plumbs them end-to-end). Positions/weapons are server-owned.
      const sh = gw.state.players.get(shPid)!; const vic = gw.state.players.get(vicPid)!;
      sh.x = 300; sh.y = 216; sh.invuln = 0; sh.spawnGraceT = 0; sh.spawnShieldT = 0;
      sh.weapon = "railgun"; sh.ownedWeapons = ["railgun"];
      vic.x = 360; vic.y = 216; vic.invuln = 0; vic.spawnGraceT = 0; vic.spawnShieldT = 0;

      // 1) authoritative damage: the victim's HP falls on the SERVER and the same value rides the wire.
      const isHurt = await waitUntil(() => (gw.state.players.get(vicPid)?.hp ?? PVP.maxHp) < PVP.maxHp, 4000);
      check("the victim takes authoritative damage on the server", isHurt, `hp=${gw.state.players.get(vicPid)?.hp}`);
      const wireHp = await waitUntil(() => (victim.transport.getLatestSnapshot()?.self?.hp ?? PVP.maxHp) < PVP.maxHp, 2000);
      check("the authoritative HP rides the wire to the victim (server-owned, not predicted)", wireHp);

      // 2) exact-once elimination: the reliable pvpKill fires ONCE per death, to BOTH nearby clients.
      const isDead = await waitUntil(() => (gw.state.players.get(vicPid)?.respawnT ?? 0) > 0, 5000);
      check("the victim is eliminated (respawn scheduled, never removed)", isDead && gw.playerCount === 2);
      // Wait for the reliable event to be delivered + drained to BOTH clients before counting.
      await waitUntil(() => shooter.events.some((e) => e.t === "pvpKill" && e.victim === vicPid) && victim.events.some((e) => e.t === "pvpKill" && e.victim === vicPid), 3000);
      const shKills = shooter.events.filter((e) => e.t === "pvpKill" && e.victim === vicPid);
      const vicKills = victim.events.filter((e) => e.t === "pvpKill" && e.victim === vicPid);
      check("pvpKill delivered EXACTLY once to the shooter (reliable, deduped)", shKills.length === 1, `n=${shKills.length}`);
      check("pvpKill delivered EXACTLY once to the victim (reliable, deduped)", vicKills.length === 1, `n=${vicKills.length}`);
      check("the kill is attributed to the real shooter", shKills[0] !== undefined && shKills[0].t === "pvpKill" && shKills[0].by === shPid);
      check("the authoritative scoreboard credits the shooter one frag", (gw.state.match?.scores.get(shPid) ?? 0) === 1);

      // 3) respawn continuity: the SAME seat returns at full HP after the delay (never a new body).
      const isRespawned = await waitUntil(() => { const v = gw.state.players.get(vicPid); return v !== undefined && v.respawnT === 0 && v.hp === PVP.maxHp; }, 5000);
      check("the victim respawns at full HP, same seat (state continuity)", isRespawned && gw.playerCount === 2);

      // 4) exact-once match-over: freeze further combat, seat the shooter at the frag limit, and
      //    assert the reliable pvpMatchOver fires ONCE with the right winner, on both clients.
      gw.state.players.get(vicPid)!.invuln = 300; // long (but wire-valid) protection — isolate the match-over event from a stray extra kill
      gw.state.match!.scores.set(shPid, gw.state.match!.fragLimit);
      const isOver = await waitUntil(() => shooter.transport.getLatestSnapshot()?.match?.ph === "over", 4000);
      check("the match ends over real sockets (frag limit reached)", isOver);
      // Wait for the reliable global event to be delivered + drained to BOTH clients before counting.
      await waitUntil(() => shooter.events.some((e) => e.t === "pvpMatchOver") && victim.events.some((e) => e.t === "pvpMatchOver"), 3000);
      const shOver = shooter.events.filter((e) => e.t === "pvpMatchOver");
      const vicOver = victim.events.filter((e) => e.t === "pvpMatchOver");
      check("pvpMatchOver delivered EXACTLY once to the shooter", shOver.length === 1, `n=${shOver.length}`);
      check("pvpMatchOver delivered EXACTLY once to the victim", vicOver.length === 1, `n=${vicOver.length}`);
      check("the match winner is the frag leader", shOver[0] !== undefined && shOver[0].t === "pvpMatchOver" && shOver[0].winner === shPid);
      check("no co-op wipe/game-over EVER fired in the deathmatch", shooter.transport.getLatestSnapshot()?.over === false && victim.transport.getLatestSnapshot()?.over === false);

      shooter.stop(); victim.stop();
    } finally {
      await s.close();
    }
  });

  await test("adversarial E2E: a disconnect inside the grace pauses the match; the seat resumes not-lost", async () => {
    const graceMs = 3000;
    const s = await startTestServer({ pvpPublicEnabled: true, resumeGraceMs: graceMs });
    try {
      const world = "pvp:room:GRC";
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "ga", world, name: "ga", colorIndex: 1, script: () => idle(), reconnect: { baseDelayMs: 80, maxDelayMs: 250, graceMs } });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "gb", world, name: "gb", colorIndex: 2, script: () => idle(), reconnect: { baseDelayMs: 80, maxDelayMs: 250, graceMs } });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 4000);
      const gw = s.server.getWorld(world)!;
      const bPid = b.transport.getSelfServerId()!;
      const isLive = await waitUntil(() => gw.state.match?.phase === "live", 6000);
      check("the 2-player match reaches live", isLive);

      // B's link drops and stays dark: the seat is RESERVED (absent) inside its reconnect grace.
      b.dropConnection(true);
      const isAbsent = await waitUntil(() => gw.state.players.get(bPid)?.isAbsent === true, 3000);
      check("the dropped seat is reserved (absent), the body is not removed", isAbsent && gw.playerCount === 2);

      // H1 on the wire: A's scoreboard marks the absent seat NOT alive.
      const isNotAlive = await waitUntil(() => a.transport.getLatestSnapshot()?.match?.sc.find((x) => x.id === bPid)?.a === false, 2000);
      check("A's scoreboard marks the absent seat NOT alive (H1 on the wire)", isNotAlive);

      // The live match PAUSES while only one seat is present: phase stays live, the clock is frozen
      // (remaining ticks constant across a sleep). Never a solo match, never a free win.
      await sleep(200);
      const r1 = gw.state.match!.phaseEndTick - gw.state.tick;
      await sleep(500);
      const r2 = gw.state.match!.phaseEndTick - gw.state.tick;
      check("the match stays live but PAUSES while a seat is absent (clock frozen)", gw.state.match!.phase === "live" && r1 === r2, `r1=${r1} r2=${r2}`);
      check("the match never resolves a winner while paused", gw.state.match!.winner === null);

      // B returns inside the grace: the SAME seat resumes, reads alive again, and the match plays on.
      b.restoreNetwork();
      const isBack = await waitUntil(() => gw.state.players.get(bPid)?.isAbsent === false, 5000);
      check("B resumes the same seat inside the grace (never lost)", isBack && gw.playerCount === 2 && b.transport.getSelfServerId() === bPid);
      const isAliveAgain = await waitUntil(() => a.transport.getLatestSnapshot()?.match?.sc.find((x) => x.id === bPid)?.a === true, 2000);
      check("the resumed seat reads ALIVE again on A's scoreboard", isAliveAgain);
      check("the match resumes live (no no-contest, no fabricated result)", gw.state.match?.phase === "live" && gw.state.match?.winner === null);

      a.stop(); b.stop();
    } finally {
      await s.close();
    }
  });

  process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n"); process.exit(1); }
}

void main();
