// Compatibility shim: TypeScript is the source of truth.
//
// The executable Supervisor is built from supervisorMain.ts into dist. This
// source-side shim prevents an obsolete hand-transpiled implementation from
// being launched with directory-order Profile selection or from forcing a
// configured remote Profile back to LOCAL_ONLY.
export * from "./supervisorMain.ts";
