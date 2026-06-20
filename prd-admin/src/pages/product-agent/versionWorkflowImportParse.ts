import * as XLSX from 'xlsx';

export type VersionWorkflowImportKind = 'release' | 'initiation';

export type VersionWorkflowImportRow = {
  code?: string;
  tCode?: string;
  planName: string;
  systemName?: string;
  appName?: string;
  versionType?: string;
  projectType?: string;
  customerSource?: string;
  requirementDescription?: string;
  departmentName?: string;
  ownerId?: string;
  teamMemberIds?: string[];
  planUrl?: string;
  firstDraftMeetingAt?: string;
  secondDraftMeetingAt?: string;
  thirdDraftMeetingAt?: string;
  projectAt?: string;
  plannedProjectAt?: string;
  needUiDesign?: boolean;
  developmentStatus?: string;
  remark?: string;
  openBrandScope?: string;
  announcementUrl?: string;
  date?: string;
  legacyData?: Record<string, string>;
  sourceRow: number;
};

const RELEASE_HINTS = ['正式版本号', 'v号', 'v 号', '上线号', '上线公告'];
const INITIATION_HINTS = ['立项号', 't立项号', 't 立项号', '第一稿', '开发状态'];

function cellStr(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function headerScore(row: string[], kind: VersionWorkflowImportKind): number {
  const hints = kind === 'release' ? RELEASE_HINTS : INITIATION_HINTS;
  const normalized = row.map(normalizeHeader);
  if (!normalized.some(Boolean)) return -1;
  let score = 0;
  for (const hint of hints) {
    const key = normalizeHeader(hint);
    if (normalized.some((header) => header && (header.includes(key) || key.includes(header)))) score += 1;
  }
  if (normalized.some((header) => header && (header.includes('方案名称') || header.includes('产品立项方案名称')))) score += 2;
  return score;
}

function findHeaderIndex(matrix: string[][], kind: VersionWorkflowImportKind): number {
  const limit = Math.min(matrix.length, 20);
  let bestIndex = 0;
  let bestScore = 0;
  for (let index = 0; index < limit; index += 1) {
    const score = headerScore(matrix[index] ?? [], kind);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function indexOfHeader(headers: string[], ...names: string[]): number {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => names.some((name) => {
    const key = normalizeHeader(name);
    return header.includes(key) || key.includes(header);
  }));
}

/** 仅匹配表头与 name 完全一致（避免「产品」误命中「产品立项方案名称」）。 */
function indexOfExactHeader(headers: string[], name: string): number {
  const key = normalizeHeader(name);
  return headers.map(normalizeHeader).findIndex((header) => header === key);
}

function parseDateValue(value: unknown): string | undefined {
  const text = cellStr(value);
  if (!text) return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && value > 20000 && value < 100000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const date = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, parsed.S));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  const normalized = text.replace(/\./g, '-').replace(/\//g, '-');
  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return undefined;
}

function mapProjectType(raw?: string): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.includes('非定制') || value.includes('标准')) return 'standard';
  if (value.includes('定制')) return 'custom';
  return undefined;
}

function normalizeCode(value?: string): string | undefined {
  const text = value?.trim();
  if (!text || text === '-') return undefined;
  return text;
}

function mapBool(raw?: string): boolean | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (['是', 'yes', 'true', '1', '需要', 'y'].includes(value)) return true;
  if (['否', 'no', 'false', '0', '不需要', 'n'].includes(value)) return false;
  return undefined;
}

function splitMembers(raw?: string): string[] | undefined {
  if (!raw?.trim()) return undefined;
  return raw.split(/[、,，;；]/).map((item) => item.trim()).filter(Boolean);
}

