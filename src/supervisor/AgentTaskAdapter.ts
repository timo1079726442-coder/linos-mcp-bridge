import { AgentTaskService } from "../main/agentTask/AgentTaskService.js";
import { FileAgentTaskRepository } from "../main/agentTask/AgentTaskStore.js";
import type {
  ActiveAgentTaskScope,
  SubmitAgentTaskRequest,
  TrustedAgentTaskScopeResolver,
} from "../main/agentTask/AgentTaskStore.js";

export interface SupervisorAgentTaskAdapterOptions {
  stateRoot: string;
  profileId: string;
  resolveActiveScope: () => Promise<ActiveAgentTaskScope | null>;
}

export interface SupervisorAgentTaskAvailability {
  dispatchEnabled: false;
  trustedBindingAvailable: false;
  executorCatalogAvailable: false;
  reasonCode: "TRUSTED_CATALOG_UNAVAILABLE";
}

const UNAVAILABLE: SupervisorAgentTaskAvailability = Object.freeze({
  dispatchEnabled: false,
  trustedBindingAvailable: false,
  executorCatalogAvailable: false,
  reasonCode: "TRUSTED_CATALOG_UNAVAILABLE",
});

/**
 * Supervisor RPC adapter for the task service. This repository currently has
 * no reviewed Agent/Worktree catalog or trusted executor implementation, so
 * submission resolution is deliberately unavailable. The adapter never starts
 * a process, consumes MCP claims, or accepts caller completion evidence.
 */
export class SupervisorAgentTaskAdapter {
  private readonly service: AgentTaskService;

  constructor(options: SupervisorAgentTaskAdapterOptions) {
    if (!options || typeof options.resolveActiveScope !== "function") {
      throw new Error("TRUSTED_BINDING_UNAVAILABLE");
    }
    const scopeResolver: TrustedAgentTaskScopeResolver = {
      resolveActiveScope: options.resolveActiveScope,
    };
    this.service = new AgentTaskService({
      repository: new FileAgentTaskRepository(options.stateRoot, options.profileId),
      activeScopeResolver: scopeResolver,
      // No local catalog exists to validate the requested agent/worktree pair.
      // Returning null is fail-closed: AgentTaskService creates no task record.
      bindingResolver: { resolveBinding: async () => null },
    });
  }

  availability(): SupervisorAgentTaskAvailability {
    return { ...UNAVAILABLE };
  }

  submit(request: SubmitAgentTaskRequest): ReturnType<AgentTaskService["submit"]> {
    return this.service.submit(request);
  }

  status(taskId: string): ReturnType<AgentTaskService["status"]> {
    return this.service.status(taskId);
  }

  cancel(taskId: string): ReturnType<AgentTaskService["cancel"]> {
    return this.service.cancel(taskId);
  }

  result(taskId: string): ReturnType<AgentTaskService["result"]> {
    return this.service.result(taskId);
  }

  evidence(taskId: string): ReturnType<AgentTaskService["evidence"]> {
    return this.service.evidence(taskId);
  }
}
