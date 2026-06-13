/**
 * TAPD 缺陷字段 SSOT — 与 prd-api TapdDefectFieldCatalog / CapsuleExecutor.MapBugFieldsToChinese 对齐。
 * 产品管理「严重程度」仅存 structuredData，不跨字段推断。
 */
import type { DefectSeverityLevel } from './defectSeverity';

export const TAPD_DEFECT_FIELD = {
  defectId: '缺陷ID',
  title: '标题',
  reporter: '创建人',
  created: '创建时间',
  issueStartTime: '问题开始时间',
  resolved: '解决时间',
  closed: '关闭时间',
  due: '预计结束时间',
  currentOwner: '处理人',
  status: '状态',
  responsiblePerson: '责任人',
  overdue: '是否逾期',
  validReport: '有效报告',
  defectGrade: '缺陷等级',
  /** V2.6 四档：致命/严重/一般/轻微 */
  defectSeverity: '严重程度',
  /** TAPD 导出列原文：紧急/高/中/低/无关紧要 */
  tapdSeveritySource: 'TAPD严重程度',
  defectDivision: '缺陷划分',
  feedbackPerson: '反馈人',
  companyName: '公司名称',
  merchantNo: '商户编号',
  introducedProject: '引入项目',
  feedbackTime: '反馈时间',
  impactScope: '影响范围',
  structureParent: '结构归母',
  logicAttribution: '逻辑归因',
  urlLink: 'URL链接',
  linksInDescription: '描述中的链接',
  isHistorical: '是否历史问题',
  timelyFixed: '及时处理',
} as const;

/** TAPD API custom_field 映射（文档用，导入器消费） */
export const TAPD_API_FIELD_MAP: Record<string, string> = {
  custom_field_100: TAPD_DEFECT_FIELD.issueStartTime,
  custom_field_two: TAPD_DEFECT_FIELD.responsiblePerson,
  custom_field_four: TAPD_DEFECT_FIELD.overdue,
  custom_field_five: TAPD_DEFECT_FIELD.validReport,
  custom_field_6: TAPD_DEFECT_FIELD.defectGrade,
  custom_field_7: TAPD_DEFECT_FIELD.defectDivision,
  custom_field_8: TAPD_DEFECT_FIELD.feedbackPerson,
  custom_field_9: TAPD_DEFECT_FIELD.companyName,
  custom_field_10: TAPD_DEFECT_FIELD.merchantNo,
  custom_field_11: TAPD_DEFECT_FIELD.introducedProject,
  custom_field_12: TAPD_DEFECT_FIELD.feedbackTime,
  custom_field_13: TAPD_DEFECT_FIELD.impactScope,
  custom_field_one: TAPD_DEFECT_FIELD.structureParent,
  custom_field_three: TAPD_DEFECT_FIELD.logicAttribution,
};

export type TapdFieldEditorKind = 'text' | 'textarea' | 'date' | 'readonly' | 'url' | 'severity' | 'classification';

export interface TapdDefectSidebarField {
  key: string;
  label: string;
  kind: TapdFieldEditorKind;
  entitySource?: 'externalId' | 'status' | 'reporterName' | 'createdAt' | 'resolvedAt' | 'closedAt' | 'assigneeName';
}

export const TAPD_DEFECT_SIDEBAR_FIELDS: TapdDefectSidebarField[] = [
  { key: TAPD_DEFECT_FIELD.defectId, label: 'ID', kind: 'readonly', entitySource: 'externalId' },
  { key: TAPD_DEFECT_FIELD.status, label: '状态', kind: 'readonly', entitySource: 'status' },
  { key: TAPD_DEFECT_FIELD.currentOwner, label: '处理人', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.reporter, label: '创建人', kind: 'readonly', entitySource: 'reporterName' },
  { key: TAPD_DEFECT_FIELD.created, label: '创建时间', kind: 'readonly', entitySource: 'createdAt' },
  { key: TAPD_DEFECT_FIELD.defectSeverity, label: '严重程度', kind: 'severity' },
  { key: TAPD_DEFECT_FIELD.defectDivision, label: '缺陷划分', kind: 'classification' },
  { key: TAPD_DEFECT_FIELD.responsiblePerson, label: '责任人', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.overdue, label: '是否逾期', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.validReport, label: '有效报告', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.feedbackPerson, label: '反馈人', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.companyName, label: '公司名称', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.merchantNo, label: '商户编号', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.introducedProject, label: '引入项目', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.feedbackTime, label: '反馈时间', kind: 'date' },
  { key: TAPD_DEFECT_FIELD.impactScope, label: '影响范围', kind: 'textarea' },
  { key: TAPD_DEFECT_FIELD.structureParent, label: '结构归母', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.logicAttribution, label: '逻辑归因', kind: 'text' },
  { key: TAPD_DEFECT_FIELD.issueStartTime, label: '问题开始时间', kind: 'date' },
  { key: TAPD_DEFECT_FIELD.due, label: '预计结束时间', kind: 'date' },
  { key: TAPD_DEFECT_FIELD.resolved, label: '解决时间', kind: 'readonly', entitySource: 'resolvedAt' },
  { key: TAPD_DEFECT_FIELD.closed, label: '关闭时间', kind: 'readonly', entitySource: 'closedAt' },
  { key: TAPD_DEFECT_FIELD.urlLink, label: 'URL链接', kind: 'url' },
  { key: TAPD_DEFECT_FIELD.isHistorical, label: '是否历史问题', kind: 'readonly' },
  { key: TAPD_DEFECT_FIELD.timelyFixed, label: '及时处理', kind: 'readonly' },
];

/** 仅根据已有日期字段派生只读标记；无足够数据时不写入默认值 */
export function computeTapdDerivedFields(structured: Record<string, string>): Record<string, string> {
  const issueStart = structured[TAPD_DEFECT_FIELD.issueStartTime]?.trim();
  const resolved = structured[TAPD_DEFECT_FIELD.resolved]?.trim();
  const due = structured[TAPD_DEFECT_FIELD.due]?.trim();
  const next = { ...structured };
  if (issueStart && resolved) {
    const startDt = new Date(issueStart);
    const resolvedDt = new Date(resolved);
    if (!Number.isNaN(startDt.getTime()) && !Number.isNaN(resolvedDt.getTime())) {
      const months = (resolvedDt.getFullYear() - startDt.getFullYear()) * 12 + (resolvedDt.getMonth() - startDt.getMonth());
      next[TAPD_DEFECT_FIELD.isHistorical] = months >= 6 ? '是' : '否';
    }
  }
  if (due && resolved) {
    const dueDt = new Date(due);
    const resolvedDt = new Date(resolved);
    if (!Number.isNaN(dueDt.getTime()) && !Number.isNaN(resolvedDt.getTime())) {
      next[TAPD_DEFECT_FIELD.timelyFixed] = dueDt.toDateString() >= resolvedDt.toDateString() ? '是' : '否';
    }
  }
  return next;
}

export function tierToStructuredValue(level: DefectSeverityLevel | ''): string {
  return level;
}
