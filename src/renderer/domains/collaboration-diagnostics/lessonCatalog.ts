import lessonsMarkdown from "../../../../docs/LESSONS_LEARNED.md?raw";

export type LessonEvidenceStatus = "CONFIRMED" | "HIGH_CONFIDENCE" | "CANDIDATE";

export interface LessonRecord {
  id: string;
  title: string;
  provenance: string;
  errorCodes: string[];
  evidenceStatus: LessonEvidenceStatus;
  symptom: string | null;
  mistakenAssumption: string | null;
  documentedRootCause: string | null;
  documentedEvidence: string | null;
  documentedFix: string | null;
  verification: string | null;
  prevention: string | null;
}

function readField(lines: string[], fieldName: string): string | null {
  const firstLine = lines.findIndex((line) => {
    const match = /^\s*-\s*([^:：]+)[：:]\s*(.*)$/.exec(line);
    return match?.[1]?.trim() === fieldName;
  });
  if (firstLine < 0) return null;

  const result: string[] = [];
  const initial = /^\s*-\s*[^:：]+[：:]\s*(.*)$/.exec(lines[firstLine] ?? "");
  if (initial?.[1]?.trim()) result.push(initial[1].trim());
  for (let index = firstLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*-\s*[^:：]+[：:]/.test(line) || /^##\s/.test(line)) break;
    if (line.trim()) result.push(line.trim());
  }
  return result.join(" ").trim() || null;
}

function extractErrorCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const match of text.matchAll(/\bHTTP\s+([45]\d{2})\b/gi)) codes.add("HTTP " + match[1]);
  for (const match of text.matchAll(/\b(?:error|err|exit code|code)\s*[:=_-]?\s*([0-9]{3,8})\b/gi)) codes.add(match[1] ?? "");
  for (const match of text.matchAll(/\b(?:EADDRINUSE|CLOUDFLARED_MISSING|OAUTH_[A-Z0-9_]+|[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g)) codes.add(match[0]);
  codes.delete("");
  return [...codes].sort();
}

function parseLessonDocument(markdown: string): LessonRecord[] {
  const matches = markdown.matchAll(/(?:^|\r?\n)## (L\d{2}): ([^\r\n]+)\r?\n([\s\S]*?)(?=\r?\n## |\s*$)/g);
  const lessons: LessonRecord[] = [];

  for (const match of matches) {
    const id = match[1];
    const title = match[2]?.trim();
    const body = match[3] ?? "";
    if (!id || !title) continue;

    const lines = body.split(/\r?\n/);
    const symptom = readField(lines, "现象");
    const documentedRootCause = readField(lines, "真实根因");
    const documentedEvidence = readField(lines, "真实证据");
    const verification = readField(lines, "验证");
    const errorCodes = extractErrorCodes([title, symptom, documentedRootCause, documentedEvidence, verification].filter(Boolean).join(" "));
    const uncertainty = /可能|或许|疑似|推测|猜测|待确认|未确认|尚未确认|无法确认|不确定|不排除/;
    const unconfirmed = [documentedRootCause, documentedEvidence, verification]
      .some((value) => Boolean(value && uncertainty.test(value)));
    const evidenceStatus: LessonEvidenceStatus = unconfirmed
      ? "CANDIDATE"
      : documentedRootCause && verification
        ? "CONFIRMED"
        : documentedEvidence && verification
          ? "HIGH_CONFIDENCE"
          : "CANDIDATE";

    lessons.push({
      id,
      title,
      provenance: "docs/LESSONS_LEARNED.md · " + id,
      errorCodes,
      evidenceStatus,
      symptom,
      mistakenAssumption: readField(lines, "错误假设"),
      documentedRootCause,
      documentedEvidence,
      documentedFix: readField(lines, "修复"),
      verification,
      prevention: readField(lines, "避免"),
    });
  }

  return lessons;
}

/**
 * This is a read-only, versioned projection of the actual lessons document.
 * It is not an incident database and never records current machine state.
 */
export const lessonCatalog: readonly LessonRecord[] = parseLessonDocument(lessonsMarkdown);

export function searchLessons(query: string): LessonRecord[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...lessonCatalog];
  return lessonCatalog.filter((lesson) => [
    lesson.id,
    lesson.title,
    lesson.provenance,
    lesson.errorCodes.join(" "),
    lesson.evidenceStatus,
    lesson.symptom,
    lesson.mistakenAssumption,
    lesson.documentedRootCause,
    lesson.documentedEvidence,
    lesson.documentedFix,
    lesson.verification,
    lesson.prevention,
  ].some((value) => value?.toLocaleLowerCase().includes(normalized)));
}

export function lessonsById(ids: readonly string[]): LessonRecord[] {
  const requested = new Set(ids);
  return lessonCatalog.filter((lesson) => requested.has(lesson.id));
}
