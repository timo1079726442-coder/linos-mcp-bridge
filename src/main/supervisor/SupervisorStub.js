/**
 * SupervisorStub — CP2 placeholder for the real Supervisor process.
 *
 * Per ADR-V2-003 Option B, Supervisor is a separate per-user background
 * process. CP2 does NOT yet spawn that process; this stub provides the
 * same IPC contract so the UI works end-to-end. CP3 will replace this
 * with the real Supervisor implementation (REAL_RUNTIME_SUPERVISOR_READY).
 *
 * IMPORTANT: This stub MUST NOT touch Legacy Production runtime/tunnel.
 * It only manages profile / workspace / readiness state for THIS V2 build.
 */
import { ProfileStore } from "../profile/ProfileStore.js";
import { DeviceIdentity } from "../profile/DeviceIdentity.js";
import { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import { ReadinessEngine } from "../health/ReadinessEngine.js";
import { HealthProbe } from "../health/HealthProbe.js";
import { TransactionJournalStore } from "../workspace/TransactionJournal.js";
export class SupervisorStub {
    profileStore;
    device;
    workspace;
    readiness = new ReadinessEngine();
    probe = new HealthProbe();
    journal = null;
    /** Active profile (or null). */
    activeProfileId = null;
    /** Last computed readiness snapshot. */
    lastReadiness;
    /** Active connection intent (if any). */
    activeIntent = null;
    constructor(stateRoot) {
        this.device = new DeviceIdentity(stateRoot);
        this.profileStore = new ProfileStore(stateRoot, this.device);
        this.workspace = new WorkspaceManager();
        this.lastReadiness = this.readiness.empty();
    }
    // ===== Profile =====
    async listProfiles() {
        return this.profileStore.list();
    }
    async createProfile(opts) {
        const config = await this.profileStore.create(opts);
        if (!this.activeProfileId)
            this.activeProfileId = config.profileId;
        return toSummary(config);
    }
    async getProfile(profileId) {
        return this.profileStore.readConfig(profileId);
    }
    async setActiveProfile(profileId) {
        await this.profileStore.readConfig(profileId);
        this.activeProfileId = profileId;
    }
    async getActiveProfile() {
        if (!this.activeProfileId)
            return null;
        try {
            return await this.profileStore.readConfig(this.activeProfileId);
        }
        catch {
            return null;
        }
    }
    // ===== Workspace =====
    async validateWorkspace(root) {
        return this.workspace.validate(root);
    }
    async detectWorkspace(root) {
        return this.workspace.detect(root);
    }
    // ===== Workspace Change Transaction (4-phase) =====
    /**
     * PHASE A — PREPARE. Creates the journal and snapshots.
     * Returns the journal for the caller to track.
     */
    async prepareWorkspaceChange(opts) {
        const active = await this.profileStore.readConfig(opts.profileId);
        const newInfo = await this.workspace.validate(opts.newWorkspaceRoot);
        if (!newInfo.exists)
            throw new Error("New workspace path does not exist");
        if (active.currentWorkspace.workspaceId === newInfo.workspaceId) {
            throw new Error("New workspace is identical to current");
        }
        const journalStore = new TransactionJournalStore(ProfileStore.defaultStateRoot(), opts.profileId);
        const previousConfigVersion = sha256(JSON.stringify(active));
        const candidateConfigVersion = sha256(JSON.stringify({ ...active, currentWorkspace: { root: newInfo.root, workspaceId: newInfo.workspaceId } }));
        const journal = await journalStore.createPrepare({
            profileId: opts.profileId,
            oldWorkspaceId: active.currentWorkspace.workspaceId,
            oldWorkspaceRoot: active.currentWorkspace.root,
            newWorkspaceId: newInfo.workspaceId,
            newWorkspaceRoot: newInfo.root,
            previousConfigVersion,
            candidateConfigVersion,
        });
        return { journalPath: journalStore["journalPath"], newWorkspaceId: newInfo.workspaceId };
    }
    // ===== Connection Intent =====
    async createIntent() {
        const active = await this.getActiveProfile();
        if (!active)
            throw new Error("No active profile");
        const deviceId = await this.device.getDeviceId();
        // CP3: replace stub with full intent lifecycle (PENDING -> CLIENT_BOUND -> ...)
        const intent = {
            intentId: `c2c_intent_${Math.random().toString(36).slice(2, 14)}`,
            deviceId,
            profileId: active.profileId,
            runtimeId: active.runtimeId,
            runtimeInstanceId: "stub-runtime-instance",
            workspaceId: active.currentWorkspace.workspaceId ?? "",
            status: "PENDING",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            candidateClientId: null,
            candidateClientName: null,
            candidateRedirectUris: [],
            requestedScopes: [],
        };
        this.activeIntent = intent;
        return intent;
    }
    // ===== Readiness =====
    async getReadiness() {
        const active = await this.getActiveProfile();
        if (!active || !active.currentWorkspace.root) {
            this.lastReadiness = this.readiness.empty();
            return this.lastReadiness;
        }
        // Probe public endpoint only if configured. CP3+ will probe real runtime.
        const port = active.transport.expectedLocalPort;
        const local = await this.probe.probeLocalBridge(port, active.currentWorkspace.workspaceId);
        const publicSample = await this.probe.probePublic(active.transport.publicMcpUrl);
        const repoState = (await this.workspace.validate(active.currentWorkspace.root)).isGitRepo ? "UNKNOWN" : "NOT_APPLICABLE";
        this.lastReadiness = this.readiness.compute({
            runtime: local.healthEndpointOk ? "PASS" : "FAIL",
            transport: publicSample.healthStatus === 200 && publicSample.mcpAnonymous === 401 ? "PASS" : "DEGRADED",
            connector: "UNKNOWN",
            conversation: "UNKNOWN",
            workspace: local.workspaceIdMatches === true ? "PASS" : "UNKNOWN",
            repository: repoState,
        });
        return this.lastReadiness;
    }
    // ===== Diagnostics =====
    async runDiagnostics() {
        const readiness = await this.getReadiness();
        const active = await this.getActiveProfile();
        const appVersion = "2.0.0-dev.0";
        const osVersion = `${process.platform} ${process.arch} ${process.version}`;
        let workspaceInfo = { root: null, workspaceId: null, isGitRepo: false };
        let repository = { isGitRepo: false, branch: null, dirty: null };
        if (active && active.currentWorkspace.root) {
            const v = await this.workspace.validate(active.currentWorkspace.root);
            workspaceInfo = { root: v.root, workspaceId: v.workspaceId, isGitRepo: v.isGitRepo };
            if (v.isGitRepo) {
                repository = { isGitRepo: true, branch: v.branch, dirty: v.dirty };
            }
        }
        return {
            generatedAt: new Date().toISOString(),
            appVersion,
            osVersion,
            profileMetadata: active ? toSummary(active) : null,
            readiness,
            runtime: {
                pid: process.pid,
                port: active?.transport.expectedLocalPort ?? null,
                identity: active
                    ? {
                        deviceId: active.deviceId,
                        profileId: active.profileId,
                        runtimeId: active.runtimeId,
                        workspaceId: active.currentWorkspace.workspaceId ?? "",
                    }
                    : null,
                healthEndpointOk: readiness.layers.runtime === "PASS",
            },
            transport: {
                provider: active?.transport.provider ?? null,
                publicUrl: active?.transport.publicMcpUrl ?? null,
                edgeConnected: readiness.layers.transport === "PASS",
                publicHealthStatus: null,
                publicMcpAnonymous: null,
                oauthDiscoveryOk: false,
            },
            workspace: workspaceInfo,
            repository,
            secretStore: { dpapiOk: true },
            watchdog: { alive: true, lastHeartbeatAt: null },
            supervisor: { alive: true, lastHeartbeatAt: null },
            recentRecoveryActions: [],
            sanitizedLogsTail: [],
        };
    }
}
function toSummary(c) {
    return {
        profileId: c.profileId,
        profileName: c.profileName,
        profileType: c.profileType,
        createdAt: c.createdAt,
        currentWorkspaceRoot: c.currentWorkspace.root,
        currentWorkspaceId: c.currentWorkspace.workspaceId,
        transportProvider: c.transport.provider,
        publicMcpUrl: c.transport.publicMcpUrl,
    };
}
function sha256(s) {
    // Avoid importing node:crypto here; we just need a stable hash for journaling.
    // Use a simple but stable encoding; the real prod path uses a crypto hash.
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, "0");
}
