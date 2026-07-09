// The run-readiness gate for a party-started online run (the permanent fix for the Sev-0
// room divergence, where a host could "start" a run that only the host actually joined).
//
// Two rosters exist and only their AGREEMENT means the party assembled:
//   expected  — the lobby's live Convex roster (who believes they are in this room). Presence
//               rows go stale ~12s after a client dies, so a crashed/closed member drops OUT
//               of the expectation automatically — one absent client can never deadlock the
//               reveal forever.
//   connected — the authoritative server's per-world roster (snapshot `roster`, keyed by the
//               same verified ticket identity the lobby keys on). This is the truth about who
//               is actually playing in the world.
//
// The gate stays WAITING until every currently-expected member is connected (self included —
// an empty/not-yet-delivered expectation can never vacuously open it), latches READY once
// satisfied, and reports FAILED with the missing members' names when the deadline passes —
// the caller returns to the lobby with an explicit error instead of silently playing alone.
//
// Pure and clock-injected so the exact Sev-0 scenario (a member that never joins) is
// deterministically testable without a browser.

export interface ExpectedMember {
  playerId: string; // the lobby identity — equals the ticket identity (`aid`) on the server roster
  name: string;
  colorIndex: number;
}

export interface PartyMemberView {
  playerId: string;
  name: string;
  colorIndex: number;
  isSelf: boolean;
  isConnected: boolean;
}

export type PartyPhase = "waiting" | "ready" | "failed";

export interface PartyGateView {
  phase: PartyPhase;
  members: PartyMemberView[];
  missingNames: string[];
}

// How long a party start may sit waiting before it is declared failed. Deliberately longer
// than the Convex presence stale window (12s): a member who VANISHED is pruned from the
// expectation well before this fires, so the deadline only trips for members who are still
// claiming the room but never reached the world (e.g. their game-server connect failed).
export const PARTY_GATE_DEADLINE_MS = 20000;

export class PartyGate {
  private readonly selfPlayerId: string;
  private readonly deadlineMs: number;
  private startedAt: number | null = null;
  private isReadyLatched = false;

  constructor(selfPlayerId: string, deadlineMs = PARTY_GATE_DEADLINE_MS) {
    this.selfPlayerId = selfPlayerId;
    this.deadlineMs = deadlineMs;
  }

  evaluate(nowMs: number, expected: readonly ExpectedMember[], connectedAuthIds: ReadonlySet<string>): PartyGateView {
    if (this.startedAt === null) this.startedAt = nowMs;
    const members: PartyMemberView[] = expected.map((m) => ({
      playerId: m.playerId,
      name: m.name,
      colorIndex: m.colorIndex,
      isSelf: m.playerId === this.selfPlayerId,
      isConnected: connectedAuthIds.has(m.playerId),
    }));
    const isSelfExpected = members.some((m) => m.isSelf);
    const isAssembled = isSelfExpected && members.every((m) => m.isConnected);
    if (isAssembled) this.isReadyLatched = true;
    const missingNames = this.isReadyLatched ? [] : members.filter((m) => !m.isConnected).map((m) => m.name);
    const phase: PartyPhase = this.isReadyLatched
      ? "ready"
      : nowMs - this.startedAt >= this.deadlineMs
        ? "failed"
        : "waiting";
    return { phase, members, missingNames };
  }
}
