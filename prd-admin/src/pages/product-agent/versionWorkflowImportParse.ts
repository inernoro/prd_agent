import * as XLSX from 'xlsx';

export type VersionWorkflowImportKind = 'release' | 'initiation';
export const TEMPORARY_OPTIMIZATION_LABEL = '临时优化需求';

export type VersionWorkflowImportRow = {
  code?: string;
  tCode?: string;
  planName: string;
  systemName?: string;
  appName?: string;
  versionType?: string;
  projectType?: string;
  customerSource?: string;
  demandSource?: string;
  requirementDescription?: string;
  departmentName?: string;
  ownerId?: string;
  ownerName?: string;
  teamMemberIds?: string[];
  projectMemberNames?: string[];
  planUrl?: string;
  firstDraftMeetingAt?: string;
  secondDraftMeetingAt?: string;
  thirdDraftMeetingAt?: string;
  projectAt?: string;
  plannedProjectAt?: string;
  needUiDesign?: boolean;
  isAiPoc?: boolean;
  developmentStatus?: string;
  remark?: string;
  openBrandScope?: string;
  isGlobalOpen?: boolean;
  contractParty?: string;
  plannedTrainingMinutes?: number;
  announcementUrl?: string;
  date?: string;
  legacyData?: Record<string, string>;
  sourceRow: number;
};

function cellStr(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/\((url|分钟)\)$/, '');
}

