import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path: string, value: object): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  const file = openSync(temporary, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
