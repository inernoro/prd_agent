/**
 * TAPD 缺陷 Excel/CSV 导入解析。
 * 严重程度列（紧急/高/中/低/无关紧要）→ V2.6 四档；不读取「优先级」列。
 */
import * as XLSX from 'xlsx';
import type { ImportSimpleItemRow } from '@/services/real/productAgent';
import { normalizeTapdToSeverityLevel } from './defectSeverity';

function cellStr(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function headerIndex(headers: string[], ...names: string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  return normalized.findIndex((header) =>
    names.some((name) => header === name.toLowerCase() || header.includes(name.toLowerCase())),
  );
}

/** TAPD 导出 / CSV 行 → 导入行（仅缺陷） */
export function mapDefectImportRows(headers: string[], body: string[][]): ImportSimpleItemRow[] {
  const titleIndex = headerIndex(headers, '标题', 'title');
  const descIndex = headerIndex(headers, '详细描述', '描述', 'description', 'desc');
  /** TAPD 标准导出列名；与「优先级」「缺陷等级」无关 */
  const severityIndex = headerIndex(headers, '严重程度', 'severity');
  const statusIndex = headerIndex(headers, '状态', 'status');
  const idIndex = headerIndex(headers, 'id', '缺陷id', '外部id', 'externalid');
  const effectiveTitleIndex = titleIndex >= 0 ? titleIndex : 0;

  return body
    .map((values) => {
      const rawTapdSeverity = severityIndex >= 0 ? values[severityIndex]?.trim() : undefined;
      const mapped = rawTapdSeverity ? normalizeTapdToSeverityLevel(rawTapdSeverity) : undefined;
      return {
        title: values[effectiveTitleIndex]?.trim() ?? '',
        description: descIndex >= 0 ? values[descIndex]?.trim() : undefined,
        severity: mapped,
        tapdSeverityRaw: rawTapdSeverity,
        status: statusIndex >= 0 ? values[statusIndex]?.trim() : undefined,
        sourceSystem: 'tapd',
        externalId: idIndex >= 0 ? values[idIndex]?.trim() : undefined,
      };
    })
    .filter((row) => row.title);
}

export function parseDefectImportCsv(text: string): ImportSimpleItemRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  return mapDefectImportRows(rows[0], rows.slice(1));
}

export function parseDefectImportXlsxBuffer(buffer: ArrayBuffer): ImportSimpleItemRow[] {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (matrix.length < 2) return [];
  const headers = (matrix[0] ?? []).map(cellStr);
  const body = matrix.slice(1).map((row) => (row ?? []).map(cellStr));
  return mapDefectImportRows(headers, body);
}

export async function parseDefectImportFile(file: File): Promise<ImportSimpleItemRow[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) return parseDefectImportCsv(await file.text());
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseDefectImportXlsxBuffer(await file.arrayBuffer());
  }
  throw new Error('不支持的文件格式，请上传 TAPD 导出的 CSV 或 Excel（.xlsx）');
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
