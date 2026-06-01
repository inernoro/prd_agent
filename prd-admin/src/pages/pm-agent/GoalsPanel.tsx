import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, Target, Lock, Users, Compass, Flag, Sparkles, ChevronRight, ChevronDown, GitBranch, Network, List } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  listPmGoals, createPmGoal, updatePmGoal, deletePmGoal, listPmMilestones,
} from '@/services';
import type { PmGoal, PmGoalScope, PmGoalStatus, SavePmGoalInput, PmMilestone } from '@/services/contracts/pmAgent';
import { GOAL_STATUS_REGISTRY, GOAL_SCOPE, MILESTONE_HEALTH_REGISTRY, GOAL_MAX_DEPTH } from './pmConstants';
import { GoalsCanvas } from './goals-canvas/GoalsCanvas';
import { GoalDecomposePanel } from './GoalDecomposePanel';

interface Props {
  projectId: string;
  /** 项目业务目标（北极星，来自立项） */
  businessGoal: string;
  /** 是否可管理团队目标（owner/leader） */
  canManage: boolean;
  /** 目标画布反查列表点击跳转 */
  onNavigateTask?: (taskId: string) => void;
  onNavigateWeekly?: (reportId: string) => void;
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
export function GoalsPanel({ projectId, businessGoal, canManage, onNavigateTask, onNavigateWeekly }: Props) {
  const [goals, setGoals] = useState<PmGoal[]>([]);
  const [milestones, setMilestones] = useState<PmMilestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // null | `new:{scope}:{parentId|root}` | id
  const [draft, setDraft] = useState<SavePmGoalInput>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'canvas' | 'list'>('canvas');
  // AI 拆解目标：null=未打开；{scope} 项目级拆顶层；{parentGoalId,...} 针对某目标拆子目标
  const [aiTarget, setAiTarget] = useState<{ parentGoalId?: string; parentTitle?: string; scope: PmGoalScope } | null>(null);

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

  // 父子树映射：parentId -> 子目标列表（按 orderKey），以及全量 id 集合（判断孤儿根）
  const childrenByParent = useMemo(() => {
    const m = new Map<string, PmGoal[]>();
    for (const g of goals) {
      if (g.parentId) {
        const arr = m.get(g.parentId) ?? [];
        arr.push(g);
        m.set(g.parentId, arr);
      }
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.orderKey ?? 0) - (b.orderKey ?? 0));
    return m;
  }, [goals]);
  const idSet = useMemo(() => new Set(goals.map((g) => g.id)), [goals]);
  const rootsOf = useCallback(
    (scope: PmGoalScope) => grouped[scope]
      .filter((g) => !g.parentId || !idSet.has(g.parentId))
      .sort((a, b) => (a.orderKey ?? 0) - (b.orderKey ?? 0)),
    [grouped, idSet],
  );
  const toggleExpand = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const sortedMilestones = useMemo(
    () => [...milestones].sort((a, b) => (a.dueAt || '').localeCompare(b.dueAt || '')),
    [milestones],
  );

  const startCreate = (scope: PmGoalScope, parentId?: string) => {
    setEditing(`new:${scope}:${parentId ?? 'root'}`);
    setDraft({ scope, parentId, status: 'on_track', progress: 0, progressMode: 'auto' });
    if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
  };
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
    const hasChildren = (childrenByParent.get(g.id)?.length ?? 0) > 0;
    const msg = hasChildren
      ? `确定删除目标「${g.title}」？将一并删除其下所有子目标。`
      : `确定删除目标「${g.title}」？`;
    if (!window.confirm(msg)) return;
    setBusyId(g.id);
    const res = await deletePmGoal(g.id);
    if (res.success) { await load(); } // 级联删子树，重新拉取以反映整棵子树移除
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

