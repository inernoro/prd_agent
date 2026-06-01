import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, ArrowRight, CircleUser, Target, ListTodo, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  listPmDecisions, createPmDecision, updatePmDecision, deletePmDecision, listPmRisks, createPmRisk,
} from '@/services';
import type { PmDecision, PmDecisionType, PmGoal, PmTask, PmRisk } from '@/services/contracts/pmAgent';
import { DECISION_TYPE_REGISTRY, DECISION_COLUMNS, riskScore, riskScoreColor } from './pmConstants';

interface Props {
  projectId: string;
  /** 项目目标（供决策关联，仅团队目标可关联） */
  goals: PmGoal[];
  /** 项目任务（供决策关联） */
  tasks: PmTask[];
  /** 是否可登记风险（项目成员） */
  canManageRisk?: boolean;
}

function fmtTime(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 一个状态列里的下一个流转目标（用于「移到下一态」快捷按钮） */
const NEXT_TYPE: Record<PmDecisionType, PmDecisionType | null> = {
  pending: 'decided',
  decided: 'memo',
  memo: null,
};

/**
 * 项目决策事项 — 三态分栏（待决策 / 已决策 / 备忘）。
 * 支持新建、内联编辑、状态流转（转入已决策落定案人/时间）、删除。
 */
export function DecisionsPanel({ projectId, goals, tasks, canManageRisk }: Props) {
  const [items, setItems] = useState<PmDecision[]>([]);
  const [risks, setRisks] = useState<PmRisk[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 编辑态：existing decision id，或 `new:{type}` 表示在某列新建
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftGoalIds, setDraftGoalIds] = useState<string[]>([]);
  const [draftTaskIds, setDraftTaskIds] = useState<string[]>([]);

  const teamGoals = useMemo(() => goals.filter((g) => g.scope === 'team'), [goals]);
  const goalTitle = useCallback((id: string) => goals.find((g) => g.id === id)?.title ?? '已删除目标', [goals]);
  const taskTitle = useCallback((id: string) => tasks.find((t) => t.id === id)?.title ?? '已删除任务', [tasks]);

  const load = useCallback(async () => {
    const res = await listPmDecisions(projectId);
    if (res.success) setItems(res.data.items);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const loadRisks = useCallback(async () => {
    const res = await listPmRisks(projectId);
    if (res.success) setRisks(res.data.items);
  }, [projectId]);
  useEffect(() => { loadRisks(); }, [loadRisks]);

  const risksByDecision = useMemo(() => {
    const m: Record<string, PmRisk[]> = {};
    for (const r of risks) if (r.relatedDecisionId) (m[r.relatedDecisionId] ??= []).push(r);
    return m;
  }, [risks]);

  const registerRisk = async (d: PmDecision) => {
    setBusyId(`risk:${d.id}`);
    const res = await createPmRisk(projectId, {
      title: d.title, description: d.content?.trim() || undefined,
      probability: 'medium', impact: 'medium', response: 'open', status: 'open',
      relatedDecisionId: d.id, relatedGoalId: d.relatedGoalIds?.[0], relatedTaskId: d.relatedTaskIds?.[0],
    });
    setBusyId(null);
    if (res.success) { toast.success('已登记关联风险', '去「风险」Tab 完善概率/影响/应对'); await loadRisks(); }
    else toast.error('登记失败', res.error?.message || '');
  };

  const grouped = useMemo(() => {
    const m: Record<PmDecisionType, PmDecision[]> = { pending: [], decided: [], memo: [] };
    for (const d of items) (m[d.type] ?? m.pending).push(d);
    return m;
  }, [items]);

  const startCreate = (type: PmDecisionType) => { setEditing(`new:${type}`); setDraftTitle(''); setDraftContent(''); setDraftGoalIds([]); setDraftTaskIds([]); };
  const startEdit = (d: PmDecision) => { setEditing(d.id); setDraftTitle(d.title); setDraftContent(d.content || ''); setDraftGoalIds(d.relatedGoalIds ?? []); setDraftTaskIds(d.relatedTaskIds ?? []); };
  const cancelEdit = () => { setEditing(null); setDraftTitle(''); setDraftContent(''); setDraftGoalIds([]); setDraftTaskIds([]); };

  const toggleGoal = (id: string) => setDraftGoalIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const addTask = (id: string) => { if (id && !draftTaskIds.includes(id)) setDraftTaskIds((prev) => [...prev, id]); };
  const removeTask = (id: string) => setDraftTaskIds((prev) => prev.filter((x) => x !== id));

  const saveDraft = async () => {
    if (!draftTitle.trim()) { toast.error('请填写决策标题', ''); return; }
    if (!editing) return;
    setBusyId(editing);
    if (editing.startsWith('new:')) {
      const type = editing.slice(4) as PmDecisionType;
      const res = await createPmDecision(projectId, { title: draftTitle.trim(), content: draftContent.trim() || undefined, type, relatedGoalIds: draftGoalIds, relatedTaskIds: draftTaskIds });
      if (res.success) { toast.success('已新增', ''); cancelEdit(); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    } else {
      const res = await updatePmDecision(editing, { title: draftTitle.trim(), content: draftContent.trim(), relatedGoalIds: draftGoalIds, relatedTaskIds: draftTaskIds });
      if (res.success) { toast.success('已保存', ''); cancelEdit(); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    }
    setBusyId(null);
  };

  const moveTo = async (d: PmDecision, type: PmDecisionType) => {
    setBusyId(d.id);
    const res = await updatePmDecision(d.id, { type });
    if (res.success) await load();
    else toast.error('操作失败', res.error?.message || '');
    setBusyId(null);
  };

  const handleDelete = async (d: PmDecision) => {
    if (!window.confirm(`确定删除决策「${d.title}」？`)) return;
    setBusyId(d.id);
    const res = await deletePmDecision(d.id);
    if (res.success) { setItems((prev) => prev.filter((x) => x.id !== d.id)); }
    else toast.error('删除失败', res.error?.message || '');
    setBusyId(null);
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载决策事项…" /></div>;

  const renderEditor = (key: string) => (
    <div className="rounded-lg border p-2.5 flex flex-col gap-2" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-elevated)' }}>
      <input autoFocus value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="决策标题"
        className="w-full text-[13px] rounded-md px-2 py-1.5 outline-none border"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
      <textarea value={draftContent} onChange={(e) => setDraftContent(e.target.value)} placeholder="背景 / 决策内容 / 影响（可选）" rows={3}
        className="w-full text-[12px] rounded-md px-2 py-1.5 outline-none border resize-y"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />

      {/* 关联目标：团队目标可切换 chip */}
      {teamGoals.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10.5px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Target size={11} />关联目标</div>
          <div className="flex flex-wrap gap-1">
            {teamGoals.map((g) => {
              const on = draftGoalIds.includes(g.id);
              return (
                <button key={g.id} type="button" onClick={() => toggleGoal(g.id)}
                  className="text-[11px] px-1.5 py-0.5 rounded-md border max-w-[160px] truncate"
                  style={{ borderColor: on ? '#10B981' : 'var(--border-subtle)', background: on ? 'rgba(16,185,129,0.12)' : 'transparent', color: on ? '#10B981' : 'var(--text-secondary)' }}
                  title={g.title}>{g.title}</button>
              );
            })}
          </div>
        </div>
      )}

      {/* 关联任务：下拉添加 + 可移除 chip */}
      <div className="flex flex-col gap-1">
        <div className="text-[10.5px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><ListTodo size={11} />关联任务</div>
        <select value="" onChange={(e) => { addTask(e.target.value); e.currentTarget.selectedIndex = 0; }}
          className="w-full text-[12px] rounded-md px-2 py-1.5 outline-none border"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
          <option value="">+ 添加关联任务…</option>
          {tasks.filter((t) => !draftTaskIds.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        {draftTaskIds.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {draftTaskIds.map((id) => (
              <span key={id} className="text-[11px] px-1.5 py-0.5 rounded-md border inline-flex items-center gap-1 max-w-[180px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-secondary)' }} title={taskTitle(id)}>
                <span className="truncate">{taskTitle(id)}</span>
                <button type="button" onClick={() => removeTask(id)} className="shrink-0 hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={cancelEdit}><X size={13} />取消</Button>
        <Button variant="primary" size="sm" onClick={saveDraft} disabled={busyId === key}>
          {busyId === key ? <MapSpinner size={13} /> : <Check size={13} />}保存
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>决策事项</div>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>记录项目推进中的关键决策与待办判断（待决策 / 已决策 / 备忘）</span>
      </div>

      <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {DECISION_COLUMNS.map((type) => {
          const cfg = DECISION_TYPE_REGISTRY[type];
          const list = grouped[type];
          const creatingHere = editing === `new:${type}`;
          return (
            <div key={type} className="flex flex-col min-h-0 rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
              <div className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="w-2 h-2 rounded-full" style={{ background: cfg.color }} />
                <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>{cfg.label}</span>
                <span className="text-[11px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{list.length}</span>
                <button onClick={() => startCreate(type)} className="ml-auto p-1 rounded hover:opacity-80" title="新建" style={{ color: cfg.color }}><Plus size={15} /></button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2" style={{ overscrollBehavior: 'contain' }}>
                {creatingHere && renderEditor(`new:${type}`)}

                {list.length === 0 && !creatingHere ? (
                  <div className="text-[11px] text-center py-6 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                    {cfg.desc}
                  </div>
                ) : (
                  list.map((d) => (
                    editing === d.id ? (
                      <div key={d.id}>{renderEditor(d.id)}</div>
                    ) : (
                      <div key={d.id} className="group rounded-lg border p-2.5 flex flex-col gap-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}>
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0 text-[13px] font-medium break-words" style={{ color: 'var(--text-primary)' }}>{d.title}</div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                            <button onClick={() => startEdit(d)} className="p-1 rounded" title="编辑" style={{ color: 'var(--text-muted)' }}><Pencil size={13} /></button>
                            <button onClick={() => handleDelete(d)} className="p-1 rounded" title="删除" style={{ color: 'var(--text-muted)' }} disabled={busyId === d.id}><Trash2 size={13} /></button>
                          </div>
                        </div>
                        {d.content && <div className="text-[11.5px] whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{d.content}</div>}
                        {((d.relatedGoalIds?.length ?? 0) > 0 || (d.relatedTaskIds?.length ?? 0) > 0) && (
                          <div className="flex flex-wrap gap-1">
                            {(d.relatedGoalIds ?? []).map((gid) => (
                              <span key={`g-${gid}`} className="text-[10.5px] px-1.5 py-0.5 rounded inline-flex items-center gap-1 max-w-[150px]"
                                style={{ background: 'rgba(16,185,129,0.12)', color: '#10B981' }} title={goalTitle(gid)}>
                                <Target size={10} className="shrink-0" /><span className="truncate">{goalTitle(gid)}</span>
                              </span>
                            ))}
                            {(d.relatedTaskIds ?? []).map((tid) => (
                              <span key={`t-${tid}`} className="text-[10.5px] px-1.5 py-0.5 rounded inline-flex items-center gap-1 max-w-[150px]"
                                style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }} title={taskTitle(tid)}>
                                <ListTodo size={10} className="shrink-0" /><span className="truncate">{taskTitle(tid)}</span>
                              </span>
                            ))}
                          </div>
                        )}
                        {(risksByDecision[d.id]?.length ?? 0) > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {risksByDecision[d.id].map((r) => {
                              const sc = riskScore(r.probability, r.impact);
                              return (
                                <span key={r.id} className="text-[10.5px] px-1.5 py-0.5 rounded inline-flex items-center gap-1 max-w-[160px]"
                                  style={{ background: `${riskScoreColor(sc)}22`, color: riskScoreColor(sc) }} title={`衍生风险 · 风险值 ${sc}`}>
                                  <ShieldAlert size={10} className="shrink-0" /><span className="truncate">{r.title}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {d.type === 'decided' && d.decidedByName && (
                          <div className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                            <CircleUser size={11} />定案：{d.decidedByName} · {fmtTime(d.decidedAt)}
                          </div>
                        )}
                        {canManageRisk && (
                          <button onClick={() => registerRisk(d)} disabled={busyId === `risk:${d.id}`}
                            className="self-start mt-0.5 text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
                            style={{ borderColor: 'var(--border-subtle)', color: '#EF4444' }} title="据此决策登记一条风险（自动回链本决策）">
                            {busyId === `risk:${d.id}` ? <MapSpinner size={11} /> : <ShieldAlert size={11} />}据此登记风险
                          </button>
                        )}
                        {NEXT_TYPE[type] && (
                          <button onClick={() => moveTo(d, NEXT_TYPE[type]!)} disabled={busyId === d.id}
                            className="self-start mt-0.5 text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
                            style={{ borderColor: 'var(--border-subtle)', color: DECISION_TYPE_REGISTRY[NEXT_TYPE[type]!].color }}>
                            {busyId === d.id ? <MapSpinner size={11} /> : <ArrowRight size={11} />}转「{DECISION_TYPE_REGISTRY[NEXT_TYPE[type]!].label}」
                          </button>
                        )}
                      </div>
                    )
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
