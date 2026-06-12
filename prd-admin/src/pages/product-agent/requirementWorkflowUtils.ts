/**
 * 全局需求工作流工具：状态 Key 规范化 + 中文标签解析 + 流转按钮文案。
 * SSOT 与后端 TapdRequirementWorkflow 对齐；工作流定义来自 API 时优先使用定义内标签。
 */
import type { WorkflowDefinition, WorkflowTransition } from './types';
import { TAPD_REQUIREMENT_STATE_LABEL, tapdRequirementStateLabel } from './tapdRequirementWorkflow';

/** MAP 旧默认流程状态 → TAPD 对齐状态（与后端 LegacyStateMap 一致）。 */
const LEGACY_STATE_MAP: Record<string, string> = {
  pending: 'new',
  reviewed: 'planning',
  developing: 'developing',
  testing: 'developing',
  done: 'resolved',
  rejected: 'rejected',
};

/** 将需求 currentState 规范为 TAPD 对齐 Key。 */
export function normalizeRequirementStateKey(key?: string | null): string {
  if (!key?.trim()) return 'new';
  const k = key.trim();
  if (TAPD_REQUIREMENT_STATE_LABEL[k]) return k;
  return LEGACY_STATE_MAP[k] ?? k;
}

/** 解析需求状态中文标签（工作流定义 > TAPD 内置表 > 原 Key）。 */
export function resolveRequirementStateLabel(
  key?: string | null,
  workflow?: WorkflowDefinition | null,
): string {
  const normalized = normalizeRequirementStateKey(key);
  const fromWorkflow =
    workflow?.states.find((s) => s.key === normalized)?.label
    ?? workflow?.states.find((s) => s.key === key)?.label;
  if (fromWorkflow) return fromWorkflow;
  return tapdRequirementStateLabel(normalized);
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
