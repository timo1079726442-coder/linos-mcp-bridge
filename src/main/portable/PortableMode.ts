import path from "node:path";

export interface StateRootOptions {
  portable: boolean;
  localAppData?: string;
  homeDir: string;
  override?: string;
}
/** No installed-app state, no machine-specific paths baked into an artifact. */
export function desktopStateRoot(options:StateRootOptions):string {
  const local=options.localAppData?.trim() ||
    path.join(options.homeDir,"AppData","Local");
  // Do not honor inherited Legacy state-root overrides in packaged portable mode.
  if(options.portable) return path.join(local,"linos-mcp-portable");
  if(options.override?.trim()) return path.resolve(options.override.trim());
  return path.join(local,"linos-c2c-control-center");
}
