// Control-plane test entrypoint. Unit suites run against in-memory fakes; the integration suite
// boots a real game server. Run all suites with `npm test`, or select one group via package scripts.

import { TestRunner } from "./harness.js";
import { suite as authSuite } from "./auth.test.js";
import { suite as verifierSuite } from "./verifier.test.js";
import { suite as deploySuite } from "./deploy.test.js";
import { suite as apiSuite } from "./api.test.js";
import { suite as redactSuite } from "./redact.test.js";
import { suite as integrationSuite } from "./integration.test.js";
import { suite as configSuite } from "./config.test.js";

async function main(): Promise<void> {
  const isUnitOnly = process.argv.includes("--unit");
  const isIntegrationOnly = process.argv.includes("--integration");
  if (isUnitOnly && isIntegrationOnly) {
    throw new Error("choose either --unit or --integration");
  }

  const t = new TestRunner();
  if (!isIntegrationOnly) {
    await configSuite(t);
    await authSuite(t);
    await verifierSuite(t);
    await deploySuite(t);
    await apiSuite(t);
    await redactSuite(t);
  }
  if (!isUnitOnly) {
    await integrationSuite(t);
  }

  process.stdout.write(`\n${t.passed} checks passed, ${t.failed} failed\n`);
  if (t.failed > 0) {
    process.stdout.write(`FAILURES:\n${t.failures.map((f) => "  - " + f).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll control-plane assertions passed.\n");
}

void main();
