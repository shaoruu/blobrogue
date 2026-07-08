// Append-only, immutable audit log (JSONL). Every mutating action writes exactly one record
// (actor / action / release / request / pre / post / result / time). Records are only ever
// appended; nothing rewrites or truncates the file. Tokens are referenced by jti, never value.

import type { AuditSink } from "../interfaces.js";
import type { FileSystemPort } from "../ports.js";
import type { AuditRecord } from "../types.js";

function parseAudit(line: string): AuditRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.at !== "string" || typeof o.actor !== "string" || typeof o.action !== "string") return null;
  return obj as AuditRecord;
}

export class FileAuditSink implements AuditSink {
  private readonly file: string;

  constructor(private fs: FileSystemPort, stateDir: string) {
    this.file = `${stateDir}/audit.jsonl`;
  }

  async append(record: AuditRecord): Promise<void> {
    await this.fs.appendFile(this.file, JSON.stringify(record) + "\n", 0o600);
  }

  async list(limit: number): Promise<AuditRecord[]> {
    const raw = await this.fs.readFile(this.file);
    if (raw === null) return [];
    const records: AuditRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      const rec = parseAudit(line);
      if (rec !== null) records.push(rec);
    }
    records.reverse(); // newest first
    return records.slice(0, Math.max(0, limit));
  }
}
