// Snapshot delta codec (pure, shared by the server publisher and the browser client).
//
// The authoritative per-client snapshot grew into its bandwidth budget (§4): most of the wire
// is entities whose FIELDS are static tick-to-tick (kind/radius/tier/affix never change; only a
// handful of enemies move or take damage each tick). This module turns a COMPLETE snapshot into
// a delta against the client's last acknowledged snapshot — only changed top-level scalars,
// only changed self fields, and per keyed-list only the entities that were added/changed plus
// explicit removal tombstones — and reconstructs the complete snapshot on the far side.
//
// DETERMINISM CONTRACT: reconstructing a delta against the exact baseline it was diffed from
// yields a snapshot whose DECODED STATE (every entity keyed by id, every field value) is
// identical to the source. The delta only ever OMITS unchanged data; it never transforms it.
// (List ORDER is not part of the decoded state — the client keys every entity by id — so
// reconstruction is order-agnostic; gameplay, prediction, and the golden sim replays are
// entirely server-side and untouched by the wire form.)
//
// TOMBSTONES: a removal is tagged with WHY the entity left this client's snapshot — "gone"
// (died / despawned: absent from the authoritative world) vs "left" (still alive in the world
// but outside this client's interest radius). The reconstructed state is identical either way
// (the entity is absent), but the reason stays on the wire so interest-filtering is never
// conflated with death (interest filtering is OFF today — radius 0 — but the distinction is a
// first-class wire concept, ready for when it is re-enabled).

import type { SelfWire, WireEvent } from "./protocol.js";

// A JSON value as it appears on the wire. Explicit (rather than `unknown`) so the generic
// field-diff/merge stays type-checked end to end.
export type WireValue = number | string | boolean | null | WireValue[] | WireObject;
export interface WireObject { [key: string]: WireValue }

// Why an entity left a client's snapshot. NOT conflated: "gone" removes it for good; "left"
// means it is still in the authoritative world, just out of interest range.
export type RemovalReason = "gone" | "left";

// One keyed list's delta: `u` carries added entities (full struct) and changed entities
// (partial: id + only the changed fields); `r` carries removal tombstones [id, reason].
export interface KeyedDelta {
  u?: WireObject[];
  r?: Array<[number | string, RemovalReason]>;
}

// How `self` changed: a full struct (baseline had none), a partial patch, or a flip to null.
export type SelfDelta = { f: SelfWire } | { p: WireObject } | { d: true };

// The keyed entity lists carried on a snapshot, with their short delta tag. All are keyed by
// the stable per-entity `id` field (PlayerWire.id is the player id string; the rest are ints).
export const KEYED_LISTS = [
  { field: "enemies", tag: "en" },
  { field: "players", tag: "pl" },
  { field: "props", tag: "pr" },
  { field: "pickups", tag: "pk" },
  { field: "chests", tag: "ch" },
  { field: "hzds", tag: "hz" },
  { field: "effs", tag: "ef" },
] as const;

// Small lists (or id-less ones like bullets) sent whole when they change — cheap and simpler
// than a keyed diff, and never a dominant cost. `match` is one small object (pvp only) whose
// phase timer rides as an absolute end-tick, so it changes only on transitions/kills/deaths —
// whole-replacing it when it changes stays tiny and never smears across entities.
export const WHOLE_LISTS = ["roster", "wait", "exr", "bullets", "shop", "match"] as const;

// Top-level scalar fields diffed by value. `events`/`evTo`/`sseq` are handled out of band, and
// the keyed/whole lists + `self` have their own channels, so they are excluded here.
const SCALARS = ["tick", "rev", "ackSeq", "full", "over", "selfId", "wid", "seed", "floor", "pcl", "cleared", "tok"] as const;

// The per-connection view of the authoritative world: which entity ids still EXIST (alive) so a
// removal can be tagged "left" (filtered out) vs "gone" (truly despawned).
export interface WorldLiveIds {
  enemies: ReadonlySet<number>;
  players: ReadonlySet<string>;
  props: ReadonlySet<number>;
  pickups: ReadonlySet<number>;
  chests: ReadonlySet<number>;
  hzds: ReadonlySet<number>;
  effs: ReadonlySet<number>;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: WireValue): v is WireObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Structural equality for wire values (arrays/objects/primitives). Used only for the small
