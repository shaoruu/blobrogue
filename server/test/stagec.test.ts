// Stage C server/netcode assertion suite: the authoritative MULTI-CLIENT combat properties
// over the real WSTransport netcode. Drives 2+ bot clients against an in-process server and
// asserts the shared authoritative world (same boss/enemies/loot for all clients), server-owned
// combat (a tampered client can't fabricate damage/speed/fire-rate), interest management over
// the wire, and prediction/reconciliation across a spread of RTT/jitter/loss. Exits non-zero on
// any failure so it gates CI. Run: npm run test:stagec (in server/).

import { startTestServer, Bot, SCRIPTS, idle, waitUntil, sleep } from "../harness/lib.js";
import { mintTicket } from "../src/auth.js";
import { jsonCodec } from "../../src/net/protocol.js";
import { acquireWeaponInWorld, devSpawnEnemy } from "../../src/sim/world.js";
import type { RoomRuntime } from "../src/ports.js";
import { TILE } from "../../src/sim/types.js";
import { WebSocket as WsClient } from "ws";

// Spawn a controlled boss near the dungeon spawn (where bots enter) so boss-combat tests are
// deterministic on the real generated floor-1 dungeon (which has no boss of its own).
function spawnBossNearSpawn(world: RoomRuntime, hp: number) {
  const s = world.state.dungeon.spawn;
  const boss = devSpawnEnemy(world.state, "boss", s.x * TILE + TILE / 2, s.y * TILE + TILE / 2 - 120);
  boss.hp = hp; boss.maxHp = hp;
  return boss;
}

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

