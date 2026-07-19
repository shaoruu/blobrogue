# blobrogue-control — deployment / control plane

A loopback-only ops service that the `admin.create.town` panel proxies to, so blobrogue can be
deployed, restarted, drained, and rolled back **without a laptop in the loop**. It drives an
immutable release pipeline (atomic `current` symlink), reloads **exactly** the `blobrogue-gs`
pm2 app, and audits every mutating action.

It is deliberately isolated and safe to merge independently of Stage C combat work:

- **Separate package**, separate pm2 app (`blobrogue-control`), separate port (`127.0.0.1:8091`),
  **separate credentials** from the game WS. Control and game never share handlers or secrets.
- **No game sim/netcode change.** This PR does not touch `server/` or `src/`.
- **No arbitrary shell.** There is no endpoint that accepts a command, path, process name, env
  var, git ref, URL, or free-form pm2 argument. Every mutation is a fixed operation over a
  constant executable + constant argv. `town` is not a value any request can produce.

Canonical design: [`docs/specs/blobrogue_POST_SERVER_CONTROL_PLANE_spec.md`](../docs/specs/blobrogue_POST_SERVER_CONTROL_PLANE_spec.md).

## Trust boundary

```
Internet ──TLS 443──▶ nginx ──▶ admin.create.town panel proxy (operator session)
                                    │  attaches Authorization: Bearer <admin ops token>
                                    ▼
                       blobrogue-control (127.0.0.1:8091)
                                    ├─ HTTP  ─▶ blobrogue-gs /healthz /metrics (127.0.0.1:8090)
                                    ├─ WS    ─▶ blobrogue-gs /ws  (synthetic-join verify)
                                    ├─ pm2   ─▶ reload blobrogue-gs   (fixed app + argv)
                                    └─ fs    ─▶ releases/<id> + atomic current symlink
```

Only 443 is public. `blobrogue-gs` (8090) and `blobrogue-control` (8091) bind loopback; health
and metrics are never exposed — the control plane re-exposes bounded, redacted views behind the
ops token.

## API contract (v1) — for the admin panel

All routes are under `/v1` and require `Authorization: Bearer <adminToken>` (a short-lived signed
token whose payload carries `scope: ["blobrogue:ops"]`, a valid `aud`, an unexpired `exp`, and a
one-time `jti`). Deploy/restart/rollback additionally require `X-Confirm-Token` (below).
Mutations should carry an `Idempotency-Key`.

### Read

| Method + path | Returns |
|---|---|
| `GET /v1/status` | `{ status, uptimeSec, worlds, players, connections, tickMs_p50/p95/max }` |
| `GET /v1/readiness` | `{ live, ready, detail }` |
| `GET /v1/version` | `{ releaseId, version, commit, builtAt }` of the current release |
| `GET /v1/worlds` | `{ worlds: [{ id, players, tick }] }` |
| `GET /v1/metrics` | flat `{ <counter>: number }` (redacted) |
| `GET /v1/logs?limit=N&level=L` | `{ logs: [{ time, level, msg, fields }] }` (bounded, redacted) |
| `GET /v1/releases` | `{ releases: [{ releaseId, version, commit, builtAt, isCurrent, isStaging, isRetained }] }` |
| `GET /v1/operations?limit=N` | `{ operations: [OperationRecord] }` |
| `GET /v1/operations/:id` | full `OperationRecord` (state-machine transitions) |
| `GET /v1/audit?limit=N` | `{ audit: [AuditRecord] }` |

### Mutate

Request bodies accept only `releaseId` (validated grammar, looked up) and, for `/confirm`, an
`action` enum. Any body carrying a forbidden key (`target`, `app`, `cmd`, `path`, `env`, `ref`,
`url`, `args`, `town`, …) is rejected `400` before dispatch.

