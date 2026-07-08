// Reads the last N lines of a (potentially large) log file by reading only a bounded window from
// the end — so tailing gs logs never loads a multi-megabyte file into memory. Used by the probe
// to back GET /v1/logs.

import { open, stat } from "node:fs/promises";
import type { TailReader } from "./httpProbe.js";

const MAX_WINDOW_BYTES = 512 * 1024;

export class NodeTailReader implements TailReader {
  async tail(path: string, maxLines: number): Promise<string[]> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const info = await stat(path);
      const size = info.size;
      const window = Math.min(size, MAX_WINDOW_BYTES);
      const start = size - window;
      fh = await open(path, "r");
      const buf = Buffer.alloc(window);
      await fh.read(buf, 0, window, start);
      const text = buf.toString("utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      return lines.slice(-maxLines);
    } catch {
      return [];
    } finally {
      if (fh !== null) await fh.close().catch(() => undefined);
    }
  }
}
