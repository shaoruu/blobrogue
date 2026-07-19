// The control API (spec §2). One small router over node:http with per-request isolation: a
// single malformed or hostile request is caught and turned into a 4xx/5xx and can never crash
// the service. Every route is admin-token gated; deploy/restart/rollback additionally require a
// matching confirmation token. Bodies are strictly validated and structurally reject any
// forbidden key. There is no route that accepts a command, path, process, env, ref, or url.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import type { AuthGate } from "./auth/gate.js";
import { mintConfirmToken, type ConfirmTokenPayload } from "./auth/tokens.js";
import type { RateLimiter } from "./auth/rateLimiter.js";
import type { ControlConfig } from "./config.js";
import { DeployController, type OperationContext } from "./deployController.js";
import { LockedError, PreconditionError } from "./errors.js";
import { isValidWorldId, MAX_ADMIN_FLOOR, randomId } from "./ids.js";
import type { ArtifactVerifier, AuditSink, GameServerAdmin, OperationStore, ReleaseStore } from "./interfaces.js";
import type { Logger } from "./logger.js";
import type { Clock } from "./ports.js";
import type { GameServerWorldActionResult, OperationRecord } from "./types.js";
import { findForbiddenKey, parseConfirmBody, parseJsonObject, parseReleaseIdBody } from "./validation.js";

export interface ControlDeps {
  cfg: ControlConfig;
  log: Logger;
  clock: Clock;
  releases: ReleaseStore;
  operations: OperationStore;
  gameServer: GameServerAdmin;
  verifier: ArtifactVerifier;
  audit: AuditSink;
  controller: DeployController;
  authGate: AuthGate;
  rateLimiter: RateLimiter;
}

const MAX_BODY_BYTES = 16 * 1024;
const CONFIRM_TTL_SEC = 45;

export class ControlHttpServer {
  private http: HttpServer;

