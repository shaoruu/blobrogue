// Trusted-proxy client-IP resolution (P0-4). Behind nginx, req.socket.remoteAddress is ALWAYS
// the loopback proxy, so a naive per-IP cap collapses every real user into one bucket. We instead
// derive the real client IP from X-Forwarded-For — but ONLY when the immediate peer is a
// configured trusted proxy (loopback by default). An untrusted peer's XFF is IGNORED (it can't
// spoof its cap bucket). We take the RIGHTMOST XFF entry that is not itself a trusted proxy: the
// address the trusted proxy observed, which a client cannot forge past the trusted hop.

import type { IncomingMessage } from "node:http";

// Parse an IPv4/IPv6 address + optional CIDR prefix into a comparable form. Returns null on junk.
interface Cidr { bytes: number[]; bits: number }

function ipToBytes(ip: string): number[] | null {
  const s = ip.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/^::ffff:/i, ""); // strip v6 brackets + v4-mapped prefix
  if (s.includes(":")) {
    // IPv6 (expand :: once). Best-effort; enough for loopback/link-local proxy checks.
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
    if (groups.length !== 8) return null;
    const bytes: number[] = [];
    for (const g of groups) {
      const v = parseInt(g || "0", 16);
      if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
      bytes.push((v >> 8) & 0xff, v & 0xff);
    }
    return bytes;
  }
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    bytes.push(v);
  }
  return bytes;
}

export function parseCidr(spec: string): Cidr | null {
  const [ip, prefix] = spec.split("/");
  const bytes = ipToBytes(ip);
  if (!bytes) return null;
  const bits = prefix === undefined ? bytes.length * 8 : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > bytes.length * 8) return null;
  return { bytes, bits };
}

export function parseCidrList(specs: string[]): Cidr[] {
  const out: Cidr[] = [];
  for (const s of specs) { const c = parseCidr(s); if (c) out.push(c); }
  return out;
}

function inCidr(ip: string, cidr: Cidr): boolean {
  const bytes = ipToBytes(ip);
  if (!bytes || bytes.length !== cidr.bytes.length) return false; // family mismatch => not in range
  let bits = cidr.bits;
  for (let i = 0; i < bytes.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((bytes[i] & mask) !== (cidr.bytes[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

export function isTrustedProxy(ip: string, trusted: Cidr[]): boolean {
  for (const c of trusted) if (inCidr(ip, c)) return true;
  return false;
}

// Resolve the rate-limiting client IP for a connection.
// - If the immediate peer is NOT a trusted proxy, use the peer address (direct connection; XFF is
//   attacker-controlled and ignored).
// - If it IS a trusted proxy, walk X-Forwarded-For from the right, skipping trusted-proxy hops,
//   and return the first non-trusted address (the real client as the trusted edge saw it).
export function clientIpFrom(req: IncomingMessage, trusted: Cidr[]): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!isTrustedProxy(peer, trusted)) return peer;
  const xff = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(xff) ? xff.join(",") : xff ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(chain[i], trusted)) return chain[i];
  }
  // Whole chain is trusted proxies (or empty) — fall back to the peer.
  return peer;
}