| Method + path | Body | Confirm? | Effect |
|---|---|---|---|
| `POST /v1/confirm` | `{ action, releaseId? }` | — | returns `{ confirmToken, action, releaseId, expiresInSec }` |
| `POST /v1/deploy-preview` | `{ releaseId }` | no | verify artifact + gates, stage into the staging slot |
| `POST /v1/deploy` | `{ releaseId }` | **yes** | run the deploy state machine to make `releaseId` current |
| `POST /v1/drain` | `{}` | no | ask gs to stop accepting new joins |
| `POST /v1/resume` | `{}` | no | ask gs to resume |
| `POST /v1/restart` | `{}` | **yes** | reload exactly `blobrogue-gs`, verify |
| `POST /v1/rollback` | `{ releaseId }` | **yes** | switch current back to a retained release, reload, verify |

Every mutate returns `{ operationId, kind, state, result, ... }`; poll `GET /v1/operations/:id`
for progress. `releaseId` grammar: `<commitShort>-<version>-<checksum12>`.

### Two-step confirm flow (deploy/restart/rollback)

```
POST /v1/confirm  { "action": "deploy", "releaseId": "<id>" }   -> { confirmToken }
POST /v1/deploy   { "releaseId": "<id>" }
     headers: Authorization: Bearer <adminToken>
              X-Confirm-Token: <confirmToken>          # bound to (deploy, <id>), TTL <= 60s
              Idempotency-Key: <opaque>
```

A confirm token is cryptographically bound to its exact action + release; it cannot authorize a
different action or release, and it is single-use.

## Local development

```sh
cd control
npm install
BRC_ALLOW_DEV_AUTH=1 npm run dev
# -> control listening on 127.0.0.1:8091
```

With `BRC_ALLOW_DEV_AUTH=1` (never in production), send `Authorization: Bearer dev:<actor>` and,
for confirm-gated routes, `X-Confirm-Token: dev:whatever`. Point it at a local gs with
`BRC_GS_BASE_URL` / `BRC_GS_WS_URL`.

```sh
npm run typecheck   # tsc (src + tests + the real-gs integration import)
npm run build       # tsc emit -> dist/src/main.js
npm run test:unit   # blocking correctness suite over injected fs/pm2/gs fakes
npm run test:integration # real-gs live VERIFY integration
npm test            # both groups
```

## Release build → promote → deploy

Releases are **immutable**. The build runs on CI / a build box from a clean checkout — never an
admin-triggered `git pull`, never a mutable working-tree deploy.

```sh
# 1) BUILD (CI / build box): fast interactive path skips only the flaky live-gs VERIFY
control/scripts/build-release.sh --skip-verify
#    FAST_DEPLOY=1 control/scripts/build-release.sh is equivalent.
#    Without fast mode, live-gs VERIFY runs report-only and writes artifacts/control-verify-<commit>.log.
#    Typecheck, server/control unit tests, and deterministic goldens always remain blocking.
#    -> artifacts/<releaseId>.tar.gz (+ .sha256), prints <releaseId>
#    releaseId = <commitShort>-<version>-<checksum12>; manifest records gate results + checksum

# 2) UPLOAD the artifact to the box (scp/rsync the tarball + .sha256), then PROMOTE it:
control/scripts/promote.sh /path/to/<releaseId>.tar.gz /opt/blobrogue-gs
#    -> unpacks into /opt/blobrogue-gs/releases/<releaseId> (checksum-verified, idempotent)
#    promote NEVER flips current — it only stages the immutable release.

# 3) DEPLOY via the control API (runs the verified state machine):
#    POST /v1/confirm {action:deploy, releaseId} -> confirmToken
#    POST /v1/deploy  {releaseId} with X-Confirm-Token
```

