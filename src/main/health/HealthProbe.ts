/**
 * HealthProbe — minimal, capability-aware probe utilities used by the
 * ReadinessEngine. CP1 RECOVERY_SAFETY_GUARD_V2 makes the runtime layer
 * not strictly trusted (capability MAC at /admin/*); probes used here
 * remain at public endpoints and only touch the localhost bridge.
 */

import type { LayerState } from "../../shared/types.js";
import { createConnection } from "node:net";

export interface LocalBridgeSample {
  alive: boolean;
  healthEndpointOk: boolean;
  workspaceIdMatches: boolean | null;
  port: number | null;
  /** TCP listener presence only; it does not establish process ownership. */
  portListening?: boolean | null;
}

export class HealthProbe {
  async probeLocalBridge(port: number, expectedWorkspaceId: string | null): Promise<LocalBridgeSample> {
    if (port <= 0) {
      return { alive: false, healthEndpointOk: false, workspaceIdMatches: null, port, portListening: null };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { alive: true, healthEndpointOk: false, workspaceIdMatches: null, port, portListening: true };
      const body = (await res.json()) as { workspaceId?: string };
      return {
        alive: true,
        healthEndpointOk: true,
        workspaceIdMatches:
            expectedWorkspaceId === null || body.workspaceId === undefined
            ? null
            : body.workspaceId === expectedWorkspaceId,
        port,
        portListening: true,
      };
    } catch {
      return {
        alive: false,
        healthEndpointOk: false,
        workspaceIdMatches: null,
        port,
        portListening: await probeTcpPort(port),
      };
    }
  }

  async probePublic(publicUrl: string | null): Promise<{
    healthStatus: number | null;
    mcpAnonymous: number | null;
    oauthDiscoveryOk: boolean;
  }> {
    if (!publicUrl) {
      return { healthStatus: null, mcpAnonymous: null, oauthDiscoveryOk: false };
    }
    let healthStatus: number | null = null;
    let mcpAnonymous: number | null = null;
    let oauthDiscoveryOk = false;
    try {
      const h = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(5000) });
      healthStatus = h.status;
    } catch {
      // unreachable
    }
    try {
      const m = await fetch(`${publicUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      mcpAnonymous = m.status;
    } catch {
      // unreachable
    }
    try {
      const o = await fetch(
        `${publicUrl}/.well-known/oauth-authorization-server`,
        { signal: AbortSignal.timeout(5000) },
      );
      oauthDiscoveryOk = o.ok;
    } catch {
      // unreachable
    }
    return { healthStatus, mcpAnonymous, oauthDiscoveryOk };
  }

  toLayerStateFromHealth(localOk: boolean, publicOk: boolean): LayerState {
    if (localOk && publicOk) return "PASS";
    if (localOk && !publicOk) return "DEGRADED";
    if (!localOk) return "FAIL";
    return "UNKNOWN";
  }
}

/** Read-only TCP check. A listener is never treated as owned by this Profile. */
export function probeTcpPort(port: number, timeoutMs = 700): Promise<boolean | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? false : null);
    });
  });
}
