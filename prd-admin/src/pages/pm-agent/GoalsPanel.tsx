import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, Target, Lock, Users, Compass, Flag, Sparkles } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  listPmGoals, createPmGoal, updatePmGoal, deletePmGoal, listPmMilestones,
} from '@/services';
import type { PmGoal, PmGoalScope, PmGoalStatus, SavePmGoalInput, PmMilestone } from '@/services/contracts/pmAgent';
import { GOAL_STATUS_REGISTRY, GOAL_SCOPE, MILESTONE_HEALTH_REGISTRY } from './pmConstants';
import { GoalDecomposePanel } from './GoalDecomposePanel';

interface Props {
  projectId: string;
  /** 项目业务目标（北极星，来自立项） */
  businessGoal: string;
  /** 是否可管理团队目标（owner/leader） */
  canManage: boolean;
}

const STATUS_KEYS: PmGoalStatus[] = ['on_track', 'at_risk', 'done', 'abandoned'];

function fmtDate(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 项目目标 —— 以业务目标为北极星，团队目标（全员可见）+ 我的个人目标（仅本人）。
 * 团队目标进度可由关联里程碑自动滚动（auto）或手填（manual）。团队目标写操作限项目经理。
 */
export function GoalsPanel({ projectId, businessGoal, canManage }: Props) {
  const [goals, setGoals] = useState<PmGoal[]>([]);
  const [milestones, setMilestones] = useState<PmMilestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // null | `new:team` | `new:personal` | id
  const [draft, setDraft] = useState<SavePmGoalInput>({});
  const [showAi, setShowAi] = useState(false);

  const load = useCallback(async () => {
    const [gr, mr] = await Promise.all([listPmGoals(projectId), listPmMilestones(projectId)]);
    if (gr.success) setGoals(gr.data.items); else toast.error('加载失败', gr.error?.message || '');
    if (mr.success) setMilestones(mr.data.items);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => ({
    team: goals.filter((g) => g.scope === 'team'),
    personal: goals.filter((g) => g.scope === 'personal'),
  }), [goals]);

  const sortedMilestones = useMemo(
    () => [...milestones].sort((a, b) => (a.dueAt || '').localeCompare(b.dueAt || '')),
    [milestones],
  );

  const startCreate = (scope: PmGoalScope) => { setEditing(`new:${scope}`); setDraft({ scope, status: 'on_track', progress: 0, progressMode: 'auto' }); };
  const startEdit = (g: PmGoal) => { setEditing(g.id); setDraft({ title: g.title, description: g.description || '', metric: g.metric || '', period: g.period || '', progress: g.progress, progressMode: g.progressMode, status: g.status }); };
  const cancelEdit = () => { setEditing(null); setDraft({}); };

  const saveDraft = async () => {
    if (!draft.title?.trim()) { toast.error('请填写目标标题', ''); return; }
    if (!editing) return;
    setBusyId(editing);
    const res = editing.startsWith('new:') ? await createPmGoal(projectId, draft) : await updatePmGoal(editing, draft);
    if (res.success) { toast.success(editing.startsWith('new:') ? '已新增' : '已保存', ''); cancelEdit(); await load(); }
    else toast.error('保存失败', res.error?.message || '');
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

  const renderEditor = (key: string) => {
    const mode = draft.progressMode ?? 'auto';
    return (
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
          {/* 进度模式：auto 由里程碑滚动 / manual 手填 */}
          <div className="flex gap-1 rounded-md p-0.5" style={{ background: 'var(--bg-base)' }}>
            {(['auto', 'manual'] as const).map((m) => (
              <button key={m} onClick={() => setDraft((d) => ({ ...d, progressMode: m }))}
                className="px-2 py-1 rounded text-[11px]" style={{ background: mode === m ? 'var(--bg-card)' : 'transparent', color: mode === m ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {m === 'auto' ? '里程碑滚动' : '手填进度'}
              </button>
            ))}
          </div>
          {mode === 'manual' ? (
            <label className="text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
              进度
              <input type="range" min={0} max={100} value={draft.progress ?? 0} onChange={(e) => setDraft((d) => ({ ...d, progress: Number(e.target.value) }))} />
              <span className="w-9 text-right tabular-nums">{draft.progress ?? 0}%</span>
            </label>
          ) : (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>进度由关联里程碑的任务完成度自动计算</span>
          )}
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
  };

  const renderCard = (g: PmGoal, canWrite: boolean) => {
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
          {canWrite && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
              <button onClick={() => startEdit(g)} className="p-1 rounded" title="编辑" style={{ color: 'var(--text-muted)' }}><Pencil size={13} /></button>
              <button onClick={() => handleDelete(g)} className="p-1 rounded" title="删除" style={{ color: 'var(--text-muted)' }} disabled={busyId === g.id}><Trash2 size={13} /></button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
            <div style={{ width: `${g.progress}%`, height: '100%', background: st.color }} />
          </div>
          <span className="text-[11px] tabular-nums w-9 text-right" style={{ color: 'var(--text-muted)' }}>{g.progress}%</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
          {g.progressMode === 'auto'
            ? <span className="inline-flex items-center gap-1"><Flag size={10} />里程碑滚动{g.linkedMilestoneCount ? ` · 关联 ${g.linkedMilestoneCount}` : '（未关联）'}</span>
            : <span>手填进度</span>}
          {g.metric && <span className="truncate">指标：{g.metric}</span>}
          {g.period && <span className="shrink-0">周期：{g.period}</span>}
        </div>
      </div>
    );
  };

  const section = (scope: PmGoalScope, icon: typeof Target, canWrite: boolean, withAi = false) => {
    const Icon = icon;
    const list = grouped[scope];
    const creating = editing === `new:${scope}`;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon size={15} style={{ color: scope === 'team' ? '#3B82F6' : '#A855F7' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{GOAL_SCOPE[scope].label}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{GOAL_SCOPE[scope].desc}</span>
          {canWrite && (
            <div className="ml-auto flex items-center gap-1.5">
              {withAi && <Button variant="ghost" size="sm" onClick={() => setShowAi(true)}><Sparkles size={13} />AI 拆目标</Button>}
              <Button variant="ghost" size="sm" onClick={() => startCreate(scope)}><Plus size={13} />新增</Button>
            </div>
          )}
        </div>
        {creating && renderEditor(`new:${scope}`)}
        {list.length === 0 && !creating ? (
          <div className="text-[11px] text-center py-5 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
            {scope === 'team' ? (canWrite ? '还没有团队目标，点「新增」围绕业务目标设定共同目标' : '还没有团队目标') : '还没有个人目标，点「新增」设定只有你能看到的计划'}
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {list.map((g) => renderCard(g, canWrite))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-5 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      {/* 业务目标北极星 */}
      <div className="rounded-xl border p-4" style={{ borderColor: 'rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.06)' }}>
        <div className="flex items-center gap-2 mb-1">
          <Compass size={15} style={{ color: '#F59E0B' }} />
          <span className="text-[12px] font-semibold" style={{ color: '#F59E0B' }}>项目业务目标（北极星）</span>
        </div>
        <div className="text-[14px]" style={{ color: 'var(--text-primary)' }}>{businessGoal || '立项时未填写业务目标'}</div>
      </div>

      {/* 里程碑时间轴 */}
      {sortedMilestones.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Flag size={14} style={{ color: '#A855F7' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>里程碑时间轴</span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>在「任务 - 甘特图」里管理</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1" style={{ overscrollBehavior: 'contain' }}>
            {sortedMilestones.map((m) => {
              const h = MILESTONE_HEALTH_REGISTRY[m.health];
              return (
                <div key={m.id} className="shrink-0 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', minWidth: 150 }}>
                  <div className="flex items-center gap-1.5">
                    <span style={{ width: 9, height: 9, background: h.color, transform: 'rotate(45deg)', display: 'inline-block', borderRadius: 2 }} />
                    <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>{m.title}</span>
                  </div>
                  <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    {m.dueAt ? `${fmtDate(m.dueAt)} · ` : ''}{m.progress}% · <span style={{ color: h.color }}>{h.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {section('team', Users, canManage, true)}
      {section('personal', Lock, true)}

      {showAi && (
        <GoalDecomposePanel projectId={projectId} businessGoal={businessGoal}
          onClose={() => setShowAi(false)} onCreated={() => { setShowAi(false); load(); }} />
      )}
    </div>
  );
}
