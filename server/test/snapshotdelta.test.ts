// Server snapshot-delta suite: drives the REAL WsSnapshotPublisher against a real GameWorld
// with fake sockets, and locks the server half of the delta contract (the reviewer's gate 1):
//   - a connection with NO acknowledged baseline gets a full keyframe (t:"snap");
//   - once it acks, the server sends deltas (t:"snapd") diffed against the EXACT snapshot it
//     acknowledged — a per-connection baseline, never shared/assumed;
//   - two connections at different ack points get deltas based on THEIR OWN baseline;
//   - a client that stops acking (baseline falls too far behind what the server retains) is
//     re-keyframed, and the ack promotion is strictly monotonic;
//   - what the server ships reconstructs, on the client, to the exact authoritative snapshot.
//
// Run: npx tsx test/snapshotdelta.test.ts (in server/).

import { GameWorld } from "../src/world.js";
import { WsSnapshotPublisher } from "../src/snapshotPublisher.js";
import { newConnState, type Conn } from "../src/connection.js";
import { Metrics } from "../src/metrics.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { jsonCodec, validateSnap, type ServerMsg, type SnapMsg } from "../../src/net/protocol.js";
import { applySnapshotDelta, snapshotToWire } from "../../src/net/snapshotDelta.js";
import { devSpawnEnemy } from "../../src/sim/world.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

// A fake socket that captures every frame the publisher sends.
class CaptureSocket {
  bufferedAmount = 0;
  sent: string[] = [];
  send(raw: string): void { this.sent.push(raw); }
  close(): void {}
  last(): ServerMsg { return jsonCodec.decodeServer(this.sent[this.sent.length - 1]); }
}

function makeConn(id: number, pid: string, sock: CaptureSocket): Conn {
  const conn = { id, ws: sock as unknown as Conn["ws"], ip: "127.0.0.1", log: createLogger({ app: "delta-test" }, "error"), ...newConnState(0) } as Conn;
  conn.authed = true;
  conn.playerId = pid;
  conn.worldId = "w-test";
  return conn;
}

function makePublisher(): WsSnapshotPublisher {
  return new WsSnapshotPublisher({ config: loadConfig({}), metrics: new Metrics(), codec: jsonCodec, kick: () => {} });
}

// A mirror of a client's baseline: apply whatever the server sends (keyframe or delta) and hold
// the reconstructed complete snapshot, exactly as WSTransport does.
class ClientMirror {
  baseline: SnapMsg | null = null;
  apply(msg: ServerMsg): void {
    if (msg.t === "snap") { this.baseline = msg; return; }
    if (msg.t === "snapd") {
      if (this.baseline === null || msg.b !== this.baseline.sseq) throw new Error(`gap: delta base ${msg.b} vs baseline ${this.baseline?.sseq}`);
      this.baseline = validateSnap(applySnapshotDelta(snapshotToWire(this.baseline), msg));
    }
  }
}

function baselineAndAckTests(): void {
  section("per-connection baseline: keyframe until acked, then deltas against the acked snapshot");
  const room = new GameWorld("w-test", 0x1234);
  room.addPlayer("p1");
  devSpawnEnemy(room.state, "slime", 700, 700);
  devSpawnEnemy(room.state, "slime", 760, 720);
  const sock = new CaptureSocket();
  const conn = makeConn(1, "p1", sock);
  room.conns.set(1, conn);
  const pub = makePublisher();

  // No ack yet -> the first frame is a complete keyframe.
  pub.publish(room);
  check("first frame (no acked baseline) is a full keyframe (t:snap)", sock.last().t === "snap", `t=${sock.last().t}`);
  // Still no ack -> still a keyframe (a delta can never be sent before a baseline is confirmed).
  pub.publish(room);
  check("still a keyframe while unacked", sock.last().t === "snap");

  // The client applies the latest keyframe and acks it (ack tracks what was applied + retained).
  const mirror = new ClientMirror();
  mirror.apply(sock.last());
  const acked = mirror.baseline!.sseq;
  pub.ackSnapshot(conn, acked);

  // Next frame is a DELTA against EXACTLY the snapshot the client acknowledged.
  room.state.enemies[0].x += 25;
  room.state.tick += 1;
  pub.publish(room);
  const d = sock.last();
  check("after ack, the server sends a delta (t:snapd)", d.t === "snapd", `t=${d.t}`);
  check("the delta is diffed against the EXACT acked baseline sseq", d.t === "snapd" && d.b === acked, d.t === "snapd" ? `b=${d.b} acked=${acked}` : "");

  mirror.apply(d);
  check("client reconstructs the moved enemy from the delta", Math.abs((mirror.baseline!.enemies.find((e) => e.id === room.state.enemies[0].id)!.x) - room.state.enemies[0].x) < 1e-9);
}

