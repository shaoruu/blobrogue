import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bot, idle, startTestServer, waitUntil, type TestServer } from "../harness/lib.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function controlToken(
  secret: string,
  action: "snapshot" | "restore",
  worldId: string,
  jti: string,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(JSON.stringify({
    action,
    worldId,
    iat,
    exp: iat + 5,
    jti,
  }), "utf8").toString("base64url");
  const body = `brc1.${encoded}`;
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

async function worldAction(
  port: number,
  secret: string,
  action: "snapshot" | "restore",
  worldId: string,
  jti: string,
): Promise<{ status: number; body: Record<string, string | number | boolean> }> {
  const response = await fetch(`http://127.0.0.1:${port}/admin/world-action`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlToken(secret, action, worldId, jti)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, worldId }),
  });
  return {
    status: response.status,
    body: JSON.parse(await response.text()) as Record<string, string | number | boolean>,
  };
}

const directory = mkdtempSync(join(tmpdir(), "blobrogue-run-snapshot-"));
const snapshotDirectory = join(directory, "snapshots");
const generationStatePath = join(directory, "admission.json");
const snapshotPath = join(snapshotDirectory, "room:SAVE:g1.json");
const controlSecret = "run-snapshot-control-secret";
const worldId = "room:SAVE:g1";
let first: TestServer | null = null;
let second: TestServer | null = null;
let ian: Bot | null = null;
let anson: Bot | null = null;
let intruder: Bot | null = null;

