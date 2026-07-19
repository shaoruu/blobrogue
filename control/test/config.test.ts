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
          BRC_GS_CONTROL_SECRET: "control-secret",
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
      BRC_GS_CONTROL_SECRET: "control-secret",
    });
    t.check("production accepts configured probe secret",
      production.gsSyntheticTicketSecret === "configured-secret");
    let controlMessage = "";
    try {
      loadConfig({
        NODE_ENV: "production",
        BRC_GS_SYNTHETIC_TICKET_SECRET: "configured-secret",
      });
    } catch (error) {
      controlMessage = error instanceof Error ? error.message : String(error);
    }
    t.check("production requires a dedicated game-server control secret",
      controlMessage === "game_server_control_secret_missing");
    let reuseMessage = "";
    try {
      loadConfig({
        BRC_GS_SYNTHETIC_TICKET_SECRET: "shared-secret",
        BRC_GS_CONTROL_SECRET: "shared-secret",
      });
    } catch (error) {
      reuseMessage = error instanceof Error ? error.message : String(error);
    }
    t.check("game-server control secret cannot reuse another credential",
      reuseMessage === "game_server_control_secret_reused");
    const development = loadConfig({});
    t.check("development may omit secret for diagnostic-only liveness",
      development.gsSyntheticTicketSecret === null);
  });
}
