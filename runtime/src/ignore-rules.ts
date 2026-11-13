/**
 * 忽略规则（.gitignore 的一个可预测子集）。
 *
 * 目的：`directory_tree` 在真实仓库里会被 `node_modules/`、`dist/`、`*.log` 淹没，
 * 直接截断会丢掉有用结构。这里提供"先过滤再截断"的能力。
 *
 * 支持的语法（其余一律当普通字符，避免误判）：
 * - 空行与 `#` 注释忽略
 * - `!pattern` 反向包含（后匹配优先，与 git 一致）
 * - 结尾 `/` 只匹配目录
 * - 前导 `/` 锚定仓库根；不含 `/` 的模式匹配任意层级的同名项
 * - `*` 不跨 `/`；`**` 跨层级；`?` 单个非 `/` 字符
 *
 * 不支持（明确记录，避免假装完整）：字符类、反斜杠转义、以及双星号在中间层级的复杂嵌套语义。
 */

export interface IgnoreRule {
  pattern: string;
  negate: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把单个 gitignore 风格模式编译成正则。 */
function compilePattern(body: string, anchored: boolean): RegExp {
  let source = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "*") {
      if (body[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(char);
  }
  // 不含 `/` 的模式匹配任意层级；含 `/` 的模式按锚定语义处理。
  return anchored ? new RegExp(`^${source}$`) : new RegExp(`(^|/)${source}$`);
}

/** 解析一组规则文本（可来自多个 .gitignore 片段）。 */
export function parseIgnoreRules(lines: readonly string[]): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1).trim();
      if (!line) continue;
    }
    let directoryOnly = false;
    if (line.endsWith("/")) {
      directoryOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ pattern: raw.trim(), negate, directoryOnly, anchored, regex: compilePattern(line, anchored) });
  }
  return rules;
}

/**
 * 判断相对路径是否应被忽略。
 * `isDirectory` 用于 `dir/` 这类只在目录上生效的规则。
 * 与 git 一致：**后匹配的规则优先**（因此 `!` 可以重新包含）。
 */
export function isIgnored(relativePath: string, isDirectory: boolean, rules: readonly IgnoreRule[]): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return false;
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (rule.regex.test(normalized)) ignored = !rule.negate;
  }
  return ignored;
}
