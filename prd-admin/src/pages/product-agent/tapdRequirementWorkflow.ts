/**
 * TAPD「米多需求收集工作流」状态 Key 与中文标签（与后端 TapdRequirementWorkflow 对齐）。
 */
export const TAPD_REQUIREMENT_STATE_LABEL: Record<string, string> = {
  new: '待评审',
  planning: '待规划',
  status_2: '已立项',
  developing: '开发中',
  resolved: '已上线',
  rejected: '已拒绝',
  status_3: '已排期',
};

export const TAPD_REQUIREMENT_STATE_ORDER = [
  'new',
  'planning',
  'status_2',
  'developing',
  'resolved',
  'rejected',
  'status_3',
] as const;

export function tapdRequirementStateLabel(key?: string | null): string {
  if (!key) return '未设置';
  return TAPD_REQUIREMENT_STATE_LABEL[key] ?? key;
}