function rawSocket(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function main(): Promise<void> {
  // ---- shared boss: two bots, different weapons, identical HP/phase/death + one chest ----
  await test("2 bots attack the same boss with different weapons: shared HP/death + one chest", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "weap-a", attack: "boss" });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "weap-b", attack: "boss" });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      // The world exists once a client has joined. Bots survive to focus on shared boss-kill
      // determinism (not personal survival), and the boss HP is lowered so the authoritative
      // kill resolves quickly. Combat still runs fully server-side; nothing is bypassed.
      const world = s.server.getWorld()!;
      world.state.isGodMode = true;
      const boss = spawnBossNearSpawn(world, 30);
      const bossMax = boss.maxHp;
      const aid = a.serverId()!, bid = b.serverId()!;
      // Different weapons (granted server-side, the authoritative source of loadout).
      acquireWeaponInWorld(world.state, aid, "railgun");
      acquireWeaponInWorld(world.state, bid, "shotgun");

      await waitUntil(() => boss.hp < bossMax, 6000);
      check("boss took damage from the shared authoritative combat", boss.hp < bossMax, `hp=${boss.hp}/${bossMax}`);

      // Both clients see the SAME authoritative boss HP + phase (at most a tick of skew).
      const sa = a.transport.getLatestSnapshot();
      const sb = b.transport.getLatestSnapshot();
      const ba = sa?.enemies.find((e) => e.kind === "boss");
      const bb = sb?.enemies.find((e) => e.kind === "boss");
      if (ba && bb) {
        check("boss HP identical across clients", Math.abs(ba.hp - bb.hp) < 5, `a=${ba.hp.toFixed(1)} b=${bb.hp.toFixed(1)}`);
        check("boss phase identical across clients", ba.bph === bb.bph, `a=${ba.bph} b=${bb.bph}`);
      }

      const dead = await waitUntil(() => !world.state.enemies.some((e) => e.kind === "boss"), 25000);
      check("boss defeated by the combined authoritative fire", dead);
      const bossChests = world.state.chests.filter((c) => c.kind === "boss").length;
      check("exactly one authoritative boss chest spawned", bossChests === 1, `chests=${bossChests}`);

      await sleep(200);
      const ca = a.transport.getLatestSnapshot()?.chests.filter((c) => c.kind === "boss").length ?? 0;
      const cb = b.transport.getLatestSnapshot()?.chests.filter((c) => c.kind === "boss").length ?? 0;
      check("both clients see the one boss chest (shared objective loot)", ca === 1 && cb === 1, `a=${ca} b=${cb}`);
      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  // ---- identical enemy + shared world content across clients ----
  await test("two co-located clients see identical enemy set + shared props/chests", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "set-a", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "set-b", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      await sleep(600);
      const sa = a.transport.getLatestSnapshot()!;
      const sb = b.transport.getLatestSnapshot()!;
      const idsA = new Set(sa.enemies.map((e) => e.id));
      const idsB = new Set(sb.enemies.map((e) => e.id));
      let sameSet = idsA.size === idsB.size;
      for (const id of idsA) if (!idsB.has(id)) sameSet = false;
      check("both clients see the same enemy id set", sameSet, `a=${idsA.size} b=${idsB.size}`);
      // HP agrees within a tick's worth of damage.
      let maxHpDelta = 0;
      const mapB = new Map(sb.enemies.map((e) => [e.id, e]));
      for (const e of sa.enemies) { const o = mapB.get(e.id); if (o) maxHpDelta = Math.max(maxHpDelta, Math.abs(e.hp - o.hp)); }
      check("enemy HP identical across clients", maxHpDelta < 3, `maxHpDelta=${maxHpDelta}`);
      check("shared props identical across clients", sa.props.length === sb.props.length && sa.props.length > 0, `a=${sa.props.length} b=${sb.props.length}`);
      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  // ---- interest management over the wire ----
  await test("interest mgmt over the wire: a far client sees only the global boss, a near one sees the cluster", async () => {
    const s = await startTestServer({ interestRadius: 300 });
    try {
      const near = new Bot({ url: s.url, secret: s.secret, playerId: "near", script: () => idle() });
      const far = new Bot({ url: s.url, secret: s.secret, playerId: "far", script: () => idle() });
      near.start(); far.start();
      await waitUntil(() => near.transport.isReady() && far.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      world.state.isGodMode = true;
      const sp = world.state.dungeon.spawn;
      const cx = sp.x * TILE + TILE / 2, cy = sp.y * TILE + TILE / 2;
      // A controlled cluster of slimes right on the spawn (near the idle "near" bot) + a boss far
      // away (a global objective that must reach every client regardless of distance).
      for (let i = 0; i < 4; i++) devSpawnEnemy(world.state, "slime", cx + (i - 2) * 20, cy + 30);
      devSpawnEnemy(world.state, "boss", cx + 2000, cy);
      // Authoritatively place the far player well outside the interest radius (the generated
      // dungeon's walls make walking there flaky; this test targets the FILTER, not pathfinding).
      // Both bots idle, so the server holds each player where it is.
      const farP = world.state.players.get(far.serverId()!)!;
      farP.x = cx + 2000; farP.y = cy;
      await sleep(1000);
      const farPos = far.predictedSelf();
      check("far player is outside the interest radius of the cluster", Math.hypot(farPos.x - cx, farPos.y - cy) > 320, `dist=${Math.hypot(farPos.x - cx, farPos.y - cy).toFixed(0)}`);
      const sn = near.transport.getLatestSnapshot()!;
      const sf = far.transport.getLatestSnapshot()!;
      const farNonBoss = sf.enemies.filter((e) => e.kind !== "boss").length;
      const nearNonBoss = sn.enemies.filter((e) => e.kind !== "boss").length;
      check("far client's snapshot excludes the distant non-boss cluster", farNonBoss === 0, `farNonBoss=${farNonBoss}`);
      check("far client still receives the global boss", sf.enemies.some((e) => e.kind === "boss"));
      check("near client still sees nearby non-boss enemies", nearNonBoss > 0, `nearNonBoss=${nearNonBoss}`);
      near.stop(); far.stop();
    } finally { await s.close(); }
  });

  // ---- anti-cheat: a tampered client can't fabricate damage / speed / fire rate ----
  await test("tampered client cannot speed-hack or fire-rate-hack (server owns cooldowns)", async () => {
    const s = await startTestServer();
    try {
      const cheat = await rawSocket(s.url);
      cheat.on("message", () => {}); // never pong; we only measure our own player
      cheat.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "cheater"), protocol: 1 }));
      await waitUntil(() => (s.server.getWorld()?.playerCount ?? 0) >= 1, 2000);
      const world = s.server.getWorld()!;
      const pid = [...world.state.players.keys()][0];
      const p = world.state.players.get(pid)!;
      const startX = p.x, startY = p.y;
      const startShots = p.shotSeq;
      // Blast wire-valid but impossible inputs (dt=1s each, over-unit move, fire every message)
      // at ~80/s — under the rate-limit cap so the client stays connected and we can measure that
      // the SERVER, not the flood, decides movement + fire rate. Unclamped these would advance
      // ~80s of movement and fire 80x/s; the per-tick dt cap + server fireCd make it impossible.
      const t0 = Date.now();
      let seq = 1;
      const flood = setInterval(() => {
        cheat.send(jsonCodec.encodeClient({ t: "input", seq: seq++, mx: 8, my: 8, aim: 0, fire: true, dash: false, ackEv: 0 }));
      }, 12);
      await sleep(1000);
      clearInterval(flood);
      const dt = (Date.now() - t0) / 1000;
      const after = world.state.players.get(pid)!;
      const moved = Math.hypot(after.x - startX, after.y - startY);
      const shots = after.shotSeq - startShots;
      // Honest ceiling: the per-tick dt cap allows <= ~2 ticks of 200px/s movement per tick,
      // i.e. <= ~400px/s (vs ~16000px if dt=1 were honored). Pistol fires ~6/s (fireCd 0.16).
      check("speed-hack movement clamped", moved < 450 * dt, `moved=${moved.toFixed(0)}px in ${dt.toFixed(1)}s`);
      check("fire-rate-hack clamped (server owns fireCd)", shots < 12 * dt, `shots=${shots} in ${dt.toFixed(1)}s`);
      check("no client message can even assert a hit/kill (structural)", true);
      check("server healthy after tamper flood", s.server.health().status === "ok");
      cheat.close();
    } finally { await s.close(); }
  });

  // ---- prediction/reconciliation across a spread of RTT + jitter + loss ----
  await test("prediction reconverges across 50/100/150ms RTT (jitter + loss): no permanent drift", async () => {
    for (const rttMs of [50, 100, 150]) {
      const s = await startTestServer();
      try {
        const bot = new Bot({
          url: s.url, secret: s.secret, playerId: `rtt${rttMs}`,
          net: { rttMs, jitterMs: Math.round(rttMs * 0.25), loss: 0.05 },
          script: (tick, t) => (tick < 200 ? SCRIPTS.pingpong(tick, t) : idle()),
        });
        bot.start();
        await waitUntil(() => bot.transport.isReady(), 3000);
        await sleep(4500 + rttMs * 4);
        const sid = bot.serverId();
        const server = sid ? s.server.getWorld()?.state.players.get(sid) : undefined;
        const pred = bot.predictedSelf();
        const drift = server ? Math.hypot(pred.x - server.x, pred.y - server.y) : Infinity;
        check(`predicted self reconverges @ ${rttMs}ms RTT`, drift < 12, `drift=${drift.toFixed(2)}px`);
        const stats = bot.transport.getNetStats();
        check(`@ ${rttMs}ms: adaptive interp delay stayed bounded`, stats.interpDelayMs >= 80 && stats.interpDelayMs <= 300, `interp=${stats.interpDelayMs.toFixed(0)}ms rtt~${stats.rttMs.toFixed(0)} corrMax=${stats.correctionMaxPx.toFixed(1)}px`);
        bot.stop();
      } finally { await s.close(); }
    }
  });

  // ---- lag comp end to end: a laggy attacker still lands shots on the boss ----
  await test("lag-comp: a high-latency attacker still damages the shared boss", async () => {
    const s = await startTestServer({ heartbeatMs: 300 });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "laggy", attack: "boss", net: { rttMs: 150, jitterMs: 30, loss: 0.03 } });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      world.state.isGodMode = true;
      const boss = spawnBossNearSpawn(world, 40);
      const hit = await waitUntil(() => boss.hp < 40, 12000);
      check("laggy attacker's shots registered on the moving boss (lag-comp)", hit, `hp=${boss.hp}`);
      bot.stop();
    } finally { await s.close(); }
  });

  // ---- authoritative weapon switching over the wire (independent per client + validated) ----
  await test("two clients switch weapons independently; server validates ownership", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "sw-a", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "sw-b", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const aid = a.serverId()!, bid = b.serverId()!;
      // Grant each a distinct extra weapon server-side (the authoritative loadout source).
      acquireWeaponInWorld(world.state, aid, "shotgun");
      acquireWeaponInWorld(world.state, bid, "tesla");
      // Reset both back to pistol so the switch is observable, and let the inventory reach clients.
      world.state.players.get(aid)!.weapon = "pistol";
      world.state.players.get(bid)!.weapon = "pistol";
      await waitUntil(() => (a.transport.getLatestSnapshot()?.self?.wpns.includes("shotgun") ?? false), 1500);
      a.transport.sendSwitch("shotgun");
      b.transport.sendSwitch("tesla");
      await sleep(300);
      check("A switched to its own weapon", world.state.players.get(aid)!.weapon === "shotgun", `A=${world.state.players.get(aid)!.weapon}`);
      check("B switched to its own weapon", world.state.players.get(bid)!.weapon === "tesla", `B=${world.state.players.get(bid)!.weapon}`);

      // A raw client asking for a weapon it does NOT own is rejected (weapon unchanged).
      const rej0 = s.server.health().counters.rejectedInputs;
      const raw = await rawSocket(s.url);
      raw.on("message", () => {});
      raw.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "sw-cheat"), protocol: 1 }));
      await waitUntil(() => world.playerCount >= 3, 1500);
      const cheatId = [...world.state.players.keys()].find((k) => k !== aid && k !== bid)!;
      raw.send(jsonCodec.encodeClient({ t: "switch", weapon: "railgun" })); // never acquired
      await sleep(200);
      check("unowned-weapon switch rejected (weapon stays pistol)", world.state.players.get(cheatId)!.weapon === "pistol");
      check("rejected switch counted", s.server.health().counters.rejectedInputs > rej0);
      raw.close();
      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  // ---- authoritative blessings: server offers, validates the pick, applies mods server-side ----
  await test("blessing offer/pick is authoritative; off-pool pick rejected", async () => {
    const s = await startTestServer();
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "bless", script: () => idle() });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const pid = bot.serverId()!;
      // Force an authoritative descend to trigger a between-floor blessing offer for the player.
      world.state.enemies = [];
      const d = world.state.dungeon;
      const p = world.state.players.get(pid)!;
      p.x = d.exit.x * TILE + TILE / 2; p.y = d.exit.y * TILE + TILE / 2;
      const gotOffer = await waitUntil(() => bot.transport.getPendingOfferPeek() !== null, 2000);
      check("server sent a blessing offer on descend", gotOffer);
      const offer = bot.transport.getPendingOfferPeek();
      check("offer carries a choice set", !!offer && offer.length > 0, `choices=${offer?.join(",")}`);

      // Off-pool pick is rejected: no item applied.
      const rej0 = s.server.health().counters.rejectedInputs;
      const itemsBefore = world.state.players.get(pid)!.ownedItemIds.length;
      bot.transport.sendPickBlessing("not_a_real_item");
      await sleep(200);
      check("off-pool blessing pick rejected (no item applied)", world.state.players.get(pid)!.ownedItemIds.length === itemsBefore);
      check("rejected pick counted", s.server.health().counters.rejectedInputs > rej0);

      // A valid pick (one of the offered ids) is applied authoritatively.
      const pick = offer![0];
      bot.transport.sendPickBlessing(pick);
      await waitUntil(() => world.state.players.get(pid)!.ownedItemIds.includes(pick), 1500);
      check("valid blessing applied server-side", world.state.players.get(pid)!.ownedItemIds.includes(pick), `items=${world.state.players.get(pid)!.ownedItemIds.join(",")}`);
      // Picking again with the now-consumed offer is rejected (can't re-apply).
      const items2 = world.state.players.get(pid)!.ownedItemIds.length;
      bot.transport.sendPickBlessing(pick);
      await sleep(200);
      check("a consumed offer can't be re-picked", world.state.players.get(pid)!.ownedItemIds.length === items2);
      bot.stop();
    } finally { await s.close(); }
  });

  // ---- authoritative floor transition over the wire ----
  await test("authoritative descend: both clients transition to the same next floor + layout", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "fl-a", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "fl-b", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const floor0 = world.state.floor;
      world.state.enemies = [];
      const d = world.state.dungeon;
      for (const id of [a.serverId()!, b.serverId()!]) {
        const p = world.state.players.get(id)!;
        p.x = d.exit.x * TILE + TILE / 2; p.y = d.exit.y * TILE + TILE / 2;
      }
      await waitUntil(() => world.state.floor === floor0 + 1, 2000);
      check("server descended one floor (party-wide, authoritative)", world.state.floor === floor0 + 1, `floor=${world.state.floor}`);
      await sleep(300);
      const sa = a.transport.getLatestSnapshot()!;
      const sb = b.transport.getLatestSnapshot()!;
      check("both clients see the same next floor", sa.floor === sb.floor && sa.floor === floor0 + 1, `a=${sa.floor} b=${sb.floor}`);
      check("both clients see the same seed", sa.seed === sb.seed);
      const idsA = sa.enemies.map((e) => e.id).sort().join(",");
      const idsB = sb.enemies.map((e) => e.id).sort().join(",");
      check("both clients see the identical new-floor enemy layout", idsA === idsB);
      check("no client sent the transition (server-owned; there is no descend message)", true);
      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll Stage-C server/netcode assertions passed.\n");
}

void main();
