import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Windows-safe atomic file write.
 *
 * On Windows, rename() over an existing file fails with EPERM/EBUSY when
 * another handle (a concurrent reader, an in-flight heartbeat save, or an
 * antivirus scanner) has the target open. Without retries this surfaces as
 * intermittent EPERM failures under parallel load. Retry with backoff and
 * fail closed only when the filesystem stays unavailable.
 */
const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export async function renameWithRetry(tmp: string, target: string, attempts = 8): Promise<void> {
  let delayMs = 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      if (!RETRYABLE_CODES.has(code) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 400);
    }
  }
}

export async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    await renameWithRetry(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
