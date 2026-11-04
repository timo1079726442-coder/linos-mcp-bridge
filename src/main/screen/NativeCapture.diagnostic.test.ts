import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
// 这台机器上的 Electron 33（node_modules/electron）在启动时崩溃（STATUS_BREAKPOINT），
// 与断言无关。装好可用的桌面 Electron 后用 C2C_NATIVE_E2E=1 打开这组原生诊断。
const NATIVE_E2E = process.env.C2C_NATIVE_E2E === "1";
type Report={isolated:boolean;productionPortsUntouched:boolean;otherWindowImagesReadOrExported:boolean;
  nativeWindowListed:boolean;nativeFrameNonempty:boolean;
  nativeFrameDimensionsVerified:boolean;frameMatchesFixture:boolean;
  classification:string;ownWindowCapturePage:boolean;enumeratedSourceCount:number|null;
  sourceHandleMatched:boolean;sourceTitleMatched:boolean;sourcePrefixMatched:boolean;
  result:"CONFIRMED"|"OBSERVED_GAP"};
describe.skipIf(!NATIVE_E2E)("Windows native capture diagnostic (no private window pixels exposed)",()=>{
  it("probes a freshly created isolated fixture window and reports CONFIRMED or OBSERVED_GAP",async()=>{
    const desktopRoot=process.cwd();
    const result=await new Promise<{stderr:string;stdout:string;exit:number}>((resolve,reject)=>{
      execFile(process.execPath,[path.join(desktopRoot,"scripts","native-window-capture-e2e.mjs")],
        {cwd:desktopRoot,windowsHide:true,timeout:45_000,maxBuffer:48_000},
        (error,stdout,stderr)=>{
          if(error && !(error as NodeJS.ErrnoException).code)reject(error);
          else resolve({exit:error?1:0,stdout,stderr});
        });
    });
    const marker=result.stdout.split("\n").find(x=>x.startsWith("ISOLATED_NATIVE_CAPTURE_DIAGNOSTIC="));
    expect(result.exit,result.stderr.slice(-2400)).toBe(0);
    expect(marker,result.stderr.slice(-2400)).toBeTruthy();
    const report=JSON.parse(marker!.split("=")[1]!) as Report;
    expect(report).toMatchObject({isolated:true,productionPortsUntouched:true,
      otherWindowImagesReadOrExported:false});
    expect(["CONFIRMED","OBSERVED_GAP"]).toContain(report.result);
    if(report.result==="CONFIRMED") {
      expect(report.nativeWindowListed).toBe(true);
      expect(report.nativeFrameNonempty).toBe(true);
      expect(report.nativeFrameDimensionsVerified).toBe(true);
      expect(report.frameMatchesFixture).toBe(true);
    }
    // Print only bounded metadata and no window title or image bytes.
    process.stdout.write("NATIVE_WINDOW_CAPTURE="+report.result+
      " reason="+report.classification+" ownPage="+report.ownWindowCapturePage+
      " sources="+report.enumeratedSourceCount+
      " handle="+report.sourceHandleMatched+" title="+report.sourceTitleMatched+
      " prefix="+report.sourcePrefixMatched+"\n");
  },55_000);
});