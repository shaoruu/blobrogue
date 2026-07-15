// Patch's shop over REAL sockets: the authoritative shopBuy command end-to-end. Real
// WSTransport clients join a room-scoped world moved onto a shop floor, and the suite
// asserts:
//   1. both wires carry identical shared stock/layout and viewer-specific personal stock;
//   2. a client's BUY intent resolves server-side — coins server-owned, weapon granted,
//      the claim flips to SOLD on every wire (state, not events);
//   3. two clients racing one shared pedestal get exactly ONE winner; the loser's coins
//      are untouched and their wire reads the claim honestly;
//   4. a replayed cseq (resent command) can never double-charge, an out-of-range or
//      unaffordable buy rejects without consuming, and a downed buyer is refused;
//   5. reconnect: the stall's claim/reroll state survives a drop + resume byte-for-byte
//      (the seat keeps the body; the snapshot carries the same shop truth).
// Run: npm run test:shop (in server/).

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { mintTicket } from "../src/auth.js";
import { jsonCodec, PROTOCOL_VERSION } from "../../src/net/protocol.js";
import type { ShopWire } from "../../src/net/protocol.js";
import { loadFloorIntoWorld } from "../../src/sim/world.js";
import type { RoomRuntime } from "../src/ports.js";
import { SHOP } from "../../src/sim/balance.js";
import { WebSocket as WsClient } from "ws";

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

// Move the room's world onto floor 3 (the first shop floor) authoritatively — the same
// loadFloorIntoWorld a real descend runs; clients rebuild geometry off the snapshot.
function gotoShopFloor(world: RoomRuntime): void {
  loadFloorIntoWorld(world.state, 3);
  world.state.enemies = [];
  world.state.pendingSpawns = [];
}

