// Rich WebAudio + fetch doubles for the wave-audio suites. Unlike domShim's inert
// AudioContext stub (which exists so the golden oracle can IGNORE audio), these fakes
// record everything — node graphs, gain schedules, starts/stops, fetch counts — so tests
// can assert on voice budgets, duck curves, loop lifecycles, and loader hygiene.
//
// Import AFTER domShim and BEFORE any src/game module, then call installFakeAudio().

import "./domShim.js";

type ParamCall = { method: string; args: (number | Float32Array)[] };

export class FakeAudioParam {
  value: number;
  calls: ParamCall[] = [];

  constructor(value = 1) {
    this.value = value;
  }

  setValueAtTime(v: number, at: number): void {
    this.calls.push({ method: "setValueAtTime", args: [v, at] });
    this.value = v;
  }

  linearRampToValueAtTime(v: number, at: number): void {
    this.calls.push({ method: "linearRampToValueAtTime", args: [v, at] });
    this.value = v;
  }

  exponentialRampToValueAtTime(v: number, at: number): void {
    this.calls.push({ method: "exponentialRampToValueAtTime", args: [v, at] });
    this.value = v;
  }

  setTargetAtTime(v: number, at: number, tc: number): void {
    this.calls.push({ method: "setTargetAtTime", args: [v, at, tc] });
    this.value = v;
  }

  setValueCurveAtTime(curve: Float32Array, at: number, dur: number): void {
    this.calls.push({ method: "setValueCurveAtTime", args: [curve, at, dur] });
    this.value = curve[curve.length - 1];
  }

  cancelScheduledValues(at: number): void {
    this.calls.push({ method: "cancelScheduledValues", args: [at] });
  }

  targetsSet(): number[] {
    return this.calls.filter((c) => c.method === "setTargetAtTime").map((c) => c.args[0] as number);
  }
}

export class FakeNode {
  kind: string;
  targets: (FakeNode | FakeAudioParam)[] = [];

  constructor(kind: string) {
    this.kind = kind;
  }

  connect<T extends FakeNode | FakeAudioParam>(target: T): T {
    this.targets.push(target);
    return target;
  }

  disconnect(): void {
    this.targets.length = 0;
  }
}

export class FakeGainNode extends FakeNode {
  gain = new FakeAudioParam(1);

  constructor() {
    super("gain");
  }
}

export class FakeBiquadNode extends FakeNode {
  type = "lowpass";
  frequency = new FakeAudioParam(350);
  Q = new FakeAudioParam(1);

  constructor() {
    super("biquad");
  }
}

export class FakeCompressorNode extends FakeNode {
  threshold = new FakeAudioParam(-24);
  ratio = new FakeAudioParam(12);
  attack = new FakeAudioParam(0.003);
  release = new FakeAudioParam(0.25);
  knee = new FakeAudioParam(30);

  constructor() {
    super("compressor");
  }
}

export class FakeSourceNode extends FakeNode {
  onended: (() => void) | null = null;
  startCount = 0;
  isEnded = false;
  stopAt: number | null = null;
  private ctx: FakeAudioContext;

  constructor(kind: string, ctx: FakeAudioContext) {
    super(kind);
    this.ctx = ctx;
  }

  start(_at?: number): void {
    this.startCount++;
  }

  // Scheduled like the real node: onended fires once the context clock passes stopAt
  // (tests drive the clock with ctx.advance), so voice-expiry behavior is observable.
  stop(at?: number): void {
    const t = at ?? this.ctx.currentTime;
    if (this.stopAt === null || t < this.stopAt) this.stopAt = t;
    this.ctx.sweepEnded();
  }

  settle(now: number): void {
    if (this.isEnded || this.stopAt === null || this.stopAt > now) return;
    this.isEnded = true;
    if (this.onended) this.onended();
  }
}

export class FakeOscillatorNode extends FakeSourceNode {
  type = "sine";
  frequency = new FakeAudioParam(440);

  constructor(ctx: FakeAudioContext) {
    super("oscillator", ctx);
  }
}

