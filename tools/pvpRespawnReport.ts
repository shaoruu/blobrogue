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
const isAccepted = metrics.postRespawnEpisodeCount >= seedCount * 3
  && metrics.spawnToFirstDamageP10Sec >= 2
  && metrics.spawnToFirstDamageMedianSec >= 3
  && metrics.spawnToDeathP10Sec >= 4.5
  && metrics.spawnToDeathMedianSec >= 7
  && metrics.maxRespawnOnlyFragsPer20Sec <= 2
  && (metrics.timeToEightMinSec === null || metrics.timeToEightMinSec >= 90)
  && metrics.controlEstablishedRate >= 0.95
  && (profile !== "playtestBot" || metrics.shieldFireAttempts === 0);
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
  `- Max respawn-only bot frags / 20s: ${metrics.maxRespawnOnlyFragsPer20Sec}`,
  `- Fastest time-to-8: ${metrics.timeToEightMinSec === null
    ? `not reached in ${metrics.seedCount} seeds`
    : `${metrics.timeToEightMinSec.toFixed(2)}s`}`,
  `- Control established before first damage: ${(metrics.controlEstablishedRate * 100).toFixed(1)}%`,
  `- Wait-safe respawns: ${metrics.waitSafeRespawnCount}`,
  `- Threatened choices: ${metrics.threatenedSpawnCount}`,
  `- Repeated indices: ${metrics.repeatedSpawnCount}`,
  `- Firing attempts into shields: ${metrics.shieldFireAttempts}`,
  `- JSON: ${outPath}`,
  `- Acceptance: ${isAccepted ? "PASS" : "FAIL"}`,
  "",
].join("\n"));
if (!isAccepted) process.exitCode = 1;