Deploy state machine: `PREFLIGHT → DRAIN → FLUSH → SWITCH → PM2_RELOAD → VERIFY → RESUME`. VERIFY
checks health/readiness, WS liveness/tick, and (when `BRC_GS_SYNTHETIC_TICKET_SECRET` is set) a
full synthetic join. Any post-switch failure **atomically restores the prior `current` symlink,
reloads, and resumes**, and the operation ends `rolled_back`. Operation state is durable, so an
interrupted deploy (crash / admin reconnect) is recoverable and reported.

## Rollback / recovery

```sh
# audited rollback to a known retained release (same verified state machine as deploy):
BRC_ADMIN_TOKEN=<token> control/scripts/rollback.sh <releaseId>
```

- Rollback targets must be a **retained** release still present under `releases/`
  (`BRC_RETAINED_RELEASES`, default 5). Verify `GET /v1/releases`.
- If the control process is restarted mid-operation, it marks the interrupted operation on boot;
  the admin sees the true state via `GET /v1/operations/:id`. Re-issue the deploy/rollback.
- Last-resort manual recovery (operator, on the box): the previous good release is a retained
  directory; repoint `current` and reload gs. Prefer the API path so the change is verified +
  audited.

## One-time Hetzner install (beside town)

```sh
# GUARDED template — prints its actions; runs only with BRC_I_UNDERSTAND=1. Town is never touched.
BRC_I_UNDERSTAND=1 control/scripts/install-hetzner.sh
#   creates /opt/blobrogue-gs/releases, /opt/blobrogue-control/state (chmod 700),
#   /var/log/blobrogue-{gs,control}, .env files (chmod 600), pm2-logrotate, pm2 startup
```

Then set secrets by hand in the `.env` files (chmod 600), promote a release, `POST /v1/deploy`,
and `pm2 save`. See `ops/`:

- `ops/ecosystem.blobrogue.config.cjs` — `blobrogue-gs` + `blobrogue-gs-staging` +
  `blobrogue-control`, three separate `fork` apps, `instances: 1`, own ports/logs/memory caps,
  `cwd` at the release symlink. **Town is not defined here.**
- `ops/nginx.control.example.conf` — `/ws` → gs (8090) and the admin control proxy → control
  (8091), with the health/metrics loopback note.
- `ops/logrotate.example` — log rotation beside town (or use `pm2 install pm2-logrotate`).

## Required environment (names only; values live in a chmod-600 `.env`)

See [`.env.example`](.env.example). Notably: `BRC_ADMIN_TOKEN_SECRET` and
`BRC_CONFIRM_TOKEN_SECRET` (required in production — the service refuses to start without them),
`BRC_TOKEN_AUDIENCE`, `BRC_RELEASES_ROOT`, `BRC_STATE_DIR`, `BRC_GS_BASE_URL`/`BRC_GS_WS_URL`, and
the optional `BRC_GS_SYNTHETIC_TICKET_SECRET` (enables full synthetic-join verify; loopback only,
never used to accept inbound control requests). These are **separate** from the game server's
`GS_AUTH_SECRET`.

## Module map

```
src/interfaces.ts     ReleaseStore, OperationStore, GameServerAdmin, ArtifactVerifier, AuditSink
src/ports.ts          injected host seams: FileSystemPort, Pm2Port, GameServerProbe, Clock
src/auth/             admin + confirmation tokens, replay nonce store, token-bucket rate limit, gate
src/stores/           FsReleaseStore, FileOperationStore, FileAuditSink, manifest parser
src/artifactVerifier  recompute checksum, re-derive releaseId, require gates green
src/gameServerAdmin   reads/verify via probe; restart reloads exactly blobrogue-gs
src/deployController   the deploy/rollback/restart state machine + durable ops + audit
src/validation        strict body schemas + structural forbidden-key rejection
src/httpApi           the /v1 router (per-request isolation)
src/adapters/         real node fs / pm2 / gs-probe (+ synthetic join) / log tail
scripts/  ops/        immutable pipeline scripts + pm2/nginx/logrotate examples
test/                 unit + integration suite (in-memory fakes + one real-gs integration)
```
