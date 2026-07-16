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
  exact confirmed kit/pet. The proof uses the same server-to-Convex `GS_RECEIPT_SECRET`; timeout
  or Convex unavailability rejects the join.
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

Pure guests use a random 24-hour access capability scoped to profile, room, ticket, and economy
writes. A separate random 30-day refresh capability can only rotate the guest session; it cannot
enter a room, mint a ticket, or spend economy state. Both rotate on renewal and are revoked when
the row becomes an account. Account rows always require current Convex Auth; a retained
`clientId` or guest capability cannot write or mint after sign-out. Sign-out first creates a
fresh guest row and capability pair while the account JWT is still present, then removes the JWT.

When a guest is merged into an existing account, active room references block the merge.
Inactive host/presence references are rewired transactionally before the guest row is deleted.

## Dark PVP room policy foundation

PVP authorization is bound to one durable room field, `rooms.pvpPolicy`. The only policy
recognized by this release is `private_draft_v1`: it requires `mode=pvp`, `isPublic=false`, and a
maximum of four members. Co-op rooms must not carry a policy. Missing, unknown, or inconsistent
policy never defaults, downgrades, or falls back; legacy PVP rows without policy remain
inaccessible and the generation migration deliberately does not upgrade them.

Convex chooses the canonical policy from a private-room intent. The browser cannot submit a
policy value. Both private and public PVP rollout flags remain false, independently, so this
foundation creates no production PVP path.

Policy-bound PVP tickets use `v2` with fixed payload order
`pid,exp,wld,pp,nm,cl,ht,fc,kt,ml,pt,pc,sv`; `pp` is the canonical policy id. Co-op remains on
ticket `v1`. A v1 ticket cannot enter PVP, and v2 cannot authorize co-op. Generation admission is
the `a2` envelope and MAC-binds `mode` and `pvpPolicy` with player, world, room, generation,
loadout, expiry, and jti. Convex compares those values against one current durable room snapshot.

The control-plane parser probe is a separate v2 domain with exact ordered claims
`pid,exp,wld,pp,pr`: subject `synthetic-policy-v2`, world
`verify-policy-v2:<16 lowercase hex>`, policy `private_draft_v1`, and purpose
`policy_v2_parser`. The GS emits `authorityAck/policy_v2_parser` and closes before rollout flags,
admission, reservation, registry, world, or player creation. Wrong purpose, subject, namespace,
policy, version, signature, field set, or key order terminates as a rejection. Convex and browser
ticket minters do not expose the purpose claim.

Signed ticket payloads pass a bounded recursive JSON scanner before `JSON.parse`. It requires
fatal UTF-8, one complete top-level object, valid JSON tokens and surrogate pairs, and unique
decoded property names in every object scope. Policy v2 tickets additionally require
byte-for-byte equality with their locked-order `JSON.stringify` form, rejecting whitespace,
reordered or escaped key spellings, noncanonical numbers, duplicate claims, and trailing tokens
even under a valid HMAC. Admission a2 proofs use the same duplicate-aware structural scanner.

Shared HMAC envelopes (`r1` receipts and `a2` admission proofs) also require canonical unpadded
base64url on both payload and signature segments. The decoder accepts only `A-Z`, `a-z`, `0-9`,
`_`, and `-`; rejects padding, whitespace, standard-base64 characters, Unicode, invalid lengths,
and unused-tail-bit aliases; then re-encodes decoded bytes and requires exact string equality.
HMAC-SHA256 signatures are exactly 32 decoded bytes and 43 encoded characters. Node receipt and
ticket verification uses the same helper, while Web Crypto still verifies the MAC over the exact
canonical `<prefix>.<payload>` text.

The game server stores the verified policy immutably on its room runtime. Every later join and
resume must present the same policy, and active bodies plus reserved reconnect seats share the
four-player cap. `/version` exposes protocol 34, ticket `v1`/`v2`, admission `a2`, supported
policies, and both dark rollout flags. Control requires the exact policy catalog
`["private_draft_v1"]`, the terminal v2 parser acknowledgement, and ordinary WS/snapshot
liveness. The older signed v1 liveness synthetic remains deliberately separate: it creates an
ephemeral non-generation world/body and follows the normal reconnect cleanup lifecycle, so it is
not evidence of policy authority and is never used for the v2 parser gate.

