// Control-plane test entrypoint. Runs every suite against in-memory fakes (plus one real-gs
// integration suite), aggregates results, and exits non-zero on any failure so it gates CI.
// Run: npm run test (in control/).

import { TestRunner } from "./harness.js";
import { suite as authSuite } from "./auth.test.js";
import { suite as verifierSuite } from "./verifier.test.js";
import { suite as deploySuite } from "./deploy.test.js";
import { suite as apiSuite } from "./api.test.js";
import { suite as redactSuite } from "./redact.test.js";
import { suite as integrationSuite } from "./integration.test.js";

async function main(): Promise<void> {
  const t = new TestRunner();
  await authSuite(t);
  await verifierSuite(t);
  await deploySuite(t);
  await apiSuite(t);
  await redactSuite(t);
  await integrationSuite(t);

  process.stdout.write(`\n${t.passed} checks passed, ${t.failed} failed\n`);
  if (t.failed > 0) {
    process.stdout.write(`FAILURES:\n${t.failures.map((f) => "  - " + f).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll control-plane assertions passed.\n");
}

void main();