function mapRows(headers: string[], body: string[][], kind: VersionWorkflowImportKind, headerRowIndex: number): VersionWorkflowImportRow[] {
  const planIndex = indexOfHeader(headers, '产品立项方案名称', '方案名称', '方案');
  const systemIndex = indexOfHeader(headers, '系统');
  const appIndex = indexOfHeader(headers, '应用', '应用/产品', '产品');
  const productIndex = indexOfExactHeader(headers, '产品');
  const projectTypeIndex = indexOfHeader(headers, '项目类别');
  const versionTypeIndex = indexOfHeader(headers, '版本类别', '版本级别');
  const departmentIndex = indexOfHeader(headers, '所属部门', '部门');
  const ownerIndex = indexOfHeader(headers, '产品负责人', '负责人', '申领人');
  const planUrlIndex = indexOfHeader(headers, '方案地址');
  const requirementDescIndex = indexOfHeader(headers, '项目需求描述', '需求描述');
  const customerSourceIndex = indexOfHeader(headers, '客户来源');
  const remarkIndex = indexOfHeader(headers, '备注');
  const developmentIndex = indexOfHeader(headers, '开发状态');
  const uiDesignIndex = indexOfHeader(headers, '是否需要ui设计', '是否需要 ui 设计', 'ui设计');
  const announcementIndex = indexOfHeader(headers, '上线公告地址', '公告地址');
  const openBrandIndex = indexOfHeader(headers, '当前开放品牌', '当前开放范围', '开放范围');
  const teamIndex = indexOfHeader(headers, '项目组成员', '组成员');
  const requirementSourceIndex = indexOfHeader(headers, '需求来源');
  const platformIndex = indexOfHeader(headers, '平台');
  const contractPartyIndex = indexOfHeader(headers, '合同签订方');

  const codeIndex = kind === 'release'
    ? indexOfHeader(headers, '正式版本号', 'v号', 'v 号', 'v上线号', '上线号')
    : indexOfHeader(headers, 't立项号', 't 立项号', '立项号', 't号', '内部版本号');
  const tCodeIndex = kind === 'release'
    ? indexOfHeader(headers, '内部版本号', 't立项号', 't 立项号', '立项号', 't号')
    : -1;
  const dateIndex = kind === 'release'
    ? indexOfHeader(headers, '上线日期', '实际上线时间', '计划上线时间', '上线时间', '日期')
    : indexOfHeader(headers, '立项时间', '立项时间（三稿通过）', '三稿通过');
  const firstDraftIndex = indexOfHeader(headers, '第一稿会议时间', '第一稿');
  const secondDraftIndex = indexOfHeader(headers, '第二稿会议时间', '第二稿');
  const thirdDraftIndex = indexOfHeader(headers, '第三稿会议时间', '第三稿');
  const plannedProjectIndex = indexOfHeader(headers, '计划立项时间');

  const effectivePlanIndex = planIndex >= 0 ? planIndex : codeIndex >= 0 ? -1 : 0;

  const rows: VersionWorkflowImportRow[] = [];
  body.forEach((values, offset) => {
    const planName = (effectivePlanIndex >= 0 ? values[effectivePlanIndex]?.trim() : '') || '';
    const code = codeIndex >= 0 ? normalizeCode(values[codeIndex]) : undefined;
    if (!planName && !code) return;

    const legacyData: Record<string, string> = {};
    const ownerName = ownerIndex >= 0 ? values[ownerIndex]?.trim() : undefined;
    if (ownerName) legacyData['产品负责人'] = ownerName;
    if (requirementSourceIndex >= 0 && values[requirementSourceIndex]?.trim()) {
      legacyData['需求来源'] = values[requirementSourceIndex].trim();
    }
    if (platformIndex >= 0 && values[platformIndex]?.trim()) {
      legacyData['平台'] = values[platformIndex].trim();
    }
    if (contractPartyIndex >= 0 && values[contractPartyIndex]?.trim()) {
      legacyData['合同签订方'] = values[contractPartyIndex].trim();
    }

    const explicitProduct = productIndex >= 0 ? values[productIndex]?.trim() : undefined;
    let systemName = systemIndex >= 0 ? values[systemIndex]?.trim() : undefined;
    let appName = appIndex >= 0 ? values[appIndex]?.trim() : undefined;
    if (explicitProduct) {
      legacyData['产品'] = explicitProduct;
      appName = explicitProduct;
      systemName = undefined;
    } else if (appName && !systemName) {
      legacyData['产品'] = appName;
    } else if (systemName && !appName) {
      legacyData['产品'] = systemName;
    } else if (appName) {
      legacyData['产品'] = appName;
    }

    rows.push({
      code,
      tCode: tCodeIndex >= 0 ? normalizeCode(values[tCodeIndex]) : undefined,
      planName: planName || code || '',
      systemName,
      appName,
      versionType: versionTypeIndex >= 0 ? values[versionTypeIndex]?.trim() : undefined,
      projectType: projectTypeIndex >= 0 ? mapProjectType(values[projectTypeIndex]) : undefined,
      customerSource: customerSourceIndex >= 0 ? values[customerSourceIndex]?.trim() : undefined,
      requirementDescription: requirementDescIndex >= 0 ? values[requirementDescIndex]?.trim() : undefined,
      departmentName: departmentIndex >= 0 ? values[departmentIndex]?.trim() : undefined,
      ownerId: ownerName,
      teamMemberIds: teamIndex >= 0 ? splitMembers(values[teamIndex]) : undefined,
      planUrl: planUrlIndex >= 0 ? values[planUrlIndex]?.trim() : undefined,
      firstDraftMeetingAt: firstDraftIndex >= 0 ? parseDateValue(values[firstDraftIndex]) : undefined,
      secondDraftMeetingAt: secondDraftIndex >= 0 ? parseDateValue(values[secondDraftIndex]) : undefined,
      thirdDraftMeetingAt: thirdDraftIndex >= 0 ? parseDateValue(values[thirdDraftIndex]) : undefined,
      projectAt: dateIndex >= 0 ? parseDateValue(values[dateIndex]) : undefined,
      plannedProjectAt: plannedProjectIndex >= 0 ? parseDateValue(values[plannedProjectIndex]) : undefined,
      needUiDesign: uiDesignIndex >= 0 ? mapBool(values[uiDesignIndex]) : undefined,
      developmentStatus: developmentIndex >= 0 ? values[developmentIndex]?.trim() : undefined,
      remark: remarkIndex >= 0 ? values[remarkIndex]?.trim() : undefined,
      openBrandScope: openBrandIndex >= 0 ? values[openBrandIndex]?.trim() : undefined,
      announcementUrl: announcementIndex >= 0 ? values[announcementIndex]?.trim() : undefined,
      date: dateIndex >= 0 ? parseDateValue(values[dateIndex]) : undefined,
      legacyData: Object.keys(legacyData).length > 0 ? legacyData : undefined,
      sourceRow: headerRowIndex + offset + 2,
    });
  });
  return rows;
}

