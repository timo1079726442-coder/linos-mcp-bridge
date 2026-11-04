import * as path from "node:path";
import type { ProfileConfig } from "../../shared/types.js";
import { enforceIsolatedDefaults } from "../profile/ProfileStore.js";
import { CloudflareNamedProvider } from "./CloudflareNamedProvider.js";
import { LocalOnlyTransport } from "./LocalOnlyTransport.js";
import type { TransportProvider } from "./TransportProvider.js";

/**
 * Creates the transport selected by the persisted Profile.
 *
 * LOCAL_ONLY remains the safe default. A remote provider is accepted only
 * when the Profile contains a complete, explicit V2 identity. This prevents
 * Supervisor restart from silently downgrading a configured remote Profile or
 * guessing Legacy credentials from the user's default cloudflared directory.
 */
export class TransportFactory {
  static create(profile: ProfileConfig, stateRoot: string): TransportProvider {
    enforceIsolatedDefaults(profile);
    const provider = (profile.transport.provider ?? "LOCAL_ONLY").toUpperCase();
    if (provider === "LOCAL_ONLY") return new LocalOnlyTransport();
    if (provider !== "CLOUDFLARE_NAMED" && provider !== "CLOUDFLARE-NAMED") {
      throw new Error(`V2_TRANSPORT_PROVIDER_UNSUPPORTED:${profile.transport.provider ?? "null"}`);
    }
    const hostname = profile.transport.hostname?.trim().toLowerCase();
    const tunnelName = profile.transport.tunnelName?.trim();
    const tunnelId = profile.transport.tunnelId?.trim();
    const publicMcpUrl = profile.transport.publicMcpUrl?.trim();
    const credentialPath = profile.transport.credentialPath?.trim();
    if (!hostname || !tunnelName || !tunnelId || !publicMcpUrl || !credentialPath) {
      throw new Error("V2_REMOTE_TRANSPORT_PROFILE_INCOMPLETE");
    }
    const expectedUrl = `https://${hostname}/mcp`;
    if (publicMcpUrl.toLowerCase() !== expectedUrl) throw new Error("V2_REMOTE_TRANSPORT_PUBLIC_URL_MISMATCH");
    const profileTransportDir = path.resolve(stateRoot, "profiles", profile.profileId, "transport");
    const credentialResolved = path.resolve(credentialPath);
    if (!isDescendantOrSelf(profileTransportDir, credentialResolved)) {
      throw new Error("V2_REMOTE_TRANSPORT_CREDENTIAL_OUTSIDE_PROFILE");
    }
    const idFilePart = tunnelId.toLowerCase();
    return new CloudflareNamedProvider({
      provider: "cloudflare-named",
      hostname,
      zone: profile.transport.zone ?? "",
      tunnelName,
      tunnelId,
      binaryPath: profile.transport.binaryPath ?? null,
      credentialPath: credentialResolved,
      configPath: path.join(profileTransportDir, `cloudflared-${idFilePart}.yml`),
      ownershipPath: path.join(profileTransportDir, "process-ownership.json"),
      expectedLocalPort: profile.transport.expectedLocalPort,
    });
  }
}

function isDescendantOrSelf(root: string, target: string): boolean {
  const normalizedRoot = withSeparator(normalize(root));
  const normalizedTarget = normalize(target);
  return normalizedTarget === normalize(root) || normalizedTarget.startsWith(normalizedRoot);
}

function withSeparator(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalize(value: string): string {
  return path.normalize(value).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}