  const renderCard = (g: PmGoal, canWrite: boolean, depth: number) => {
    if (editing === g.id) return renderEditor(g.id);
    const st = GOAL_STATUS_REGISTRY[g.status];
    const canHaveChildren = depth + 1 < GOAL_MAX_DEPTH;
    return (
      <div className="group rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              {depth > 0 && (
                <span className="text-[9.5px] px-1 py-0.5 rounded shrink-0 tabular-nums" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>L{depth + 1}</span>
              )}
              <span className="text-[13px] font-medium break-words" style={{ color: 'var(--text-primary)' }}>{g.title}</span>
            </div>
            {g.description && <div className="text-[11.5px] mt-0.5 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{g.description}</div>}
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${st.color}22`, color: st.color }}>{st.label}</span>
          {canWrite && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
              <button onClick={() => setAiTarget({ parentGoalId: g.id, parentTitle: g.title, scope: g.scope })} className="p-1 rounded disabled:opacity-30" title={canHaveChildren ? 'AI 拆细为子目标' : '已达最大层级'} style={{ color: '#F59E0B' }} disabled={!canHaveChildren}><Sparkles size={13} /></button>
              <button onClick={() => startCreate(g.scope, g.id)} className="p-1 rounded disabled:opacity-30" title={canHaveChildren ? '加子目标' : '已达最大层级'} style={{ color: 'var(--text-muted)' }} disabled={!canHaveChildren}><Plus size={13} /></button>
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

  // 递归渲染目标节点：缩进 + 展开/折叠 + 子目标内联新增
  const renderNode = (g: PmGoal, depth: number, canWrite: boolean) => {
    const kids = childrenByParent.get(g.id) ?? [];
    const hasKids = kids.length > 0;
    const isOpen = expanded.has(g.id);
    const creatingChild = editing === `new:${g.scope}:${g.id}`;
    return (
      <div key={g.id} className="flex flex-col gap-2">
        <div className="flex items-stretch gap-1.5" style={{ marginLeft: depth * 18 }}>
          <div className="shrink-0 flex items-start pt-3" style={{ width: 16, color: 'var(--text-muted)' }}>
            {hasKids ? (
              <button onClick={() => toggleExpand(g.id)} title={isOpen ? '折叠' : '展开'}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : depth > 0 ? <GitBranch size={12} style={{ opacity: 0.5 }} /> : null}
          </div>
          <div className="flex-1 min-w-0">{renderCard(g, canWrite, depth)}</div>
        </div>
        {creatingChild && <div style={{ marginLeft: (depth + 1) * 18 + 22 }}>{renderEditor(`new:${g.scope}:${g.id}`)}</div>}
        {hasKids && isOpen && kids.map((c) => renderNode(c, depth + 1, canWrite))}
      </div>
    );
  };

  const section = (scope: PmGoalScope, icon: typeof Target, canWrite: boolean, withAi = false) => {
    const Icon = icon;
    const roots = rootsOf(scope);
    const creating = editing === `new:${scope}:root`;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon size={15} style={{ color: scope === 'team' ? '#3B82F6' : '#A855F7' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{GOAL_SCOPE[scope].label}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{GOAL_SCOPE[scope].desc}</span>
          {canWrite && (
            <div className="ml-auto flex items-center gap-1.5">
              {withAi && <Button variant="ghost" size="sm" onClick={() => setAiTarget({ scope })}><Sparkles size={13} />AI 拆目标</Button>}
              <Button variant="ghost" size="sm" onClick={() => startCreate(scope)}><Plus size={13} />新增</Button>
            </div>
          )}
        </div>
        {creating && renderEditor(`new:${scope}:root`)}
        {roots.length === 0 && !creating ? (
          <div className="text-[11px] text-center py-5 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
            {scope === 'team' ? (canWrite ? '还没有团队目标，点「新增」围绕业务目标设定共同目标，或用「AI 拆目标」一键生成' : '还没有团队目标') : '还没有个人目标，点「新增」设定只有你能看到的计划'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {roots.map((g) => renderNode(g, 0, canWrite))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 视图切换：画布（思维导图）/ 列表（缩进树） */}
      <div className="flex items-center gap-2 pb-3 shrink-0">
        <div className="flex gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
          {([['canvas', '画布', Network], ['list', '列表', List]] as const).map(([k, label, Ic]) => (
            <button key={k} onClick={() => setView(k)} className="px-2.5 py-1 rounded text-[12px] flex items-center gap-1"
              style={{ background: view === k ? 'var(--bg-card)' : 'transparent', color: view === k ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              <Ic size={13} />{label}
            </button>
          ))}
        </div>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {view === 'canvas' ? '拖动平移 · ⌘/Ctrl+滚轮缩放 · 点节点编辑 · 节点上 AI 拆细' : '缩进树 · 逐卡 AI 拆细'}
        </span>
      </div>

      {view === 'canvas' ? (
        <GoalsCanvas projectId={projectId} businessGoal={businessGoal} canManage={canManage} goals={goals} onReload={load} onNavigateTask={onNavigateTask} onNavigateWeekly={onNavigateWeekly} />
      ) : (
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

      {aiTarget && (
        <GoalDecomposePanel projectId={projectId} businessGoal={businessGoal}
          parentGoalId={aiTarget.parentGoalId} parentTitle={aiTarget.parentTitle} scope={aiTarget.scope}
          onClose={() => setAiTarget(null)} onCreated={() => { setAiTarget(null); load(); }} />
      )}
      </div>
      )}
    </div>
  );
}
