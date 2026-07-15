# Run authority and generation admission

## Trust model

- Online progression is granted only by a `r1` receipt signed by the game server with
  `GS_RECEIPT_SECRET`.
- `GS_RECEIPT_SECRET` is distinct from `GS_AUTH_SECRET`. The former authorizes terminal run
  facts and generation completion; the latter authorizes short-lived world admission tickets.
- The game server posts receipts directly to
  `https://<deployment>.convex.site/gs/run-completion`. Browsers never mint, edit, or redeem
  progression facts.
- Convex verifies the receipt, generation, room membership, expiry, and one-time `jti` in one
  mutation before applying Amber, Mastery, rescues, unlocks, aggregates, or leaderboard data.
- Solo runs are client-authoritative and therefore unverified. They do not write Amber,
  Mastery, rescues, unlocks, or leaderboard progress.

## Durable generations

`GS_GENERATION_STATE_PATH` points to a state file outside release directories, for example
`/var/lib/blobrogue/generation-admission.json`. A generation is written active before its world
is created and retired for longer than the ticket TTL when it ends. On process startup, any
generation left active by the prior process is durably retired and a signed `server_restart`
completion is posted to Convex. Old tickets therefore remain rejected after a restart.
The receipt dispatcher persists its retry outbox beside this file as
`<GS_GENERATION_STATE_PATH>.receipts`, so a Convex outage or GS restart cannot lose a signed
terminal receipt before it expires.

Convex `rooms.generationState` is the durable lobby authority:

1. `pending` while loadout/Ready are collected.
2. `active` only after the authoritative START transaction.
3. `completed` only after a valid GS completion receipt.

`rooms.reopen` requires `completed`. Client `reportWorld` remains presentation-only.

## Guest capabilities

Pure guests use a random, expiring capability scoped to profile, room, ticket, and economy
writes. The capability is rotated on bootstrap/renewal and revoked when the row becomes an
account. Account rows always require current Convex Auth; a retained `clientId` cannot write or
mint after sign-out. Sign-out first creates a fresh guest row and capability while the account
JWT is still present, then removes the JWT.

When a guest is merged into an existing account, active room references block the merge.
Inactive host/presence references are rewired transactionally before the guest row is deleted.

## Rolling deployment order

This is a coordinated protocol-v33 hard cut.

1. Deploy the Convex schema, HTTP receipt endpoint, internal receipt mutation, guest capability
   resolver, and `migrations.backfillGenerationState`.
2. Set Convex `GS_RECEIPT_SECRET`.
3. Publish the v33 client bundle.
4. Configure GS with a distinct `GS_RECEIPT_SECRET`, `GS_CONVEX_RECEIPT_URL`, and durable
   `GS_GENERATION_STATE_PATH`.
5. Use the control-plane drain and flush endpoints. Drain refuses new joins; flush emits signed
   abandoned-generation completions and retires worlds before PM2 reload.
6. Deploy/reload GS v33, verify the synthetic join, then resume joins.

Old clients receive a terminal protocol or guest-capability rejection with refresh-required
copy. They do not retry for the 90-second reconnect window and cannot strand a room.

## Migration and compatibility

- Run `migrations.backfillGenerationState` before enabling the v33 GS.
- Existing pure guest rows receive a one-time capability on their first v33 `ensurePlayer`.
  Once a session exists, bare `clientId` calls fail closed.
- Existing account rows are immediately protected: unsigned `clientId` access is rejected.
- Existing leaderboard/player rows require no progression backfill.
- Consumed receipt rows are retained through receipt expiry and cleaned by the hourly cron.
- Do not deploy the v33 GS before Convex and the client are ready; it intentionally rejects old
  protocol clients rather than accepting an authority-incomplete session.