// whole-replace lists and array fields, so a stringify-free deep walk is unnecessary overhead;
// JSON compare is simplest and exact for the plain-data wire.
function wireEqual(a: WireValue, b: WireValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Partial of `next` containing only the keys whose value differs from `base`. Nested plain
// objects recurse (so a changed enemy attack sends only the changed attack sub-fields); arrays
// and primitives replace wholesale. Returns null when nothing changed. Assumes base and next
// share the same key set (true for a fixed wire struct) — only `next`'s keys are considered.
export function diffWireObject(base: WireObject, next: WireObject): WireObject | null {
  let out: WireObject | null = null;
  for (const k of Object.keys(next)) {
    const bv = base[k];
    const nv = next[k];
    if (isPlainObject(bv) && isPlainObject(nv)) {
      const sub = diffWireObject(bv, nv);
      if (sub !== null) (out ??= {})[k] = sub;
    } else if (!wireEqual(bv, nv)) {
      (out ??= {})[k] = nv;
    }
  }
  return out;
}

// base with patch applied: nested plain objects merge recursively; arrays/primitives replace.
// Never mutates `base` (the retained baseline). Dangerous keys are dropped defensively.
export function mergeWireObject(base: WireObject, patch: WireObject): WireObject {
  const out: WireObject = { ...base };
  for (const k of Object.keys(patch)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    const bv = out[k];
    const pv = patch[k];
    out[k] = isPlainObject(bv) && isPlainObject(pv) ? mergeWireObject(bv, pv) : pv;
  }
  return out;
}

function asWireObject(o: object): WireObject {
  // The wire structs are plain JSON data; this single localized cast bridges the typed snapshot
  // structs to the generic diff/merge without leaking `unknown` through the module.
  return o as unknown as WireObject;
}

function keyOf(e: WireValue): number | string {
  const id = isPlainObject(e) ? e.id : undefined;
  return typeof id === "number" || typeof id === "string" ? id : -1;
}

function diffKeyedList(baseArr: WireValue[], nextArr: WireValue[], live: ReadonlySet<number | string>): KeyedDelta | null {
  const baseById = new Map<number | string, WireObject>();
  for (const e of baseArr) if (isPlainObject(e)) baseById.set(keyOf(e), e);
  const nextIds = new Set<number | string>();
  const u: WireObject[] = [];
  for (const e of nextArr) {
    if (!isPlainObject(e)) continue;
    const id = keyOf(e);
    nextIds.add(id);
    const b = baseById.get(id);
    if (b === undefined) {
      u.push(e); // new entity: full struct
    } else {
      const patch = diffWireObject(b, e);
      if (patch !== null) { patch.id = id; u.push(patch); } // changed: id + changed fields
    }
  }
  const r: Array<[number | string, RemovalReason]> = [];
  for (const id of baseById.keys()) {
    if (!nextIds.has(id)) r.push([id, live.has(id) ? "left" : "gone"]);
  }
  if (u.length === 0 && r.length === 0) return null;
  const out: KeyedDelta = {};
  if (u.length > 0) out.u = u;
  if (r.length > 0) out.r = r;
  return out;
}

function applyKeyedList(baseArr: WireValue[], delta: KeyedDelta | undefined): WireValue[] {
  if (delta === undefined) return baseArr; // list unchanged
  const removed = new Set<number | string>();
  if (delta.r) for (const [id] of delta.r) removed.add(id);
  const baseIds = new Set<number | string>();
  for (const e of baseArr) if (isPlainObject(e)) baseIds.add(keyOf(e));
  const patches = new Map<number | string, WireObject>();
  const adds: WireObject[] = [];
  if (delta.u) {
    for (const e of delta.u) {
      const id = keyOf(e);
      if (baseIds.has(id)) patches.set(id, e); else adds.push(e);
    }
  }
  const out: WireValue[] = [];
  for (const b of baseArr) {
    if (!isPlainObject(b)) continue;
    const id = keyOf(b);
    if (removed.has(id)) continue;
    const p = patches.get(id);
    out.push(p ? mergeWireObject(b, p) : b);
  }
  for (const e of adds) out.push(e);
  return out;
}

// The wire form of a snapshot delta (the payload of a ServerMsg `snapd`). Declared here so the
// diff/apply own the shape; protocol.ts references it in the ServerMsg union.
export interface SnapshotDelta {
  q: number;              // this frame's per-connection snapshot sequence
  b: number;              // the baseline sequence this delta applies to
  sc: WireObject;         // changed top-level scalars (always carries at least `tick`)
  self?: SelfDelta;       // self change (absent = unchanged)
  en?: KeyedDelta; pl?: KeyedDelta; pr?: KeyedDelta; pk?: KeyedDelta; ch?: KeyedDelta; hz?: KeyedDelta; ef?: KeyedDelta;
  w?: WireObject;         // whole-replace lists that changed (roster/wait/exr/bullets/shop)
  ev: WireEvent[];        // reliable events (fresh every frame — independent of the delta baseline)
  et: number;             // evTo (highest committed event id)
}

// Diff a complete snapshot `next` against the baseline `base` (the last snapshot this client
// acknowledged) into a delta. `world` names the ids still alive so removals get the right
// reason. Events/evTo/sseq are supplied by the caller (they ride every frame verbatim).
export function diffSnapshot(base: WireObject, next: WireObject, sseq: number, world: WorldLiveIds): SnapshotDelta {
  const sc: WireObject = {};
  for (const k of SCALARS) {
    if (!wireEqual(base[k] ?? null, next[k] ?? null)) sc[k] = next[k] ?? null;
  }
  const out: SnapshotDelta = {
    q: sseq,
    b: typeof base.sseq === "number" ? base.sseq : 0,
    sc,
    ev: (next.events as unknown as WireEvent[]) ?? [],
    et: typeof next.evTo === "number" ? next.evTo : 0,
  };

  const baseSelf = base.self;
  const nextSelf = next.self;
  if (!wireEqual(baseSelf ?? null, nextSelf ?? null)) {
    if (nextSelf === null || nextSelf === undefined) out.self = { d: true };
    else if (!isPlainObject(baseSelf)) out.self = { f: nextSelf as unknown as SelfWire };
    else { const p = diffWireObject(baseSelf, nextSelf as WireObject); out.self = { p: p ?? {} }; }
  }

  for (const { field, tag } of KEYED_LISTS) {
    const baseArr = (base[field] as WireValue[]) ?? [];
    const nextArr = (next[field] as WireValue[]) ?? [];
    const live = world[field as keyof WorldLiveIds] as ReadonlySet<number | string>;
    const d = diffKeyedList(baseArr, nextArr, live);
    if (d !== null) out[tag] = d;
  }

  let whole: WireObject | null = null;
  for (const field of WHOLE_LISTS) {
    if (!wireEqual(base[field] ?? null, next[field] ?? null)) (whole ??= {})[field] = next[field] ?? null;
  }
  if (whole !== null) out.w = whole;

  return out;
}

// Reconstruct the complete snapshot object from a baseline and a delta. The result is a raw
// wire object (t:"snap"); the caller runs it through the exhaustive snapshot validator, which
// also canonicalizes it, before applying — so a malformed reconstruction surfaces as a normal
// ProtocolError, never NaN state.
export function applySnapshotDelta(base: WireObject, d: SnapshotDelta): WireObject {
  const out: WireObject = { ...base };
  out.t = "snap";
  out.sseq = d.q;
  for (const k of Object.keys(d.sc)) {
    if (!DANGEROUS_KEYS.has(k)) out[k] = d.sc[k];
  }
  if (d.self !== undefined) {
    if ("d" in d.self && d.self.d === true) out.self = null;
    else if ("f" in d.self) out.self = asWireObject(d.self.f);
    else out.self = mergeWireObject(isPlainObject(base.self) ? base.self : {}, d.self.p);
  }
  for (const { field, tag } of KEYED_LISTS) {
    out[field] = applyKeyedList((base[field] as WireValue[]) ?? [], d[tag]);
  }
  if (d.w !== undefined) {
    for (const k of Object.keys(d.w)) {
      if (!DANGEROUS_KEYS.has(k)) out[k] = d.w[k];
    }
  }
  out.events = d.ev as unknown as WireValue[];
  out.evTo = d.et;
  return out;
}

// Bridge a typed snapshot message to the generic wire object for diffing (server side).
export function snapshotToWire(snap: object): WireObject {
  return asWireObject(snap);
}
