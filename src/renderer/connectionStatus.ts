import type { LayerState } from "../shared/types.js";

/** Keep public reachability separate from local Runtime health. */
export function publicProbeLayer(status: number | null, fresh: boolean): LayerState {
  if (!fresh || status === null) return "UNKNOWN";
  if (status >= 200 && status < 400) return "PASS";
  if (status === 530) return "DEGRADED";
  return "FAIL";
}
