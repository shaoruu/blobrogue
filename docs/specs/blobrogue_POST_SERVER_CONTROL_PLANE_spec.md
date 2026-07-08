# blobrogue — POST-SERVER CONTROL PLANE + IMMUTABLE RELEASE PIPELINE (spec)

Status: canonical. Scope: **production deployment/control plane, not gameplay.** This is the
post–Stage-C operational deploy path. It changes NOTHING in the game simulation, netcode, or
the Stage-B/Stage-C game server (`server/`); it can merge independently as long as it stays
isolated (own package, own PM2 app, own port, own credentials).

The goal is operational: **remove the laptop from the deploy loop.** `admin.create.town` is
logged in and a separate PR builds the operator UI. This spec defines the safe backend the
panel proxies to, and the immutable release pipeline that backend consumes.

Read alongside `blobrogue_PRODUCTION_server_spec.md` (§6 observability, §7 Hetzner ops, §8
staging), `blobrogue_AUTHORITATIVE_SERVER_spec.md` (§6 hosting, LOCKED), and
`blobrogue_STAGE_B_spec.md`.

---

## 1. Trust boundaries (LOCKED)

```
Internet ──TLS 443──▶ nginx ──▶ admin.create.town server proxy (auth: operator session)
                                     │  attaches short-lived signed admin ops token
                                     ▼
                        blobrogue-control  (127.0.0.1:8091, loopback only)
                                     │  narrow, typed, allowlisted control API
                                     ├──HTTP──▶ blobrogue-gs /healthz /metrics (127.0.0.1:8090)
                                     ├──WS────▶ blobrogue-gs /ws (synthetic join verify)
                                     ├──pm2 (fixed app names, fixed args)
                                     └──fs  (immutable releases dir + atomic symlink)
```

Non-negotiable properties:

- **Only nginx/443 is public.** `blobrogue-gs` (8090) and `blobrogue-control` (8091) bind
  `127.0.0.1` and are never exposed. Health/metrics stay loopback.
- **Control and game do NOT share handlers or credentials.** The game WS ticket
  (`GS_AUTH_SECRET`, binds a `playerId`) and the admin ops token (`BRC_ADMIN_TOKEN_SECRET`,
  carries `scope: ["blobrogue:ops"]`) are different secrets verified by different code. A game
  ticket can never authorize a control action and vice-versa.
- **No arbitrary shell.** There is no endpoint that accepts a command, path, process name, env
  var, git ref, URL, or free-form PM2 argument. Every mutating action maps to a fixed,
  compiled-in operation over a constant executable + constant argv, or a narrow injected
  executor whose inputs are structurally validated allow-list values.
- **Town is structurally untouchable.** The control service only ever names the constant apps
  `blobrogue-gs` and (for its own supervision) `blobrogue-control`. `town` is not a value any
  request can produce; targeting it is rejected before any executor is reached.

---

## 2. Control API (v1)

Transport: HTTP/JSON on `127.0.0.1:8091`, one small router, per-request isolation (a single
malformed/hostile request can never crash the service — mirrors `server/`'s per-message
isolation). All routes are versioned under `/v1`.

### 2.1 AuthN / AuthZ (every route)

Every request MUST carry:

- `Authorization: Bearer <adminToken>` — a short-lived signed admin ops token (§3.1) with
  `scope` containing `blobrogue:ops`, a valid `aud`, unexpired `exp`, and an unused `jti`
  (replay-rejected).

Mutating deploy-class routes (`/deploy`, `/restart`, `/rollback`) additionally require:

- `X-Confirm-Token: <confirmToken>` — a second, action-bound token (§3.2), TTL ≤ 60s, issued by
  `/v1/confirm` and cryptographically bound to `{action, releaseId?}`. It cannot be reused for a
  different action or release.

All requests SHOULD carry `Idempotency-Key: <opaque>` on mutating routes; duplicate keys return
the original operation instead of starting a new one (§4.4).

Origin/CSRF: when an `Origin` header is present it MUST be in `BRC_ALLOWED_ORIGINS`
(default: the admin panel origin). Absent `Origin` (server-to-server proxy) is allowed. This is
belt-and-suspenders behind the token; the token is the real gate.