try {
  first = await startTestServer({
    controlSecret,
    generationStatePath,
    runSnapshotDir: snapshotDirectory,
    resumeGraceMs: 10_000,
  });
  const ianBot = new Bot({
    url: first.url,
    secret: first.secret,
    playerId: "ian-account",
    world: worldId,
    name: "Ian",
    kit: "phantom",
    masteryLevel: 5,
    isPetChoiceMade: true,
    script: () => idle(),
    reconnect: { baseDelayMs: 50, maxDelayMs: 200, graceMs: 10_000 },
  });
  const ansonBot = new Bot({
    url: first.url,
    secret: first.secret,
    playerId: "anson-account",
    world: worldId,
    name: "Anson",
    kit: "bulwark",
    masteryLevel: 5,
    isPetChoiceMade: true,
    script: () => idle(),
    reconnect: { baseDelayMs: 50, maxDelayMs: 200, graceMs: 10_000 },
  });
  ian = ianBot;
  anson = ansonBot;
  ianBot.start();
  ansonBot.start();
  check("both co-op players join the live generation",
    await waitUntil(() => ianBot.transport.isReady() && ansonBot.transport.isReady(), 4_000));

  const liveWorld = first.server.getWorld(worldId)!;
  check("both clients confirm possession of their reconnect credentials",
    await waitUntil(() => (
      [...liveWorld.conns.values()].length === 2
      && [...liveWorld.conns.values()].every((conn) => conn.isResumeTokenConfirmed)
    ), 2_000));
  check("admin setup reaches the deep floor", liveWorld.adminWarpToFloor(55));
  const ianPid = [...liveWorld.conns.values()].find((conn) => conn.authName === "ian-account")!.playerId!;
  const ansonPid = [...liveWorld.conns.values()].find((conn) => conn.authName === "anson-account")!.playerId!;
  const ianBody = liveWorld.state.players.get(ianPid)!;
  const ansonBody = liveWorld.state.players.get(ansonPid)!;
  ianBody.hp = 2.5;
  ianBody.coins = 137;
  ianBody.ownedWeapons.push("tesla");
  ianBody.ownedItemIds.push("it_dmg", "it_dmg");
  ianBody.mods.damageMult = 1.7;
  ansonBody.hp = 3.5;
  ansonBody.coins = 91;
  ansonBody.ownedWeapons.push("shotgun");
  ansonBody.ownedItemIds.push("it_speed");
  ansonBody.mods.moveSpeedMult = 1.2;
  if (liveWorld.state.encounter !== null) liveWorld.state.encounter.failed = true;

  const snapshot = await worldAction(
    first.port,
    controlSecret,
    "snapshot",
    worldId,
    "111111111111111111111111",
  );
  check("signed admin snapshot succeeds with build+floor fidelity",
    snapshot.status === 200
    && snapshot.body.fidelity === "build+floor"
    && snapshot.body.snapshotPath === snapshotPath);
  check("snapshot is durable and owner-readable only",
    readFileSync(snapshotPath, "utf8").includes('"floor":55')
    && (statSync(snapshotPath).mode & 0o777) === 0o600);

  await fetch(`http://127.0.0.1:${first.port}/admin/flush`, { method: "POST" });
  check("deploy flush closes both clients into reconnect mode without retiring the room",
    await waitUntil(() => (
      ianBot.transport.getReconnectInfo().isReconnecting
      && ansonBot.transport.getReconnectInfo().isReconnecting
    ), 3_000));
  ianBot.dropConnection(true);
  ansonBot.dropConnection(true);
  const port = first.port;
  await first.close();
  first = null;

  second = await startTestServer({
    port,
    controlSecret,
    generationStatePath,
    runSnapshotDir: snapshotDirectory,
    resumeGraceMs: 10_000,
  });
  const intruderBot = new Bot({
    url: second.url,
    secret: second.secret,
    playerId: "new-party-member",
    world: worldId,
    script: () => idle(),
  });
  intruder = intruderBot;
  intruderBot.start();
  check("a fresh join cannot collide with either restored player id",
    await waitUntil(() => intruderBot.transport.isReady(), 3_000)
    && intruderBot.transport.getSelfServerId() !== ianPid
    && intruderBot.transport.getSelfServerId() !== ansonPid);
  intruderBot.stop();
  intruder = null;
  check("the fresh body leaves without disturbing restored seats",
    await waitUntil(() => second?.server.getWorld(worldId)?.playerCount === 2, 2_000));
  ianBot.restoreNetwork();
  ansonBot.restoreNetwork();
  check("both clients resume their original seats after the process restart",
    await waitUntil(() => (
      ianBot.transport.isReady()
      && ansonBot.transport.isReady()
      && !ianBot.transport.getReconnectInfo().isReconnecting
      && !ansonBot.transport.getReconnectInfo().isReconnecting
    ), 6_000));

  const restoredWorld = second.server.getWorld(worldId)!;
  const restoredIan = restoredWorld.state.players.get(ianPid);
  const restoredAnson = restoredWorld.state.players.get(ansonPid);
  check("restore keeps both identities in one authoritative room",
    restoredWorld.playerCount === 2
    && ianBot.transport.getSelfServerId() === ianPid
    && ansonBot.transport.getSelfServerId() === ansonPid);
  check("Ian's HP, kit, weapons, blessings, mods, and coins survive",
    restoredIan?.hp === 2.5
    && restoredIan.kitId === "phantom"
    && restoredIan.ownedWeapons.includes("tesla")
    && restoredIan.ownedItemIds.filter((item) => item === "it_dmg").length === 2
    && restoredIan.mods.damageMult === 1.7
    && restoredIan.coins === 137);
  check("Anson's HP, kit, weapons, blessings, mods, and coins survive",
    restoredAnson?.hp === 3.5
    && restoredAnson.kitId === "bulwark"
    && restoredAnson.ownedWeapons.includes("shotgun")
    && restoredAnson.ownedItemIds.includes("it_speed")
    && restoredAnson.mods.moveSpeedMult === 1.2
    && restoredAnson.coins === 91);
  check("floor 55 is freshly regenerated by the new build",
    restoredWorld.state.floor === 55
    && restoredWorld.state.enemies.length > 0
    && restoredWorld.state.encounter?.failed === false);
  check("restored players are present and restored runs cannot mint progression",
    restoredIan?.isAbsent === false
    && restoredAnson?.isAbsent === false
    && restoredWorld.runReceiptParticipants().length === 0);

  const restore = await worldAction(
    second.port,
    controlSecret,
    "restore",
    worldId,
    "222222222222222222222222",
  );
  check("post-restart restore command is idempotent",
    restore.status === 200
    && restore.body.fidelity === "build+floor"
    && restoredWorld.playerCount === 2);
} finally {
  ian?.stop();
  anson?.stop();
  intruder?.stop();
  if (first !== null) await first.close();
  if (second !== null) await second.close();
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(`\nrun snapshot: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
