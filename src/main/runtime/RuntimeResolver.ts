import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * RuntimeResolver — resolve the V2 Runtime binary path per `runtime.source`.
 *
 * Per ADR-0002 §7:
 *   - Production MUST use PACKAGED_V2 (NOT process.execPath)
 *   - EXTERNAL_DEV / LEGACY_MIGRATION allowed only with explicit opt-in
 *   - Path is required to exist and be executable; missing → throw
 *
 * Resolution strategy:
 *   1. PACKAGED_V2  → app.getAppPath()/resources/runtime/dist/main.js
 *                     (or MCP_BRIDGE_RUNTIME_BUNDLE_DIR env override)
 *   2. EXTERNAL_DEV  → $C2C_RUNTIME_EXTERNAL_DIR/main.js (user-provided)
 *   3. LEGACY_MIGRATION → $C2C_LEGACY_RUNTIME_DIR/c2c.js (legacy dev only)
 *   4. Default (Development build) → repo-local runtime/dist/main.js
 */
export interface ResolvedRuntime {
  binaryPath: string;
  entryPath: string;
  source: "PACKAGED_V2" | "EXTERNAL_DEV" | "LEGACY_MIGRATION" | "DEV_REPO";
}

export interface ResolveOptions {
  profileSource: string;
  workspaceRoot: string;
  appRoot?: string;
}

