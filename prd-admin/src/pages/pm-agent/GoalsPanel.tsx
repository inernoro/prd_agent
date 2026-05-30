import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, Target, Lock, Users } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  listPmGoals, createPmGoal, updatePmGoal, deletePmGoal,
} from '@/services';
import type { PmGoal, PmGoalScope, PmGoalStatus, SavePmGoalInput } from '@/services/contracts/pmAgent';
import { GOAL_STATUS_REGISTRY, GOAL_SCOPE } from './pmConstants';

interface Props {
  projectId: string;
}

const STATUS_KEYS: PmGoalStatus[] = ['on_track', 'at_risk', 'done', 'abandoned'];

/**
 * 项目目标 / 计划 — 团队目标（全员可见）+ 我的个人目标（仅本人，后端隔离）。
 */
export function GoalsPanel({ projectId }: Props) {
  const [goals, setGoals] = useState<PmGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // null | `new:team` | `new:personal` | id
  const [draft, setDraft] = useState<SavePmGoalInput>({});

  const load = useCallback(async () => {
    const res = await listPmGoals(projectId);
    if (res.success) setGoals(res.data.items);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => ({
    team: goals.filter((g) => g.scope === 'team'),
    personal: goals.filter((g) => g.scope === 'personal'),
  }), [goals]);

  const startCreate = (scope: PmGoalScope) => { setEditing(`new:${scope}`); setDraft({ scope, status: 'on_track', progress: 0 }); };
  const startEdit = (g: PmGoal) => { setEditing(g.id); setDraft({ title: g.title, description: g.description || '', metric: g.metric || '', period: g.period || '', progress: g.progress, status: g.status }); };
  const cancelEdit = () => { setEditing(null); setDraft({}); };

  const saveDraft = async () => {
    if (!draft.title?.trim()) { toast.error('请填写目标标题', ''); return; }
    if (!editing) return;
    setBusyId(editing);
    if (editing.startsWith('new:')) {
      const res = await createPmGoal(projectId, draft);
      if (res.success) { toast.success('已新增', ''); cancelEdit(); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    } else {
      const res = await updatePmGoal(editing, draft);
      if (res.success) { toast.success('已保存', ''); cancelEdit(); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    }
    setBusyId(null);
  };

  const handleDelete = async (g: PmGoal) => {
    if (!window.confirm(`确定删除目标「${g.title}」？`)) return;
    setBusyId(g.id);
    const res = await deletePmGoal(g.id);
    if (res.success) setGoals((prev) => prev.filter((x) => x.id !== g.id));
    else toast.error('删除失败', res.error?.message || '');
    setBusyId(null);
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载目标…" /></div>;

  const renderEditor = (key: string) => (
    <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-elevated)' }}>
      <input autoFocus value={draft.title || ''} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} placeholder="目标标题"
        className="w-full text-[13px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
      <textarea value={draft.description || ''} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="目标描述（可选）" rows={2}
        className="w-full text-[12px] rounded-md px-2 py-1.5 outline-none border resize-y" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
      <div className="flex gap-2 flex-wrap">
        <input value={draft.metric || ''} onChange={(e) => setDraft((d) => ({ ...d, metric: e.target.value }))} placeholder="衡量指标 / 关键结果"
          className="flex-1 min-w-[140px] text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
        <input value={draft.period || ''} onChange={(e) => setDraft((d) => ({ ...d, period: e.target.value }))} placeholder="周期（如 2026 Q2）"
          className="w-[140px] text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          进度
          <input type="range" min={0} max={100} value={draft.progress ?? 0} onChange={(e) => setDraft((d) => ({ ...d, progress: Number(e.target.value) }))} />
          <span className="w-9 text-right tabular-nums">{draft.progress ?? 0}%</span>
        </label>
        <select value={draft.status || 'on_track'} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as PmGoalStatus }))}
          className="text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
          {STATUS_KEYS.map((s) => <option key={s} value={s}>{GOAL_STATUS_REGISTRY[s].label}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={cancelEdit}><X size={13} />取消</Button>
          <Button variant="primary" size="sm" onClick={saveDraft} disabled={busyId === key}>{busyId === key ? <MapSpinner size={13} /> : <Check size={13} />}保存</Button>
        </div>
      </div>
    </div>
  );

  const renderCard = (g: PmGoal) => {
    if (editing === g.id) return <div key={g.id}>{renderEditor(g.id)}</div>;
    const st = GOAL_STATUS_REGISTRY[g.status];
    return (
      <div key={g.id} className="group rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium break-words" style={{ color: 'var(--text-primary)' }}>{g.title}</div>
            {g.description && <div className="text-[11.5px] mt-0.5 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{g.description}</div>}
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${st.color}22`, color: st.color }}>{st.label}</span>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
            <button onClick={() => startEdit(g)} className="p-1 rounded" title="编辑" style={{ color: 'var(--text-muted)' }}><Pencil size={13} /></button>
            <button onClick={() => handleDelete(g)} className="p-1 rounded" title="删除" style={{ color: 'var(--text-muted)' }} disabled={busyId === g.id}><Trash2 size={13} /></button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
            <div style={{ width: `${g.progress}%`, height: '100%', background: st.color }} />
          </div>
          <span className="text-[11px] tabular-nums w-9 text-right" style={{ color: 'var(--text-muted)' }}>{g.progress}%</span>
        </div>
        {(g.metric || g.period) && (
          <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {g.metric && <span className="truncate">指标：{g.metric}</span>}
            {g.period && <span className="shrink-0">周期：{g.period}</span>}
          </div>
        )}
      </div>
    );
  };

  const section = (scope: PmGoalScope, icon: typeof Target) => {
    const Icon = icon;
    const list = grouped[scope];
    const creating = editing === `new:${scope}`;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon size={15} style={{ color: scope === 'team' ? '#3B82F6' : '#A855F7' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{GOAL_SCOPE[scope].label}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{GOAL_SCOPE[scope].desc}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => startCreate(scope)}><Plus size={13} />新增</Button>
        </div>
        {creating && renderEditor(`new:${scope}`)}
        {list.length === 0 && !creating ? (
          <div className="text-[11px] text-center py-5 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
            {scope === 'team' ? '还没有团队目标，点「新增」设定项目共同目标' : '还没有个人目标，点「新增」设定只有你能看到的计划'}
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {list.map(renderCard)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-5 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      {section('team', Users)}
      {section('personal', Lock)}
    </div>
  );
}
