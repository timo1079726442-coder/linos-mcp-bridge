import { describe, it, expect } from "vitest";
import { FILE_TYPE_PRESETS, parseExtensionSelection, toggleExtension,
  validateFileTypeAcl } from "./fileTypePresets.js";

describe("LinOS file-type chooser reusing original Folder ACL", () => {
  it("offers HAR, markdown, code and office presets instead of requiring manual typing", () => {
    const all = FILE_TYPE_PRESETS.flatMap(g => g.extensions);
    for (const ext of [".har", ".md", ".py", ".tsx", ".json", ".xlsx", ".pdf", ".png", ".zip"]) {
      expect(all).toContain(ext);
    }
  });
  it("normalizes and toggles without duplicate permissions", () => {
    expect(parseExtensionSelection(".MD， .md, .HAR")).toEqual([".md", ".har"]);
    expect(toggleExtension(".md, .json", ".md")).toBe(".json");
    expect(toggleExtension(".md", ".har")).toBe(".md, .har");
  });
  it("allows broad writes and any preset, but rejects malformed extension inputs", () => {
    expect(validateFileTypeAcl("READ_WRITE","ALLOW_ALL","")).toBeNull();
    expect(validateFileTypeAcl("READ_WRITE","ALLOW_LIST",".md, .har")).toBeNull();
    expect(validateFileTypeAcl("READ_WRITE","ALLOW_LIST",".xlsx")).toBeNull();
    expect(validateFileTypeAcl("READ_WRITE","ALLOW_LIST","*.md")).toContain("有效扩展名");
    expect(validateFileTypeAcl("READ_ONLY","ALLOW_LIST",".md, .har")).toBeNull();
    expect(validateFileTypeAcl("READ_WRITE","ALLOW_LIST",".md, .py")).toBeNull();
    expect(validateFileTypeAcl("DENY","ALLOW_ALL","")).toBeNull();
  });
});