export class RuntimeResolver {
  /**
   * Resolve the runtime entry path. Returns the first candidate that both:
   *   - ends with `.js`
   *   - actually exists on disk (async fs.access)
   */
  async resolve(opts: ResolveOptions): Promise<ResolvedRuntime> {
    const source = opts.profileSource as "PACKAGED_V2" | "EXTERNAL_DEV" | "LEGACY_MIGRATION" | "DEV_REPO";

    switch (source) {
      case "PACKAGED_V2": {
        const envEntry = process.env.MCP_BRIDGE_RUNTIME_ENTRY?.trim();
        const bundleDir = process.env.MCP_BRIDGE_RUNTIME_BUNDLE_DIR?.trim();
        // 宿主环境变量污染防护：任何从父进程继承的 MCP_BRIDGE_RUNTIME_ENTRY 都可能指向
        // 另一份旧安装（实测过：Harness 的 shell 里带着 D:\LinOS\... 的旧路径，
        // 导致新包拉起 10/17 的旧 runtime，接口缺失且难排查）。
        // 打包运行（有 appRoot）时：优先用包内 runtime；环境变量只有在指向包内目录，
        // 或显式设置 C2C_ALLOW_RUNTIME_OVERRIDE=1 时才被采纳。
        const packagedRoot = opts.appRoot ? path.resolve(opts.appRoot) : null;
        const allowOverride = process.env.C2C_ALLOW_RUNTIME_OVERRIDE === "1";
        const insidePackage = (candidate: string): boolean =>
          !packagedRoot ? true : path.resolve(candidate).toLowerCase().startsWith(packagedRoot.toLowerCase());
        const envEntryUsable = Boolean(envEntry) && (allowOverride || insidePackage(envEntry!));
        const bundleDirUsable = Boolean(bundleDir) && (allowOverride || insidePackage(bundleDir!));

        const bundledCandidates: string[] = [];
        if (bundleDirUsable) {
          bundledCandidates.push(path.join(bundleDir!, "main.js"));
          bundledCandidates.push(path.join(bundleDir!, "dist", "main.js"));
          bundledCandidates.push(path.join(bundleDir!, "src", "main.js"));
        }
        if (opts.appRoot) {
          bundledCandidates.push(path.join(opts.appRoot, "resources", "runtime", "main.js"));
          bundledCandidates.push(path.join(opts.appRoot, "resources", "runtime", "dist", "main.js"));
          // Unpacked layout: resources/app/... (asar disabled) keeps the runtime
          // inside resources/app/runtime.
          bundledCandidates.push(path.join(opts.appRoot, "resources", "app", "runtime", "dist", "main.js"));
          bundledCandidates.push(path.join(opts.appRoot, "resources", "app", "runtime", "main.js"));
          // Keep the legacy nested candidate only for already-installed dev
          // bundles; the current runtime build is runtime/dist/main.js.
          bundledCandidates.push(path.join(opts.appRoot, "runtime", "dist", "main.js"));
          bundledCandidates.push(path.join(opts.appRoot, "runtime", "dist", "src", "main.js"));
          bundledCandidates.push(path.join(opts.appRoot, "runtime", "main.js"));
        }
        // 无 appRoot（开发/测试）时保持旧顺序：环境变量优先，便于本地指向仓库构建。
        const candidates = packagedRoot
          ? [...bundledCandidates, ...(envEntryUsable ? [envEntry!] : [])]
          : [...(envEntry ? [envEntry] : []), ...bundledCandidates];
        const found = await this.firstExistingJs(candidates);
        if (found) return { binaryPath: this.node(), entryPath: found, source: "PACKAGED_V2" };
        throw new Error(
          `RUNTIME_NOT_FOUND: PACKAGED_V2 runtime not found. Tried: ${candidates.join(", ")}. ` +
            (envEntry && !envEntryUsable
              ? `已忽略继承的 MCP_BRIDGE_RUNTIME_ENTRY=${envEntry}（不在安装目录内，可能是宿主环境泄漏；如确需覆盖请设 C2C_ALLOW_RUNTIME_OVERRIDE=1）。`
              : "Set MCP_BRIDGE_RUNTIME_BUNDLE_DIR or MCP_BRIDGE_RUNTIME_ENTRY or run from packaged app."),
        );
      }
      case "EXTERNAL_DEV": {
        const dir = process.env.C2C_RUNTIME_EXTERNAL_DIR;
        if (!dir) {
          throw new Error(
            "EXTERNAL_DEV requires C2C_RUNTIME_EXTERNAL_DIR env var. " +
              "Per OPTION_A_PLUS, EXTERNAL_DEV is opt-in only.",
          );
        }
        const entry = path.join(dir, "main.js");
        if (!(await this.exists(entry))) {
          throw new Error(`RUNTIME_NOT_FOUND: ${entry} not found or not executable`);
        }
        return { binaryPath: this.node(), entryPath: entry, source: "EXTERNAL_DEV" };
      }
      case "LEGACY_MIGRATION": {
        if (process.env.LEGACY_MIGRATION_MODE !== "true") {
          throw new Error(
            "LEGACY_MIGRATION_MODE not enabled. Per ADR-0002 §5, " +
              "LEGACY_MIGRATION requires explicit Founder approval AND RC1_ACCEPTANCE_PASS.",
          );
        }
        const dir = process.env.C2C_LEGACY_RUNTIME_DIR;
        if (!dir) {
          throw new Error("LEGACY_MIGRATION requires C2C_LEGACY_RUNTIME_DIR env var");
        }
        const entry = path.join(dir, "c2c.js");
        if (!(await this.exists(entry))) {
          throw new Error(`RUNTIME_NOT_FOUND: legacy entry ${entry} not found`);
        }
        return { binaryPath: this.node(), entryPath: entry, source: "LEGACY_MIGRATION" };
      }
      default: {
        const entry = path.join(opts.workspaceRoot, "..", "runtime", "dist", "main.js");
        if (!(await this.exists(entry))) {
          throw new Error(
            `RUNTIME_NOT_FOUND (DEV_REPO): ${entry} not found. ` +
              "Run `npm run build` inside runtime/ first.",
          );
        }
        return { binaryPath: this.node(), entryPath: entry, source: "DEV_REPO" };
      }
    }
  }

  private node(): string {
    return process.execPath; // Node interpreter; safe to use here.
  }

  private async exists(p: string): Promise<boolean> {
    if (!p || !p.endsWith(".js")) return false;
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async firstExistingJs(candidates: string[]): Promise<string | null> {
    for (const c of candidates) {
      if (await this.exists(c)) return c;
    }
    return null;
  }

  /** Async validation of resolution result. */
  async validate(resolved: ResolvedRuntime): Promise<void> {
    try {
      await fs.access(resolved.entryPath);
    } catch {
      throw new Error(`RUNTIME_ENTRY_MISSING: ${resolved.entryPath}`);
    }
    try {
      await fs.access(resolved.binaryPath);
    } catch {
      throw new Error(`RUNTIME_NODE_MISSING: ${resolved.binaryPath}`);
    }
  }
}