export function parseVersionWorkflowImportMatrix(matrix: unknown[][], kind: VersionWorkflowImportKind): VersionWorkflowImportRow[] {
  const rows = matrix.map((row) => (row ?? []).map(cellStr));
  if (rows.length < 2) return [];
  const headerRowIndex = findHeaderIndex(rows, kind);
  const headers = rows[headerRowIndex] ?? [];
  const body = rows.slice(headerRowIndex + 1).filter((row) => row.some(Boolean));
  return mapRows(headers, body, kind, headerRowIndex);
}

export function parseVersionWorkflowImportCsv(text: string, kind: VersionWorkflowImportKind): VersionWorkflowImportRow[] {
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
  return parseVersionWorkflowImportMatrix(rows, kind);
}

export function parseVersionWorkflowImportXlsxBuffer(buffer: ArrayBuffer, kind: VersionWorkflowImportKind): VersionWorkflowImportRow[] {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  return parseVersionWorkflowImportMatrix(matrix, kind);
}

export async function parseVersionWorkflowImportFile(file: File, kind: VersionWorkflowImportKind): Promise<VersionWorkflowImportRow[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) return parseVersionWorkflowImportCsv(await file.text(), kind);
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseVersionWorkflowImportXlsxBuffer(await file.arrayBuffer(), kind);
  }
  throw new Error('不支持的文件格式，请上传 CSV 或 Excel（.xlsx / .xls）');
}
