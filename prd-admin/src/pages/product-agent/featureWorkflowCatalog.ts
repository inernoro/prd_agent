/**
 * MAP 内置功能工作流目录（与后端 FeatureWorkflowCatalog 一致）。
 * 7 个需求同名状态 + 已下架；仅作 API 未返回流程定义时的兜底。
 */
import { BUILTIN_REQUIREMENT_STATE_LABEL } from './requirementWorkflowCatalog';

export const BUILTIN_FEATURE_STATE_LABEL: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(BUILTIN_REQUIREMENT_STATE_LABEL).filter(([k]) => k !== 'to_defect'),
  ),
  cancelled: '已下架',
};

export const BUILTIN_FEATURE_STATE_DESCRIPTION: Record<string, string> = {
  new: '新提交的需求，待评审',
  planning: '经过产品经理评审，认为此需求合理，待排期规划',
  status_2: '需求已出产品方案，待开发',
  developing: '该需求正在开发中，待上线',
  resolved: '需求已经实现，并且项目已经上线',
  rejected: '经过产品经理评审，认为此需求不合理',
  status_3: '需求经过产品经理规划，已申请立项，待评审',
  cancelled: '功能在本版本中不再提供，由已上线状态下架（可重新打开回到待规划等状态）',
};

/** 旧功能流程 Key → 当前 Key */
export const FEATURE_LEGACY_STATE_MAP: Record<string, string> = {
  planned: 'new',
  testing: 'developing',
  released: 'resolved',
  cancelled: 'cancelled',
};

export function builtinFeatureStateLabel(key?: string | null): string {
  if (!key) return '未设置';
  const normalized = FEATURE_LEGACY_STATE_MAP[key] ?? key;
  return BUILTIN_FEATURE_STATE_LABEL[normalized] ?? normalized;
}
