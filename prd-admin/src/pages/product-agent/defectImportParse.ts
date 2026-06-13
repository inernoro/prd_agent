/**
 * TAPD 缺陷 Excel/CSV 导入解析。
 * 唯一等级映射：TAPD「优先级」→ 系统「严重程度」（V2.6 四档）；无值留空，不写入处理优先级 p0–p3。
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
  /** TAPD 历史导出：「优先级」列语义即严重程度，不读「严重程度」列 */
  const priorityIndex = headerIndex(headers, '优先级', 'priority');
  const statusIndex = headerIndex(headers, '状态', 'status');
  const assigneeIndex = headerIndex(headers, '处理人', '当前处理人', 'assignee', 'handler');
  const reporterIndex = headerIndex(headers, '创建人', '上报人', 'reporter', '提交人');
  const idIndex = headerIndex(headers, 'id', '缺陷id', '外部id', 'externalid');
  const effectiveTitleIndex = titleIndex >= 0 ? titleIndex : 0;

  return body
    .map((values) => {
      const rawTapdPriority = priorityIndex >= 0 ? values[priorityIndex]?.trim() : undefined;
      const severity = rawTapdPriority ? normalizeTapdToSeverityLevel(rawTapdPriority) : undefined;
      const handlerRaw = assigneeIndex >= 0 ? values[assigneeIndex]?.trim() : undefined;
      const reporterRaw = reporterIndex >= 0 ? values[reporterIndex]?.trim() : undefined;
      const splitPeople = (raw?: string) => (raw ?? '').split(/[;；,，]/).map((n) => n.trim()).filter(Boolean);
      return {
        title: values[effectiveTitleIndex]?.trim() ?? '',
        description: descIndex >= 0 ? values[descIndex]?.trim() : undefined,
        severity,
        tapdSeverityRaw: rawTapdPriority || undefined,
        status: statusIndex >= 0 ? values[statusIndex]?.trim() : undefined,
        sourceSystem: 'tapd',
        externalId: idIndex >= 0 ? values[idIndex]?.trim() : undefined,
        handlerNames: handlerRaw ? splitPeople(handlerRaw) : undefined,
        reporterNames: reporterRaw ? splitPeople(reporterRaw) : undefined,
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
  if (lower.endsWith('.rtf')) {
    const { parseDefectRtfFile } = await import('./defectRtfImport');
    return parseDefectRtfFile(file);
  }
  if (lower.endsWith('.csv')) return parseDefectImportCsv(await file.text());
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseDefectImportXlsxBuffer(await file.arrayBuffer());
  }
  throw new Error('不支持的文件格式，请上传 TAPD 导出的 CSV、Excel（.xlsx）或 RTF');
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
