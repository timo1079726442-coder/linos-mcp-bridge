/**
 * 模糊块匹配（borrowed idea from DesktopCommanderMCP's "edit_block", independent implementation）。
 *
 * 目的：AI 给出的 `find` 块常常与文件里的缩进/行尾空白/连续空格不完全一致。
 * 精确字符串匹配会因此失败，而整文件重写又费 token 且易冲突。
 *
 * 规则（保守优先）：
 * - 只在**行边界**上匹配，不做任意子串模糊，避免改到不该改的地方；
 * - 比较时把每行折叠为"去掉首尾空白 + 内部连续空白压成一个空格"；
 * - 默认要求**唯一命中**：命中 0 次报 EDIT_NOT_FOUND，命中 ≥2 次报 EDIT_NOT_UNIQUE；
 * - 替换时用原始（未折叠）偏移切分，保留文件其余字节不变。
 */

export interface FuzzyMatch {
  /** 命中的原始文本起止偏移（左闭右开）。 */
  start: number;
  end: number;
  /** 原始文件里命中的文本，用于预览/诊断。 */
  text: string;
  /** 命中起始行号（0 基），便于报错定位。 */
  line: number;
}

interface LineSpan {
  text: string;
  start: number;
  end: number;
}

function splitLines(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      spans.push({ text: text.slice(start, index), start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start <= text.length) {
    spans.push({ text: text.slice(start), start, end: text.length });
  }
  return spans;
}

/** 折叠空白：去首尾、内部连续空白压成单个空格。 */
export function normalizeFuzzyLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** 把 `find` 文本拆成需要比较的行（去掉首尾空行）。 */
function needleLines(needle: string): string[] {
  const lines = splitLines(needle).map((span) => normalizeFuzzyLine(span.text));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 找到所有模糊命中（最多返回 `limit` 个，默认 2；调用方用数量判断唯一性）。
 * `needle` 折叠后为空时返回空数组（不允许空替换目标）。
 */
export function findFuzzyMatches(text: string, needle: string, limit = 2): FuzzyMatch[] {
  const wanted = needleLines(needle);
  if (wanted.length === 0) return [];

  const spans = splitLines(text);
  const normalized = spans.map((span) => normalizeFuzzyLine(span.text));
  const matches: FuzzyMatch[] = [];

  for (let index = 0; index + wanted.length <= spans.length; index += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (normalized[index + offset] !== wanted[offset]) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    const start = spans[index]!.start;
    const end = spans[index + wanted.length - 1]!.end;
    matches.push({ start, end, text: text.slice(start, end), line: index });
    if (matches.length >= limit) break;
  }
  return matches;
}

export interface FuzzyEditResult {
  content: string;
  /** 被替换掉的原始文本（未折叠）。 */
  replaced: string;
  line: number;
}

/**
 * 用 `replace` 替换唯一命中的模糊块。
 *
 * 语义：`find` 是**整行**匹配（行边界对齐）。若 `replace` 没有以换行结尾，而被替换块
 * 以换行结尾，则自动补回该换行——否则下一行会被拼到替换内容后面。
 *
 * 命中数不为 1 时抛错（错误码由调用方映射为对外错误）。
 */
export function applyFuzzyEdit(text: string, find: string, replace: string): FuzzyEditResult {
  const matches = findFuzzyMatches(text, find, 2);
  if (matches.length === 0) throw new Error("EDIT_NOT_FOUND");
  if (matches.length > 1) throw new Error("EDIT_NOT_UNIQUE");
  const match = matches[0]!;
  const endsWithNewline = match.text.endsWith("\n");
  let replacement = replace;
  // 缩进继承：调用方写片段行（无前导空白）时，保留原块的缩进，避免"替换后代码顶格"。
  const matchedIndent = /^[ \t]*/.exec(match.text)?.[0] ?? "";
  if (matchedIndent.length > 0 && replacement.length > 0) {
    const firstLine = replacement.split("\n", 1)[0] ?? "";
    if (firstLine.length > 0 && !/^[ \t]/.test(firstLine)) {
      replacement = `${matchedIndent}${replacement}`;
    }
  }
  if (endsWithNewline && replacement.length > 0 && !replacement.endsWith("\n")) {
    replacement = `${replacement}\n`;
  }
  const content = `${text.slice(0, match.start)}${replacement}${text.slice(match.end)}`;
  return { content, replaced: match.text, line: match.line };
}

/** 生成紧凑的预览（被删块 + 新块），最多 `maxLines` 行，仅用于人工确认。 */
export function previewEdit(match: FuzzyMatch, replace: string, maxLines = 20): string[] {
  const removed = match.text.replace(/\n$/, "").split("\n").map((line) => `- ${line}`);
  const added = replace.replace(/\n$/, "").split("\n").map((line) => `+ ${line}`);
  return [`@@ line ${match.line + 1} @@`, ...removed, ...added].slice(0, maxLines);
}