  constructor(private d: ControlDeps) {
    this.http = createServer((req, res) => {
      void this.onRequest(req, res);
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.d.cfg.port, this.d.cfg.host, () => {
        const addr = this.http.address();
        const port = typeof addr === "object" && addr ? addr.port : this.d.cfg.port;
        this.d.log.info("control listening", { host: this.d.cfg.host, port, prod: this.d.cfg.isProd });
        resolve(port);
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomId("req");
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const remote = req.socket.remoteAddress ?? "unknown";

      if (!this.d.authGate.checkOrigin(req.headers.origin ?? null)) {
        return this.send(res, 403, { error: "origin_forbidden", requestId });
      }
      if (!this.d.rateLimiter.allow(remote)) {
        return this.send(res, 429, { error: "rate_limited", requestId });
      }
      const auth = this.d.authGate.authenticate(req.headers.authorization ?? null);
      if (!auth.ok) {
        this.d.log.warn("auth rejected", { requestId, reason: auth.reason, remote });
        return this.send(res, auth.status, { error: auth.reason, requestId });
      }

      const body = await this.readBody(req);
      if (body === null) return this.send(res, 413, { error: "body_too_large", requestId });

      await this.route(req.method ?? "GET", url, body, { requestId, actor: auth.ctx.actor, tokenJti: auth.ctx.tokenJti, req }, res);
    } catch (err) {
      this.d.log.error("request handler crashed (isolated)", { requestId, reason: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) this.send(res, 500, { error: "internal", requestId });
    }
  }

  private async route(
    method: string,
    url: URL,
    body: string,
    rc: { requestId: string; actor: string; tokenJti: string; req: IncomingMessage },
    res: ServerResponse,
  ): Promise<void> {
    const p = url.pathname;
    if (method === "GET") {
      switch (p) {
        case "/v1/status": return this.send(res, 200, await this.d.gameServer.status());
        case "/v1/readiness": return this.send(res, 200, await this.d.gameServer.readiness());
        case "/v1/version": return this.send(res, 200, await this.versionView());
        case "/v1/worlds": return this.send(res, 200, { worlds: await this.d.gameServer.worlds() });
        case "/v1/metrics": return this.send(res, 200, await this.d.gameServer.metrics());
        case "/v1/logs": return this.send(res, 200, { logs: await this.d.gameServer.logs({ limit: this.clampLimit(url, this.d.cfg.logTailMax), level: url.searchParams.get("level") }) });
        case "/v1/releases": return this.send(res, 200, { releases: (await this.d.releases.list()).map(releaseView) });
        case "/v1/operations": return this.send(res, 200, { operations: await this.d.operations.list(this.clampLimit(url, 100)) });
        case "/v1/audit": return this.send(res, 200, { audit: await this.d.audit.list(this.clampLimit(url, 200)) });
      }
      const opMatch = /^\/v1\/operations\/(op_[a-f0-9]{18})$/.exec(p);
      if (opMatch) {
        const op = await this.d.operations.get(opMatch[1]);
        return op === null ? this.send(res, 404, { error: "operation_not_found" }) : this.send(res, 200, op);
      }
      return this.send(res, 404, { error: "not_found" });
    }

    if (method === "POST") {
      switch (p) {
        case "/v1/confirm": return this.handleConfirm(body, rc, res);
        case "/v1/deploy-preview": return this.handleDeployPreview(body, rc, res);
        case "/v1/deploy": return this.handleDeploy(body, rc, res);
        case "/v1/drain": return this.handleLifecycle("drain", rc, res);
        case "/v1/resume": return this.handleLifecycle("resume", rc, res);
        case "/v1/worlds/warp": return this.handleWorldWarp(body, rc, res);
        case "/v1/worlds/force-open-exit": return this.handleForceOpenExit(body, rc, res);
        case "/v1/restart": return this.handleRestart(body, rc, res);
        case "/v1/rollback": return this.handleRollback(body, rc, res);
      }
      return this.send(res, 404, { error: "not_found" });
    }
    return this.send(res, 405, { error: "method_not_allowed" });
  }

  private async versionView(): Promise<{ releaseId: string | null; version: string | null; commit: string | null; builtAt: string | null }> {
    const cur = await this.d.releases.current();
    if (cur === null) return { releaseId: null, version: null, commit: null, builtAt: null };
    return { releaseId: cur.releaseId, version: cur.manifest.version, commit: cur.manifest.commit, builtAt: cur.manifest.builtAt };
  }

  // ---- mutate handlers ----

  private async handleConfirm(body: string, rc: RouteCtx, res: ServerResponse): Promise<void> {
    if (this.d.cfg.confirmTokenSecret === null) return this.send(res, 503, { error: "confirm_secret_unconfigured" });
    const parsed = parseJsonObject(body);
    if (!parsed.ok) return this.send(res, 400, { error: parsed.reason });
    const cb = parseConfirmBody(parsed.value);
    if (!cb.ok) return this.send(res, 400, { error: cb.reason });
    const nowSec = Math.floor(this.d.clock.now() / 1000);
    const payload: ConfirmTokenPayload = {
      action: cb.value.action,
      releaseId: cb.value.releaseId,
      sub: rc.actor,
      aud: this.d.cfg.tokenAudience,
      iat: nowSec,
      exp: nowSec + CONFIRM_TTL_SEC,
      jti: randomId("cf"),
    };
    const token = mintConfirmToken(this.d.cfg.confirmTokenSecret, payload);
    return this.send(res, 200, { confirmToken: token, action: payload.action, releaseId: payload.releaseId, expiresInSec: CONFIRM_TTL_SEC });
  }

  private async handleDeployPreview(body: string, rc: RouteCtx, res: ServerResponse): Promise<void> {
    const rb = parseReleaseIdBody(this.mustObject(body, res));
    if (this.wasSent(res)) return;
    if (!rb.ok) return this.send(res, 400, { error: rb.reason });
    await this.runOperation(res, null, () => this.d.controller.deployPreview(rb.value.releaseId, this.ctx(rc, null, null)));
  }

  private async handleDeploy(body: string, rc: RouteCtx, res: ServerResponse): Promise<void> {
    const rb = parseReleaseIdBody(this.mustObject(body, res));
    if (this.wasSent(res)) return;
    if (!rb.ok) return this.send(res, 400, { error: rb.reason });
    const confirm = this.d.authGate.verifyConfirmation(this.header(rc, "x-confirm-token"), "deploy", rb.value.releaseId);
    if (!confirm.ok) return this.send(res, confirm.status, { error: confirm.reason });
    await this.runOperation(res, this.idemKey(rc), () => this.d.controller.deploy(rb.value.releaseId, this.ctx(rc, this.idemKey(rc), confirm.jti)));
  }

  private async handleRollback(body: string, rc: RouteCtx, res: ServerResponse): Promise<void> {
    const rb = parseReleaseIdBody(this.mustObject(body, res));
    if (this.wasSent(res)) return;
    if (!rb.ok) return this.send(res, 400, { error: rb.reason });
    const confirm = this.d.authGate.verifyConfirmation(this.header(rc, "x-confirm-token"), "rollback", rb.value.releaseId);
    if (!confirm.ok) return this.send(res, confirm.status, { error: confirm.reason });
    await this.runOperation(res, this.idemKey(rc), () => this.d.controller.rollback(rb.value.releaseId, this.ctx(rc, this.idemKey(rc), confirm.jti)));
  }

  private async handleRestart(body: string, rc: RouteCtx, res: ServerResponse): Promise<void> {
    const parsed = parseJsonObject(body);
    if (!parsed.ok) return this.send(res, 400, { error: parsed.reason });
    const forbidden = findForbiddenKey(parsed.value);
    if (forbidden !== null) return this.send(res, 400, { error: `forbidden_key:${forbidden}` });
    const confirm = this.d.authGate.verifyConfirmation(this.header(rc, "x-confirm-token"), "restart", null);
    if (!confirm.ok) return this.send(res, confirm.status, { error: confirm.reason });
    await this.runOperation(res, this.idemKey(rc), () => this.d.controller.restart(this.ctx(rc, this.idemKey(rc), confirm.jti)));
  }

  private async handleLifecycle(action: "drain" | "resume", rc: RouteCtx, res: ServerResponse): Promise<void> {
    const effect = action === "drain" ? await this.d.gameServer.drain() : await this.d.gameServer.resume();
    await this.d.audit.append({
      at: new Date(this.d.clock.now()).toISOString(),
      actor: rc.actor, action, releaseId: null, prevReleaseId: null, requestId: rc.requestId,
      operationId: null, tokenJti: rc.tokenJti, confirmJti: null, result: effect.mode, detail: effect.detail,
    });
    return this.send(res, 200, { action, mode: effect.mode, detail: effect.detail });
  }

  private async handleWorldWarp(body: string, rc: RouteCtx, res: ServerResponse): Promise<void> {
    const parsed = this.mustObject(body, res);
    if (this.wasSent(res)) return;
    if (Object.keys(parsed).length !== 2
      || typeof parsed.worldId !== "string"
      || !isValidWorldId(parsed.worldId)
      || typeof parsed.floor !== "number"
      || !Number.isSafeInteger(parsed.floor)
      || parsed.floor < 1
      || parsed.floor > MAX_ADMIN_FLOOR) {
      return this.send(res, 400, { error: "world_warp_invalid" });
    }
    const result = await this.d.gameServer.warpWorld(parsed.worldId, parsed.floor);
    await this.auditWorldAction("warp_world", parsed.worldId, parsed.floor, result, rc);
    if (!result.isApplied) return this.sendWorldActionError(res, result.reason);
    return this.send(res, 200, result);
  }

  private async handleForceOpenExit(body: string, rc: RouteCtx, res: ServerResponse): Promise<void> {
    const parsed = this.mustObject(body, res);
    if (this.wasSent(res)) return;
    if (Object.keys(parsed).length !== 1
      || typeof parsed.worldId !== "string"
      || !isValidWorldId(parsed.worldId)) {
      return this.send(res, 400, { error: "world_force_open_invalid" });
    }
    const result = await this.d.gameServer.forceOpenWorldExit(parsed.worldId);
    await this.auditWorldAction("force_open_exit", parsed.worldId, null, result, rc);
    if (!result.isApplied) return this.sendWorldActionError(res, result.reason);
    return this.send(res, 200, result);
  }

  private async auditWorldAction(
    action: "warp_world" | "force_open_exit",
    worldId: string,
    floor: number | null,
    result: GameServerWorldActionResult,
    rc: RouteCtx,
  ): Promise<void> {
    await this.d.audit.append({
      at: new Date(this.d.clock.now()).toISOString(),
      actor: rc.actor,
      action,
      releaseId: null,
      prevReleaseId: null,
      requestId: rc.requestId,
      operationId: null,
      tokenJti: rc.tokenJti,
      confirmJti: null,
      result: result.isApplied ? "applied" : result.reason,
      detail: `world=${worldId}${floor === null ? "" : ` floor=${floor}`}`,
    });
  }

  private sendWorldActionError(
    res: ServerResponse,
    reason: "world_not_found" | "pvp_forbidden" | "unavailable",
  ): void {
    const status = reason === "world_not_found" ? 404 : reason === "pvp_forbidden" ? 409 : 503;
    this.send(res, status, { error: reason });
  }

  private async runOperation(res: ServerResponse, idemKey: string | null, run: () => Promise<OperationRecord>): Promise<void> {
    if (idemKey !== null) {
      const existing = await this.d.operations.findByIdempotencyKey(idemKey);
      if (existing !== null) return this.send(res, 200, { operationId: existing.id, kind: existing.kind, state: existing.state, result: existing.result, idempotent: true });
    }
    try {
      const op = await run();
      const status = op.result === "failure" ? 422 : 200;
      return this.send(res, status, { operationId: op.id, kind: op.kind, state: op.state, result: op.result, error: op.error, releaseId: op.releaseId, prevReleaseId: op.prevReleaseId });
    } catch (err) {
      if (err instanceof LockedError) {
        if (idemKey !== null) {
          const existing = await this.d.operations.findByIdempotencyKey(idemKey);
          if (existing !== null) return this.send(res, 200, { operationId: existing.id, kind: existing.kind, state: existing.state, result: existing.result, idempotent: true });
        }
        return this.send(res, 409, { error: "deploy_locked" });
      }
      if (err instanceof PreconditionError) return this.send(res, 422, { error: err.message });
      throw err;
    }
  }

  // ---- small helpers ----

  private ctx(rc: RouteCtx, idemKey: string | null, confirmJti: string | null): OperationContext {
    return { actor: rc.actor, requestId: rc.requestId, idempotencyKey: idemKey, tokenJti: rc.tokenJti, confirmJti };
  }

  private idemKey(rc: RouteCtx): string | null {
    const v = rc.req.headers["idempotency-key"];
    if (typeof v !== "string" || v.length === 0 || v.length > 128) return null;
    return v;
  }

  private header(rc: RouteCtx, name: string): string | null {
    const v = rc.req.headers[name];
    return typeof v === "string" ? v : null;
  }

  private mustObject(body: string, res: ServerResponse): Record<string, unknown> {
    const parsed = parseJsonObject(body);
    if (!parsed.ok) {
      this.send(res, 400, { error: parsed.reason });
      return {};
    }
    return parsed.value;
  }

  private wasSent(res: ServerResponse): boolean {
    return res.headersSent || res.writableEnded;
  }

  private clampLimit(url: URL, max: number): number {
    const raw = Number(url.searchParams.get("limit") ?? max);
    if (!Number.isFinite(raw) || raw <= 0) return max;
    return Math.min(max, Math.floor(raw));
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    // Over the soft limit -> drop further chunks and return null (413) while still draining the
    // request so a clean response can be sent. A hard limit destroys a truly abusive stream.
    return new Promise((resolve) => {
      let size = 0;
      let over = false;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) over = true;
        else chunks.push(c);
        if (size > MAX_BODY_BYTES * 64) {
          resolve(null);
          req.destroy();
        }
      });
      req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(null));
    });
  }

  private send(res: ServerResponse, status: number, obj: object): void {
    if (res.headersSent) return;
    const bodyText = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(bodyText);
  }
}

interface RouteCtx {
  requestId: string;
  actor: string;
  tokenJti: string;
  req: IncomingMessage;
}

function releaseView(r: { releaseId: string; manifest: { version: string; commit: string; builtAt: string }; isCurrent: boolean; isStaging: boolean; isRetained: boolean }): object {
  return {
    releaseId: r.releaseId,
    version: r.manifest.version,
    commit: r.manifest.commit,
    builtAt: r.manifest.builtAt,
    isCurrent: r.isCurrent,
    isStaging: r.isStaging,
    isRetained: r.isRetained,
  };
}

export function createControlServer(deps: ControlDeps): ControlHttpServer {
  return new ControlHttpServer(deps);
}