Rate limits: token-bucket per `(actor, remote)` (§3.3). Over-limit → `429`.

### 2.2 READ routes (admin token only)

| Method + path | Returns |
|---|---|
| `GET /v1/status` | game server liveness + summary (uptime, worlds, players, connections, tick p50/p95/max, status) |
| `GET /v1/readiness` | `{ live, ready }` — liveness (process up) vs readiness (accepting joins / not draining) |
| `GET /v1/version` | `{ releaseId, version, commit, builtAt }` of the currently-`current` release |
| `GET /v1/worlds` | bounded world summaries (`id`, `players`, `tick`) |
| `GET /v1/metrics` | bounded, redacted counters + tick percentiles (from gs `/metrics`) |
| `GET /v1/logs?limit=N&level=L` | bounded (≤ `BRC_LOG_TAIL_MAX`) redacted structured log records |
| `GET /v1/releases` | known/retained releases (releaseId, version, commit, verified, current, retained) |
| `GET /v1/operations?limit=N` | recent operations (id, kind, state, result, timestamps) |
| `GET /v1/operations/:id` | full durable operation record incl. state-machine transitions |
| `GET /v1/audit?limit=N` | bounded append-only audit records |

### 2.3 MUTATE routes

Bodies are strictly typed. **Any body containing a forbidden key is rejected `400` before
dispatch**: `cmd`, `command`, `path`, `dir`, `cwd`, `process`, `app`, `appName`, `name`,
`target`, `host`, `env`, `ref`, `gitRef`, `branch`, `commit`, `sha`, `url`, `args`, `argv`,
`script`, `shell`. The only accepted mutating input is a `releaseId` (strict charset, must
resolve in the ReleaseStore) plus, where relevant, a boolean `staging` flag.

| Method + path | Body | Confirm? | Effect |
|---|---|---|---|
| `POST /v1/confirm` | `{ action, releaseId? }` | — | issue an action-bound confirm token (§3.2) |
| `POST /v1/deploy-preview` | `{ releaseId }` | no | verify artifact + manifest + checksum + gates; stage into the staging slot/app; NO prod switch |
| `POST /v1/deploy` | `{ releaseId }` | **yes** | run the deploy state machine (§4) to make `releaseId` the prod `current` |
| `POST /v1/drain` | `{}` | no | ask gs to stop accepting new joins |
| `POST /v1/resume` | `{}` | no | ask gs to resume accepting joins |
| `POST /v1/restart` | `{}` | **yes** | restart exactly `blobrogue-gs` (pm2 reload), verify health |
| `POST /v1/rollback` | `{ releaseId }` | **yes** | switch `current` back to a known **retained** release + reload + verify |

`releaseId` grammar: `^[a-z0-9]+-[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}$`
(`<commitShort>-<version>-<manifestChecksum12>`). This is generated by the build pipeline; the
control service never constructs or mutates it, only looks it up.

Every mutate returns an **operation** (`{ operationId, kind, state }`); progress is polled via
`GET /v1/operations/:id`. There is no long-lived streaming requirement.

---

## 3. Auth model

### 3.1 Admin ops token

HMAC-SHA256 signed, compact `v1.<b64url(payload)>.<sig>` (same envelope shape as the game
ticket, but a DIFFERENT secret + richer payload). Minted by the admin panel's server side after
it authenticates the human operator. Payload:

```
{
  sub:   string   // operator identity (audit actor)
  scope: string[] // MUST contain "blobrogue:ops"
  aud:   string   // MUST equal BRC_TOKEN_AUDIENCE (e.g. "blobrogue-control")
  iss:   string   // issuer (informational, logged)
  iat:   number   // issued-at (unix seconds)
  exp:   number   // expiry (unix seconds); short-lived (≤ BRC_ADMIN_TOKEN_MAX_TTL_SEC)
  jti:   string   // unique token id — REPLAY-rejected via NonceStore
}
```

Verification (constant-time sig compare): signature → audience → scope → expiry → not-before
sanity → `jti` unseen. A seen `jti` is rejected (`401 replay`). `jti` is remembered until
`exp` (bounded store, evict on expiry).

### 3.2 Confirmation token (deploy/restart/rollback)

