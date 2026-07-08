// The single deployment lock. At most one deploy/restart/rollback runs at a time (the control
// service is one fork process, so an in-process flag is the whole lock). A second attempt while
// held throws LockedError, which the API maps to 409 — unless the caller matched an in-flight
// operation by idempotency key first.

import { LockedError } from "./errors.js";

export class DeployLock {
  private heldBy: string | null = null;

  acquire(operationId: string): void {
    if (this.heldBy !== null) throw new LockedError();
    this.heldBy = operationId;
  }

  release(operationId: string): void {
    if (this.heldBy === operationId) this.heldBy = null;
  }

  get isHeld(): boolean {
    return this.heldBy !== null;
  }
}
