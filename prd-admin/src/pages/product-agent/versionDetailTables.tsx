/** 版本详情页：需求 / 功能 / 缺陷列表列定义（空数据仍渲染表头） */
import type { Feature, Requirement, WorkflowDefinition } from './types';
import { ITEM_GRADE_LABEL, defectSeverityTierLabel, defectStatusLabel } from './types';
import { resolveRequirementStateLabel } from './requirementWorkflowUtils';
import type { TracedDefect } from '@/services/real/productAgent';
import { workflowFmtDate } from './workflowDetailUi';

export function requirementDetailColumns(reqWorkflow?: WorkflowDefinition | null) {
  return [
    { header: '编号', width: '10%', render: (row: { id: string }) => <span className="font-mono text-cyan-200/80">{(row as Requirement).requirementNo}</span> },
    { header: '标题', width: '30%', render: (row: { id: string }) => <span className="text-white/85 truncate block" title={(row as Requirement).title}>{(row as Requirement).title}</span> },
    { header: '分级', width: '8%', render: (row: { id: string }) => ITEM_GRADE_LABEL[(row as Requirement).grade] },
    { header: '状态', width: '12%', render: (row: { id: string }) => resolveRequirementStateLabel((row as Requirement).currentState ?? '', reqWorkflow) || '—' },
    { header: '更新时间', width: '14%', render: (row: { id: string }) => workflowFmtDate((row as Requirement).updatedAt) },
  ];
}

export function featureDetailColumns() {
  return [
    { header: '编号', width: '12%', render: (row: { id: string }) => <span className="font-mono text-violet-200/80">{(row as Feature).featureNo}</span> },
    { header: '标题', width: '32%', render: (row: { id: string }) => <span className="text-white/85 truncate block" title={(row as Feature).title}>{(row as Feature).title}</span> },
    { header: '模块', width: '14%', render: (row: { id: string }) => (row as Feature).moduleName || '—' },
    { header: '关联需求', width: '10%', render: (row: { id: string }) => String((row as Feature).requirementIds.length) },
    { header: '更新时间', width: '14%', render: (row: { id: string }) => workflowFmtDate((row as Feature).updatedAt) },
  ];
}

export function defectDetailColumns() {
  return [
    { header: '编号', width: '10%', render: (row: { id: string }) => <span className="font-mono text-red-200/80">{(row as TracedDefect).defectNo}</span> },
    { header: '标题', width: '30%', render: (row: { id: string }) => <span className="text-white/85 truncate block" title={(row as TracedDefect).title ?? ''}>{(row as TracedDefect).title || '—'}</span> },
    { header: '状态', width: '12%', render: (row: { id: string }) => defectStatusLabel((row as TracedDefect).status) },
    { header: '严重程度', width: '12%', render: (row: { id: string }) => defectSeverityTierLabel(row as TracedDefect) || '—' },
    { header: '更新时间', width: '14%', render: (row: { id: string }) => workflowFmtDate((row as TracedDefect).updatedAt) },
  ];
}
