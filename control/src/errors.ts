// Typed control-flow errors the HTTP layer maps to status codes. Keeping these explicit (rather
// than throwing strings) means a handler can translate a domain failure into the right code
// without string-matching.

export class LockedError extends Error {
  constructor(message = "a deploy operation is already in progress") {
    super(message);
    this.name = "LockedError";
  }
}

// A precondition the caller can fix (bad/unknown release, failed gate, unknown rollback target).
export class PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionError";
  }
}
