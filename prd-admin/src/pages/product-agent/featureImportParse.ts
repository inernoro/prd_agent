/**
 * 功能目录树 Excel/CSV 导入解析。
 * 列：目录路径、功能名称、等级、功能类型、所属模块、描述、外部ID、关键规则、验收标准
 */
import * as XLSX from 'xlsx';
import type { ImportFeatureTreeRow } from '@/services/real/productAgent';
import { normalizeFeaturePath } from './featureTreeUtils';

export function parseFeatureTreeImportCsv(text: string): ImportFeatureTreeRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  return mapFeatureTreeRows(rows[0], rows.slice(1));
}

export function parseFeatureTreeImportXlsxBuffer(buffer: ArrayBuffer): ImportFeatureTreeRow[] {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (matrix.length < 2) return [];
  const headers = (matrix[0] ?? []).map(cellStr);
  const body = matrix.slice(1).map((row) => (row ?? []).map(cellStr));
  return mapFeatureTreeRows(headers, body);
}

export async function parseFeatureTreeImportFile(file: File): Promise<ImportFeatureTreeRow[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) return parseFeatureTreeImportCsv(await file.text());
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseFeatureTreeImportXlsxBuffer(await file.arrayBuffer());
  }
  throw new Error('不支持的文件格式，请上传 CSV 或 Excel（.xlsx）');
}

function cellStr(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function mapFeatureTreeRows(headers: string[], body: string[][]): ImportFeatureTreeRow[] {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const indexOf = (...names: string[]) =>
    normalized.findIndex((header) => names.some((name) => header.includes(name)));

  const pathIndex = indexOf('目录路径', '路径', 'path');
  const titleIndex = indexOf('功能名称', '名称', 'title', 'name');
  const gradeIndex = indexOf('等级', '分级', 'grade');
  const typeIndex = indexOf('功能类型', '类型', 'featuretype', 'type');
  const moduleIndex = indexOf('所属模块', '模块', 'module');
  const descIndex = indexOf('描述', 'description', 'desc');
  const externalIndex = indexOf('外部id', '外部标识', 'externalid', 'external');
  const rulesIndex = indexOf('关键规则', '规则', 'keyrules');
  const acceptIndex = indexOf('验收标准', '验收', 'acceptance');

  const effectivePathIndex = pathIndex >= 0 ? pathIndex : 0;

  return body
    .map((values) => {
      const rawPath = values[effectivePathIndex]?.trim() ?? '';
      const path = normalizeFeaturePath(rawPath);
      const segments = path ? path.split('/') : [];
      const title = (titleIndex >= 0 ? values[titleIndex]?.trim() : '') || segments[segments.length - 1] || '';
      return {
        path,
        title: title || undefined,
        grade: gradeIndex >= 0 ? values[gradeIndex]?.trim() : undefined,
        featureType: typeIndex >= 0 ? values[typeIndex]?.trim() : undefined,
        moduleName: moduleIndex >= 0 ? values[moduleIndex]?.trim() : undefined,
        description: descIndex >= 0 ? values[descIndex]?.trim() : undefined,
        externalId: externalIndex >= 0 ? values[externalIndex]?.trim() : undefined,
        keyRules: rulesIndex >= 0 ? values[rulesIndex]?.trim() : undefined,
        acceptanceCriteria: acceptIndex >= 0 ? values[acceptIndex]?.trim() : undefined,
      };
    })
    .filter((row) => row.path);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}
