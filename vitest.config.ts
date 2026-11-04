// Dedicated vitest config — runs from project root to pick up tests across main + renderer + shared.
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      {
        // The test must exercise the canonical TypeScript recovery source,
        // not the checked-in legacy JavaScript artifact beside it.
        find: /^\.\/RecoveryCoordinator\.js(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/main/recovery/RecoveryCoordinator.ts"),
      },
      {
        // Keep the checked-in Legacy JS artifact untouched, but make Vitest
        // exercise the canonical TypeScript implementation explicitly.
        find: /^\.\/ReadinessEngine(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/main/health/ReadinessEngine.ts"),
      },
      {
        // Audit projections must test the canonical TypeScript chain reader,
        // including imports from RecoveryCoordinator and direct unit tests.
        find: /^(?:.*[\\/])?AuditChain\.js(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/main/audit/AuditChain.ts"),
      },
      {
        // Keep central redaction tests on the canonical TypeScript source.
        find: /^(?:.*[\\/])?Redactor\.js(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/main/redaction/Redactor.ts"),
      },
      {
        // The repair request validator is maintained in shared/types.ts; the
        // checked-in shared/types.js is a legacy twin without the new guard.
        find: /^(?:.*[\\/])?shared[\\/]types\.js(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/shared/types.ts"),
      },
      {
        // The runtime bridge derives a dedicated key from the canonical HKDF TypeScript source.
        find: /^(?:.*[\\/])?HKDF\.js(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/main/security/HKDF.ts"),
      },
      {
        // RuntimeSpawner gained ELECTRON_RUN_AS_NODE injection and SupervisorProcess
        // gained exit-callback identity + start idempotence guards. Their checked-in
        // .js artifacts in src/ are stale and would otherwise shadow the .ts source.
        find: /^(?:.*[\\/])?RuntimeSpawner\.js(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/main/process/RuntimeSpawner.ts"),
      },
      {
        find: /^(?:.*[\\/])?SupervisorProcess\.js(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/main/process/SupervisorProcess.ts"),
      },
      {
        // WorkspaceManager gained fail-closed git handling (dirty=null and
        // GIT_COMMAND_FAILED instead of a false-clean tree). Its checked-in
        // .js twin is stale and would otherwise shadow the .ts source, leaving
        // the fix untested.
        find: /^(?:.*[\\/])?WorkspaceManager\.js(?:\?.*)?$/,
        replacement: resolve(__dirname, "src/main/workspace/WorkspaceManager.ts"),
      },
    ],
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 30_000,
  },
});
