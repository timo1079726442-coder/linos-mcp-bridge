import { describe, it, expect } from "vitest";
import { Watchdog } from "./Watchdog.js";

describe("Watchdog", () => {
  it("initial tick with both alive -> NONE", () => {
    const wd = new Watchdog();
    const r = wd.tick(true, true);
    expect(r.action).toBe("NONE");
    expect(r.loopGuard).toBe(false);
  });

  it("supervisor missing -> RESTART_SUPERVISOR", () => {
    const wd = new Watchdog();
    const r = wd.tick(false, true);
    expect(r.action).toBe("RESTART_SUPERVISOR");
    expect(r.loopGuard).toBe(false);
  });

  it("watchdog missing -> RESTART_WATCHDOG", () => {
    const wd = new Watchdog();
    const r = wd.tick(true, false);
    expect(r.action).toBe("RESTART_WATCHDOG");
  });

  it("budget decreases with each restart", () => {
    const wd = new Watchdog();
    wd.tick(false, true);
    wd.tick(false, true);
    const r = wd.tick(false, true);
    expect(r.budget).toBe(0);
  });

  it("after 3 supervisor restarts -> loopGuard=true (CP1-R2 24h budget)", () => {
    const wd = new Watchdog();
    wd.tick(false, true);
    wd.tick(false, true);
    wd.tick(false, true);
    const r = wd.tick(false, true);
    expect(r.loopGuard).toBe(true);
  });

  it("watchdog budget independent of supervisor budget", () => {
    const wd = new Watchdog();
    wd.tick(false, true);
    wd.tick(false, true);
    expect(wd.currentBudget("supervisor").remaining).toBe(1);
    expect(wd.currentBudget("watchdog").remaining).toBe(3);
  });
});