async function main(): Promise<void> {
  await test("the stall rides both wires identically; a BUY resolves authoritatively", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "shopper-a", world: "room:SHOP", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "shopper-b", world: "room:SHOP", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      const world = s.server.getWorld("room:SHOP")!;
      gotoShopFloor(world);
      const hasStall = await waitUntil(() => (a.transport.getLatestSnapshot()?.shop?.slots.length ?? 0) === 5
        && (b.transport.getLatestSnapshot()?.shop?.slots.length ?? 0) === 5, 3000);
      check("both wires carry the 5-station stall after the floor move", hasStall);
      const sharedProjection = (shop: ShopWire): string =>
        JSON.stringify(shop.slots.map((slot) => ({
          id: slot.id,
          kind: slot.k,
          isShared: slot.sh,
          weapon: slot.sh ? slot.wpn : null,
          price: slot.pr,
          x: slot.x,
          y: slot.y,
          isMystery: slot.myst,
        })));
      check("both wires agree on shared stock, layout, rarity prices, and mystery state",
        sharedProjection(a.transport.getLatestSnapshot()!.shop!)
        === sharedProjection(b.transport.getLatestSnapshot()!.shop!));

      const aSim = world.state.players.get(a.serverId()!)!;
      const slot = world.state.shop!.slots.find((x) => x.kind === "weapon")!;
      aSim.coins = slot.price;
      aSim.x = slot.x; aSim.y = slot.y;
      a.transport.requestShopBuy(slot.id);
      const isBought = await waitUntil(() => aSim.ownedWeapons.includes(slot.weapon!), 2000);
      check("the buy resolved server-side (weapon granted, exact price paid)",
        isBought && aSim.coins === 0 && world.state.shop!.slots.find((x) => x.id === slot.id)!.soldTo === a.serverId());
      const isSoldOnWires = await waitUntil(() => {
        const wa = a.transport.getLatestSnapshot()?.shop?.slots.find((x) => x.id === slot.id);
        const wb = b.transport.getLatestSnapshot()?.shop?.slots.find((x) => x.id === slot.id);
        return wa?.sold === a.serverId() && wb?.sold === a.serverId();
      }, 2000);
      check("the claim reaches BOTH wires (the teammate reads SOLD from state)", isSoldOnWires);
      check("the buyer's coins flow back via SelfWire (server-owned)",
        await waitUntil(() => a.transport.getLatestSnapshot()?.self?.coins === 0, 2000));

      // A heart buy for the OTHER client (personal slot): +1 HP exactly, once.
      const bSim = world.state.players.get(b.serverId()!)!;
      const heart = world.state.shop!.slots.find((x) => x.kind === "heart")!;
      bSim.hp = 2; bSim.coins = SHOP.heartPrice;
      bSim.x = heart.x; bSim.y = heart.y;
      b.transport.requestShopBuy(heart.id);
      const isHealed = await waitUntil(() => bSim.hp === 3, 2000);
      check("the heart station heals exactly +1 for its buyer", isHealed && bSim.coins === 0);
      b.transport.requestShopBuy(heart.id);
      await sleep(250);
      check("a second heart buy is refused (one per player per shop) — nothing consumed", bSim.hp === 3 && bSim.coins === 0);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  await test("two clients race ONE shared pedestal: exactly one winner, honest SOLD for the loser", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "race-a", world: "room:RACE", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "race-b", world: "room:RACE", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      const world = s.server.getWorld("room:RACE")!;
      gotoShopFloor(world);
      await waitUntil(() => (a.transport.getLatestSnapshot()?.shop?.slots.length ?? 0) === 5, 3000);

      const slot = world.state.shop!.slots.find((x) => x.kind === "weapon")!;
      const aSim = world.state.players.get(a.serverId()!)!;
      const bSim = world.state.players.get(b.serverId()!)!;
      for (const p of [aSim, bSim]) { p.coins = slot.price; p.x = slot.x; p.y = slot.y; }
      const rej0 = s.server.health().counters.rejectedInputs;
      a.transport.requestShopBuy(slot.id);
      b.transport.requestShopBuy(slot.id);
      await waitUntil(() => slot.soldTo !== null, 2000);
      await sleep(300); // let the loser's command land too
      const winners = [aSim, bSim].filter((p) => p.ownedWeapons.includes(slot.weapon!));
      const loser = aSim.ownedWeapons.includes(slot.weapon!) ? bSim : aSim;
      check("exactly ONE winner claimed the physical weapon", winners.length === 1 && slot.soldTo !== null);
      check("the loser's coins are untouched (a lost race never consumes)", loser.coins === slot.price, `coins=${loser.coins}`);
      check("the losing command was counted as rejected (ops signal)", s.server.health().counters.rejectedInputs > rej0);
      const agreed = await waitUntil(() => {
        const wa = a.transport.getLatestSnapshot()?.shop?.slots.find((x) => x.id === slot.id)?.sold;
        const wb = b.transport.getLatestSnapshot()?.shop?.slots.find((x) => x.id === slot.id)?.sold;
        return wa === slot.soldTo && wb === slot.soldTo;
      }, 2000);
      check("both wires agree on the winner", agreed);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  await test("raw socket: replayed cseq never double-charges; invalid buys reject without consuming", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "watch", world: "room:CSEQ", script: () => idle() });
      a.start();
      await waitUntil(() => a.transport.isReady(), 3000);
      const world = s.server.getWorld("room:CSEQ")!;
      gotoShopFloor(world);

      const raw = await rawSocket(s.url);
      raw.on("message", () => {});
      raw.send(jsonCodec.encodeClient({ t: "join", ticket: mintTicket(s.secret, "cseq-cheat", 60, Date.now(), { worldId: "room:CSEQ" }), protocol: PROTOCOL_VERSION }));
      await waitUntil(() => world.playerCount >= 2, 1500);
      const cheatId = [...world.state.players.keys()].find((k) => k !== a.serverId())!;
      const cheat = world.state.players.get(cheatId)!;
      const heart = world.state.shop!.slots.find((x) => x.kind === "heart")!;
      const blessing = world.state.shop!.slots.find((x) => x.kind === "blessing")!;
      cheat.hp = 1;
      cheat.coins = SHOP.heartPrice * 3;
      cheat.x = heart.x; cheat.y = heart.y;

      raw.send(jsonCodec.encodeClient({ t: "shopBuy", slot: heart.id, cseq: 1 }));
      const isOnce = await waitUntil(() => cheat.hp === 2, 2000);
      raw.send(jsonCodec.encodeClient({ t: "shopBuy", slot: heart.id, cseq: 1 })); // exact replay
      await sleep(250);
      check("the first buy landed; the exact replay changed NOTHING (cseq idempotency)",
        isOnce && cheat.hp === 2 && cheat.coins === SHOP.heartPrice * 2);

      // A fresh cseq on the same personal slot is refused by the sim (already bought).
      raw.send(jsonCodec.encodeClient({ t: "shopBuy", slot: heart.id, cseq: 2 }));
      await sleep(250);
      check("a fresh-cseq rebuy of a bought personal slot consumes nothing",
        cheat.hp === 2 && cheat.coins === SHOP.heartPrice * 2);

      // Remote buy: standing across the map, the pedestal is out of authoritative reach.
      cheat.x = 40; cheat.y = 40;
      raw.send(jsonCodec.encodeClient({ t: "shopBuy", slot: blessing.id, cseq: 3 }));
      await sleep(250);
      check("a remote buy (out of range) is refused without consuming",
        cheat.coins === SHOP.heartPrice * 2 && !cheat.ownedItemIds.includes(blessing.itemId!));

      // A downed buyer is refused even at point-blank.
      cheat.x = blessing.x; cheat.y = blessing.y;
      cheat.isDown = true;
      raw.send(jsonCodec.encodeClient({ t: "shopBuy", slot: blessing.id, cseq: 4 }));
      await sleep(250);
      check("a downed buyer is refused", cheat.coins === SHOP.heartPrice * 2 && !cheat.ownedItemIds.includes(blessing.itemId!));

      raw.close();
      a.stop();
    } finally { await s.close(); }
  });

  await test("reconnect preserves the stall: claims + reroll state identical after resume", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({
        url: s.url, secret: s.secret, playerId: "resumer", world: "room:BACK", script: () => idle(),
        reconnect: { baseDelayMs: 50, maxDelayMs: 100, graceMs: 10000 },
      });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "stayer", world: "room:BACK", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      const world = s.server.getWorld("room:BACK")!;
      gotoShopFloor(world);
      await waitUntil(() => (a.transport.getLatestSnapshot()?.shop?.slots.length ?? 0) === 5, 3000);

      // A claims a weapon and burns one reroll before the outage.
      const aSim = world.state.players.get(a.serverId()!)!;
      const weapon = world.state.shop!.slots.find((x) => x.kind === "weapon")!;
      const reroll = world.state.shop!.slots.find((x) => x.kind === "reroll")!;
      aSim.coins = weapon.price + SHOP.rerollCost;
      aSim.x = weapon.x; aSim.y = weapon.y;
      a.transport.requestShopBuy(weapon.id);
      await waitUntil(() => weapon.soldTo === a.serverId(), 2000);
      aSim.x = reroll.x; aSim.y = reroll.y;
      a.transport.requestShopBuy(reroll.id);
      await waitUntil(() => world.state.shop!.rerollsUsed === 1, 2000);
      const stallBefore = JSON.stringify(world.state.shop);

      a.dropConnection();
      const resumed = await waitUntil(() => a.transport.isReady() && a.transport.getStatus() === "open", 8000);
      check("the shopper resumed into the same world", resumed);
      check("the stall survived the outage byte-for-byte (claims + reroll counter)",
        JSON.stringify(world.state.shop) === stallBefore);
      const wireAgain = await waitUntil(() => {
        const shop = a.transport.getLatestSnapshot()?.shop;
        return shop !== null && shop !== undefined
          && shop.slots.find((x) => x.id === weapon.id)?.sold === a.serverId()
          && shop.ru === 1;
      }, 3000);
      check("the resumed wire carries the same claim + reroll state", wireAgain);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll shop socket assertions passed.\n");
}

void main();
