import { TAPD_DEFECT_FIELD } from './tapdDefectFieldCatalog';

/** V2.6 缺陷严重程度四档（structuredData SSOT） */
export type DefectSeverityLevel = '致命' | '严重' | '一般' | '轻微';

export const DEFECT_SEVERITY_LEVEL_HINT: Record<DefectSeverityLevel, string> = {
  致命: '阻断业务 / 数据安全 / 崩溃',
  严重: '核心功能不可用',
  一般: '功能异常但可绕过',
  轻微: 'UI / 文案 / 体验',
};

export const DEFECT_SEVERITY_LEVEL_OPTIONS: { value: DefectSeverityLevel; label: string }[] = [
  { value: '致命', label: '致命' },
  { value: '严重', label: '严重' },
  { value: '一般', label: '一般' },
  { value: '轻微', label: '轻微' },
];

const V26_LEVELS: DefectSeverityLevel[] = ['致命', '严重', '一般', '轻微'];

function isV26Level(v: string): v is DefectSeverityLevel {
  return (V26_LEVELS as string[]).includes(v);
}

/**
 * TAPD「严重程度」五档（紧急/高/中/低/无关紧要）→ V2.6 四档。仅用于导入列「严重程度」原文映射。
 */
export function normalizeTapdToSeverityLevel(raw?: string | null): DefectSeverityLevel | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (isV26Level(text)) return text;

  switch (text) {
    case '紧急':
      return '致命';
    case '高':
      return '严重';
    case '中':
      return '一般';
    case '低':
    case '无关紧要':
      return '轻微';
    default:
      return undefined;
  }
}

/** @deprecated 别名，供导入解析沿用 */
export const normalizeTapdLevelToTier = normalizeTapdToSeverityLevel;

/** 只读 structuredData，不跨字段推断 */
export function readDefectSeverityLevel(d: { structuredData?: Record<string, string> | null }): DefectSeverityLevel | null {
  const v = d.structuredData?.[TAPD_DEFECT_FIELD.defectSeverity]?.trim();
  if (v && isV26Level(v)) return v;
  return null;
}

/** @deprecated 别名 */
export const readDefectSeverityTier = readDefectSeverityLevel;

export function formatDefectSeverityLevel(level: DefectSeverityLevel | null | undefined): string {
  return level ?? '—';
}

/** @deprecated 别名 */
export const formatDefectSeverityTier = formatDefectSeverityLevel;
