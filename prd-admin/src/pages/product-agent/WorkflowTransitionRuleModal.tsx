/**
 * 应用配置 — 单条流转规则详情（角色 / 必填字段 / 备注等），矩阵格点击设置图标打开。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { WorkflowState, WorkflowTransition } from './types';
import {
  WORKFLOW_TRANSITION_FIELD_KEYS,
  WORKFLOW_TRANSITION_FIELD_LABELS,
  WORKFLOW_TRANSITION_ROLE_LABELS,
  WORKFLOW_TRANSITION_ROLES,
  type WorkflowTransitionFieldKey,
  type WorkflowTransitionRole,
} from './workflowTransitionGuard';
import { WORKFLOW_LINK_ENTITY_LABELS } from './productDefectLinkageCatalog';

const WORKFLOW_ROLE_OPTIONS = Object.values(WORKFLOW_TRANSITION_ROLES);
const WORKFLOW_FIELD_OPTIONS = Object.values(WORKFLOW_TRANSITION_FIELD_KEYS);

function toggleListItem(list: string[] | null | undefined, item: string): string[] {
  const base = list ?? [];
  return base.includes(item) ? base.filter((x) => x !== item) : [...base, item];
}

export function WorkflowTransitionRuleModal({
  open,
  transition,
  fromState,
  toState,
  onClose,
  onSave,
}: {
  open: boolean;
  transition: WorkflowTransition;
  fromState: WorkflowState;
  toState: WorkflowState;
  onClose: () => void;
  onSave: (patch: WorkflowTransition) => void;
}) {
  const [draft, setDraft] = useState(transition);

  useEffect(() => {
    if (open) setDraft(transition);
  }, [open, transition]);

  if (!open) return null;

  const fromLabel = fromState.label || fromState.key;
  const toLabel = toState.label || toState.key;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        className="relative z-10 w-full max-w-lg rounded-xl border border-token-subtle bg-[#14161b] shadow-2xl flex flex-col min-h-0"
        style={{ maxHeight: 'min(90vh, 640px)' }}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-token-subtle">
          <div>
            <div className="text-sm font-medium text-token-primary">流转附加设置</div>
            <div className="text-xs text-token-muted mt-0.5">
              {fromLabel} → {toLabel}
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-token-secondary hover-text-primary hover-bg-soft">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4" style={{ overscrollBehavior: 'contain' }}>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-token-secondary">动作名称</span>
            <input
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              className="px-3 py-2 rounded-lg bg-token-nested border border-token-subtle text-sm text-token-primary outline-none focus:border-cyan-500/40"
            />
          </label>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-token-secondary">
              <input
                type="checkbox"
                checked={draft.requireComment}
                onChange={(e) => setDraft((d) => ({ ...d, requireComment: e.target.checked }))}
                className="accent-cyan-500"
              />
              需备注
            </label>
            <label className="flex items-center gap-2 text-sm text-token-secondary" title="触发该流转时自动把处理人指派给操作人本人">
              <input
                type="checkbox"
                checked={draft.autoAssignToActor ?? false}
                onChange={(e) => setDraft((d) => ({ ...d, autoAssignToActor: e.target.checked }))}
                className="accent-cyan-500"
              />
              自动认领
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-token-secondary">允许角色（不选表示不限）</span>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WORKFLOW_ROLE_OPTIONS.map((role) => (
                <label key={role} className="flex items-center gap-1.5 text-xs text-token-secondary">
                  <input
                    type="checkbox"
                    checked={(draft.allowedRoles ?? []).includes(role)}
                    onChange={() => setDraft((d) => ({ ...d, allowedRoles: toggleListItem(d.allowedRoles, role) }))}
                    className="accent-cyan-500"
                  />
                  {WORKFLOW_TRANSITION_ROLE_LABELS[role as WorkflowTransitionRole]}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-token-secondary">跨对象联动（流转成功后自动执行）</span>
            <select
              value={draft.linkEntityType ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, linkEntityType: e.target.value || null }))}
              className="px-3 py-2 rounded-lg bg-token-nested border border-token-subtle text-sm text-token-primary outline-none focus:border-cyan-500/40"
            >
              <option value="">无</option>
              <option value="defect">{WORKFLOW_LINK_ENTITY_LABELS.defect}</option>
              <option value="requirement">{WORKFLOW_LINK_ENTITY_LABELS.requirement}</option>
            </select>
            <p className="text-[11px] text-token-muted">需求流转可联动生成缺陷；缺陷流转可联动转为需求。可在矩阵中按业务配置。</p>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-token-secondary">流转前必填字段</span>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WORKFLOW_FIELD_OPTIONS.map((fieldKey) => (
                <label key={fieldKey} className="flex items-center gap-1.5 text-xs text-token-secondary">
                  <input
                    type="checkbox"
                    checked={(draft.requiredFieldKeys ?? []).includes(fieldKey)}
                    onChange={() => setDraft((d) => ({ ...d, requiredFieldKeys: toggleListItem(d.requiredFieldKeys, fieldKey) }))}
                    className="accent-cyan-500"
                  />
                  {WORKFLOW_TRANSITION_FIELD_LABELS[fieldKey as WorkflowTransitionFieldKey]}
                </label>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-token-muted">
            内部 key：<span className="font-mono text-token-secondary">{draft.key}</span>
          </p>
        </div>
        <div className="shrink-0 flex justify-end gap-2 px-4 py-3 border-t border-token-subtle">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-token-secondary border border-token-subtle hover-bg-soft">
            取消
          </button>
          <button
            type="button"
            onClick={() => { onSave(draft); onClose(); }}
            className="px-3 py-1.5 rounded-lg text-sm bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400"
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function findMatrixTransition(
  transitions: WorkflowTransition[],
  fromKey: string,
  toKey: string,
): WorkflowTransition | undefined {
  return transitions.find((t) => t.fromState === fromKey && t.toState === toKey);
}

export function createDefaultMatrixTransition(
  from: WorkflowState,
  to: WorkflowState,
  existing?: WorkflowTransition,
): WorkflowTransition {
  const toLabel = to.label || to.key;
  return {
    key: existing?.key ?? `${from.key}-to-${to.key}`,
    label: existing?.label || (toLabel ? `到${toLabel}` : `到${to.key}`),
    fromState: from.key,
    toState: to.key,
    requireComment: existing?.requireComment ?? false,
    autoAssignToActor: existing?.autoAssignToActor,
    allowedRoles: existing?.allowedRoles,
    requiredFieldKeys: existing?.requiredFieldKeys,
    linkEntityType: existing?.linkEntityType,
  };
}
