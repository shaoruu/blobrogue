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
check("spawn-to-death P10 is at least 4.5s",
  metrics.spawnToDeathP10Sec >= 4.5,
  `p10=${metrics.spawnToDeathP10Sec.toFixed(2)}s`);
check("spawn-to-death median is at least 7s",
  metrics.spawnToDeathMedianSec >= 7,
  `median=${metrics.spawnToDeathMedianSec.toFixed(2)}s`);
check("no more than 2% of respawns die within 3s",
  metrics.deathWithin3sRate <= 0.02,
  `rate=${(metrics.deathWithin3sRate * 100).toFixed(1)}%`);
check("rapid bot earns no more than two respawn-only frags in any 20s window",
  metrics.maxRespawnOnlyFragsPer20Sec <= 2,
  `max=${metrics.maxRespawnOnlyFragsPer20Sec}`);
check("at least 95% establish dash, 90-degree aim, and two-tile movement before first damage",
  metrics.controlEstablishedRate >= 0.95,
  `rate=${(metrics.controlEstablishedRate * 100).toFixed(1)}%`);
check("arming UX probe lets at least 90% intentionally fire within 0.5s of grace end",
  metrics.intentionalFireWithin500msRate >= 0.9,
  `rate=${(metrics.intentionalFireWithin500msRate * 100).toFixed(1)}%`);
check("arming UX probe gives clear blocked-input feedback and never auto-fires held input",
  metrics.armingFeedbackCoverageRate === 1
  && metrics.armingClarityProxyRate >= 0.9
  && metrics.heldFireAutoFireCount === 0,
  `feedback=${(metrics.armingFeedbackCoverageRate * 100).toFixed(0)}% clarity=${(metrics.armingClarityProxyRate * 100).toFixed(0)}% auto=${metrics.heldFireAutoFireCount}`);
const geometry2p = report.geometry.parties.find((party) => party.playerCount === 2)!;
const geometry4p = report.geometry.parties.find((party) => party.playerCount === 4)!;
const geometry6p = report.geometry.parties.find((party) => party.playerCount === 6)!;
check("actual-coordinate safe-candidate gates hold at 2p/4p/6p",
  geometry2p.safeCandidateMedian >= 2
  && geometry4p.safeCandidateMedian >= 1
  && geometry6p.safeCandidateP25 >= 1,
  `2p-median=${geometry2p.safeCandidateMedian} 4p-median=${geometry4p.safeCandidateMedian} 6p-p25=${geometry6p.safeCandidateP25}`);
check("wait-safe P95 gates hold at 2p/4p/6p",
  geometry2p.waitP95Ms <= 300
  && geometry4p.waitP95Ms <= 300
  && geometry6p.waitP95Ms <= 750,
  `2p=${geometry2p.waitP95Ms}ms 4p=${geometry4p.waitP95Ms}ms 6p=${geometry6p.waitP95Ms}ms`);
check("fallback 3s shield rates stay below party-size overrejection caps",
  geometry2p.fallbackRate <= 0.05
  && geometry4p.fallbackRate <= 0.15
  && geometry6p.fallbackRate <= 0.30,
  `2p=${(geometry2p.fallbackRate * 100).toFixed(1)}% 4p=${(geometry4p.fallbackRate * 100).toFixed(1)}% 6p=${(geometry6p.fallbackRate * 100).toFixed(1)}%`);
check("projectile challenges never choose avoidable TTI <=0.75s and no index repeats 3x",
  report.geometry.parties.every((party) =>
    party.immediateProjectileChallengeCount > 0
    && party.avoidableImmediateProjectileSelections === 0
    && party.isNeverTripleIndex
  ));

const playtestReport = runRespawnPolicyReport(20, "playtestBot");
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
check("playtestBot life, spawn-frag, and time-to-8 gates hold",
  playtestMetrics.spawnToFirstDamageP10Sec >= 2
  && playtestMetrics.spawnToFirstDamageMedianSec >= 3
  && playtestMetrics.spawnToDeathMedianSec >= 7
  && playtestMetrics.deathWithin3sRate <= 0.02
  && playtestMetrics.maxRespawnOnlyFragsPer20Sec <= 2
  && playtestMetrics.controlEstablishedRate >= 0.95
  && (playtestMetrics.timeToEightMinSec === null || playtestMetrics.timeToEightMinSec >= 90),
  `first=${playtestMetrics.spawnToFirstDamageP10Sec.toFixed(2)}/${playtestMetrics.spawnToFirstDamageMedianSec.toFixed(2)}s life=${playtestMetrics.spawnToDeathMedianSec.toFixed(2)}s spawnFrags=${playtestMetrics.maxRespawnOnlyFragsPer20Sec} timeTo8=${playtestMetrics.timeToEightMinSec}`);
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
