import { loadConfig } from "../src/config.js";
import { TestRunner } from "./harness.js";

export async function suite(t: TestRunner): Promise<void> {
  await t.suite("config: production requires policy parser probe secret", async () => {
    for (const [label, value] of [
      ["missing", undefined],
      ["empty", ""],
    ] as const) {
      let message = "";
      try {
        loadConfig({
          NODE_ENV: "production",
          ...(value === undefined ? {} : { BRC_GS_SYNTHETIC_TICKET_SECRET: value }),
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      t.check(`production ${label} probe secret fails startup`,
        message === "policy_probe_secret_missing");
    }
    const production = loadConfig({
      NODE_ENV: "production",
      BRC_GS_SYNTHETIC_TICKET_SECRET: "configured-secret",
    });
    t.check("production accepts configured probe secret",
      production.gsSyntheticTicketSecret === "configured-secret");
    const development = loadConfig({});
    t.check("development may omit secret for diagnostic-only liveness",
      development.gsSyntheticTicketSecret === null);
  });
}