function perConnectionBaselineTests(): void {
  section("two connections at different ack points get deltas against their OWN baseline");
  const room = new GameWorld("w-test", 0x2222);
  room.addPlayer("p1");
  room.addPlayer("p2");
  devSpawnEnemy(room.state, "slime", 700, 700);
  const sockA = new CaptureSocket(); const connA = makeConn(1, "p1", sockA); room.conns.set(1, connA);
  const sockB = new CaptureSocket(); const connB = makeConn(2, "p2", sockB); room.conns.set(2, connB);
  const pub = makePublisher();

  pub.publish(room); // both keyframe #1 (sockX.sent[0])
  pub.publish(room); // both keyframe #2 (sockX.sent[1])

  // Model different ack points: A LOST keyframe #2 (applied + acked only #1); B applied both.
  const mA = new ClientMirror(); mA.apply(jsonCodec.decodeServer(sockA.sent[0]));
  const mB = new ClientMirror(); mB.apply(jsonCodec.decodeServer(sockB.sent[0])); mB.apply(jsonCodec.decodeServer(sockB.sent[1]));
  const aSseq = mA.baseline!.sseq;
  const bSseq = mB.baseline!.sseq;
  pub.ackSnapshot(connA, aSseq);
  pub.ackSnapshot(connB, bSseq);

  room.state.enemies[0].x += 10; room.state.tick += 1;
  pub.publish(room);
  const dA = sockA.last(); const dB = sockB.last();
  check("connection A delta is based on A's acked baseline", dA.t === "snapd" && dA.b === aSseq, dA.t === "snapd" ? `b=${dA.b} exp=${aSseq}` : "");
  check("connection B delta is based on B's (different) acked baseline", dB.t === "snapd" && dB.b === bSseq, dB.t === "snapd" ? `b=${dB.b} exp=${bSseq}` : "");
  check("the two baselines are genuinely different (not shared/assumed)", aSseq !== bSseq, `A=${aSseq} B=${bSseq}`);

  // Both mirrors reconstruct identical authoritative enemy state despite different baselines.
  mA.apply(dA); mB.apply(dB);
  const xA = mA.baseline!.enemies[0].x, xB = mB.baseline!.enemies[0].x;
  check("both connections reconstruct identical authoritative enemy state", Math.abs(xA - xB) < 1e-9 && Math.abs(xA - room.state.enemies[0].x) < 1e-9);
}

function gapKeyframeTests(): void {
  section("a client that stops acking is re-keyframed; ack promotion is monotonic");
  const room = new GameWorld("w-test", 0x3333);
  room.addPlayer("p1");
  devSpawnEnemy(room.state, "slime", 700, 700);
  const sock = new CaptureSocket(); const conn = makeConn(1, "p1", sock); room.conns.set(1, conn);
  const pub = makePublisher();

  pub.publish(room);
  const s1 = sock.last();
  const s1Sseq = s1.t === "snap" ? s1.sseq : -1;
  pub.ackSnapshot(conn, s1Sseq); // ack the first keyframe

  // Now publish WITHOUT ever acking again. For a while these are deltas; once the client falls
  // MAX_DELTA_LAG behind, the server re-keyframes so the delta can't grow unboundedly.
  let sawDelta = false;
  let reKeyframedAt = -1;
  for (let i = 0; i < 140; i++) {
    room.state.enemies[0].x += 1; room.state.tick += 1;
    pub.publish(room);
    const m = sock.last();
    if (m.t === "snapd") sawDelta = true;
    if (m.t === "snap" && reKeyframedAt < 0 && sawDelta) reKeyframedAt = i;
  }
  check("a lagging (never-acking) client received deltas first", sawDelta);
  check("a lagging client is eventually re-keyframed (delta lag bounded)", reKeyframedAt >= 0, `reKeyframedAt=${reKeyframedAt}`);

  // Monotonic ack: a stale ack (<= current) never regresses the baseline.
  const before = conn.ackedSnapSseq;
  pub.ackSnapshot(conn, 1);
  check("a stale ack (<= current) is ignored (baseline never regresses)", conn.ackedSnapSseq === before, `acked=${conn.ackedSnapSseq}`);

  // A realistic client (applies keyframes, and a delta only when it matches the held baseline)
  // reconstructs authoritative state across the re-keyframe — the last keyframe is complete.
  const mirror = new ClientMirror();
  for (const raw of sock.sent) {
    const m = jsonCodec.decodeServer(raw);
    if (m.t === "snap") mirror.apply(m);
    else if (m.t === "snapd" && mirror.baseline && m.b === mirror.baseline.sseq) mirror.apply(m);
  }
  check("client reconstructs authoritative state across the re-keyframe", Math.abs(mirror.baseline!.enemies[0].x - room.state.enemies[0].x) < 1e-9);
}

function main(): void {
  baselineAndAckTests();
  perConnectionBaselineTests();
  gapKeyframeTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll server snapshot-delta assertions passed.\n");
}

main();
