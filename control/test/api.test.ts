// HTTP API tests: read routes work with a valid token; missing/expired/wrong-scope/replayed
// tokens are rejected; malformed and oversized bodies are safe; forbidden keys (and any attempt
// to name a town/target/cmd/path) are structurally rejected; deploy requires a matching confirm
// token; idempotency + lock behave; rate limiting engages; drain/resume are audited.

import { api, adminToken, confirmToken, makeTestBed, stageRelease, TestRunner } from "./harness.js";

export async function suite(t: TestRunner): Promise<void> {
  await t.suite("api: read routes require and accept a valid token", async () => {
    const bed = await makeTestBed();
    try {
      const noAuth = await api(bed.base, "GET", "/v1/status");
      t.check("no token -> 401", noAuth.status === 401);

      const tok = adminToken(bed.clock);
      const status = await api(bed.base, "GET", "/v1/status", { token: tok });
      t.check("status 200 with valid token", status.status === 200 && status.body.status === "ok");

      const version = await api(bed.base, "GET", "/v1/version", { token: adminToken(bed.clock) });
      t.check("version returns null current before any deploy", version.status === 200 && version.body.releaseId === null);

      const releases = await api(bed.base, "GET", "/v1/releases", { token: adminToken(bed.clock) });
      t.check("releases list is an array", releases.status === 200 && Array.isArray(releases.body.releases));

      const unknownOp = await api(bed.base, "GET", "/v1/operations/op_" + "0".repeat(18), { token: adminToken(bed.clock) });
      t.check("unknown operation -> 404", unknownOp.status === 404);
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: auth rejections (scope / audience / expiry / replay)", async () => {
    const bed = await makeTestBed();
    try {
      const wrongScope = await api(bed.base, "GET", "/v1/status", { token: adminToken(bed.clock, { scope: ["x"] }) });
      t.check("wrong scope -> 401 missing_scope", wrongScope.status === 401 && wrongScope.body.error === "missing_scope");

      const expired = await api(bed.base, "GET", "/v1/status", { token: adminToken(bed.clock, { ttlSec: -5 }) });
      t.check("expired -> 401 expired", expired.status === 401 && expired.body.error === "expired");

      const replayTok = adminToken(bed.clock, { jti: "replay-1" });
      const first = await api(bed.base, "GET", "/v1/status", { token: replayTok });
      const second = await api(bed.base, "GET", "/v1/status", { token: replayTok });
      t.check("first use ok, replay -> 401 replay", first.status === 200 && second.status === 401 && second.body.error === "replay");
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: structural rejection of forbidden keys (town/cmd/path unnameable)", async () => {
    const bed = await makeTestBed();
    try {
      const id = stageRelease(bed.fs, bed.cfg.releasesRoot);
      const cf = confirmToken(bed.clock, "deploy", id);
      for (const bad of [{ target: "town" }, { app: "town" }, { cmd: "rm -rf /" }, { path: "/etc" }, { gitRef: "main" }, { url: "http://x" }, { args: ["--force"] }, { town: true }]) {
        const res = await api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock), confirm: cf, body: { releaseId: id, ...bad } });
        const key = Object.keys(bad)[0];
        t.check(`forbidden key '${key}' -> 400`, res.status === 400 && String(res.body.error).startsWith("forbidden_key"), `status=${res.status} err=${String(res.body.error)}`);
      }
      const noTarget = await api(bed.base, "POST", "/v1/restart", { token: adminToken(bed.clock), confirm: confirmToken(bed.clock, "restart", null), body: { target: "town" } });
      t.check("restart cannot carry a target -> 400", noTarget.status === 400);
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: malformed + oversized bodies are safe", async () => {
    const bed = await makeTestBed();
    try {
      const badJson = await fetch(bed.base + "/v1/deploy", { method: "POST", headers: { authorization: `Bearer ${adminToken(bed.clock)}`, "content-type": "application/json" }, body: "}{ not json" });
      t.check("malformed json -> 400", badJson.status === 400);

      const huge = "x".repeat(64 * 1024);
      const big = await fetch(bed.base + "/v1/deploy", { method: "POST", headers: { authorization: `Bearer ${adminToken(bed.clock)}`, "content-type": "application/json" }, body: JSON.stringify({ releaseId: huge }) });
      t.check("oversized body -> 413", big.status === 413);

      const stillUp = await api(bed.base, "GET", "/v1/status", { token: adminToken(bed.clock) });
      t.check("service healthy after hostile bodies", stillUp.status === 200);
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: deploy requires a matching confirmation token", async () => {
    const bed = await makeTestBed();
    try {
      const id = stageRelease(bed.fs, bed.cfg.releasesRoot);
      const noConfirm = await api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock), body: { releaseId: id } });
      t.check("deploy without confirm -> 401", noConfirm.status === 401 && noConfirm.body.error === "missing_confirm_token");

      const wrongRelease = confirmToken(bed.clock, "deploy", "abc123def456-9.9.9-ffffffffffff");
      const mismatch = await api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock), confirm: wrongRelease, body: { releaseId: id } });
      t.check("confirm bound to another release -> 401", mismatch.status === 401 && mismatch.body.error === "confirm_release_mismatch");

      const wrongAction = confirmToken(bed.clock, "restart", null);
      const actionMismatch = await api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock), confirm: wrongAction, body: { releaseId: id } });
      t.check("confirm bound to another action -> 401", actionMismatch.status === 401);

      const ok = await api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock), confirm: confirmToken(bed.clock, "deploy", id), body: { releaseId: id } });
      t.check("valid deploy -> 200 done", ok.status === 200 && ok.body.state === "done", `status=${ok.status} state=${String(ok.body.state)}`);
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: /confirm issues a bound token that drives a real deploy", async () => {
    const bed = await makeTestBed();
    try {
      const id = stageRelease(bed.fs, bed.cfg.releasesRoot);
      const confirmRes = await api(bed.base, "POST", "/v1/confirm", { token: adminToken(bed.clock), body: { action: "deploy", releaseId: id } });
      t.check("/confirm returns a token", confirmRes.status === 200 && typeof confirmRes.body.confirmToken === "string");
      const cf = String(confirmRes.body.confirmToken);
      const dep = await api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock), confirm: cf, body: { releaseId: id } });
      t.check("deploy with issued confirm -> done", dep.status === 200 && dep.body.state === "done");
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: idempotency returns the same operation", async () => {
    const bed = await makeTestBed();
    try {
      const id = stageRelease(bed.fs, bed.cfg.releasesRoot);
      const first = await api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock), confirm: confirmToken(bed.clock, "deploy", id), idem: "dup-key-1", body: { releaseId: id } });
      t.check("first deploy runs", first.status === 200 && typeof first.body.operationId === "string");
      const second = await api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock), confirm: confirmToken(bed.clock, "deploy", id), idem: "dup-key-1", body: { releaseId: id } });
      t.check("duplicate idempotency-key returns same operation", second.status === 200 && second.body.operationId === first.body.operationId && second.body.idempotent === true);
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: concurrent deploys hit the single lock (409)", async () => {
    const bed = await makeTestBed();
    try {
      const a = stageRelease(bed.fs, bed.cfg.releasesRoot, { version: "1.0.0" });
      const b = stageRelease(bed.fs, bed.cfg.releasesRoot, { version: "2.0.0" });
      bed.probe.verifyDelayMs = 60; // first deploy holds the lock across a timer
      const [r1, r2] = await Promise.all([
        api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock, { jti: "c1" }), confirm: confirmToken(bed.clock, "deploy", a, { jti: "cf-c1" }), idem: "k-a", body: { releaseId: a } }),
        api(bed.base, "POST", "/v1/deploy", { token: adminToken(bed.clock, { jti: "c2" }), confirm: confirmToken(bed.clock, "deploy", b, { jti: "cf-c2" }), idem: "k-b", body: { releaseId: b } }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      t.check("one deploy succeeds, one is locked (409)", statuses[0] === 200 && statuses[1] === 409, `statuses=${statuses.join(",")}`);
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: rate limiting engages under a flood", async () => {
    const bed = await makeTestBed({ rateCapacity: 3, rateRefillPerSec: 0 });
    try {
      const results: number[] = [];
      for (let i = 0; i < 8; i++) results.push((await api(bed.base, "GET", "/v1/status", { token: adminToken(bed.clock, { jti: "rl-" + i }) })).status);
      t.check("some requests are rate-limited (429)", results.includes(429), `statuses=${results.join(",")}`);
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: drain/resume are audited", async () => {
    const bed = await makeTestBed();
    try {
      const drain = await api(bed.base, "POST", "/v1/drain", { token: adminToken(bed.clock) });
      t.check("drain -> 200 applied", drain.status === 200 && drain.body.mode === "applied");
      const resume = await api(bed.base, "POST", "/v1/resume", { token: adminToken(bed.clock) });
      t.check("resume -> 200 applied", resume.status === 200);
      const audits = await api(bed.base, "GET", "/v1/audit", { token: adminToken(bed.clock) });
      const list = Array.isArray(audits.body.audit) ? audits.body.audit : [];
      const actions = list.map((r) => (typeof r === "object" && r !== null ? (r as { action?: unknown }).action : null));
      t.check("audit contains drain + resume", actions.includes("drain") && actions.includes("resume"), `actions=${actions.join(",")}`);
    } finally {
      await bed.close();
    }
  });

  await t.suite("api: live-world rescue actions are admin-gated and audited", async () => {
    const bed = await makeTestBed();
    try {
      const noAuth = await api(bed.base, "POST", "/v1/worlds/warp", {
        body: { worldId: "arena-1", floor: 55 },
      });
      t.check("warp without admin token is rejected", noAuth.status === 401);
      t.check("rejected warp never reaches the game server", bed.probe.worldActionCalls.length === 0);
      const noAuthSnapshot = await api(bed.base, "POST", "/v1/worlds/snapshot", {
        body: { worldId: "arena-1" },
      });
      t.check("snapshot without admin token is rejected", noAuthSnapshot.status === 401);

      const warp = await api(bed.base, "POST", "/v1/worlds/warp", {
        token: adminToken(bed.clock),
        body: {
          worldId: "arena-1",
          floor: 55,
          loadouts: [{
            player: "Ian",
            kitId: "phantom",
            hp: 2.5,
            weapons: ["nailer", "umbra"],
            blessings: [{ id: "glass_cannon", lvl: 3 }],
          }],
        },
      });
      const warpCall = bed.probe.worldActionCalls[0];
      t.check("admin warp reaches the named world", warp.status === 200
        && warp.body.isApplied === true
        && warp.body.floor === 55
        && warpCall?.action === "warp"
        && warpCall.loadouts?.[0]?.player === "Ian"
        && warpCall.loadouts[0].weapons?.includes("umbra") === true);

      const force = await api(bed.base, "POST", "/v1/worlds/force-open-exit", {
        token: adminToken(bed.clock),
        body: { worldId: "arena-1" },
      });
      t.check("admin force-open reaches the named world", force.status === 200
        && force.body.isApplied === true
        && bed.probe.worldActionCalls[1]?.action === "force-open-exit");

      const snapshot = await api(bed.base, "POST", "/v1/worlds/snapshot", {
        token: adminToken(bed.clock),
        body: { worldId: "arena-1" },
      });
      t.check("admin snapshot persists the named world", snapshot.status === 200
        && snapshot.body.fidelity === "build+floor"
        && bed.probe.worldActionCalls[2]?.action === "snapshot");

      const restore = await api(bed.base, "POST", "/v1/worlds/restore", {
        token: adminToken(bed.clock),
        body: { worldId: "arena-1" },
      });
      t.check("admin restore rehydrates the named world", restore.status === 200
        && restore.body.fidelity === "build+floor"
        && bed.probe.worldActionCalls[3]?.action === "restore");

      const missing = await api(bed.base, "POST", "/v1/worlds/warp", {
        token: adminToken(bed.clock),
        body: { worldId: "missing", floor: 55 },
      });
      t.check("missing world is explicit", missing.status === 404 && missing.body.error === "world_not_found");

      const malformed = await api(bed.base, "POST", "/v1/worlds/warp", {
        token: adminToken(bed.clock),
        body: { worldId: "arena-1", floor: 1001 },
      });
      t.check("invalid floor is rejected before the game server", malformed.status === 400);
      const malformedLoadout = await api(bed.base, "POST", "/v1/worlds/warp", {
        token: adminToken(bed.clock),
        body: {
          worldId: "arena-1",
          floor: 55,
          loadouts: [{ player: "Ian", blessings: [{ id: "glass_cannon", lvl: 99 }] }],
        },
      });
      t.check("invalid loadout structure is rejected before the game server",
        malformedLoadout.status === 400);

      const audits = await api(bed.base, "GET", "/v1/audit", {
        token: adminToken(bed.clock),
      });
      const serialized = JSON.stringify(audits.body);
      t.check("every live-run rescue attempt is audited", serialized.includes("warp_world")
        && serialized.includes("force_open_exit")
        && serialized.includes("snapshot_world")
        && serialized.includes("restore_world")
        && serialized.includes("world=arena-1"));
    } finally {
      await bed.close();
    }
  });
}