Production control startup requires `BRC_GS_SYNTHETIC_TICKET_SECRET`. Read-only
`verifyDiagnostic()` may report HTTP or credential-free WS liveness in development.
`verifyForDeploy()` fails with `policy_probe_secret_missing` without the secret and succeeds only
at exact depth `policy_v2_parser+synthetic_join`. Deploy, restart, and rollback call only the
authority-required method and independently reject every partial depth.

Admission responses are also closed: the only positive body is exactly
`{"isAllowed":true,"code":"ok"}`. A negative body must be exactly
`{"isAllowed":false,"code":<allowlisted code>}` with one of `room_not_active`,
`generation_not_active`, `player_missing`, `membership_changed`, `policy_required`,
`policy_invalid`, `policy_mismatch`, `private_disabled`, `public_disabled`, or `room_full`.
Only HTTP 200 may carry the allow body, and only HTTP 403 may carry a known deny. Malformed JSON,
extra or inherited keys, every other status/body pairing, unknown codes, timeout, and 5xx
responses become local `admission_unavailable` and cannot bind a world.

## Rolling deployment order

This is a coordinated protocol-v34 hard cut, not a rolling mixed-version deploy.

1. Set a new Convex `GS_RECEIPT_SECRET`, distinct from `GS_AUTH_SECRET`, and deploy the additive
   schema, receipt/admission routes, guest capability resolver, and migration function.
2. Enter maintenance and stop legacy joins. Drain all pre-v34 worlds. A v32 server has no signed
   completion route, so verify `/worlds` is empty before continuing; v33 worlds must also drain
   because their offer/snapshot contract predates policy-bound drafts.
3. Run
   `migrations.backfillGenerationState({ isLegacyWorldsDrained: true })`. The explicit assertion
   converts drained legacy `playing` rooms to completed so they can reopen once, without
   pretending an old server emitted a receipt.
4. Publish the v34 client bundle.
5. Configure GS with `GS_AUTH_SECRET`, the distinct `GS_RECEIPT_SECRET`,
   `GS_CONVEX_RECEIPT_URL`, `GS_CONVEX_ADMISSION_URL`, and durable
   `GS_GENERATION_STATE_PATH`.
6. Deploy/reload GS v34, run the signed non-generation synthetic join, then resume joins.

For later v34 deploys, use the normal control-plane drain and flush endpoints. Drain refuses new
joins; flush clears reconnect seats, persists signed abandonment receipts, retires worlds, and
only then permits reload.

Old clients receive a terminal protocol or guest-capability rejection with refresh-required
copy. They do not retry for the 90-second reconnect window and cannot strand a room.

The policy-bound draft runtime changes the offer/event/snapshot contract, so
`PROTOCOL_VERSION` is 34 across client, game server, and control. Old clients terminate with
refresh-required copy. Ticket v2 and admission a2 remain the authority envelopes.

`RoomRuntime.pvpPolicy === "private_draft_v1"` is the sole draft-runtime switch. The immutable
policy is copied into the simulation when the world is constructed; null, unsupported, public,
and co-op worlds are inert. The 3-frag/45-active-second cadence, 60-active-second offer lifetime,
offer choices, picks, and drafted build are match-scoped. Insufficient-present-player pauses and
absence freeze the affected clocks; death does not cancel a pending offer because applying a
blessing cannot fire, heal, move, or otherwise cause immediate combat action. Match over,
no-contest, final leave, and requeue clear every pending offer and drafted build.

Deploy Convex policy schema/query support before the matching game server, verify `/version`,
and keep both PVP flags false. This change is safe to merge dark but does not authorize private
or public admission; a later private-PVP release must flip only the private guard after its
coordinated client/server release.

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
- PVP remains disabled. Do not enable it until its server-owned terminal event emits the same
  generation-completion proof; the co-op reward fold intentionally rejects PVP receipts.
