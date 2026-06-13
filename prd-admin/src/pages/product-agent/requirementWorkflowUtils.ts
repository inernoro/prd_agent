/**
 * 全局需求工作流工具：状态 Key 规范化 + 中文标签 + 流转按钮文案。
 * 运行时 SSOT = API 返回的 WorkflowDefinition；内置目录仅兜底与遗留 Key 迁移。
 */
import type { WorkflowDefinition, WorkflowTransition } from './types';
import { BUILTIN_REQUIREMENT_STATE_LABEL, builtinRequirementStateLabel } from './requirementWorkflowCatalog';

/** MAP 旧默认流程状态 → 当前内置状态 Key（与后端 LegacyStateMap 一致）。 */
const LEGACY_STATE_MAP: Record<string, string> = {
  pending: 'new',
  reviewed: 'planning',
  developing: 'developing',
  testing: 'developing',
  done: 'resolved',
  rejected: 'rejected',
  /** 历史误把表单字段 key「state」写入 currentState 时的兜底迁移 */
  state: 'new',
};

function initialStateKey(workflow?: WorkflowDefinition | null): string {
  return workflow?.states.find((s) => s.isInitial)?.key ?? workflow?.states[0]?.key ?? 'new';
}

/** 规范需求 currentState：遗留 Key → 工作流定义内 Key → 内置目录 → 原样保留（自定义状态）。 */
export function normalizeRequirementStateKey(key?: string | null, workflow?: WorkflowDefinition | null): string {
  if (!key?.trim()) return initialStateKey(workflow);
  let k = key.trim();
  if (LEGACY_STATE_MAP[k]) k = LEGACY_STATE_MAP[k];
  if (workflow?.states.some((s) => s.key === k)) return k;
  if (BUILTIN_REQUIREMENT_STATE_LABEL[k]) return k;
  return k;
}

/** 解析需求状态中文标签（工作流定义优先，内置目录兜底）。 */
export function resolveRequirementStateLabel(
  key?: string | null,
  workflow?: WorkflowDefinition | null,
  importedStatusLabel?: string | null,
): string {
  const normalized = normalizeRequirementStateKey(key, workflow);
  const wfState = workflow?.states.find((s) => s.key === normalized);
  const wfLabel = wfState?.label?.trim();
  if (wfLabel && wfLabel !== wfState?.key) return wfLabel;
  if (BUILTIN_REQUIREMENT_STATE_LABEL[normalized]) return BUILTIN_REQUIREMENT_STATE_LABEL[normalized];
  const imported = importedStatusLabel?.trim();
  if (imported && (/^state_\d+$/i.test(normalized) || wfLabel === normalized || normalized === key?.trim())) {
    return imported;
  }
  return wfLabel || builtinRequirementStateLabel(normalized);
}

/** 流转按钮展示文案：优先后端短标签「到X」，兼容旧版「源→目标」格式。 */
export function requirementTransitionButtonLabel(
  transition: Pick<WorkflowTransition, 'label' | 'toState'>,
  workflow?: WorkflowDefinition | null,
): string {
  if (transition.label && !transition.label.includes('→')) return transition.label;
  const toLabel = resolveRequirementStateLabel(transition.toState, workflow);
  return `到${toLabel}`;
}