function resolveColumns(headers: string[], kind: VersionWorkflowImportKind) {
  const normalized = headers.map(normalizeHeader);
  const find = (...aliases: string[]) => {
    for (const alias of aliases) {
      const index = normalized.indexOf(normalizeHeader(alias));
      if (index >= 0) return index;
    }
    return -1;
  };
  const release = kind === 'release';
  const internalCodes = ['内部版本号', 't立项号', '立项号', 't号', 't版本号'];
  return {
    planIndex: find('产品立项方案名称', '产品方案名称', '方案名称', '立项方案名称', '上线项目', '方案'),
    systemIndex: find('系统', '系统名称'),
    appIndex: find('应用', '应用名称', '所属应用', '应用/产品', '产品名称', '产品'),
    productIndex: find('产品'),
    projectTypeIndex: find('项目类别', '项目类型'),
    versionTypeIndex: find('版本类别', '版本级别', '版本类型'),
    departmentIndex: find('所属部门', '部门'),
    ownerIndex: find('产品负责人', '产品责任人', '负责人', '申领人'),
    planUrlIndex: find('方案地址', '方案链接', '产品方案地址'),
    requirementDescIndex: find('项目需求描述', '需求描述'),
    customerSourceIndex: find('客户来源'),
    remarkIndex: find('备注'),
    developmentIndex: find('开发状态'),
    uiDesignIndex: find('是否需要ui设计', '是否需要ui', 'ui设计'),
    aiPocIndex: find('是否属于ai poc项目', '是否ai poc', 'ai poc'),
    announcementIndex: find('上线公告地址', '公告地址', '上线公告链接', '公告链接'),
    globalOpenIndex: find('是否全域开放', '全域开放'),
    openBrandIndex: find('当前开放品牌', '当前开放范围', '开放范围'),
    teamIndex: find('项目组成员', '组成员'),
    requirementSourceIndex: find('需求来源'),
    platformIndex: find('平台'),
    contractPartyIndex: find('合同签订方'),
    trainingMinutesIndex: release ? find('预计培训时长', '培训时长', '预计培训时间') : -1,
    codeIndex: release ? find('正式版本号', 'v号', 'v上线号', '上线号', 'v版本号') : find(...internalCodes),
    tCodeIndex: release ? find(...internalCodes) : -1,
    dateIndex: release
      ? find('上线日期', '实际上线时间', '上线时间', '计划上线时间', '日期')
      : find('立项时间', '立项时间（三稿通过）', '三稿通过'),
    firstDraftIndex: find('第一稿会议时间', '第一稿'),
    secondDraftIndex: find('第二稿会议时间', '第二稿'),
    thirdDraftIndex: find('第三稿会议时间', '第三稿'),
    plannedProjectIndex: find('计划立项时间'),
  };
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

function normalizeInternalCode(value?: string): string | undefined {
  const text = value?.trim();
  return !text || /^-+$/.test(text) ? undefined : text;
}

/** 只推断无表头且非空值全部为完整T号的唯一列，不能把普通空表头列当成业务字段。 */
function inferInternalCodeColumn(headers: string[], body: string[][]): number {
  const candidates = headers.flatMap((header, index) => {
    if (header.trim()) return [];
    const values = body.map((row) => normalizeInternalCode(row[index])).filter((value): value is string => Boolean(value));
    return values.length > 0 && values.every((value) => /^T\d+\.\d+\.\d+$/i.test(value)) ? [index] : [];
  });
  return candidates.length === 1 ? candidates[0] : -1;
}

function internalCodeFromPlanName(planName: string): string | undefined {
  const codes = [...new Set([...planName.matchAll(/(?<![A-Za-z0-9])T\d+\.\d+\.\d+(?![\d.])/gi)].map((match) => match[0].toUpperCase()))];
  return codes.length === 1 ? codes[0] : undefined;
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

function parseTrainingMinutes(raw?: string): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const match = text.match(/^(\d+)\s*(?:分钟)?$/);
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : undefined;
}

function mapRows(headers: string[], body: string[][], kind: VersionWorkflowImportKind, headerRowIndex: number): VersionWorkflowImportRow[] {
  const {
    planIndex, systemIndex, appIndex, productIndex, projectTypeIndex, versionTypeIndex,
    departmentIndex, ownerIndex, planUrlIndex, requirementDescIndex, customerSourceIndex, remarkIndex,
    developmentIndex, uiDesignIndex, aiPocIndex, announcementIndex, globalOpenIndex, openBrandIndex,
    teamIndex, requirementSourceIndex, platformIndex, contractPartyIndex, trainingMinutesIndex,
    codeIndex: headerCodeIndex, tCodeIndex, dateIndex, firstDraftIndex, secondDraftIndex, thirdDraftIndex,
    plannedProjectIndex,
  } = resolveColumns(headers, kind);
  const codeIndex = kind === 'initiation' && headerCodeIndex < 0 ? inferInternalCodeColumn(headers, body) : headerCodeIndex;

  const rows: VersionWorkflowImportRow[] = [];
  body.forEach((values, offset) => {
    const trainingText = trainingMinutesIndex >= 0 ? values[trainingMinutesIndex]?.trim() : '';
    const trainingMinutes = parseTrainingMinutes(trainingText);
    if (trainingText && trainingMinutes == null) throw new Error(`第 ${headerRowIndex + offset + 2} 行预计培训时长应填写非负整数分钟，不能填写日期。`);
    const planName = values[planIndex]?.trim() ?? '';
    const code = kind === 'initiation'
      ? normalizeInternalCode(codeIndex >= 0 ? values[codeIndex] : undefined) ?? internalCodeFromPlanName(planName)
      : codeIndex >= 0 ? normalizeCode(values[codeIndex]) : undefined;
    if (!planName && !code) return;
    const versionType = versionTypeIndex >= 0 ? values[versionTypeIndex]?.trim() : undefined;
    const temporary = kind === 'release' && versionType === TEMPORARY_OPTIMIZATION_LABEL;

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
      code: temporary ? undefined : code,
      tCode: !temporary && tCodeIndex >= 0 ? normalizeCode(values[tCodeIndex]) : undefined,
      planName: temporary ? planName : planName || code || '',
      systemName,
      appName,
      versionType,
      projectType: projectTypeIndex >= 0 ? mapProjectType(values[projectTypeIndex]) : undefined,
      customerSource: customerSourceIndex >= 0 ? values[customerSourceIndex]?.trim() : undefined,
      demandSource: requirementSourceIndex >= 0 ? values[requirementSourceIndex]?.trim() : undefined,
      requirementDescription: requirementDescIndex >= 0 ? values[requirementDescIndex]?.trim() : undefined,
      departmentName: departmentIndex >= 0 ? values[departmentIndex]?.trim() : undefined,
      ownerId: ownerName,
      ownerName,
      teamMemberIds: teamIndex >= 0 ? splitMembers(values[teamIndex]) : undefined,
      projectMemberNames: teamIndex >= 0 ? splitMembers(values[teamIndex]) : undefined,
      planUrl: planUrlIndex >= 0 ? values[planUrlIndex]?.trim() : undefined,
      firstDraftMeetingAt: firstDraftIndex >= 0 ? parseDateValue(values[firstDraftIndex]) : undefined,
      secondDraftMeetingAt: secondDraftIndex >= 0 ? parseDateValue(values[secondDraftIndex]) : undefined,
      thirdDraftMeetingAt: thirdDraftIndex >= 0 ? parseDateValue(values[thirdDraftIndex]) : undefined,
      projectAt: dateIndex >= 0 ? parseDateValue(values[dateIndex]) : undefined,
      plannedProjectAt: plannedProjectIndex >= 0 ? parseDateValue(values[plannedProjectIndex]) : undefined,
      needUiDesign: uiDesignIndex >= 0 ? mapBool(values[uiDesignIndex]) : undefined,
      isAiPoc: aiPocIndex >= 0 ? mapBool(values[aiPocIndex]) : undefined,
      developmentStatus: developmentIndex >= 0 ? values[developmentIndex]?.trim() : undefined,
      remark: remarkIndex >= 0 ? values[remarkIndex]?.trim() : undefined,
      openBrandScope: openBrandIndex >= 0 ? values[openBrandIndex]?.trim() : undefined,
      isGlobalOpen: globalOpenIndex >= 0 ? mapBool(values[globalOpenIndex]) : undefined,
      contractParty: contractPartyIndex >= 0 ? values[contractPartyIndex]?.trim() : undefined,
      plannedTrainingMinutes: trainingMinutes,
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
  let headerRowIndex = -1;
  let bestScore = 0;
  rows.slice(0, -1).forEach((row, index) => {
    const columns = resolveColumns(row, kind);
    if (columns.planIndex < 0 && columns.codeIndex < 0) return;
    const score = new Set(Object.values(columns).filter((column) => column >= 0)).size;
    if (score > bestScore) {
      bestScore = score;
      headerRowIndex = index;
    }
  });
  if (headerRowIndex < 0) return [];
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
  if (lower.endsWith('.csv')) {
    const bytes = await file.arrayBuffer();
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      content = new TextDecoder('gb18030').decode(bytes);
    }
    return parseVersionWorkflowImportCsv(content, kind);
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseVersionWorkflowImportXlsxBuffer(await file.arrayBuffer(), kind);
  }
  throw new Error('不支持的文件格式，请上传 CSV 或 Excel（.xlsx / .xls）');
}
