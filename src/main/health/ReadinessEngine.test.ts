import { describe, it, expect } from "vitest";
import { ReadinessEngine } from "./ReadinessEngine";

describe("ReadinessEngine", () => {
  it("empty returns GRAY", () => {
    const r = new ReadinessEngine().empty();
    expect(r.overall).toBe("GRAY");
    expect(r.c2cFullReady).toBe(false);
  });

  it("all PASS -> GREEN, fullReady=true", () => {
    const r = new ReadinessEngine().compute({
      runtime: "PASS",
      transport: "PASS",
      connector: "PASS",
      conversation: "PASS",
      workspace: "PASS",
      repository: "NOT_APPLICABLE",
    });
    expect(r.overall).toBe("GREEN");
    expect(r.c2cFullReady).toBe(true);
  });

  it("any FAIL -> RED", () => {
    const r = new ReadinessEngine().compute({
      runtime: "PASS",
      transport: "PASS",
      connector: "PASS",
      conversation: "FAIL",
      workspace: "PASS",
      repository: "NOT_APPLICABLE",
    });
    expect(r.overall).toBe("RED");
  });

  it("DEGRADED layer -> YELLOW", () => {
    const engine = new ReadinessEngine();
    const r = engine.compute({
      runtime: "PASS",
      transport: "DEGRADED",
      connector: "PASS",
      conversation: "PASS",
      workspace: "PASS",
      repository: "NOT_APPLICABLE",
    });
    expect(r.overall).toBe("YELLOW");
    expect(r.lastStateCheckAt).not.toBeNull();
    expect(r.lastFullVerification).toBeNull();
    const full = engine.compute({
      runtime: "PASS",
      transport: "PASS",
      connector: "PASS",
      conversation: "PASS",
      workspace: "PASS",
      repository: "NOT_APPLICABLE",
    });
    expect(full.lastFullVerification).not.toBeNull();
  });

  it("REPO_READY=NOT_APPLICABLE does not break C2C_FULL_READY", () => {
    const r = new ReadinessEngine().compute({
      runtime: "PASS",
      transport: "PASS",
      connector: "PASS",
      conversation: "PASS",
      workspace: "PASS",
      repository: "NOT_APPLICABLE",
    });
    expect(r.c2cFullReady).toBe(true);
  });

  it("Conversation FORBIDDEN yields FAIL without forcing RED on runtime", () => {
    const r = new ReadinessEngine().compute({
      runtime: "PASS",
      transport: "PASS",
      connector: "PASS",
      conversation: "FAIL",
      workspace: "PASS",
      repository: "NOT_APPLICABLE",
    });
    expect(r.layers.runtime).toBe("PASS");
    expect(r.layers.conversation).toBe("FAIL");
    expect(r.overall).toBe("RED");
  });
});
