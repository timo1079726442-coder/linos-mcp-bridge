/** Deterministic CSV reader for bounded MCP previews; no writes or formula execution. */
export interface CsvPreview {
  headers: string[];
  rows: string[][];
  previewRowCount: number;
  truncated: boolean;
  columnCount: number;
}

export function parseCsvPreview(source: string, requestedRows = 10): CsvPreview {
  const maxRows = Math.max(1, Math.min(20, Math.floor(requestedRows) || 10));
  if (source.length > 1_000_000) throw new Error("csv_too_large");
  const input = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const result: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let atCellStart = true;
  let justClosedQuote = false;
  let stoppedEarly = false;
  function appendCell(): void {
    if (row.length >= 80) throw new Error("csv_too_many_columns");
    row.push(cell.slice(0, 512));
    cell = "";
    atCellStart = true;
    justClosedQuote = false;
  }
  function appendRow(): void {
    appendCell();
    result.push(row);
    row = [];
    if (result.length > maxRows + 1) stoppedEarly = true;
  }
  for (let i = 0; i < input.length && !stoppedEarly; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        justClosedQuote = true;
      } else {
        if (cell.length < 512) cell += char;
      }
      continue;
    }
    if (char === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
    } else if (char === '"' || (justClosedQuote && char !== ',' && char !== '\n' && char !== '\r')) {
      throw new Error("csv_invalid_quotes");
    } else if (char === ',') {
      appendCell();
    } else if (char === '\n' || char === '\r') {
      appendRow();
      if (char === '\r' && input[i + 1] === '\n') i++;
    } else {
      if (cell.length < 512) cell += char;
      atCellStart = false;
    }
  }
  if (quoted) throw new Error("csv_unclosed_quote");
  if (!stoppedEarly && (cell.length > 0 || row.length > 0 || !atCellStart)) appendRow();
  const headers = result[0] ?? [];
  if (headers.length === 0) throw new Error("csv_empty");
  const rows = result.slice(1, 1 + maxRows);
  return { headers, rows, previewRowCount: rows.length, truncated: stoppedEarly || result.length > maxRows + 1, columnCount: headers.length };
}
