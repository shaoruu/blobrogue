// Client-side entity interpolation for remote players.
//
// Convex delivers each teammate's position as discrete presence snapshots a handful of
// times per second. Rendering those raw makes remote blobs teleport between samples (the
// jitter the owner reported). Instead we buffer a short per-player history of received
// samples -- stamped with the LOCAL time they arrived, which sidesteps client/server clock
// skew -- and, on every read, return the pose at a render clock that trails real time by one
// sync interval. That render point almost always sits between two buffered samples, so we
// linearly interpolate x/y and angle-lerp the aim: the blob glides along the path the
// network described instead of snapping to each update. Classic entity interpolation -- we
// spend a fixed sliver of latency to buy motion that stays smooth through network jitter.

// Trail real time by roughly one active send interval so two samples almost always straddle
// the render clock. Larger is smoother but laggier; tuned to the ~18Hz active push rate.
export const RENDER_DELAY_MS = 120;

// If the newest sample predates the render clock (a late / dropped update), project forward
// from the last two samples for up to this long before giving up and holding position.
const MAX_EXTRAPOLATE_MS = 220;

// Fixed per-player history: ~330ms at the active rate. Enough to straddle the render clock
// with margin, small enough that reads stay a trivial linear scan and steady state never
// allocates.
const HISTORY = 6;

// A jump larger than this between consecutive samples is a teleport (descend to a new floor /
// respawn), not travel -- even a dash (620 px/s) covers far less between updates. We snap to
// it rather than sliding the blob across the map.
const TELEPORT_DIST_SQ = 600 * 600;

export interface Pose {
  x: number;
  y: number;
  aimAngle: number;
}

interface Sample {
  recvAt: number; // local time (ms) this sample was received
  srcAt: number;  // server updatedAt, used only to dedupe repeat callbacks
  x: number;
  y: number;
  aim: number;
}

interface Track {
  samples: Sample[]; // chronological by recvAt, length <= HISTORY
  pose: Pose;        // scratch reused across reads so the hot path never allocates
}

// Shortest-path angle interpolation, so aim swinging past +/-PI turns the short way round.
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

export class RemoteInterp {
  private tracks = new Map<string, Track>();
  // Effective render trail (ms). Defaults to the tuned base but the authoritative-server client
  // sizes it adaptively from measured jitter (Stage C) via setRenderDelay.
  private renderDelayMs = RENDER_DELAY_MS;

  setRenderDelay(ms: number): void {
    this.renderDelayMs = ms;
  }
  getRenderDelay(): number {
    return this.renderDelayMs;
  }

  // Feed the latest snapshot for one player. Only rows whose server timestamp advanced add a
  // keyframe, so a burst of subscription callbacks (fired whenever ANY player changes) never
  // floods a still player's buffer with duplicate samples.
  ingest(id: string, srcAt: number, x: number, y: number, aim: number, now: number): void {
    let track = this.tracks.get(id);
    if (!track) {
      track = { samples: [], pose: { x, y, aimAngle: aim } };
      this.tracks.set(id, track);
    }
    const samples = track.samples;
    const last = samples[samples.length - 1];
    if (last && last.srcAt === srcAt) return;
    // A teleport (floor descend / respawn) would otherwise slide the blob across the level for
    // one render delay; drop the stale history so the next read snaps straight to the new spot.
    if (last) {
      const dx = x - last.x, dy = y - last.y;
      if (dx * dx + dy * dy > TELEPORT_DIST_SQ) samples.length = 0;
    }
    // Reuse the oldest slot once the ring is full, so ingest stops allocating after warmup.
    const s = samples.length >= HISTORY
      ? samples.shift()!
      : { recvAt: 0, srcAt: 0, x: 0, y: 0, aim: 0 };
    s.recvAt = now; s.srcAt = srcAt; s.x = x; s.y = y; s.aim = aim;
    samples.push(s);
  }

  // Forget players no longer in the room so their buffers don't linger.
  retain(ids: Set<string>): void {
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
  }

  // The interpolated pose at (now - RENDER_DELAY_MS), or null if this player has no samples
  // yet. The returned object is reused per player -- copy the fields out; don't retain it.
  sample(id: string, now: number): Pose | null {
    const track = this.tracks.get(id);
    if (!track || track.samples.length === 0) return null;
    const s = track.samples;
    const pose = track.pose;
    const renderAt = now - this.renderDelayMs;

    // Before the oldest keyframe (just joined, or a long stall): hold the oldest pose.
    if (renderAt <= s[0].recvAt) {
      pose.x = s[0].x; pose.y = s[0].y; pose.aimAngle = s[0].aim;
      return pose;
    }
    // Common case: the render clock falls between two keyframes -- interpolate.
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1];
      if (renderAt <= b.recvAt) {
        const span = b.recvAt - a.recvAt;
        const t = span > 0 ? (renderAt - a.recvAt) / span : 0;
        pose.x = a.x + (b.x - a.x) * t;
        pose.y = a.y + (b.y - a.y) * t;
        pose.aimAngle = lerpAngle(a.aim, b.aim, t);
        return pose;
      }
    }
    // Past the newest keyframe: briefly extrapolate from the last two, otherwise hold.
    const last = s[s.length - 1];
    const ahead = renderAt - last.recvAt;
    if (s.length >= 2 && ahead <= MAX_EXTRAPOLATE_MS) {
      const prev = s[s.length - 2];
      const span = last.recvAt - prev.recvAt;
      const k = span > 0 ? ahead / span : 0;
      pose.x = last.x + (last.x - prev.x) * k;
      pose.y = last.y + (last.y - prev.y) * k;
      pose.aimAngle = last.aim; // don't spin aim on a guess
    } else {
      pose.x = last.x; pose.y = last.y; pose.aimAngle = last.aim;
    }
    return pose;
  }
}
