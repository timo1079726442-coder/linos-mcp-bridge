import { ProfileClientRegistry } from "../oauth/ProfileClientRegistry.js";
import { WorkspaceGrantStore } from "../oauth/WorkspaceGrantStore.js";
import { readToolAuditStatus, type ToolAuditStatus } from "../audit/ToolAuditStatus.js";
import type { LayerState, OAuthAuthorizationStatus } from "../../shared/types.js";

export interface ConnectorEvidence {
  state: LayerState;
  activeClientCount: number;
  validWorkspaceGrant: boolean | null;
  oauthState: OAuthAuthorizationStatus["state"];
  observedAt: string;
}

export interface ConversationEvidence {
  state: LayerState;
  latestSuccessfulTool: string | null;
  latestSuccessfulToolCallAt: string | null;
  entries: number;
  chainOk: boolean;
  brokenAt?: number;
}

/**
 * OAuth connector evidence uses the persisted client registry and workspace
 * grant snapshots only. Plaintext tokens are never read here.
 */
export async function readConnectorEvidence(
  stateRoot: string,
  profileId: string,
  workspaceId: string | null,
): Promise<ConnectorEvidence> {
  const observedAt = new Date().toISOString();
  const unavailable = (activeClientCount = 0, validWorkspaceGrant: boolean | null = null): ConnectorEvidence => ({
    state: "UNKNOWN",
    activeClientCount,
    validWorkspaceGrant,
    oauthState: "UNKNOWN",
    observedAt,
  });

  try {
    const registry = await new ProfileClientRegistry(stateRoot, profileId).inspect();
    if (registry.state === "UNAVAILABLE") return unavailable();
    if (registry.state === "NOT_CONFIGURED") {
      return { ...unavailable(), oauthState: "NOT_CONFIGURED" };
    }
    const activeClients = registry.records.filter((client) => client.pinStatus === "active");
    if (activeClients.length === 0) {
      return { ...unavailable(), oauthState: "NOT_CONFIGURED" };
    }
    if (!workspaceId) {
      return {
        state: "DEGRADED",
        activeClientCount: activeClients.length,
        validWorkspaceGrant: null,
        oauthState: "WORKSPACE_REQUIRED",
        observedAt,
      };
    }
    const grantSnapshot = await new WorkspaceGrantStore(stateRoot, profileId).inspect(workspaceId);
    if (grantSnapshot.state !== "PRESENT") {
      return {
        state: grantSnapshot.state === "MISSING" ? "DEGRADED" : "UNKNOWN",
        activeClientCount: activeClients.length,
        validWorkspaceGrant: grantSnapshot.state === "MISSING" ? false : null,
        oauthState: grantSnapshot.state === "MISSING" ? "AUTH_REQUIRED" : "UNKNOWN",
        observedAt,
      };
    }
    const grant = grantSnapshot.grant;
    if (grant.revoked || !activeClients.some((client) => client.clientId === grant.clientId)) {
      return {
        state: "FAIL",
        activeClientCount: activeClients.length,
        validWorkspaceGrant: false,
        oauthState: "REVOKED",
        observedAt,
      };
    }
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return {
        state: "FAIL",
        activeClientCount: activeClients.length,
        validWorkspaceGrant: false,
        oauthState: "EXPIRED",
        observedAt,
      };
    }
    return {
      state: "PASS",
      activeClientCount: activeClients.length,
      validWorkspaceGrant: true,
      oauthState: "AUTHORIZED",
      observedAt,
    };
  } catch {
    return unavailable();
  }
}

/**
 * Conversation evidence uses tool-audit metadata only: timestamps, tool
 * names, and success flags. Paths, commands, file contents, and secrets are
 * never read here.
 */
export async function readConversationEvidence(profileDir: string): Promise<ConversationEvidence> {
  let status: ToolAuditStatus;
  try {
    status = await readToolAuditStatus(profileDir);
  } catch {
    return { state: "UNKNOWN", latestSuccessfulTool: null, latestSuccessfulToolCallAt: null, entries: 0, chainOk: false };
  }
  if (!status.ok) {
    return {
      state: "FAIL",
      latestSuccessfulTool: status.latestSuccessfulTool ?? null,
      latestSuccessfulToolCallAt: status.latestSuccessfulToolCallAt ?? null,
      entries: status.entries,
      chainOk: false,
      brokenAt: status.brokenAt,
    };
  }
  if (status.latestSuccessfulToolCallAt && status.latestSuccessfulTool) {
    return {
      state: "PASS",
      latestSuccessfulTool: status.latestSuccessfulTool,
      latestSuccessfulToolCallAt: status.latestSuccessfulToolCallAt,
      entries: status.entries,
      chainOk: true,
    };
  }
  return {
    state: "UNKNOWN",
    latestSuccessfulTool: null,
    latestSuccessfulToolCallAt: null,
    entries: status.entries,
    chainOk: true,
  };
}

/** Map the richer OAuth status onto the six-layer readiness state. */
export function connectorLayerFromOAuth(oauthState: OAuthAuthorizationStatus["state"]): LayerState {
  switch (oauthState) {
    case "AUTHORIZED":
      return "PASS";
    case "AUTH_REQUIRED":
    case "WORKSPACE_REQUIRED":
      return "DEGRADED";
    case "EXPIRED":
    case "REVOKED":
      return "FAIL";
    case "NOT_CONFIGURED":
    case "UNKNOWN":
    default:
      return "UNKNOWN";
  }
}

/** Map tool-audit conversation evidence onto the six-layer readiness state. */
export function conversationLayerFromAudit(evidence: ConversationEvidence): LayerState {
  return evidence.state;
}
