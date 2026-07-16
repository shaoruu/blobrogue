import { Bot, idle, startTestServer, waitUntil } from "../harness/lib.js";
import { WIPE_HOLD_SECONDS } from "../../src/sim/balance.js";
import { FIXED_DT } from "../../src/net/protocol.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, isCondition: boolean, detail = ""): void {
  if (isCondition) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`);
  } else {
    failed++;
    failures.push(name + (detail ? " — " + detail : ""));
    process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  try {
    await fn();
  } catch (error) {
    failed++;
    failures.push(`${name} threw: ${String(error)}`);
    process.stdout.write(`  FAIL ${name} threw ${String(error)}\n`);
  }
}

async function runCase(iteration: number): Promise<void> {
  const server = await startTestServer({ absenceDetectMs: 0 });
  const bot = new Bot({
    url: server.url,
    secret: server.secret,
    playerId: `h6-game-over-${iteration}`,
    script: () => idle(),
  });
  const startedAt = Date.now();
  try {
    bot.start();
    const isJoined = await waitUntil(() => {
      const world = server.server.getWorld();
      const playerId = bot.serverId();
      return bot.transport.isReady()
        && world !== undefined
        && playerId !== null
        && world.state.players.has(playerId)
        && [...world.conns.values()].some((connection) => connection.playerId === playerId);
    }, 3000);
    const world = server.server.getWorld();
    const playerId = bot.serverId();
    const player = playerId === null ? undefined : world?.state.players.get(playerId);
    const connection = playerId === null
      ? undefined
      : [...(world?.conns.values() ?? [])].find((candidate) => candidate.playerId === playerId);
    const joinDetail = JSON.stringify({
      iteration,
      isTransportReady: bot.transport.isReady(),
      transportStatus: bot.transport.getStatus(),
      transportError: bot.transport.lastError,
      serverStatus: server.server.health().status,
      isWorldPresent: world !== undefined,
      seed: world?.state.seed ?? null,
      playerId,
      isPlayerPresent: player !== undefined,
      isConnectionPresent: connection !== undefined,
    });
    check(
      "H6 bot joined with authoritative world, player, and connection",
      isJoined && world !== undefined && playerId !== null && player !== undefined && connection !== undefined,
      joinDetail,
    );
    if (!isJoined || world === undefined || playerId === null || player === undefined || connection === undefined) return;

    const initialSeed = world.state.seed;
    const eventFloor = world.latestEventId();
    player.hp = 1;
    player.invuln = 0;
    player.dashInvuln = 0;
    world.state.bullets.push({
      x: player.x,
      y: player.y,
      vx: 0,
      vy: 0,
      radius: 8,
      life: 1,
      friendly: false,
      owner: null,
      damage: 5,
      color: "#f00",
      pierce: 0,
      hitList: null,
      isCrit: false,
    });

    const isDowned = await waitUntil(
      () => world.state.players.get(playerId)?.isDown === true && !world.state.isRunOver,
      3000,
    );
    const downTick = world.state.tick;
    check(
      "lethal damage downs the final player without ending the shared run immediately",
      isDowned,
      JSON.stringify({
        iteration,
        tick: world.state.tick,
        wipeTimer: world.state.wipeTimer,
        isRunOver: world.state.isRunOver,
        isDown: world.state.players.get(playerId)?.isDown ?? false,
        isAbsent: world.state.players.get(playerId)?.isAbsent ?? false,
      }),
    );
    if (!isDowned) return;

    const isWipeHoldStarted = await waitUntil(
      () => world.state.wipeTimer >= FIXED_DT && !world.state.isRunOver,
      3000,
    );
    check(
      "authoritative wipe hold starts while the run remains active",
      isWipeHoldStarted,
      JSON.stringify({
        iteration,
        ticksSinceDown: world.state.tick - downTick,
        wipeTimer: world.state.wipeTimer,
        isRunOver: world.state.isRunOver,
      }),
    );
    if (!isWipeHoldStarted) return;

    world.state.wipeTimer = WIPE_HOLD_SECONDS - FIXED_DT / 2;
    const isAuthoritativeGameOver = await waitUntil(
      () => connection.gameOver
        && world.eventsSince(eventFloor).some(
          (wire) => wire.e.t === "gameOver" && wire.e.pid === playerId,
        ),
      3000,
    );
    const gameOverEvent = world.eventsSince(eventFloor)
      .find((wire) => wire.e.t === "gameOver" && wire.e.pid === playerId);
    const diagnostic = () => JSON.stringify({
      iteration,
      elapsedMs: Date.now() - startedAt,
      initialSeed,
      currentSeed: world.state.seed,
      tick: world.state.tick,
      ticksSinceDown: world.state.tick - downTick,
      wipeTimer: world.state.wipeTimer,
      isWorldRunOver: world.state.isRunOver,
      isDown: player.isDown,
      isAbsent: player.isAbsent,
      gameOverEventId: gameOverEvent?.id ?? null,
      acknowledgedEventId: connection.ackedEventId,
      isConnectionClosing: connection.closing,
      isConnectionGameOver: connection.gameOver,
      isPlayerPresent: world.state.players.has(playerId),
      isServerWorldPresent: server.server.getWorld() !== undefined,
      serverPlayerCount: server.server.getWorld()?.playerCount ?? 0,
      transportStatus: bot.transport.getStatus(),
      transportCloseKind: bot.transport.getCloseKind(),
      isClientRunOver: bot.transport.isRunOver(),
      transportError: bot.transport.lastError,
    });
    check(
      "wipe threshold commits the authoritative game-over event and close marker",
      isAuthoritativeGameOver && gameOverEvent !== undefined,
      diagnostic(),
    );
    check(
      "terminal teardown starts without waiting for the final event acknowledgement",
      gameOverEvent !== undefined
        && connection.closing
        && connection.gameOver
        && connection.ackedEventId < gameOverEvent.id,
      diagnostic(),
    );

    const isServerClosed = await waitUntil(
      () => connection.closing
        && connection.gameOver
        && !world.state.players.has(playerId)
        && server.server.getWorld() === undefined,
      3000,
    );
    check("server closes and unbinds the game-over connection", isServerClosed, diagnostic());

    const isClientClosed = await waitUntil(
      () => bot.transport.getStatus() === "closed"
        && bot.transport.getCloseKind() === "game_over",
      3000,
    );
    check("client observes the terminal game-over close", isClientClosed, diagnostic());
  } finally {
    bot.stop();
    await server.close();
  }
}

async function main(): Promise<void> {
  const requestedRuns = Number(process.env.GS_TEST_H6_RUNS ?? 1);
  const runCount = Number.isInteger(requestedRuns) && requestedRuns > 0 ? requestedRuns : 1;
  for (let iteration = 1; iteration <= runCount; iteration++) {
    await test(`H6 game-over lifecycle run ${iteration}/${runCount}`, () => runCase(iteration));
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((failure) => "  - " + failure).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll H6 game-over lifecycle regressions passed.\n");
}

void main();
