/**
 * 产品批量导入 — CSV / Excel 解析（列：产品名称、产品类型、产品描述、产品标识）。
 */
import type { ImportProductRow } from '@/services/real/productAgent';

export function parseProductImportCsv(text: string): ImportProductRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  return mapProductImportRows(rows[0], rows.slice(1));
}

export async function parseProductImportFile(file: File): Promise<ImportProductRow[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) {
    return parseProductImportCsv(await file.text());
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' }) as string[][];
    if (matrix.length < 2) return [];
    return mapProductImportRows(matrix[0], matrix.slice(1));
  }
  return [];
}

function mapProductImportRows(headers: string[], body: string[][]): ImportProductRow[] {
  const normalized = headers.map((value) => value.trim().toLowerCase());
  const indexOf = (...names: string[]) =>
    normalized.findIndex((header) => names.some((name) => header.includes(name)));

  const nameIndex = indexOf('产品名称', '名称', '应用', 'name');
  const gradeIndex = indexOf('产品类型', '类型', 'grade', 'category');
  const descriptionIndex = indexOf('产品描述', '描述', 'description', 'desc');
  const codeIndex = indexOf('产品标识', '标识', '短码', 'code');

  const effectiveNameIndex = nameIndex >= 0 ? nameIndex : 0;

  return body
    .map((values) => ({
      name: values[effectiveNameIndex]?.trim() ?? '',
      grade: gradeIndex >= 0 ? values[gradeIndex]?.trim() : undefined,
      description: descriptionIndex >= 0 ? values[descriptionIndex]?.trim() : undefined,
      code: codeIndex >= 0 ? values[codeIndex]?.trim() : undefined,
    }))
    .filter((row) => row.name);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
