// Durable operation records: one atomic JSON file per operation under `${stateDir}/operations`.
// State is written before AND after each deploy step so an interrupted operation (process crash,
// admin reconnect) is recoverable — on boot, findNonTerminal() surfaces anything left mid-flight
// so the service can mark it `interrupted` rather than silently losing it.

import type { OperationStore } from "../interfaces.js";
import type { FileSystemPort } from "../ports.js";
import type { OperationRecord, OperationState } from "../types.js";

const TERMINAL: ReadonlySet<OperationState> = new Set<OperationState>(["done", "failed", "rolled_back", "interrupted"]);

function parseOperation(raw: string): OperationRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.kind !== "string" || typeof o.state !== "string") return null;
  return obj as OperationRecord;
}

export class FileOperationStore implements OperationStore {
  private readonly dir: string;

  constructor(private fs: FileSystemPort, stateDir: string) {
    this.dir = `${stateDir}/operations`;
  }

  private path(id: string): string {
    const safe = /^op_[a-f0-9]{18}$/.test(id) ? id : null;
    if (safe === null) throw new Error("invalid operation id");
    return `${this.dir}/${safe}.json`;
  }

  private async writeRecord(op: OperationRecord): Promise<void> {
    await this.fs.ensureDir(this.dir, 0o700);
    await this.fs.writeFileAtomic(this.path(op.id), JSON.stringify(op, null, 2) + "\n", 0o600);
  }

  async create(op: OperationRecord): Promise<void> {
    await this.writeRecord(op);
  }
  async update(op: OperationRecord): Promise<void> {
    await this.writeRecord(op);
  }

  async get(id: string): Promise<OperationRecord | null> {
    if (!/^op_[a-f0-9]{18}$/.test(id)) return null;
    const raw = await this.fs.readFile(this.path(id));
    return raw === null ? null : parseOperation(raw);
  }

  private async all(): Promise<OperationRecord[]> {
    if (!(await this.fs.exists(this.dir))) return [];
    const entries = await this.fs.listDir(this.dir);
    const out: OperationRecord[] = [];
    for (const e of entries) {
      if (e.isDirectory || !e.name.endsWith(".json")) continue;
      const raw = await this.fs.readFile(`${this.dir}/${e.name}`);
      const op = raw === null ? null : parseOperation(raw);
      if (op !== null) out.push(op);
    }
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return out;
  }

  async list(limit: number): Promise<OperationRecord[]> {
    const all = await this.all();
    return all.slice(0, Math.max(0, limit));
  }

  async findNonTerminal(): Promise<OperationRecord[]> {
    const all = await this.all();
    return all.filter((op) => !TERMINAL.has(op.state));
  }

  async findByIdempotencyKey(key: string): Promise<OperationRecord | null> {
    const all = await this.all();
    return all.find((op) => op.idempotencyKey === key) ?? null;
  }
}
