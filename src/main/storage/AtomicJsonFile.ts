import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const lockTails = new Map<string, Promise<void>>();

export class AtomicJsonFileError extends Error {
  constructor(readonly code: "JSON_STORE_TOO_LARGE" | "JSON_STORE_INVALID" | "JSON_STORE_WRITE_FAILED") {
    super(code);
    this.name = "AtomicJsonFileError";
  }
}

/** Serialize mutations from multiple store instances in this trusted process. */
export async function withAtomicJsonFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  lockTails.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

/** Missing is distinct from malformed or unreadable state. */
export async function readAtomicJson<T>(filePath: string, maxBytes: number): Promise<T | undefined> {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new AtomicJsonFileError("JSON_STORE_INVALID");
  if (stats.size > maxBytes) throw new AtomicJsonFileError("JSON_STORE_TOO_LARGE");

  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AtomicJsonFileError("JSON_STORE_INVALID");
  }
}

/** Write-then-rename with a unique same-directory temporary file. */
export async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true });

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } catch {
    try { await handle?.close(); } catch { /* best effort close */ }
    try { await fs.unlink(temporaryPath); } catch { /* absent after rename or failed before create */ }
    throw new AtomicJsonFileError("JSON_STORE_WRITE_FAILED");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
