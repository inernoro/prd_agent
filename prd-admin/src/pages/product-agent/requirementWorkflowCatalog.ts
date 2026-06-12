/**
 * MAP 内置需求工作流目录（与后端 RequirementWorkflowCatalog 一致）。
 * 仅作 API 未返回流程定义时的兜底；正常运行时标签来自 GET workflow-definitions。
 */
export const BUILTIN_REQUIREMENT_STATE_LABEL: Record<string, string> = {
  new: '待评审',
  planning: '待规划',
  status_2: '已立项',
  developing: '开发中',
  resolved: '已上线',
  rejected: '已拒绝',
  status_3: '已排期',
};

export const BUILTIN_REQUIREMENT_STATE_ORDER = [
  'new',
  'planning',
  'status_2',
  'developing',
  'resolved',
  'rejected',
  'status_3',
] as const;

export function builtinRequirementStateLabel(key?: string | null): string {
  if (!key) return '未设置';
  return BUILTIN_REQUIREMENT_STATE_LABEL[key] ?? key;
}
