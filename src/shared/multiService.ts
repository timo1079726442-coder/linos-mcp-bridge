export interface ManagedServiceView {
  id: string;
  name: string;
  port: number;
  workspace: string;
  hostname: string | null;
  publicMcpUrl: string | null;
  profileId: string | null;
  status: "RUNNING" | "STOPPED" | "UNKNOWN";
  createdAt: string;
}

export interface ManagedServiceCreateInput {
  name: string;
  workspace: string;
  port: number;
  hostname?: string | null;
}

export interface ManagedServiceCreateResult {
  service: ManagedServiceView;
  pairingCode: string;
  expiresAt: number;
}