export class FakeBufferSourceNode extends FakeSourceNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  playbackRate = new FakeAudioParam(1);

  constructor(ctx: FakeAudioContext) {
    super("bufferSource", ctx);
  }
}

export class FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  private channels: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = [];
    for (let i = 0; i < channels; i++) this.channels.push(new Float32Array(length));
  }

  getChannelData(ch: number): Float32Array {
    return this.channels[ch];
  }
}

export class FakeAudioContext {
  state = "suspended";
  currentTime = 0;
  destination = new FakeNode("destination");
  created: FakeNode[] = [];

  createGain(): FakeGainNode {
    const n = new FakeGainNode();
    this.created.push(n);
    return n;
  }

  createOscillator(): FakeOscillatorNode {
    const n = new FakeOscillatorNode(this);
    this.created.push(n);
    return n;
  }

  createBufferSource(): FakeBufferSourceNode {
    const n = new FakeBufferSourceNode(this);
    this.created.push(n);
    return n;
  }

  createBiquadFilter(): FakeBiquadNode {
    const n = new FakeBiquadNode();
    this.created.push(n);
    return n;
  }

  createDynamicsCompressor(): FakeCompressorNode {
    const n = new FakeCompressorNode();
    this.created.push(n);
    return n;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  decodeAudioData(_bytes: ArrayBuffer): Promise<FakeAudioBuffer> {
    return Promise.resolve(new FakeAudioBuffer(1, 4410, 44100));
  }

  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
    this.sweepEnded();
  }

  sweepEnded(): void {
    for (const n of this.created) {
      if (n instanceof FakeSourceNode) n.settle(this.currentTime);
    }
  }

  nodesOf<T extends FakeNode>(kind: string): T[] {
    const out: T[] = [];
    for (const n of this.created) if (n.kind === kind) out.push(n as T);
    return out;
  }
}

const contexts: FakeAudioContext[] = [];

export function lastContext(): FakeAudioContext {
  if (contexts.length === 0) throw new Error("no FakeAudioContext constructed yet");
  return contexts[contexts.length - 1];
}

// Narrow an engine-typed node (DOM GainNode) back to its fake for assertions.
export function asFakeGain(node: object | null): FakeGainNode {
  if (!(node instanceof FakeGainNode)) throw new Error("expected a FakeGainNode");
  return node;
}

// Fetch double: every wave/sample URL fails (404) unless a pattern allows it; every
// request is counted so loader-hygiene tests can prove single-flight behavior.
export const fetchCounts = new Map<string, number>();
let okPatterns: RegExp[] = [];

export function allowFetch(...patterns: RegExp[]): void {
  okPatterns = patterns;
}

export function resetFetchPlan(): void {
  okPatterns = [];
  fetchCounts.clear();
}

export function fetchCountFor(pattern: RegExp): number {
  let n = 0;
  for (const [url, count] of fetchCounts) if (pattern.test(url)) n += count;
  return n;
}

export function totalFetchCount(): number {
  let n = 0;
  for (const count of fetchCounts.values()) n += count;
  return n;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function fakeFetch(url: string): Promise<FakeResponse> {
  fetchCounts.set(url, (fetchCounts.get(url) ?? 0) + 1);
  const isOk = okPatterns.some((p) => p.test(url));
  return Promise.resolve({
    ok: isOk,
    status: isOk ? 200 : 404,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
}

// Node 22 microtask/promise chains inside the loaders settle within one macrotask.
export function flushLoads(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

interface AudioGlobals {
  AudioContext?: typeof FakeAudioContext;
  fetch?: typeof fakeFetch;
  window?: { AudioContext?: typeof FakeAudioContext };
}

export function installFakeAudio(): void {
  class TrackedContext extends FakeAudioContext {
    constructor() {
      super();
      contexts.push(this);
    }
  }
  const g = globalThis as AudioGlobals;
  g.AudioContext = TrackedContext;
  if (g.window) g.window.AudioContext = TrackedContext;
  g.fetch = fakeFetch;
}