A second signed token, separate short secret (`BRC_CONFIRM_TOKEN_SECRET`), issued by
`/v1/confirm` and bound to the exact action:

```
{ action: "deploy"|"restart"|"rollback", releaseId?: string, sub, aud, iat, exp, jti }
```

`exp - iat ≤ 60s`. The mutate handler recomputes the binding: the confirm token's `action` MUST
equal the route's action and its `releaseId` (when the action carries one) MUST equal the
request's `releaseId`. A confirm token minted for `deploy releaseId=A` cannot authorize
`deploy releaseId=B`, nor `restart`, nor `rollback`. `jti` is replay-rejected like §3.1.

This yields intentional two-step confirmation and makes accidental/duplicate clicks safe.

### 3.3 Rate limiting

Token-bucket keyed by `remoteAddr`, evaluated **before** auth so an unauthenticated flood is
cheap to shed: `BRC_RATE_CAPACITY` tokens, refilled `BRC_RATE_REFILL_PER_SEC`. Reads and mutates
share the bucket; mutates additionally serialize on the single deploy lock (§4.4). Over-limit →
`429` with no side effects.

### 3.4 Redaction

Structured logs and any log records returned via `GET /v1/logs` pass through a redactor that
strips token-shaped material and known secret env names/values before emission. Secrets are
never logged; audit records reference tokens by `jti`, never by value.

---

## 4. Immutable release pipeline + deploy state machine

### 4.1 Immutable releases

An artifact is produced by CI/a build box (never by the control service, never by an
admin-triggered `git pull`). The artifact is a tarball plus a `manifest.json`:

```
manifest.json = {
  releaseId, version, commit, builtAt,
  checksum,            // sha256 of the packaged tree (excluding the manifest)
  gates: { typecheck, unitTests, goldens }, // required gates, all must be "pass"
  files: string[]      // packaged entries (server + client + control artifacts)
}
```

`releaseId` embeds `commit`, `version`, and the first 12 hex of `checksum`; the ArtifactVerifier
recomputes the checksum and re-derives the `releaseId` and rejects any mismatch, missing gate, or
non-`pass` gate.

Layout on the box:

```
/opt/blobrogue-gs/
  releases/
    <releaseId-A>/    # immutable, verified; never edited in place
    <releaseId-B>/
  current -> releases/<releaseId-B>   # atomic symlink; pm2 cwd points at .../current
  staging -> releases/<releaseId-A>   # deploy-preview slot (staging app)
```

Deploy never writes into a mutable working tree; it only atomically re-points `current`.
`BRC_RETAINED_RELEASES` good releases are kept for rollback; older ones are pruned (never the
`current` or `staging` targets).

### 4.2 Deploy state machine

`PREFLIGHT → DRAIN → FLUSH → SWITCH → PM2_RELOAD → VERIFY → RESUME → DONE`

- **PREFLIGHT** — acquire the single deploy lock; ArtifactVerifier confirms release exists,
  checksum matches, gates green; confirm token valid; assert target app is the constant
  `blobrogue-gs`.
- **DRAIN** — `GameServerAdmin.drain()`: ask gs to stop accepting new joins. Best-effort +
  documented contract (see §4.5); PM2 graceful reload provides the hard drain.
- **FLUSH** — `GameServerAdmin.flush()`: ask gs to flush durable state (best-effort contract).
- **SWITCH** — atomically re-point `current` → new release (temp symlink + `rename`). The prior
  target is recorded for rollback.
- **PM2_RELOAD** — reload exactly `blobrogue-gs` (fixed app, fixed argv) so it boots from the new
  `current`.
- **VERIFY** — `GameServerAdmin.verify()`: `/healthz` status ok, readiness ready, WS reachable +
  ticking, synthetic join (§4.6). Any failure → rollback.
- **RESUME** — `GameServerAdmin.resume()`.
- **DONE** — release marked good/retained; lock released.

**Atomic failure recovery:** a failure at SWITCH/RELOAD/VERIFY runs the compensating path —
restore the prior `current` symlink, reload `blobrogue-gs`, resume — and the operation ends
`rolled_back` with the failure reason. State transitions are persisted before and after each
step so an interrupted operation (process crash, admin reconnect) is recoverable and reported,
never silently lost.

