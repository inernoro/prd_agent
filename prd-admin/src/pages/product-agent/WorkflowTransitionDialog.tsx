import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { listInitiations, listReleases, listVersions, transition } from '@/services/real/productAgent';
import type { ItemGrade, ProductEntityType, ProductInitiation, ProductRelease, ProductVersion, WorkflowDefinition, WorkflowTransition } from './types';
import { ITEM_GRADE_LABEL } from './types';
import {
  REQUIREMENT_GATE_FIELD_LABELS,
  WORKFLOW_TRANSITION_FIELD_LABELS,
  missingRequirementGateFields,
  missingTransitionFieldKeys,
  type WorkflowTransitionEntitySnapshot,
} from './workflowTransitionGuard';
import { requirementTransitionButtonLabel } from './requirementWorkflowUtils';

const ITEM_GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];

export interface WorkflowTransitionDialogProps {
  open: boolean;
  productId?: string;
  workflow: WorkflowDefinition | null;
  entityType: ProductEntityType;
  entityId: string;
  transition: WorkflowTransition | null;
  entity: WorkflowTransitionEntitySnapshot;
  actionLabel?: string;
  onClose: () => void;
  onDone: () => void;
}

export function WorkflowTransitionDialog({
  open,
  productId,
  workflow,
  entityType,
  entityId,
  transition: tr,
  entity,
  actionLabel,
  onClose,
  onDone,
}: WorkflowTransitionDialogProps) {
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState(entity.title ?? '');
  const [grade, setGrade] = useState(entity.grade ?? 'p2');
  const [assigneeId, setAssigneeId] = useState(entity.assigneeId ?? '');
  const [versionIds, setVersionIds] = useState<string[]>(entity.versionIds ?? []);
  const [initiationId, setInitiationId] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [initiations, setInitiations] = useState<ProductInitiation[]>([]);
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setComment('');
    setTitle(entity.title ?? '');
    setGrade(entity.grade ?? 'p2');
    setAssigneeId(entity.assigneeId ?? '');
    setVersionIds(entity.versionIds ?? []);
    setInitiationId('');
    setReleaseId('');
    setError(null);
  }, [open, entity.title, entity.grade, entity.assigneeId, entity.versionIds]);

  useEffect(() => {
    if (!open || !productId || entityType !== 'requirement') return;
    void Promise.all([
      listVersions(productId),
      listInitiations(productId, 'all'),
      listReleases(productId, 'all'),
    ]).then(([v, i, r]) => {
      if (v.success) setVersions(v.data.items);
      if (i.success) setInitiations(i.data.items);
      if (r.success) setReleases(r.data.items);
    });
  }, [open, productId, entityType]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose, open]);

  const linkage = useMemo(() => {
    const approvedInitiations = initiations.filter((item) => item.status === 'approved' && item.tCode);
    const completedReleases = releases.filter((item) => item.status === 'released');
    return {
      hasApprovedInitiation: entity.hasApprovedInitiation
        ?? approvedInitiations.some((item) => item.requirementIds.includes(entityId)),
      hasCompletedRelease: entity.hasCompletedRelease
        ?? completedReleases.some((item) => item.requirementIds.includes(entityId)),
      approvedInitiations,
      completedReleases,
    };
  }, [initiations, releases, entity.hasApprovedInitiation, entity.hasCompletedRelease, entityId]);

  const enrichedEntity = useMemo<WorkflowTransitionEntitySnapshot>(() => ({
    ...entity,
    versionIds,
    hasApprovedInitiation: linkage.hasApprovedInitiation,
    hasCompletedRelease: linkage.hasCompletedRelease,
  }), [entity, versionIds, linkage.hasApprovedInitiation, linkage.hasCompletedRelease]);

  const fields = useMemo(() => {
    if (!tr) return [] as Array<'title' | 'grade' | 'assigneeId' | 'comment' | 'versionIds'>;
    return missingTransitionFieldKeys(tr, enrichedEntity, comment, assigneeId, versionIds);
  }, [tr, enrichedEntity, comment, assigneeId, versionIds]);

  const gateFields = useMemo(() => {
    if (!tr) return [] as Array<'versionIds' | 'initiationId' | 'releaseId'>;
    return missingRequirementGateFields(tr, enrichedEntity, versionIds, initiationId, releaseId);
  }, [tr, enrichedEntity, versionIds, initiationId, releaseId]);

  const toggleVersion = (id: string) => {
    setVersionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  if (!open || !tr) return null;

  const label = actionLabel
    ?? (entityType === 'requirement' && workflow ? requirementTransitionButtonLabel(tr, workflow) : (tr.label || tr.key));

  const submit = async () => {
    const missingFields = missingTransitionFieldKeys(tr, enrichedEntity, comment, assigneeId, versionIds);
    const missingGates = missingRequirementGateFields(tr, enrichedEntity, versionIds, initiationId, releaseId);
    if (missingFields.length > 0 || missingGates.length > 0) {
      const labels = [
        ...missingFields.map((k) => WORKFLOW_TRANSITION_FIELD_LABELS[k]),
        ...missingGates.map((k) => REQUIREMENT_GATE_FIELD_LABELS[k]),
      ];
      setError(`请填写：${labels.join('、')}`);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await transition({
      entityType,
      entityId,
      transitionKey: tr.key,
      comment: comment.trim() || undefined,
      assigneeId: assigneeId.trim() || undefined,
      title: fields.includes('title') ? title.trim() : undefined,
      grade: fields.includes('grade') ? grade : undefined,
      versionIds: (fields.includes('versionIds') || gateFields.includes('versionIds')) ? versionIds : undefined,
      initiationId: gateFields.includes('initiationId') ? initiationId : undefined,
      releaseId: gateFields.includes('releaseId') ? releaseId : undefined,
    });
    setBusy(false);
    if (res.success) {
      onDone();
      onClose();
    } else {
      setError(res.error?.message ?? '流转失败');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4">
      <div
        className="w-full max-w-lg rounded-xl border border-white/15 bg-[#111319] shadow-2xl flex flex-col"
        style={{ maxHeight: 'min(640px, calc(100vh - 32px))' }}
      >
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-4 border-b border-white/10">
          <div>
            <div className="text-base font-semibold text-white">确认流转</div>
            <div className="text-xs text-white/45 mt-1">动作：{label}</div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="p-1.5 rounded-lg text-white/45 hover:text-white hover:bg-white/10 disabled:opacity-40" title="关闭">
            <X size={17} />
          </button>
        </div>

        <div
          className="flex-1 px-5 py-4 flex flex-col gap-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {fields.includes('title') && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-white/55">{WORKFLOW_TRANSITION_FIELD_LABELS.title} *</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
                placeholder="填写标题"
              />
            </label>
          )}
          {fields.includes('grade') && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-white/55">{WORKFLOW_TRANSITION_FIELD_LABELS.grade} *</span>
              <select
                value={grade}
                onChange={(e) => setGrade(e.target.value)}
                className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
              >
                {ITEM_GRADES.map((g) => (
                  <option key={g} value={g}>{ITEM_GRADE_LABEL[g]}</option>
                ))}
              </select>
            </label>
          )}
          {fields.includes('assigneeId') && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-white/55">{WORKFLOW_TRANSITION_FIELD_LABELS.assigneeId} *</span>
              <UserSearchSelect value={assigneeId} onChange={setAssigneeId} placeholder="选择处理人" uiSize="md" />
            </label>
          )}
          {(fields.includes('versionIds') || gateFields.includes('versionIds')) && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-white/55">{REQUIREMENT_GATE_FIELD_LABELS.versionIds} *</span>
              {versions.length === 0 ? (
                <div className="text-xs text-amber-200/80">暂无产品版本，请先在「版本」tab 创建。</div>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto rounded-lg border border-white/10 p-2" style={{ minHeight: 0 }}>
                  {versions.map((v) => (
                    <label key={v.id} className="flex items-center gap-2 text-sm text-white/75">
                      <input type="checkbox" checked={versionIds.includes(v.id)} onChange={() => toggleVersion(v.id)} className="accent-cyan-500" />
                      <span className="truncate">{v.versionName}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {gateFields.includes('initiationId') && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-white/55">{REQUIREMENT_GATE_FIELD_LABELS.initiationId} *</span>
              <select
                value={initiationId}
                onChange={(e) => setInitiationId(e.target.value)}
                className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
              >
                <option value="">选择已通过立项单</option>
                {linkage.approvedInitiations.map((item) => (
                  <option key={item.id} value={item.id}>{item.tCode} · {item.planName}</option>
                ))}
              </select>
            </label>
          )}
          {gateFields.includes('releaseId') && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-white/55">{REQUIREMENT_GATE_FIELD_LABELS.releaseId} *</span>
              <select
                value={releaseId}
                onChange={(e) => setReleaseId(e.target.value)}
                className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
              >
                <option value="">选择已完成上线单</option>
                {linkage.completedReleases.map((item) => (
                  <option key={item.id} value={item.id}>{item.vCode} · {item.planName}</option>
                ))}
              </select>
            </label>
          )}
          {fields.includes('comment') && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-white/55">{WORKFLOW_TRANSITION_FIELD_LABELS.comment} *</span>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 resize-none"
                placeholder="填写流转备注"
              />
            </label>
          )}
          {error && <div className="text-xs text-red-300/85">{error}</div>}
        </div>

        <div className="shrink-0 px-5 py-4 border-t border-white/10 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="px-3.5 py-2 rounded-lg border border-white/10 text-sm text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-40">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cyan-600/90 hover:bg-cyan-500 text-sm text-white disabled:opacity-50"
          >
            {busy ? <MapSpinner size={14} /> : null}
            确认流转
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
