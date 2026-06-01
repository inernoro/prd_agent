import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, Sparkles, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { createPmGoal, updatePmGoal, deletePmGoal } from '@/services';
import type { PmGoal, PmGoalScope, PmGoalStatus, SavePmGoalInput } from '@/services/contracts/pmAgent';
import { GOAL_STATUS_REGISTRY } from '../pmConstants';

const STATUS_KEYS: PmGoalStatus[] = ['on_track', 'at_risk', 'done', 'abandoned'];

export interface DrawerCreateCtx { scope: PmGoalScope; parentId?: string; parentTitle?: string }

interface Props {
  projectId: string;
  /** 编辑现有目标 */
  goal?: PmGoal | null;
  /** 新增模式上下文（与 goal 互斥） */
  createCtx?: DrawerCreateCtx | null;
  canWrite: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** 编辑模式下点「AI 拆细」 */
  onDecompose?: (g: PmGoal) => void;
  /** 编辑模式下点「加子目标」 */
  onAddChild?: (g: PmGoal) => void;
  /** 该目标是否还能拆子目标（未达层级上限） */
  canHaveChildren?: boolean;
}

const inputCls = 'w-full text-[12.5px] rounded-md px-2.5 py-2 outline-none border';
const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' } as const;

export function GoalDetailDrawer({ projectId, goal, createCtx, canWrite, onClose, onSaved, onDecompose, onAddChild, canHaveChildren }: Props) {
  const isCreate = !goal;
  const [draft, setDraft] = useState<SavePmGoalInput>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (goal) {
      setDraft({ title: goal.title, description: goal.description || '', metric: goal.metric || '', period: goal.period || '', progress: goal.progress, progressMode: goal.progressMode, status: goal.status });
    } else if (createCtx) {
      setDraft({ scope: createCtx.scope, parentId: createCtx.parentId, status: 'on_track', progress: 0, progressMode: 'auto' });
    }
  }, [goal, createCtx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mode = draft.progressMode ?? 'auto';

  const save = async () => {
    if (!draft.title?.trim()) { toast.error('请填写目标标题', ''); return; }
    setSaving(true);
    const res = isCreate ? await createPmGoal(projectId, draft) : await updatePmGoal(goal!.id, draft);
    setSaving(false);
    if (res.success) { toast.success(isCreate ? '已新增' : '已保存', ''); onSaved(); }
    else toast.error('保存失败', res.error?.message || '');
  };

  const remove = async () => {
    if (!goal) return;
    if (!window.confirm(`确定删除目标「${goal.title}」？将一并删除其下所有子目标。`)) return;
    setSaving(true);
    const res = await deletePmGoal(goal.id);
    setSaving(false);
    if (res.success) { toast.success('已删除', ''); onSaved(); }
    else toast.error('删除失败', res.error?.message || '');
  };

  const titleText = isCreate ? (createCtx?.parentTitle ? `新增子目标 · ${createCtx.parentTitle}` : '新增目标') : '目标详情';

  const drawer = (
    <div className="fixed inset-0 z-[100] flex justify-end" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.4)' }} />
      <div
        className="relative h-full flex flex-col border-l"
        style={{ width: 420, maxWidth: '92vw', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{titleText}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {!canWrite && !isCreate && (
            <div className="text-[11px] rounded-md px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>只读：该目标仅项目经理 / 本人可编辑</div>
          )}
          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>标题</label>
          <input autoFocus value={draft.title || ''} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} placeholder="目标标题" className={inputCls} style={inputStyle} />
          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>详细描述</label>
          <textarea value={draft.description || ''} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="目标的落地思路 / 可行性说明" rows={5} className={`${inputCls} resize-y`} style={inputStyle} />
          <div className="flex gap-2">
            <div className="flex-1 flex flex-col gap-1">
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>衡量指标 / 关键结果</label>
              <input value={draft.metric || ''} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, metric: e.target.value }))} placeholder="关键结果" className={inputCls} style={inputStyle} />
            </div>
            <div className="w-[120px] flex flex-col gap-1">
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>周期</label>
              <input value={draft.period || ''} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, period: e.target.value }))} placeholder="2026 Q2" className={inputCls} style={inputStyle} />
            </div>
          </div>
          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>进度</label>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex gap-1 rounded-md p-0.5" style={{ background: 'var(--bg-base)' }}>
              {(['auto', 'manual'] as const).map((m) => (
                <button key={m} disabled={!canWrite} onClick={() => setDraft((d) => ({ ...d, progressMode: m }))}
                  className="px-2 py-1 rounded text-[11px]" style={{ background: mode === m ? 'var(--bg-card)' : 'transparent', color: mode === m ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {m === 'auto' ? '自动汇总' : '手填进度'}
                </button>
              ))}
            </div>
            {mode === 'manual' ? (
              <label className="text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                <input type="range" min={0} max={100} disabled={!canWrite} value={draft.progress ?? 0} onChange={(e) => setDraft((d) => ({ ...d, progress: Number(e.target.value) }))} />
                <span className="w-9 text-right tabular-nums">{draft.progress ?? 0}%</span>
              </label>
            ) : (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>由子目标 / 关联里程碑自动汇总</span>
            )}
          </div>
          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>状态</label>
          <select value={draft.status || 'on_track'} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as PmGoalStatus }))} className={inputCls} style={inputStyle}>
            {STATUS_KEYS.map((s) => <option key={s} value={s}>{GOAL_STATUS_REGISTRY[s].label}</option>)}
          </select>

          {!isCreate && canWrite && (
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <Button variant="ghost" size="sm" onClick={() => onDecompose?.(goal!)} disabled={!canHaveChildren}><Sparkles size={13} />AI 拆细</Button>
              <Button variant="ghost" size="sm" onClick={() => onAddChild?.(goal!)} disabled={!canHaveChildren}><Plus size={13} />加子目标</Button>
              <Button variant="ghost" size="sm" onClick={remove}><Trash2 size={13} />删除</Button>
            </div>
          )}
        </div>

        {canWrite && (
          <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={save} disabled={saving}>{saving ? <MapSpinner size={14} /> : <Check size={14} />}保存</Button>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(drawer, document.body);
}
