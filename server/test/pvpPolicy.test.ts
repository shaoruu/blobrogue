import { Bot, idle, startTestServer, waitUntil } from "../harness/lib.js";
import { createHmac } from "node:crypto";
import { WebSocket as WsClient } from "ws";
import { PVP } from "../../src/sim/pvp.js";
import { PRIVATE_DRAFT_PVP_POLICY, PVP_POLICY_MAX_PLAYERS } from "../../src/net/pvpPolicy.js";
import { mintTicket } from "../src/auth.js";
import { jsonCodec, PROTOCOL_VERSION } from "../../src/net/protocol.js";

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

async function rejectedJoin(ticket: string, resume?: string): Promise<string> {
  const socket = new WsClient(server.url);
  await new Promise<void>((resolve) => socket.on("open", resolve));
  let code = "";
  socket.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString("utf8")) as { t?: string; code?: string };
    if (frame.t === "error") code = frame.code ?? "";
  });
  socket.send(jsonCodec.encodeClient({ t: "join", ticket, protocol: PROTOCOL_VERSION, resume }));
  await waitUntil(() => code.length > 0, 2_000);
  socket.close();
  return code;
}

function signedUnknownPolicyTicket(playerId: string): string {
  const payload = {
    pid: playerId,
    exp: Math.floor(Date.now() / 1000) + 120,
    wld: worldId,
    pp: "future_public_v1",
    kt: "gunner",
    ml: 1,
    pc: true,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const body = `v2.${encoded}`;
  const signature = createHmac("sha256", server.secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

const server = await startTestServer({ pvpPrivateEnabled: true, resumeGraceMs: 4_000 });
const worldId = "pvp:room:CAPA:g1";
const bots = Array.from({ length: PVP_POLICY_MAX_PLAYERS }, (_, index) => new Bot({
  url: server.url,
  secret: server.secret,
  playerId: `cap-${index + 1}`,
  world: worldId,
  kit: "gunner",
  masteryLevel: 1,
  isPetChoiceMade: true,
  script: () => idle(),
  reconnect: { baseDelayMs: 80, maxDelayMs: 250, graceMs: 4_000 },
}));

try {
  for (const bot of bots) bot.start();
  check("exactly four private-policy seats can join",
    await waitUntil(() => bots.every((bot) => bot.transport.isReady()), 6_000));
  const world = server.server.getWorld(worldId);
  check("world retains its immutable canonical policy",
    world?.pvpPolicy === PRIVATE_DRAFT_PVP_POLICY);
  check("GS has exactly four bodies", world?.playerCount === PVP_POLICY_MAX_PLAYERS);
  check("private policy world reaches the dormant PVP simulation",
    await waitUntil(() => world?.state.match?.phase === "live", 6_000));
  const legacyTicket = mintTicket(server.secret, "legacy-second", 120, Date.now(), {
    worldId,
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
  });
  check("existing private world rejects a missing-policy second ticket without mutation",
    await rejectedJoin(legacyTicket) === "policy_required"
    && world?.playerCount === PVP_POLICY_MAX_PLAYERS);
  check("existing private world rejects an unknown-policy second ticket without mutation",
    await rejectedJoin(signedUnknownPolicyTicket("unknown-second")) === "policy_invalid"
    && world?.playerCount === PVP_POLICY_MAX_PLAYERS);

  const fifth = new Bot({
    url: server.url,
    secret: server.secret,
    playerId: "cap-5",
    world: worldId,
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  const sixth = new Bot({
    url: server.url,
    secret: server.secret,
    playerId: "cap-6",
    world: worldId,
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  fifth.start();
  sixth.start();
  check("fifth and sixth joins fail closed with room_full",
    await waitUntil(() =>
      (fifth.transport.lastError ?? "").includes("room_full")
      && (sixth.transport.lastError ?? "").includes("room_full"), 3_000));
  check("concurrent overflow creates no extra body",
    server.server.getWorld(worldId)?.playerCount === PVP_POLICY_MAX_PLAYERS);

  const reservedToken = bots[3].transport.getResumeToken();
  bots[3].dropConnection(true);
  check("reserved fourth seat remains part of occupancy",
    await waitUntil(() => {
      const current = server.server.getWorld(worldId);
      return current?.playerCount === PVP_POLICY_MAX_PLAYERS
        && [...(current?.seats() ?? [])].length === 1;
    }, 3_000));
  const replacement = new Bot({
    url: server.url,
    secret: server.secret,
    playerId: "cap-replacement",
    world: worldId,
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  replacement.start();
  check("reserved seat prevents replacement overbooking",
    await waitUntil(() => (replacement.transport.lastError ?? "").includes("room_full"), 3_000));
  check("missing-policy resume cannot consume the reserved seat",
    reservedToken !== null
    && await rejectedJoin(legacyTicket, reservedToken) === "policy_required"
    && [...(world?.seats() ?? [])].length === 1);
  bots[3].restoreNetwork();
  check("fresh policy-bound ticket plus continuity token resumes the same seat",
    await waitUntil(() => bots[3].transport.isReady() && [...(world?.seats() ?? [])].length === 0, 5_000)
    && world?.playerCount === PVP_POLICY_MAX_PLAYERS);

  const duplicate = new Bot({
    url: server.url,
    secret: server.secret,
    playerId: "cap-1",
    world: worldId,
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  duplicate.start();
  check("duplicate identity requires continuity instead of consuming a slot",
    await waitUntil(() => (duplicate.transport.lastError ?? "").includes("resume_required"), 3_000)
    && server.server.getWorld(worldId)?.playerCount === PVP_POLICY_MAX_PLAYERS);

  if (world !== undefined) {
    for (const player of world.state.players.values()) {
      player.pvpDraftFrags = PVP.draftEveryFrags;
      player.pvpDraftActiveTicks = Math.round(PVP.draftEverySec * 20);
    }
  }
  check("canonical room policy is the sole active draft runtime switch",
    await waitUntil(() => world?.state.pendingBlessings.size === PVP_POLICY_MAX_PLAYERS, 2_000));
  check("all same-tick offers are isolated three-choice sets",
    bots.every((bot) => {
      const offer = bot.transport.getPendingOfferPeek();
      return offer?.k === "pvp_draft"
        && offer.tr === "dedup"
        && offer.choices.length === PVP.draftChoices
        && new Set(offer.choices).size === PVP.draftChoices;
    }));
  const offers = bots.map((bot) => bot.transport.getPendingOfferPeek()!);
  const rejectedBefore = server.server.health().counters.rejectedInputs;
  bots[0].transport.sendChooseBlessing(offers[0].id + 1, offers[0].choices[0]);
  const crossChoice = offers[1].choices.find((choice) => !offers[0].choices.includes(choice));
  check("same-tick player offers have independently seeded sets", crossChoice !== undefined);
  if (crossChoice !== undefined) {
    bots[0].transport.sendChooseBlessing(offers[0].id, crossChoice);
  }
  check("stale and cross-player choices reject without clearing the owner offer",
    await waitUntil(
      () => server.server.health().counters.rejectedInputs >= rejectedBefore + 2,
      2_000,
    )
    && world?.state.pendingBlessings.has(bots[0].transport.getSelfServerId() ?? "") === true);

  bots[0].transport.sendChooseBlessing(offers[0].id, offers[0].choices[0]);
  check("one valid pick clears only that player's offer",
    await waitUntil(() => {
      const pid = bots[0].transport.getSelfServerId();
      return pid !== null
        && world?.state.pendingBlessings.has(pid) === false
        && (world?.state.pendingBlessings.size ?? 0) === PVP_POLICY_MAX_PLAYERS - 1;
    }, 2_000));

  const reconnectPid = bots[2].transport.getSelfServerId()!;
  const reconnectOffer = bots[2].transport.consumePendingOffer()!;
  const reconnectRemaining = world?.state.players.get(reconnectPid)?.pvpDraftOfferTicksLeft ?? 0;
  bots[2].dropConnection(true);
  check("disconnect freezes that chooser's remaining offer duration",
    await waitUntil(() => world?.state.players.get(reconnectPid)?.isAbsent === true, 2_000)
    && await waitUntil(
      () => world?.state.players.get(reconnectPid)?.pvpDraftOfferTicksLeft === reconnectRemaining,
      500,
    ));
  bots[2].restoreNetwork();
  check("reconnect restores the exact same authoritative offer",
    await waitUntil(() => {
      const offer = bots[2].transport.getPendingOfferPeek();
      return !bots[2].transport.getReconnectInfo().isReconnecting
        && world?.state.players.get(reconnectPid)?.isAbsent === false
        && offer?.id === reconnectOffer.id
        && offer.k === "pvp_draft"
        && offer.choices.join(",") === reconnectOffer.choices.join(",");
    }, 4_000));

  const expiryPid = bots[3].transport.getSelfServerId()!;
  bots[3].transport.consumePendingOffer();
  const expiryPlayer = world?.state.players.get(expiryPid);
  if (expiryPlayer !== undefined) expiryPlayer.pvpDraftOfferTicksLeft = 1;
  check("expired PVP offer clears sim and connection state",
    await waitUntil(() => {
      const conn = [...(world?.conns.values() ?? [])].find((candidate) => candidate.playerId === expiryPid);
      return world?.state.pendingBlessings.has(expiryPid) === false && conn?.pendingOffer === null;
    }, 2_000));
  bots[3].dropConnection(true);
  await waitUntil(() => world?.state.players.get(expiryPid)?.isAbsent === true, 2_000);
  bots[3].restoreNetwork();
  check("expired offer never resurrects after a later reconnect",
    await waitUntil(() =>
      !bots[3].transport.getReconnectInfo().isReconnecting
      && world?.state.players.get(expiryPid)?.isAbsent === false,
    4_000)
    && bots[3].transport.getPendingOfferPeek() === null);

  fifth.stop();
  sixth.stop();
  replacement.stop();
  duplicate.stop();
} finally {
  for (const bot of bots) bot.stop();
  await server.close();
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
