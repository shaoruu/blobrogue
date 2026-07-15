import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { runRespawnPolicyReport } from "../test/pvpRespawnPolicy.js";
import type { RespawnBotProfile } from "../test/pvpRespawnPolicy.js";

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : null;
}

const outPath = resolve(argumentValue("--out") ?? "artifacts/pvp-respawn-report.json");
const seedCount = Number(argumentValue("--seeds") ?? "20");
const profileArg = argumentValue("--profile") ?? "conformanceBot";
if (profileArg !== "conformanceBot" && profileArg !== "playtestBot") {
  throw new Error("--profile must be conformanceBot or playtestBot");
}
const profile: RespawnBotProfile = profileArg;
if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > 200) {
  throw new Error("--seeds must be an integer from 1 to 200");
}

const report = runRespawnPolicyReport(seedCount, profile);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

const metrics = report.aggregate;
const geometry2p = report.geometry.parties.find((party) => party.playerCount === 2)!;
const geometry4p = report.geometry.parties.find((party) => party.playerCount === 4)!;
const geometry6p = report.geometry.parties.find((party) => party.playerCount === 6)!;
const isAccepted = metrics.postRespawnEpisodeCount >= seedCount * 3
  && metrics.spawnToFirstDamageP10Sec >= 2
  && metrics.spawnToDeathP10Sec >= 4.5
  && metrics.spawnToDeathMedianSec >= 7
  && metrics.deathWithin3sRate <= 0.02
  && metrics.maxRespawnOnlyFragsPer20Sec <= 2
  && metrics.controlEstablishedRate >= 0.95
  && metrics.intentionalFireWithin500msRate >= 0.9
  && metrics.armingFeedbackCoverageRate === 1
  && metrics.armingClarityProxyRate >= 0.9
  && metrics.heldFireAutoFireCount === 0
  && geometry2p.safeCandidateMedian >= 2
  && geometry4p.safeCandidateMedian >= 1
  && geometry6p.safeCandidateP25 >= 1
  && geometry2p.waitP95Ms <= 300
  && geometry4p.waitP95Ms <= 300
  && geometry6p.waitP95Ms <= 750
  && geometry2p.fallbackRate <= 0.05
  && geometry4p.fallbackRate <= 0.15
  && geometry6p.fallbackRate <= 0.30
  && report.geometry.parties.every((party) =>
    party.avoidableImmediateProjectileSelections === 0 && party.isNeverTripleIndex
  )
  && (profile !== "playtestBot"
    || (metrics.spawnToFirstDamageMedianSec >= 3
      && (metrics.timeToEightMinSec === null || metrics.timeToEightMinSec >= 90)
      && metrics.shieldFireAttempts === 0
      && metrics.playtestReactionMinMs !== null
      && metrics.playtestReactionMaxMs !== null
      && metrics.playtestReactionMinMs >= 250
      && metrics.playtestReactionMaxMs <= 350));
process.stdout.write([
  "# BlobRogue private PvP respawn fairness report",
  "",
  report.policy,
  "",
  `- Profile: ${report.profile}`,
  `- Seeds: ${metrics.seedCount}`,
  `- Completed respawn episodes: ${metrics.episodeCount}`,
  `- Completed post-death respawns: ${metrics.postRespawnEpisodeCount}`,
  `- Spawn → first damage: P10 ${metrics.spawnToFirstDamageP10Sec.toFixed(2)}s, median ${metrics.spawnToFirstDamageMedianSec.toFixed(2)}s`,
  `- Spawn → death: P10 ${metrics.spawnToDeathP10Sec.toFixed(2)}s, median ${metrics.spawnToDeathMedianSec.toFixed(2)}s`,
  `- Deaths within 3s: ${(metrics.deathWithin3sRate * 100).toFixed(1)}%`,
  `- Max respawn-only bot frags / 20s: ${metrics.maxRespawnOnlyFragsPer20Sec}`,
  `- Fastest time-to-8: ${metrics.timeToEightMinSec === null
    ? `not reached in ${metrics.seedCount} seeds`
    : `${metrics.timeToEightMinSec.toFixed(2)}s`}`,
  `- Control established before first damage: ${(metrics.controlEstablishedRate * 100).toFixed(1)}%`,
  `- Intentional fire within 0.5s of grace end: ${(metrics.intentionalFireWithin500msRate * 100).toFixed(1)}%`,
  `- Arming feedback coverage: ${(metrics.armingFeedbackCoverageRate * 100).toFixed(1)}%`,
  `- Arming clarity proxy (feedback + successful re-press): ${(metrics.armingClarityProxyRate * 100).toFixed(1)}%`,
  `- Held-fire auto-shots: ${metrics.heldFireAutoFireCount}`,
  `- Wait-safe respawns: ${metrics.waitSafeRespawnCount}`,
  `- Choices with any threat flag: ${metrics.threatenedSpawnCount}`,
  `- Repeated indices: ${metrics.repeatedSpawnCount}`,
  `- Firing command ticks into shields: ${metrics.shieldFireAttempts}`,
  `- Post-shield first-shot reaction: ${metrics.playtestReactionMinMs === null
    ? "not measured for this profile"
    : `${metrics.playtestReactionMinMs.toFixed(0)}–${metrics.playtestReactionMaxMs?.toFixed(0)}ms`}`,
  `- Safe candidates: 2p median ${geometry2p.safeCandidateMedian}, 4p median ${geometry4p.safeCandidateMedian}, 6p P25 ${geometry6p.safeCandidateP25}`,
  `- Wait-safe P95: 2p ${geometry2p.waitP95Ms}ms, 4p ${geometry4p.waitP95Ms}ms, 6p ${geometry6p.waitP95Ms}ms`,
  `- Fallback 3s shield rate: 2p ${(geometry2p.fallbackRate * 100).toFixed(1)}%, 4p ${(geometry4p.fallbackRate * 100).toFixed(1)}%, 6p ${(geometry6p.fallbackRate * 100).toFixed(1)}%`,
  `- Avoidable <=0.75s projectile selections: ${report.geometry.parties.reduce((total, party) => total + party.avoidableImmediateProjectileSelections, 0)}`,
  `- JSON: ${outPath}`,
  `- Acceptance: ${isAccepted ? "PASS" : "FAIL"}`,
  "",
].join("\n"));
if (!isAccepted) process.exitCode = 1;
