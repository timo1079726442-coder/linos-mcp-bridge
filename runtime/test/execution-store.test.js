import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExecutionRecordStore, ExecutionStoreUnavailableError } from "../dist/execution-store.js";

test("ExecutionRecordStore distinguishes an empty directory from an unavailable store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-execution-store-"));
  const empty = path.join(root, "empty");
  const missing = path.join(root, "missing");
  const notDirectory = path.join(root, "not-directory");
  try {
    await mkdir(empty);
    await writeFile(notDirectory, "fixture", "utf8");

    assert.deepEqual(await new ExecutionRecordStore(empty).list(), []);
    await assert.rejects(
      new ExecutionRecordStore(missing).list(),
      (error) => error instanceof ExecutionStoreUnavailableError && error.message === "execution_store_unavailable",
    );
    await assert.rejects(
      new ExecutionRecordStore(notDirectory).list(),
      (error) => error instanceof ExecutionStoreUnavailableError && error.message === "execution_store_unavailable",
    );
    await assert.rejects(
      new ExecutionRecordStore(null).list(),
      (error) => error instanceof ExecutionStoreUnavailableError && error.message === "execution_store_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
