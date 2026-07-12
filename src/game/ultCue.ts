// The CLIENT-SIDE ult "cue" deriver: turns the local player's ALREADY-authoritative ult meter
// (the reconciled ultCharge + the canCastUlt ready read) into cosmetic cues the renderer plays —
// charge MOTES (visible "playing charges my ult"), the READY crossing, and the CAST spend. It
// owns NO gameplay state and never touches the sim: it observes the same fixed-point charge the
// HUD already shows, so a mote can NEVER disagree with the meter. Deriving locally (vs a new wire
// event) keeps all three cues off the network protocol entirely — the charge delta and the local
// combat origins are all data the client already has (SelfWire.uc + the positional hit/kill
// events it already replays), so teammates' motes are out of scope but no protocol bump is owed.

export type UltMoteSource = "kill" | "dmg" | "boss";

// A resolved world origin + flavor for one accrual — the point a mote flies FROM. The caller
// resolves this from the combat event that charged the meter (a kill/boss hit) or falls back to
// the player's own body for the self-sourced trickle (time-floor / dash / heal / damage-taken).
export interface UltMoteOrigin {
  x: number;
  y: number;
  source: UltMoteSource;
}

export type UltCue =
  | { t: "ultMote"; x: number; y: number; amount: number; source: UltMoteSource }
  | { t: "ultReady" }
  | { t: "ultCast" };

export interface UltCueInput {
  // The authoritative fixed-point ult charge this step (0..ULT.meterMax), reconciled onto the
  // local player — the SAME value the meter fill reads.
  charge: number;
  // canCastUlt(charge, tick, readyAtTick): meter full AND past the 8s lockout. The rising edge
  // is the LOUD "ULT READY" moment; it stays false through the whole post-cast lockout.
  isReady: boolean;
  // The local player's own ult resolved this step (its ult* cast event was replayed) — the meter
  // just emptied, so any queued drip is stale.
  isCasting: boolean;
  // Where the most recent accrual came from this step (never null: the caller supplies the
  // player's body as the self-source fallback).
  origin: UltMoteOrigin;
  // Seconds since the previous feed (drives the mote-rate coalescing clock).
  dt: number;
}

// Render batching only: at most this many motes per second per player, so a shotgun into a crowd
// coalesces into ONE orb carrying the summed charge instead of spraying dozens. The charge is
// summed regardless — this caps orbs, never the meter.
export const ULT_MOTES_PER_SEC = 8;
const MOTE_INTERVAL = 1 / ULT_MOTES_PER_SEC;

// Only DISCRETE combat charge (a kill or a boss hit — meaningful and intermittent even on a kit
// that charges continuously) flies a mote from the enemy. Self-sourced charge ("dmg": heal, dash,
// time-floor trickle, damage-taken/dealt) is a body-anchored stream, so it mints NO projectile —
// it reads on the meter via the passive pulse instead.
export function isFlyingMoteSource(source: UltMoteSource): boolean {
  return source === "kill" || source === "boss";
}

// The passive meter tick that stands in for the dropped self-sourced motes: pulse the fill on any
// authoritative charge INCREASE, throttled, and never when a combat mote already pulsed this step
// (no double-ping) or during the lockout refill (the bar shows cooldown then, not charge).
export const PASSIVE_PULSE_INTERVAL = 0.15;
export function isPassiveMeterPulse(chargeDelta: number, sinceLastPulse: number, isMoteLanded: boolean, isLockout: boolean): boolean {
  return chargeDelta > 0 && !isMoteLanded && !isLockout && sinceLastPulse >= PASSIVE_PULSE_INTERVAL;
}

// Watches the local player's ult meter and emits cosmetic cues. One instance per run; reset() on
// any charge discontinuity (floor load / kit change / reconnect resync) so a jump is never read
// as combat charge.
export class UltCueTracker {
  private isPrimed = false;
  private prevCharge = 0;
  private wasReady = false;
  private pending = 0; // coalesced charge units awaiting a mote flush
  private pendingOrigin: UltMoteOrigin | null = null;
  private sinceMote = MOTE_INTERVAL; // start ready so the first accrual flushes immediately

  // Adopt a charge baseline WITHOUT emitting — call on a fresh run/floor or after a reconnect
  // snaps the meter, so the discontinuity never sprays motes.
  reset(charge = 0): void {
    this.isPrimed = true;
    this.prevCharge = charge;
    this.wasReady = false;
    this.pending = 0;
    this.pendingOrigin = null;
    this.sinceMote = MOTE_INTERVAL;
  }

  feed(input: UltCueInput): UltCue[] {
    const cues: UltCue[] = [];
    if (!this.isPrimed) {
      this.reset(input.charge);
      this.wasReady = input.isReady;
      return cues;
    }

    // A cast spends the meter to 0 this step: emit the cast cue and drop any pending drip (that
    // charge is gone), so the 100 -> 0 fall is never mistaken for un-charging.
    if (input.isCasting) {
      cues.push({ t: "ultCast" });
      this.pending = 0;
      this.pendingOrigin = null;
    }

    // Only INCREASES are combat charge; a decrease (cast / reset) just resyncs the baseline.
    const delta = input.charge - this.prevCharge;
    if (delta > 0) {
      this.pending += delta;
      this.pendingOrigin = input.origin;
    }
    this.prevCharge = input.charge;

    // Flush at most one mote per interval, carrying the summed pending charge from the most
    // recent origin — trash sums small, a boss's steady stream drips continuously.
    this.sinceMote += input.dt;
    if (this.pending > 0 && this.pendingOrigin !== null && this.sinceMote >= MOTE_INTERVAL) {
      cues.push({ t: "ultMote", x: this.pendingOrigin.x, y: this.pendingOrigin.y, amount: this.pending, source: this.pendingOrigin.source });
      this.pending = 0;
      this.pendingOrigin = null;
      this.sinceMote = 0;
    }

    // The READY crossing (full AND off lockout): one loud cue per rising edge, never during the
    // lockout — a re-charge after a cast re-fires it.
    if (input.isReady && !this.wasReady) cues.push({ t: "ultReady" });
    this.wasReady = input.isReady;

    return cues;
  }
}
