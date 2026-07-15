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

check("20 deterministic adversarial seeds are reported", metrics.seedCount === 20);
check("the policy exercises repeated completed respawns",
  metrics.episodeCount >= 20 && metrics.damagedEpisodeCount >= 20 && metrics.deathEpisodeCount >= 20,
  `episodes=${metrics.episodeCount} damaged=${metrics.damagedEpisodeCount} deaths=${metrics.deathEpisodeCount}`);
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
  metrics.timeToEightMinSec >= 90,
  `min=${metrics.timeToEightMinSec.toFixed(2)}s`);
check("at least 95% establish dash, 90-degree aim, and two-tile movement before first damage",
  metrics.controlEstablishedRate >= 0.95,
  `rate=${(metrics.controlEstablishedRate * 100).toFixed(1)}%`);

process.stdout.write(`\n${JSON.stringify(metrics, null, 2)}\n`);
process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((failure) => `  - ${failure}`).join("\n") + "\n");
  process.exit(1);
}
