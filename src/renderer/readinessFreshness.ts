import type { ReadinessSnapshot } from "../shared/types.js";

export const READINESS_MAX_AGE_MS = 60_000;

export type ReadinessFreshness = "FRESH" | "STALE" | "NO_OBSERVATION" | "INVALID_OBSERVATION";

export interface ReadinessFreshnessResult {
  status: ReadinessFreshness;
  observedAt: string | null;
  ageMs: number | null;
  maxAgeMs: number;
}

/** Treat missing, invalid, or old observations as unverified UI state. */
export function getReadinessFreshness(
  snapshot: ReadinessSnapshot | null,
  nowMs = Date.now(),
  maxAgeMs = READINESS_MAX_AGE_MS,
): ReadinessFreshnessResult {
  const observedAt = snapshot?.lastStateCheckAt ?? null;
  if (!observedAt) return { status: "NO_OBSERVATION", observedAt: null, ageMs: null, maxAgeMs };

  const timestampMs = Date.parse(observedAt);
  if (!Number.isFinite(timestampMs) || timestampMs > nowMs) {
    return { status: "INVALID_OBSERVATION", observedAt, ageMs: null, maxAgeMs };
  }

  const ageMs = nowMs - timestampMs;
  return {
    status: ageMs <= maxAgeMs ? "FRESH" : "STALE",
    observedAt,
    ageMs,
    maxAgeMs,
  };
}

export function formatReadinessFreshness(result: ReadinessFreshnessResult): string {
  if (result.status === "NO_OBSERVATION") return "尚无检查记录";
  if (result.status === "INVALID_OBSERVATION") return "检查时间无效，状态未验证";
  if (result.status === "STALE") return `上次检查已过期（${new Date(result.observedAt!).toLocaleString()}）`;
  return `最近检查：${new Date(result.observedAt!).toLocaleString()}`;
}
