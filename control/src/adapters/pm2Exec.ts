// Real pm2 adapter. Uses execFile with a FIXED binary and an argv array built ONLY from the
// Pm2App enum — never a shell, never a string concatenation, never a request-derived value. The
// app name is one of a compiled-in set that does not include `town`, so no control action can
// reload anything but the game server (or the control service's own supervisor entry). A missing
// pm2 binary or a non-zero exit surfaces as a thrown error the deploy machine treats as a step
// failure (and compensates for).

import { execFile } from "node:child_process";
import type { Pm2App, Pm2Port, Pm2ProcessInfo } from "../ports.js";

const PM2_BIN = "pm2";
const TIMEOUT_MS = 60_000;

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(PM2_BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`pm2 ${args[0]} failed: ${err.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

interface Pm2JlistEntry {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string; restart_time?: number };
}

export class Pm2Exec implements Pm2Port {
  async reload(app: Pm2App): Promise<void> {
    // `reload` is the near-zero-downtime restart; the app name is a fixed enum value.
    await run(["reload", app, "--update-env"]);
  }

  async describe(app: Pm2App): Promise<Pm2ProcessInfo | null> {
    const { stdout } = await run(["jlist"]);
    let list: unknown;
    try {
      list = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(list)) return null;
    for (const raw of list) {
      const e = raw as Pm2JlistEntry;
      if (e.name === app) {
        return {
          name: app,
          status: e.pm2_env?.status ?? "unknown",
          pid: typeof e.pid === "number" ? e.pid : null,
          restarts: typeof e.pm2_env?.restart_time === "number" ? e.pm2_env.restart_time : 0,
        };
      }
    }
    return null;
  }
}
