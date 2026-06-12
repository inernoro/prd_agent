/**
 * MAP 产品缺陷工作流目录（与后端 DefectWorkflowCatalog 一致）。
 * 7 个需求同名状态 + 非产品缺陷（转需求）。
 */
import { BUILTIN_REQUIREMENT_STATE_LABEL } from './requirementWorkflowCatalog';
import { NON_PRODUCT_DEFECT_CLASSIFICATION } from './productDefectLinkageCatalog';

export const BUILTIN_DEFECT_STATE_LABEL: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(BUILTIN_REQUIREMENT_STATE_LABEL).filter(([k]) => k !== 'to_defect'),
  ),
  to_requirement: NON_PRODUCT_DEFECT_CLASSIFICATION,
};

/** 旧缺陷状态 → 产品缺陷工作流 Key */
export const DEFECT_LEGACY_STATE_MAP: Record<string, string> = {
  draft: 'new',
  reviewing: 'new',
  awaiting: 'new',
  submitted: 'new',
  assigned: 'planning',
  processing: 'developing',
  verifying: 'developing',
  resolved: 'resolved',
  rejected: 'rejected',
  closed: 'rejected',
};

export function builtinDefectStateLabel(key?: string | null): string {
  if (!key) return '—';
  const normalized = DEFECT_LEGACY_STATE_MAP[key] ?? key;
  return BUILTIN_DEFECT_STATE_LABEL[normalized] ?? normalized;
}
