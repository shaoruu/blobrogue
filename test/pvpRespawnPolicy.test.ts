import { runRespawnPolicyReport } from "./pvpRespawnPolicy.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
    return;
  }
  failed++;
  failures.push(name + (detail ? ` — ${detail}` : ""));
  process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const report = runRespawnPolicyReport(20);
const metrics = report.aggregate;
process.stdout.write(`${report.policy}\n`);

check("20 deterministic conformanceBot seeds are reported",
  report.profile === "conformanceBot" && metrics.seedCount === 20);
check("the policy exercises repeated completed post-death respawns in every seed",
  metrics.postRespawnEpisodeCount >= 60
  && report.seeds.every((seed) => seed.episodes.some((episode) => !episode.isInitialSpawn)),
  `episodes=${metrics.episodeCount} postRespawns=${metrics.postRespawnEpisodeCount}`);
check("initial-life telemetry is anchored to the authoritative live whistle spawn",
  report.seeds.every((seed) => {
    const initial = seed.episodes[0];
    return initial?.isInitialSpawn === true
      && initial.chosenIndex >= 0
      && initial.timeToFirstInputMs !== null
      && initial.shieldBreakMs !== null
      && initial.firstDamageMs !== null;
  }));
check("spawn-to-first-damage P10 is at least 2s",
  metrics.spawnToFirstDamageP10Sec >= 2,
  `p10=${metrics.spawnToFirstDamageP10Sec.toFixed(2)}s`);
check("spawn-to-first-damage median is at least 3s",
  metrics.spawnToFirstDamageMedianSec >= 3,
  `median=${metrics.spawnToFirstDamageMedianSec.toFixed(2)}s`);
check("spawn-to-death P10 is at least 4.5s",
  metrics.spawnToDeathP10Sec >= 4.5,
  `p10=${metrics.spawnToDeathP10Sec.toFixed(2)}s`);
check("spawn-to-death median is at least 7s",
  metrics.spawnToDeathMedianSec >= 7,
  `median=${metrics.spawnToDeathMedianSec.toFixed(2)}s`);
check("rapid bot earns no more than two respawn-only frags in any 20s window",
  metrics.maxRespawnOnlyFragsPer20Sec <= 2,
  `max=${metrics.maxRespawnOnlyFragsPer20Sec}`);
check("fastest time-to-eight is at least 90s",
  metrics.timeToEightMinSec === null || metrics.timeToEightMinSec >= 90,
  metrics.timeToEightMinSec === null
    ? `not reached in ${metrics.seedCount} seeds`
    : `min=${metrics.timeToEightMinSec.toFixed(2)}s`);
check("at least 95% establish dash, 90-degree aim, and two-tile movement before first damage",
  metrics.controlEstablishedRate >= 0.95,
  `rate=${(metrics.controlEstablishedRate * 100).toFixed(1)}%`);

const playtestReport = runRespawnPolicyReport(8, "playtestBot");
const playtestMetrics = playtestReport.aggregate;
const playtestEpisodes = playtestReport.seeds.flatMap((seed) => seed.episodes);
check("playtestBot is separately labeled from adversarial conformance",
  playtestReport.profile === "playtestBot" && playtestReport.policy.includes("250–350ms"));
check("playtestBot never fires into hard grace or spawn shields",
  playtestMetrics.shieldFireAttempts === 0);
check("playtestBot authoritative first shots land 250–350ms after shield expiry",
  playtestMetrics.playtestReactionMinMs !== null
  && playtestMetrics.playtestReactionMaxMs !== null
  && playtestMetrics.playtestReactionMinMs >= 250
  && playtestMetrics.playtestReactionMaxMs <= 350,
  `range=${playtestMetrics.playtestReactionMinMs}–${playtestMetrics.playtestReactionMaxMs}ms`);
check("playtestBot report carries authoritative respawn telemetry fields",
  playtestEpisodes.some((episode) =>
    !episode.isInitialSpawn
    && episode.chosenIndex >= 0
    && episode.safeCount >= 0
    && episode.timeToFirstInputMs !== null
    && episode.shieldBreakMs !== null
    && episode.firstDamageMs !== null
    && typeof episode.isDeathWithin3s === "boolean"
    && typeof episode.isRepeatedIndex === "boolean"
    && episode.killerDistance !== null
  ));

process.stdout.write(`\n${JSON.stringify(metrics, null, 2)}\n`);
process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((failure) => `  - ${failure}`).join("\n") + "\n");
  process.exit(1);
}
