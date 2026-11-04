/** Existing Folder ACL owns the permission; this is UI-only convenience, not an MCP grant. */
export const FILE_TYPE_PRESETS = [
  { id: "text", label: "文本/笔记", extensions: [".md", ".txt", ".rst", ".log"] },
  { id: "code", label: "开发代码", extensions: [".py", ".ts", ".tsx", ".js", ".jsx", ".html", ".css"] },
  { id: "api", label: "API/HAR", extensions: [".har", ".json", ".jsonl", ".yaml", ".yml", ".xml"] },
  { id: "data", label: "数据/报表", extensions: [".csv", ".xlsx", ".xls", ".sql"] },
  { id: "office", label: "办公文档", extensions: [".docx", ".pdf", ".pptx"] },
  { id: "images", label: "图片/压缩包", extensions: [".png", ".jpg", ".jpeg", ".webp", ".svg", ".zip"] },
] as const;

export const READ_ONLY_RECOMMENDED = new Set<string>([
  ".har", ".xlsx", ".xls", ".docx", ".pdf", ".pptx",
  ".png", ".jpg", ".jpeg", ".webp", ".svg", ".zip",
]);

/** A malformed entry must never silently become a broader ACL grant. */
export function parseExtensionSelection(raw: string): string[] {
  const items = raw.split(/[,，\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  const result: string[] = [];
  for (const item of items) {
    if (!/^\.[a-z0-9][a-z0-9._+-]{0,18}$/.test(item)) continue;
    if (!result.includes(item)) result.push(item);
  }
  return result;
}
export function toggleExtension(raw: string, extension: string): string {
  const current = parseExtensionSelection(raw);
  const next = current.includes(extension)
    ? current.filter((item) => item !== extension)
    : [...current, extension];
  return next.join(", ");
}
/** Distinguish invalid manual entries from a valid empty list. */
export function isExactExtensionSelection(raw: string): boolean {
  const pieces = raw.split(/[,，\s]+/).map(x=>x.trim()).filter(Boolean);
  return pieces.length > 0 && pieces.every(x=>/^\.[a-z0-9][a-z0-9._+-]{0,18}$/i.test(x));
}
export function validateFileTypeAcl(access: "READ_ONLY" | "READ_WRITE" | "DENY",
  mode: "ALLOW_LIST" | "ALLOW_ALL", raw: string): string | null {
  if (mode !== "ALLOW_LIST") return null;
  if (!isExactExtensionSelection(raw)) return "请输入有效扩展名，如 .md、.py、.har；不能包含路径或通配符。";
  return null;
}
