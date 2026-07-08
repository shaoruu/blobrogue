// Token + gate unit tests: valid tokens pass; expired / wrong-scope / wrong-audience / too-long
// TTL / tampered / replayed tokens are rejected; confirmation tokens are bound to their exact
// action + release and are replay-protected.

import { NonceStore } from "../src/auth/nonceStore.js";
import { mintConfirmToken, verifyAdminToken, verifyConfirmToken } from "../src/auth/tokens.js";
import { AuthGate } from "../src/auth/gate.js";
import { loadConfig, type ControlConfig } from "../src/config.js";
import { ManualClock, TestRunner, TEST_ADMIN_SECRET, TEST_CONFIRM_SECRET, TEST_AUDIENCE, adminToken, confirmToken } from "./harness.js";

const POLICY = { audience: TEST_AUDIENCE, maxTtlSec: 900 };

function baseCfg(clock: ManualClock, over: Partial<ControlConfig> = {}): ControlConfig {
  void clock;
  return {
    ...loadConfig({}),
    adminTokenSecret: TEST_ADMIN_SECRET,
    confirmTokenSecret: TEST_CONFIRM_SECRET,
    tokenAudience: TEST_AUDIENCE,
    adminTokenMaxTtlSec: 900,
    allowedOrigins: [],
    allowDevAuth: false,
    ...over,
  };
}

export async function suite(t: TestRunner): Promise<void> {
  await t.suite("auth: admin token verification", async () => {
    const clock = new ManualClock();
    const now = clock.now();
    const good = adminToken(clock);
    const okRes = verifyAdminToken(TEST_ADMIN_SECRET, good, POLICY, now);
    t.check("valid admin token accepted", okRes.ok, okRes.ok ? "" : okRes.reason);

    const wrongScope = adminToken(clock, { scope: ["something:else"] });
    t.check("wrong scope rejected", !verifyAdminToken(TEST_ADMIN_SECRET, wrongScope, POLICY, now).ok);

    const wrongAud = adminToken(clock, { aud: "not-control" });
    const audRes = verifyAdminToken(TEST_ADMIN_SECRET, wrongAud, POLICY, now);
    t.check("wrong audience rejected", !audRes.ok && (audRes.ok || audRes.reason === "bad_audience"));

    const expired = adminToken(clock, { ttlSec: -10 });
    const expRes = verifyAdminToken(TEST_ADMIN_SECRET, expired, POLICY, now);
    t.check("expired token rejected", !expRes.ok && (expRes.ok || expRes.reason === "expired"));

    const tooLong = adminToken(clock, { ttlSec: 100000 });
    const ttlRes = verifyAdminToken(TEST_ADMIN_SECRET, tooLong, POLICY, now);
    t.check("over-long TTL rejected", !ttlRes.ok && (ttlRes.ok || ttlRes.reason === "ttl_too_long"));

    const tampered = good.slice(0, -3) + (good.slice(-1) === "a" ? "bbb" : "aaa");
    t.check("tampered signature rejected", !verifyAdminToken(TEST_ADMIN_SECRET, tampered, POLICY, now).ok);

    t.check("wrong secret rejected", !verifyAdminToken("other-secret", good, POLICY, now).ok);
  });

  await t.suite("auth: replay prevention (nonce)", async () => {
    const clock = new ManualClock();
    const nonces = new NonceStore(clock);
    const expSec = Math.floor(clock.now() / 1000) + 300;
    t.check("first use of jti accepted", nonces.checkAndRecord("jti-A", expSec) === false);
    t.check("second use of same jti is a replay", nonces.checkAndRecord("jti-A", expSec) === true);
    t.check("different jti accepted", nonces.checkAndRecord("jti-B", expSec) === false);
    clock.advance(301_000);
    t.check("expired jti forgotten and re-acceptable", nonces.checkAndRecord("jti-A", Math.floor(clock.now() / 1000) + 300) === false);
  });

  await t.suite("auth: confirmation token binding", async () => {
    const clock = new ManualClock();
    const now = clock.now();
    const cDeploy = confirmToken(clock, "deploy", "abc123def456-1.2.3-0123456789ab");
    const ok = verifyConfirmToken(TEST_CONFIRM_SECRET, cDeploy, TEST_AUDIENCE, now);
    t.check("valid confirm token parses", ok.ok, ok.ok ? "" : ok.reason);
    if (ok.ok) {
      t.check("confirm token bound to deploy action", ok.payload.action === "deploy");
      t.check("confirm token bound to release", ok.payload.releaseId === "abc123def456-1.2.3-0123456789ab");
    }
    const tooLong = mintConfirmToken(TEST_CONFIRM_SECRET, { action: "deploy", releaseId: null, sub: "x", aud: TEST_AUDIENCE, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 120, jti: "cf-long" });
    const longRes = verifyConfirmToken(TEST_CONFIRM_SECRET, tooLong, TEST_AUDIENCE, now);
    t.check("confirm TTL > 60s rejected", !longRes.ok && (longRes.ok || longRes.reason === "confirm_ttl_too_long"));
  });

  await t.suite("auth: gate end-to-end", async () => {
    const clock = new ManualClock();
    const cfg = baseCfg(clock);
    const gate = new AuthGate(cfg, new NonceStore(clock), new NonceStore(clock), clock);
    const tok = adminToken(clock, { jti: "gate-1" });
    const first = gate.authenticate(`Bearer ${tok}`);
    t.check("gate accepts a valid bearer", first.ok, first.ok ? first.ctx.actor : first.reason);
    const replay = gate.authenticate(`Bearer ${tok}`);
    t.check("gate rejects a replayed bearer", !replay.ok && (replay.ok || replay.reason === "replay"));
    t.check("gate rejects a missing bearer", !gate.authenticate(null).ok);

    const relId = "abc123def456-1.2.3-0123456789ab";
    const cf = confirmToken(clock, "deploy", relId, { jti: "gate-cf-1" });
    t.check("confirm matches action+release", gate.verifyConfirmation(cf, "deploy", relId).ok);
    t.check("confirm rejected for different action", !gate.verifyConfirmation(cf, "restart", null).ok);
    const cf2 = confirmToken(clock, "deploy", relId, { jti: "gate-cf-2" });
    t.check("confirm rejected for different release", !gate.verifyConfirmation(cf2, "deploy", "abc123def456-9.9.9-ffffffffffff").ok);

    t.check("origin allowed when unconfigured", gate.checkOrigin("https://anything.example"));
    const pinned = new AuthGate(baseCfg(clock, { allowedOrigins: ["https://admin.create.town"] }), new NonceStore(clock), new NonceStore(clock), clock);
    t.check("pinned origin accepts panel", pinned.checkOrigin("https://admin.create.town"));
    t.check("pinned origin rejects stranger", !pinned.checkOrigin("https://evil.example"));
    t.check("pinned origin allows no-origin proxy", pinned.checkOrigin(null));
  });
}
