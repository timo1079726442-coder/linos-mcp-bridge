/** 只读校验当前 Profile 的工具调用哈希链。 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const GENESIS = "0".repeat(64);

export interface ToolAuditStatus {
  ok: boolean;
  entries: number;
  brokenAt?: number;
  path: string;
  /** Metadata-only evidence of the latest successful MCP tools/call. */
  latestSuccessfulTool?: string | null;
  latestSuccessfulToolCallAt?: string | null;
}

function digest(prevHash: string, entry: Record<string, unknown>): string {
  return createHash("sha256").update(prevHash).update(JSON.stringify(entry)).digest("hex");
}

export async function readToolAuditStatus(profileDir: string): Promise<ToolAuditStatus> {
  const file = path.join(profileDir, "audit", "tool-calls.jsonl");
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { ok: true, entries: 0, path: file, latestSuccessfulTool: null, latestSuccessfulToolCallAt: null };
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  let prev = GENESIS;
  let latestSuccessfulTool: string | null = null;
  let latestSuccessfulToolCallAt: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: (Record<string, unknown> & { hash?: string }) | null = null;
    try {
      parsed = JSON.parse(lines[index] ?? "") as Record<string, unknown> & { hash?: string };
    } catch {
      return { ok: false, entries: lines.length, brokenAt: index + 1, path: file, latestSuccessfulTool, latestSuccessfulToolCallAt };
    }
    const { hash, ...entry } = parsed;
    if (!hash || entry.prevHash !== prev || digest(prev, entry) !== hash) {
      return { ok: false, entries: lines.length, brokenAt: index + 1, path: file, latestSuccessfulTool, latestSuccessfulToolCallAt };
    }
    prev = hash;
    if (entry.ok === true && typeof entry.at === "string" && typeof entry.tool === "string") {
      latestSuccessfulTool = entry.tool;
      latestSuccessfulToolCallAt = entry.at;
    }
  }
  return { ok: true, entries: lines.length, path: file, latestSuccessfulTool, latestSuccessfulToolCallAt };
}
