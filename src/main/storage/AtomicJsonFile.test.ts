import { mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicJsonFileError, readAtomicJson, withAtomicJsonFileLock, writeAtomicJson } from "./AtomicJsonFile.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-json-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AtomicJsonFile", () => {
  it("distinguishes missing state from malformed state", async () => {
    const file = path.join(await makeRoot(), "state.json");
    await expect(readAtomicJson(file, 1024)).resolves.toBeUndefined();
    await writeFile(file, "{broken", "utf8");
    await expect(readAtomicJson(file, 1024)).rejects.toMatchObject({ code: "JSON_STORE_INVALID" });
  });

  it("rejects symbolic-link state files", async () => {
    const root = await makeRoot();
    const source = path.join(root, "source.json");
    const link = path.join(root, "state.json");
    await writeFile(source, "{}", "utf8");
    await symlink(source, link, "file");
    await expect(readAtomicJson(link, 1024)).rejects.toBeInstanceOf(AtomicJsonFileError);
  });

  it("serializes concurrent mutations and atomically replaces the document", async () => {
    const file = path.join(await makeRoot(), "nested", "state.json");
    await Promise.all(Array.from({ length: 12 }, (_, index) => withAtomicJsonFileLock(file, async () => {
      const current = await readAtomicJson<{ values: number[] }>(file, 1024) ?? { values: [] };
      current.values.push(index);
      await writeAtomicJson(file, current);
    })));

    await expect(readAtomicJson<{ values: number[] }>(file, 1024)).resolves.toEqual({ values: expect.arrayContaining(Array.from({ length: 12 }, (_, index) => index)) });
    await expect(readFile(file, "utf8")).resolves.toContain("values");
  });
});