`rollback` and `restart` are smaller state machines that reuse SWITCH/RELOAD/VERIFY/RESUME.

### 4.3 Durable operations

Every operation is a durable record (OperationStore, atomic file writes): `id, kind, state,
releaseId?, actor, requestId, prevReleaseId?, transitions[], result, error?, startedAt,
updatedAt`. On boot the service scans for a non-terminal operation and marks it `interrupted`
(recoverable), so a reconnecting admin sees the true state.

### 4.4 Locking + idempotency

- **Single deploy lock:** at most one deploy/restart/rollback in flight. A second attempt while
  locked → `409 locked` (unless it is the same idempotency key).
- **Idempotency:** `Idempotency-Key` maps to the operation it created; a duplicate returns that
  operation (safe duplicate-click). Bounded, TTL-evicted.

### 4.5 Game-server drain/flush/resume contract (graceful degradation)

`drain/flush/resume` call documented loopback gs admin endpoints IF present. Because this PR does
not modify `server/`, the concrete adapter treats "endpoint absent" as **not-supported →
deferred to PM2 graceful reload** (gs already closes sockets cleanly on SIGTERM), and records
which mode was used. When Stage-C adds real gs readiness/drain endpoints, the same adapter uses
them with no control-plane change. This keeps the control plane isolated and mergeable now.

### 4.6 Synthetic join verification (credential boundary preserved)

VERIFY opens a real WS to `127.0.0.1:8090/ws` and asserts the server is live and ticking (it
receives a server frame within a timeout — proving the WS server + tick/heartbeat loop run). If
an operator opts in by configuring `BRC_GS_SYNTHETIC_TICKET_SECRET` (equal to the box
`GS_AUTH_SECRET`, used ONLY to mint a short-lived synthetic ticket for a dedicated synthetic
player id, loopback-only, never used to accept inbound control requests), VERIFY performs a FULL
join and asserts a `snap` with a spawned `self`. The verification result honestly records which
depth was achieved. The synthetic secret is optional; without it, verify still proves WS
liveness/ticking without borrowing game credentials.

---

## 5. Domain interfaces (small, explicit, injectable)

No god object. Each concern is an interface with a concrete adapter and an in-memory/fake test
double. Host-touching effects go through injected ports so tests never mutate the box.

- **`ReleaseStore`** — `list()`, `get(releaseId)`, `current()`, `staging()`, `switchCurrent(id)`
  (atomic), `retain(id)`, `prune(keep)`. Backed by `FileSystemPort`.
- **`OperationStore`** — `create(op)`, `update(op)`, `get(id)`, `list(limit)`,
  `findNonTerminal()`. Durable atomic writes.
- **`GameServerAdmin`** — `status()`, `readiness()`, `metrics()`, `worlds()`, `logs(q)`,
  `drain()`, `flush()`, `resume()`, `restart()`, `verify()`. Backed by `HttpProbe`,
  `SyntheticJoinProbe`, and `Pm2Port`.
- **`ArtifactVerifier`** — `verify(releaseId): VerifiedRelease | Rejection`. Recomputes checksum,
  re-derives releaseId, checks gates.
- **`AuditSink`** — `append(record)`, `list(limit)`. Append-only (JSONL), immutable.

Injected ports (the ONLY host effects; fakes in tests):

- **`FileSystemPort`** — read/list/atomic-write/symlink-swap. No path comes from a request body.
- **`Pm2Port`** — `reload(app)`, `describe(app)` where `app ∈ {"blobrogue-gs",
  "blobrogue-control"}` ONLY (enum, not a string a request can influence). Real adapter uses
  `execFile("pm2", [fixedArgs...])` — never a shell, never request-derived argv.
- **`HttpProbe`** / **`SyntheticJoinProbe`** — loopback gs reads + synthetic WS join.
- **`Clock`** — injectable time for deterministic tests.

---

## 6. Ops assets

- **PM2:** `blobrogue-gs` and `blobrogue-control` as separate `fork` apps, `instances: 1`, own
  ports (8090 / 8091), own log files, own `max_memory_restart`, `cwd` at the release `current`
  symlink. A staging app `blobrogue-gs-staging` (own port/logs) for deploy-preview. **Town is
  never referenced.**
