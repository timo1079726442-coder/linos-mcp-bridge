import {describe,it,expect} from "vitest";
import path from "node:path";
import {desktopStateRoot} from "./PortableMode.js";
describe("installer-free portable per-device configuration",()=>{
  it("always isolates portable state from inherited Legacy location",()=>{
    const root=desktopStateRoot({portable:true,localAppData:"C:\\Users\\owner\\AppData\\Local",
      homeDir:"C:\\Users\\owner",override:"C:\workspace\\company-sensitive-state"});
    expect(root).toBe(path.join("C:\\Users\\owner\\AppData\\Local","linos-mcp-portable"));
    expect(root).not.toContain("company-sensitive-state");
  });
  it("keeps other device state independent",()=>{
    const one=desktopStateRoot({portable:true,localAppData:"C:\\Users\\A\\AppData\\Local",homeDir:"C:\\Users\\A"});
    const two=desktopStateRoot({portable:true,localAppData:"C:\\Users\\B\\AppData\\Local",homeDir:"C:\\Users\\B"});
    expect(one).not.toBe(two);
    expect(one).not.toContain("C:\workspace");
  });
  it("legacy dev state root continues to work for isolated acceptance",()=>{
    expect(desktopStateRoot({portable:false,localAppData:"C:\\Local",homeDir:"C:\\Users\\A",
      override:"D:\\test-acceptance"})).toBe(path.resolve("D:\\test-acceptance"));
  });
});