// Shared harness building blocks: spin up an in-process GameServer, and a Bot that drives the
// REAL WSTransport client netcode (prediction/reconciliation/interpolation) over a
// latency-injecting socket. Used by both the assertion suite (test/server.test.ts) and the
// measurement report (harness/loadtest.ts).

import { GameServer } from "../src/server.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { mintTicket } from "../src/auth.js";
import { createLogger } from "../src/logger.js";
import { WSTransport } from "../../src/client/wsTransport.js";
import type { InputCmd } from "../../src/sim/input.js";
import { LatencySocket, type NetConditions, PERFECT_NET } from "./latencySocket.js";

export const TEST_SECRET = "harness-shared-secret";

export interface TestServer {
  server: GameServer;
  url: string;
  port: number;
  secret: string;
  close: () => Promise<void>;
}

// Boot a server on an ephemeral port with the dev/auth secret set. Quiet by default so test
// output stays readable (pass logLevel:"info" to see lifecycle logs).
export async function startTestServer(overrides: Partial<ServerConfig> = {}, logLevel: "debug" | "info" | "warn" | "error" = "error"): Promise<TestServer> {
  const base = loadConfig({});
  const cfg: ServerConfig = {
    ...base,
    host: "127.0.0.1",
    port: 0,
    auth: { secret: TEST_SECRET, allowDev: true },
    ...overrides,
  };
  const server = new GameServer(cfg, createLogger({ app: "gs-test" }, logLevel));
  const port = await server.listen();
  return {
    server,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    secret: TEST_SECRET,
    close: () => server.close(),
  };
}

export function idle(): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

// A few named input scripts (per-frame). tick = frame index, t = ms wall clock.
export type InputScript = (tick: number, t: number) => InputCmd;

export const SCRIPTS: Record<string, InputScript> = {
  idle: () => idle(),
  // Orbit: circle the arena center so the player keeps moving (exercises reconciliation).
  orbit: (tick) => {
    const a = tick * 0.03;
    return { seq: 0, moveX: Math.cos(a), moveY: Math.sin(a), aim: a, firing: false, dash: false };
  },
  // Move right for a while, then left — a there-and-back that must reconverge with no drift.
  pingpong: (tick) => {
    const phase = Math.floor(tick / 90) % 2;
    const dir = phase === 0 ? 1 : -1;
    return { seq: 0, moveX: dir, moveY: 0, aim: dir > 0 ? 0 : Math.PI, firing: false, dash: false };
  },
};

export interface BotSample {
  t: number;
  enemyX: number | null; // rendered enemy[0].x (interpolated), for render-latency measurement
}

export interface BotOptions {
  url: string;
  secret: string;
  playerId: string;
  net?: NetConditions;
  script?: InputScript;
  frameMs?: number;
}

export class Bot {
  readonly transport: WSTransport;
  private readonly script: InputScript;
  private readonly frameMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private lastT = 0;
  samples: BotSample[] = [];

  constructor(o: BotOptions) {
    const net = o.net ?? PERFECT_NET;
    this.script = o.script ?? SCRIPTS.idle;
    this.frameMs = o.frameMs ?? 16;
    this.transport = new WSTransport({
      url: o.url,
      getTicket: () => Promise.resolve(mintTicket(o.secret, o.playerId)),
      socketFactory: (url) => new LatencySocket(url, net),
      now: () => Date.now(),
    });
  }

  start(): void {
    this.transport.start();
    this.lastT = Date.now();
    this.timer = setInterval(() => this.frameTick(), this.frameMs);
  }

  private frameTick(): void {
    const now = Date.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    const cmd = this.script(this.frame++, now);
    this.transport.sendInput(cmd);
    this.transport.advance(dt);
    const { state } = this.transport.poll();
    const e0 = state.enemies.length > 0 ? state.enemies[0] : null;
    this.samples.push({ t: now, enemyX: e0 ? e0.x : null });
  }

  predictedSelf(): { x: number; y: number } {
    return this.transport.getPredictedSelf();
  }

  serverId(): string | null {
    return this.transport.getSelfServerId();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.transport.stop();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait until `pred` returns true or the timeout elapses. Resolves with the final result.
export async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[rank];
}
