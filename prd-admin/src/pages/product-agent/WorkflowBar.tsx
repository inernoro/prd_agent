/**
 * 产品管理智能体 — 状态流转条（流程模板驱动需求/功能状态变更）。
 *
 * 显示对象当前状态 + 可执行的流转动作按钮；点击调 /transition 端点改 CurrentState。
 */
import { useEffect, useMemo, useState } from 'react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { getProduct, transition } from '@/services/real/productAgent';
import type { WorkflowDefinition, ProductEntityType } from './types';
import { normalizeRequirementStateKey, requirementTransitionButtonLabel, resolveRequirementStateLabel } from './requirementWorkflowUtils';
import {
  canExecuteWorkflowTransition,
  isGlobalProductAdmin,
  transitionNeedsDialog,
  type ProductWorkflowContext,
  type WorkflowTransitionEntitySnapshot,
} from './workflowTransitionGuard';
import { WorkflowTransitionDialog } from './WorkflowTransitionDialog';
import type { WorkflowTransition } from './types';

export function WorkflowBar({
  workflow,
  entityType,
  entityId,
  productId,
  currentState,
  importedStatusLabel,
  entitySnapshot,
  onChanged,
}: {
  workflow: WorkflowDefinition | null;
  entityType: ProductEntityType;
  entityId: string;
  productId?: string;
  currentState?: string | null;
  /** RTF/CSV 导入快照中的状态中文名，用于 generic state_N Key 的展示兜底 */
  importedStatusLabel?: string | null;
  entitySnapshot?: WorkflowTransitionEntitySnapshot;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<ProductWorkflowContext | null>(null);
  const [pendingTransition, setPendingTransition] = useState<WorkflowTransition | null>(null);

  const currentUserId = useAuthStore((s) => s.user?.userId ?? '');
  const permissions = useAuthStore((s) => s.permissions);
  const isGlobalAdmin = isGlobalProductAdmin(permissions);

  useEffect(() => {
    if (!productId) {
      setProduct(null);
      return;
    }
    let active = true;
    void getProduct(productId).then((res) => {
      if (!active || !res.success) return;
      setProduct({
        ownerId: res.data.ownerId,
        ownerIds: res.data.ownerIds,
        adminIds: res.data.adminIds,
        memberIds: res.data.memberIds,
      });
    });
    return () => {
      active = false;
    };
  }, [productId]);

  const entity = entitySnapshot ?? {};

  const isRequirement = entityType === 'requirement';
  const effectiveStateKey = isRequirement ? normalizeRequirementStateKey(currentState, workflow) : (currentState ?? undefined);
  const state = workflow?.states.find((s) => s.key === effectiveStateKey) ?? workflow?.states.find((s) => s.isInitial) ?? workflow?.states[0];

  const available = useMemo(() => {
    if (!workflow) return [];
    const raw = workflow.transitions.filter((t) => !t.fromState || t.fromState === (effectiveStateKey ?? state?.key));
    if (!product || !currentUserId) return raw;
    return raw.filter((t) => canExecuteWorkflowTransition(currentUserId, t, product, isGlobalAdmin, entity));
  }, [workflow, effectiveStateKey, state?.key, product, currentUserId, isGlobalAdmin, entity]);

  const runTransition = async (tr: WorkflowTransition, payload?: { comment?: string; assigneeId?: string; title?: string; grade?: string }) => {
    setBusy(tr.key);
    setError(null);
    const res = await transition({
      entityType,
      entityId,
      transitionKey: tr.key,
      comment: payload?.comment,
      assigneeId: payload?.assigneeId,
      title: payload?.title,
      grade: payload?.grade,
    });
    setBusy(null);
    if (res.success) onChanged();
    else setError(res.error?.message ?? '流转失败');
  };

  const onClickTransition = (tr: WorkflowTransition) => {
    if (transitionNeedsDialog(tr, entity)) {
      setPendingTransition(tr);
      return;
    }
    void runTransition(tr);
  };

  if (!workflow || workflow.states.length === 0) return null;

  return (
    <>
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-white/45">当前状态</span>
        <span
          className="text-xs px-2 py-0.5 rounded font-medium"
          style={{ background: 'rgba(255,255,255,0.06)', color: state?.color ?? '#e8e8ec' }}
        >
          {isRequirement ? resolveRequirementStateLabel(currentState, workflow, importedStatusLabel) : (state?.label ?? currentState ?? '未设置')}
        </span>
        {available.length > 0 && <span className="text-white/20 mx-1">|</span>}
        {available.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onClickTransition(t)}
            disabled={!!busy}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10 disabled:opacity-50"
          >
            {busy === t.key ? <MapSpinner size={12} /> : null}
            {isRequirement ? requirementTransitionButtonLabel(t, workflow) : (t.label || t.key)}
          </button>
        ))}
        {error && <span className="text-xs text-red-300/80">{error}</span>}
      </div>

      <WorkflowTransitionDialog
        open={!!pendingTransition}
        productId={productId}
        workflow={workflow}
        entityType={entityType}
        entityId={entityId}
        transition={pendingTransition}
        entity={entity}
        onClose={() => setPendingTransition(null)}
        onDone={onChanged}
      />
    </>
  );
}
