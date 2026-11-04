import type { ReadinessSnapshot } from "../shared/types.js";

/** Read through a short Runtime restart race without changing any state. */
export async function readStableReadiness(
  read: () => Promise<ReadinessSnapshot>,
  attempts = 8,
): Promise<ReadinessSnapshot> {
  let latest: ReadinessSnapshot | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      latest = await read();
      if (latest.layers.runtime === "PASS") return latest;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 >= attempts) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (latest) return latest;
  throw lastError instanceof Error ? lastError : new Error("readiness_unavailable");
}
