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
- Before every production spawn or resume, the game server posts a short-lived signed admission
  proof to `/gs/admission`. Convex rechecks the current generation, membership, Ready state, and
  exact confirmed kit/pet. Timeout or Convex unavailability rejects the join.
- Solo runs are client-authoritative and therefore unverified. They do not write Amber,
  Mastery, rescues, unlocks, or leaderboard progress.

## Durable generations

`GS_GENERATION_STATE_PATH` points to an fsynced state file outside release directories, for
example `/var/lib/blobrogue/generation-admission.json`. A generation is written active before its
world is created. The latest retired generation remains a permanent per-room high-water mark;
superseded lower tombstones are cleaned after ticket expiry. On process startup, an active
generation left by the prior process is durably retired and a signed `server_restart` completion
is posted to Convex. An old ticket therefore cannot recreate a world after restart or cleanup.
The receipt dispatcher persists its retry outbox beside this file as
`<GS_GENERATION_STATE_PATH>.receipts`. Failed deliveries remain bounded dead letters for 30 days
instead of disappearing silently.

Convex `rooms.generationState` is the durable lobby authority:

1. `pending` while loadout/Ready are collected.
2. `active` only after the authoritative START transaction.
3. `completed` only after a valid GS completion receipt.

`rooms.reopen` requires `completed`. Client `reportWorld` remains presentation-only.

## Guest capabilities

Pure guests use a random 24-hour capability scoped to profile, room, ticket, and economy writes.
The capability is rotated on bootstrap/renewal and revoked when the row becomes an account.
Account rows always require current Convex Auth; a retained `clientId` or guest capability cannot
write or mint after sign-out. Sign-out first creates a fresh guest row and capability while the
account JWT is still present, then removes the JWT.

When a guest is merged into an existing account, active room references block the merge.
Inactive host/presence references are rewired transactionally before the guest row is deleted.

## Rolling deployment order

This is a coordinated protocol-v33 hard cut, not a rolling mixed-version deploy.

1. Set a new Convex `GS_RECEIPT_SECRET`, distinct from `GS_AUTH_SECRET`, and deploy the additive
   schema, receipt/admission routes, guest capability resolver, and migration function.
2. Enter maintenance and stop legacy joins. Drain all v32 worlds. A v32 server has no signed
   completion route, so verify `/worlds` is empty before continuing.
3. Run
   `migrations.backfillGenerationState({ isLegacyWorldsDrained: true })`. The explicit assertion
   converts drained legacy `playing` rooms to completed so they can reopen once, without
   pretending an old server emitted a receipt.
4. Publish the v33 client bundle.
5. Configure GS with `GS_AUTH_SECRET`, the distinct `GS_RECEIPT_SECRET`,
   `GS_CONVEX_RECEIPT_URL`, `GS_CONVEX_ADMISSION_URL`, and durable
   `GS_GENERATION_STATE_PATH`.
6. Deploy/reload GS v33, run the signed non-generation synthetic join, then resume joins.

For later v33 deploys, use the normal control-plane drain and flush endpoints. Drain refuses new
joins; flush clears reconnect seats, persists signed abandonment receipts, retires worlds, and
only then permits reload.

Old clients receive a terminal protocol or guest-capability rejection with refresh-required
copy. They do not retry for the 90-second reconnect window and cannot strand a room.

## Migration and compatibility

- Never pass `isLegacyWorldsDrained: true` while a v32 world is live.
- Existing pure guest rows receive a one-time capability on their first v33 `ensurePlayer`.
  Once a session exists, bare `clientId` calls fail closed.
- Existing account rows are immediately protected: unsigned `clientId` access is rejected.
- Existing leaderboard/player rows require no progression backfill.
- Consumed receipt rows are retained through receipt expiry and cleaned by the hourly cron.
- Do not deploy the v33 GS before Convex and the client are ready; it intentionally rejects old
  protocol clients rather than accepting an authority-incomplete session.
- A dead-lettered completion leaves the latest generation retired and non-admissible. Resolve the
  Convex rejection or perform an audited operator reconciliation; never delete the generation
  high-water file to make a ticket work.
