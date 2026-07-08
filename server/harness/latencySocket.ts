// A SocketLike wrapper (over the `ws` client) that injects artificial RTT, jitter, and packet
// loss symmetrically on the uplink (client->server) and downlink (server->client). Lets the
// headless harness drive the REAL WSTransport netcode under adverse network conditions to
// verify prediction/reconciliation/interpolation hold (production spec §8).

import { WebSocket as WsClient } from "ws";
import type { SocketLike } from "../../src/client/wsTransport.js";

export interface NetConditions {
  rttMs: number;   // round-trip time; each direction gets rttMs/2
  jitterMs: number;// +/- uniform jitter added per direction
  loss: number;    // 0..1 probability a frame is dropped (each direction)
}

export const PERFECT_NET: NetConditions = { rttMs: 0, jitterMs: 0, loss: 0 };

export class LatencySocket implements SocketLike {
  private ws: WsClient;
  private net: NetConditions;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(url: string, net: NetConditions) {
    this.net = net;
    this.ws = new WsClient(url);
    this.ws.on("open", () => this.onopen?.());
    this.ws.on("close", () => this.onclose?.());
    this.ws.on("error", (err) => this.onerror?.(err));
    this.ws.on("message", (data: unknown) => {
      const s = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      this.afterDelay(() => this.onmessage?.({ data: s }));
    });
  }

  private oneWayDelay(): number {
    const half = this.net.rttMs / 2;
    const j = this.net.jitterMs > 0 ? (Math.random() * 2 - 1) * this.net.jitterMs : 0;
    return Math.max(0, half + j);
  }

  private afterDelay(fn: () => void): void {
    if (this.net.loss > 0 && Math.random() < this.net.loss) return; // dropped
    const d = this.oneWayDelay();
    if (d <= 0) fn();
    else setTimeout(fn, d);
  }

  get readyState(): number {
    return this.ws.readyState;
  }
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  send(data: string): void {
    // Uplink delay/loss. Capture readiness at delivery time (socket may close meanwhile).
    this.afterDelay(() => {
      if (this.ws.readyState === WsClient.OPEN) {
        try { this.ws.send(data); } catch { /* closing */ }
      }
    });
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closing */ }
  }
}