- **nginx:** `/ws` → `127.0.0.1:8090` (WebSocket upgrade, long timeouts). Admin control proxy →
  `127.0.0.1:8091` behind the panel's operator auth; health/metrics loopback-only /
  IP-allowlisted, never public.
- **logrotate:** `pm2 install pm2-logrotate` caps growth beside town.
- **Boot persistence:** `pm2 save` + `pm2 startup`.
- **Scripts (versioned):** `build-release.sh` (CI/build-box: run gates → package exact tested
  server/client/control artifacts + manifest → releaseId), `promote.sh` (place a verified
  artifact into `releases/<id>` on the box, checksum-verified, idempotent — the switch is done by
  the control API), `rollback.sh` (reference wrapper), `install-hetzner.sh` (one-time box setup,
  guarded template). Promotion consumes an immutable verified artifact only; a Git-backed build
  workspace is allowed for BUILD but never for promotion/deploy.

Secrets: only in `/opt/blobrogue-*/.env` (chmod 600); `.env.example` documents NAMES with no
values.

---

## 7. Environment (names only)

`BRC_` = blobrogue-control. See `control/.env.example`.

| Name | Meaning |
|---|---|
| `BRC_HOST` / `BRC_PORT` | bind (default `127.0.0.1` / `8091`) |
| `BRC_ADMIN_TOKEN_SECRET` | HMAC secret for admin ops tokens (required in prod) |
| `BRC_CONFIRM_TOKEN_SECRET` | HMAC secret for confirmation tokens (required in prod) |
| `BRC_TOKEN_AUDIENCE` | required `aud` (default `blobrogue-control`) |
| `BRC_ADMIN_TOKEN_MAX_TTL_SEC` | reject admin tokens with longer TTL (default 900) |
| `BRC_ALLOWED_ORIGINS` | CSV origin allow-list (admin panel origin) |
| `BRC_RATE_CAPACITY` / `BRC_RATE_REFILL_PER_SEC` | token bucket |
| `BRC_RELEASES_ROOT` | `/opt/blobrogue-gs` |
| `BRC_RETAINED_RELEASES` | good releases kept for rollback (default 5) |
| `BRC_GS_BASE_URL` | gs loopback base (default `http://127.0.0.1:8090`) |
| `BRC_GS_WS_URL` | gs loopback ws (default `ws://127.0.0.1:8090/ws`) |
| `BRC_GS_SYNTHETIC_TICKET_SECRET` | OPTIONAL; enables full synthetic join verify (loopback only) |
| `BRC_STATE_DIR` | durable operations/audit dir (chmod 700) |
| `BRC_LOG_TAIL_MAX` | max log records returnable |
| `BRC_ALLOW_DEV_AUTH` | LOCAL DEV ONLY; hard-disabled when `NODE_ENV=production` |

---

## 8. Testing bar

Unit + integration, injected fakes for all host effects (no box mutation):

- valid read/auth passes; expired / wrong-scope / wrong-audience / replayed tokens rejected.
- malformed / flooded / oversized requests are isolated (no crash) and rate-limited.
- arbitrary cmd/path/process/env/ref/url and **town targeting** are structurally impossible /
  rejected before any executor runs.
- deploy state transitions in order; bad artifact / bad checksum / missing-or-failing gate
  rejected at PREFLIGHT.
- VERIFY failure triggers atomic rollback (prior symlink restored, reload, resume).
- duplicate idempotency key returns the same operation; second concurrent deploy hits the lock.
- logs redacted; audit written append-only for every mutate.
- restart reloads exactly `blobrogue-gs` (never town, never control).
- one real integration test boots a real `blobrogue-gs` in-process and runs the real HTTP +
  synthetic-join verify path against it (honest end-to-end evidence; no Hetzner).

`npm run typecheck && npm run build && npm run test` clean in `control/`; the repo's existing
client/server/golden suites remain green.

---

## 9. Merge posture

This is the post–Stage-C deploy path. It is safe to merge before/independently of Stage C combat
because it is fully isolated: new `control/` package, new PM2 app, new port, new credentials,
and zero edits to game sim/netcode/`server/`. It does not touch a live Hetzner box; deploy.sh and
install scripts are guarded templates.
