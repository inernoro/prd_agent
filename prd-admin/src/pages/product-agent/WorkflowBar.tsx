/**
 * 产品管理智能体 — 状态流转条（让流程模板真正驱动对象状态，参考 TAPD）。
 *
 * 显示对象当前状态 + 可执行的流转动作按钮；点击调 /transition 端点改 CurrentState。
 */
import { useState } from 'react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { transition } from '@/services/real/productAgent';
import type { WorkflowDefinition, ProductEntityType } from './types';

export function WorkflowBar({
  workflow,
  entityType,
  entityId,
  currentState,
  onChanged,
}: {
  workflow: WorkflowDefinition | null;
  entityType: ProductEntityType;
  entityId: string;
  currentState?: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!workflow || workflow.states.length === 0) return null;

  const state = workflow.states.find((s) => s.key === currentState) ?? workflow.states.find((s) => s.isInitial) ?? workflow.states[0];
  const available = workflow.transitions.filter((t) => !t.fromState || t.fromState === (currentState ?? state?.key));

  const doTransition = async (key: string, requireComment: boolean) => {
    let comment: string | undefined;
    if (requireComment) {
      const c = window.prompt('请填写流转备注');
      if (c == null) return;
      comment = c;
    }
    setBusy(key);
    setError(null);
    const res = await transition({ entityType, entityId, transitionKey: key, comment });
    setBusy(null);
    if (res.success) onChanged();
    else setError(res.error?.message ?? '流转失败');
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-white/45">当前状态</span>
      <span
        className="text-xs px-2 py-0.5 rounded font-medium"
        style={{ background: 'rgba(255,255,255,0.06)', color: state?.color ?? '#e8e8ec' }}
      >
        {state?.label ?? currentState ?? '未设置'}
      </span>
      {available.length > 0 && <span className="text-white/20 mx-1">|</span>}
      {available.map((t) => (
        <button
          key={t.key}
          onClick={() => doTransition(t.key, t.requireComment)}
          disabled={!!busy}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10 disabled:opacity-50"
        >
          {busy === t.key ? <MapSpinner size={12} /> : null}
          {t.label || t.key}
        </button>
      ))}
      {error && <span className="text-xs text-red-300/80">{error}</span>}
    </div>
  );
}
