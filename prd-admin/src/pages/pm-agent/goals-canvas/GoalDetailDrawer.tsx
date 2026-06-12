import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, Sparkles, Plus, Trash2, ListTodo, FileText, Gavel, User, Target, TrendingUp, Send, Compass, Award, CalendarRange, Flag } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import { createPmGoal, updatePmGoal, deletePmGoal, getPmProject, listPmMilestones, listPmWeeklyReports, listPmDecisions, listPmGoalCheckIns, addPmGoalCheckIn, scorePmGoal, listPmGoalCycles, setGoalAsMilestone } from '@/services';
import type { PmGoal, PmGoalScope, PmGoalStatus, SavePmGoalInput, PmTask, PmWeeklyReport, PmDecision, PmKeyResult, PmKeyResultType, PmGoalConfidence, PmGoalCheckIn, PmGoalCycle } from '@/services/contracts/pmAgent';
import { GOAL_STATUS_REGISTRY, TASK_STATUS_REGISTRY, DECISION_TYPE_REGISTRY } from '../pmConstants';

const STATUS_KEYS: PmGoalStatus[] = ['on_track', 'at_risk', 'done', 'abandoned'];
const KR_TYPES: { key: PmKeyResultType; label: string }[] = [
  { key: 'percent', label: '百分比' }, { key: 'number', label: '数值' }, { key: 'currency', label: '金额' }, { key: 'binary', label: '是/否' },
];
const CONFIDENCE_META: Record<PmGoalConfidence, { label: string; color: string }> = {
  high: { label: '信心高', color: '#10B981' }, medium: { label: '信心中', color: '#F59E0B' }, low: { label: '信心低', color: '#EF4444' },
};
let _krSeq = 0;
const newKid = () => `tmp-${Date.now()}-${_krSeq++}`;

function krProgress(kr: PmKeyResult): number {
  if (kr.type === 'binary') return kr.currentValue >= 1 ? 100 : 0;
  const span = kr.targetValue - kr.startValue;
  if (Math.abs(span) < 1e-9) return kr.currentValue >= kr.targetValue ? 100 : 0;
  return Math.round(Math.min(1, Math.max(0, (kr.currentValue - kr.startValue) / span)) * 100);
}
function fmtCi(s: string) { const d = new Date(s); return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

export interface DrawerCreateCtx { scope: PmGoalScope; parentId?: string; parentTitle?: string }

interface Props {
  projectId: string;
  /** 编辑现有目标 */
  goal?: PmGoal | null;
  /** 同项目全部目标（用于对齐路径面包屑） */
  allGoals?: PmGoal[];
  /** 项目业务目标（对齐顶层） */
  businessGoal?: string;
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
  /** 反查列表点击跳转：到任务详情 / 到周报 */
  onNavigateTask?: (taskId: string) => void;
  onNavigateWeekly?: (reportId: string) => void;
}

const inputCls = 'w-full text-[12.5px] rounded-md px-2.5 py-2 outline-none border';
const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' } as const;

export function GoalDetailDrawer({ projectId, goal, allGoals, businessGoal, createCtx, canWrite, onClose, onSaved, onDecompose, onAddChild, canHaveChildren, onNavigateTask, onNavigateWeekly }: Props) {
  const isCreate = !goal;
  const [draft, setDraft] = useState<SavePmGoalInput>({});
  const [leadId, setLeadId] = useState('');
  const [cycleId, setCycleId] = useState('');
  const [cycles, setCycles] = useState<PmGoalCycle[]>([]);
  const [krs, setKrs] = useState<PmKeyResult[]>([]);
  const [saving, setSaving] = useState(false);
  const [isMilestone, setIsMilestone] = useState(false);
  const [msToggling, setMsToggling] = useState(false);
  // 反查：关联任务（直接挂的 + 里程碑下的） + 提及本目标的周报 + 关联本目标的决策
  const [relTasks, setRelTasks] = useState<PmTask[]>([]);
  const [mentionReports, setMentionReports] = useState<PmWeeklyReport[]>([]);
  const [relDecisions, setRelDecisions] = useState<PmDecision[]>([]);
  // 进展 check-in
  const [checkins, setCheckins] = useState<PmGoalCheckIn[]>([]);
  const [ciNote, setCiNote] = useState('');
  const [ciConfidence, setCiConfidence] = useState<PmGoalConfidence | ''>('');
  const [ciProgress, setCiProgress] = useState('');
  const [ciSaving, setCiSaving] = useState(false);
  // 期末评分 / 复盘
  const [scoreVal, setScoreVal] = useState('');
  const [scoreNote, setScoreNote] = useState('');
  const [scoreSaving, setScoreSaving] = useState(false);

  useEffect(() => {
    if (goal) {
      setDraft({ title: goal.title, description: goal.description || '', metric: goal.metric || '', period: goal.period || '', progress: goal.progress, progressMode: goal.progressMode, status: goal.status });
      setLeadId(goal.leadId || '');
      setCycleId(goal.cycleId || '');
      setKrs((goal.keyResults ?? []).map((k) => ({ ...k })));
      setScoreVal(goal.score != null ? String(goal.score) : '');
      setScoreNote(goal.scoreNote || '');
      setIsMilestone(!!goal.isMilestone);
    } else if (createCtx) {
      setDraft({ scope: createCtx.scope, parentId: createCtx.parentId, status: 'on_track', progress: 0, progressMode: 'auto' });
      setLeadId(''); setCycleId(''); setKrs([]);
    }
  }, [goal, createCtx]);

  // 拉取周期（新建/编辑都可选周期）
  useEffect(() => {
    let alive = true;
    listPmGoalCycles(projectId).then((r) => { if (alive && r.success) setCycles(r.data.items); });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 加载目标侧反查（关联任务 + 提及周报 + 决策 + 进展 check-in）
  useEffect(() => {
    if (!goal) { setRelTasks([]); setMentionReports([]); setRelDecisions([]); setCheckins([]); return; }
    let alive = true;
    (async () => {
      const [pr, mr, wr, dr, ci] = await Promise.all([
        getPmProject(projectId), listPmMilestones(projectId), listPmWeeklyReports(projectId), listPmDecisions(projectId), listPmGoalCheckIns(goal.id),
      ]);
      if (!alive) return;
      if (pr.success && mr.success) {
        const goalMsIds = new Set(mr.data.items.filter((m) => m.goalId === goal.id).map((m) => m.id));
        setRelTasks(pr.data.tasks.filter((t) => t.goalId === goal.id || (t.milestoneId != null && goalMsIds.has(t.milestoneId))));
      }
      if (wr.success) setMentionReports(wr.data.items.filter((w) => (w.relatedGoalIds ?? []).includes(goal.id)));
      if (dr.success) setRelDecisions(dr.data.items.filter((d) => (d.relatedGoalIds ?? []).includes(goal.id)));
      if (ci.success) setCheckins(ci.data.items);
    })();
    return () => { alive = false; };
  }, [goal, projectId]);

  const mode = draft.progressMode ?? 'auto';
  const krAvg = krs.length > 0 ? Math.round(krs.reduce((s, k) => s + krProgress(k), 0) / krs.length) : null;

  // 对齐路径：从顶层目标到当前（不含当前），用于面包屑
  const alignChain = (() => {
    if (!goal || !allGoals) return [] as PmGoal[];
    const byId = new Map(allGoals.map((x) => [x.id, x]));
    const chain: PmGoal[] = [];
    let cur = goal.parentId ? byId.get(goal.parentId) : undefined;
    let guard = 0;
    while (cur && guard++ < 10) { chain.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return chain;
  })();

  const submitScore = async (clear = false) => {
    if (!goal) return;
    if (!clear && scoreVal === '') { toast.error('请选择评分', '0.0 - 1.0'); return; }
    setScoreSaving(true);
    const res = await scorePmGoal(goal.id, clear ? { clear: true } : { score: Number(scoreVal), note: scoreNote.trim() || undefined });
    setScoreSaving(false);
    if (res.success) { toast.success(clear ? '已清除评分' : '已评分', ''); onSaved(); }
    else toast.error('操作失败', res.error?.message || '');
  };

  const addKr = () => setKrs((p) => [...p, { id: newKid(), title: '', type: 'percent', startValue: 0, targetValue: 100, currentValue: 0 }]);
  const patchKr = (id: string, patch: Partial<PmKeyResult>) => setKrs((p) => p.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  const removeKr = (id: string) => setKrs((p) => p.filter((k) => k.id !== id));

  const save = async () => {
    if (!draft.title?.trim()) { toast.error('请填写目标标题', ''); return; }
    setSaving(true);
    const payload: SavePmGoalInput = {
      ...draft,
      leadId,
      cycleId,
      keyResults: krs.filter((k) => k.title.trim()).map((k) => ({
        id: k.id.startsWith('tmp-') ? undefined : k.id, title: k.title.trim(), type: k.type,
        startValue: k.startValue, targetValue: k.targetValue, currentValue: k.currentValue, unit: k.unit || undefined,
      })),
    };
    const res = isCreate ? await createPmGoal(projectId, payload) : await updatePmGoal(goal!.id, payload);
    setSaving(false);
    if (res.success) { toast.success(isCreate ? '已新增' : '已保存', ''); onSaved(); }
    else toast.error('保存失败', res.error?.message || '');
  };

  const submitCheckIn = async () => {
    if (!goal) return;
    if (!ciNote.trim() && !ciConfidence && !ciProgress) { toast.error('请填写进展说明、进度或信心', ''); return; }
    setCiSaving(true);
    const res = await addPmGoalCheckIn(goal.id, {
      note: ciNote.trim() || undefined,
      confidence: ciConfidence || undefined,
      progress: ciProgress ? Math.max(0, Math.min(100, Number(ciProgress))) : undefined,
    });
    setCiSaving(false);
    if (res.success) {
      setCheckins((p) => [res.data, ...p]);
      setCiNote(''); setCiConfidence(''); setCiProgress('');
      toast.success('已记录进展', '');
      onSaved();
    } else toast.error('提交失败', res.error?.message || '');
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

  const toggleMilestone = async () => {
    if (!goal) return;
    const next = !isMilestone;
    setMsToggling(true);
    const res = await setGoalAsMilestone(goal.id, next);
    setMsToggling(false);
    if (res.success) { setIsMilestone(res.data.isMilestone); toast.success(next ? '已设为里程碑' : '已取消里程碑', next ? '已在「里程碑」同步显示' : ''); onSaved(); }
    else toast.error('操作失败', res.error?.message || '');
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
          {/* 高频操作上移到头部常驻（用户反馈：埋在正文中部根本看不到）；删除收进底部危险区 */}
          {!isCreate && canWrite && (
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {onDecompose && <Button variant="ghost" size="sm" onClick={() => onDecompose(goal!)} disabled={!canHaveChildren} title={canHaveChildren ? 'AI 拆细为子目标' : '已达最大层级'}><Sparkles size={13} />AI 拆细</Button>}
              {onAddChild && <Button variant="ghost" size="sm" onClick={() => onAddChild(goal!)} disabled={!canHaveChildren} title={canHaveChildren ? '手动加子目标' : '已达最大层级'}><Plus size={13} />加子目标</Button>}
            </div>
          )}
          <button onClick={onClose} className={`${!isCreate && canWrite ? '' : 'ml-auto '}p-1 rounded hover:opacity-70 shrink-0`} style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {!canWrite && !isCreate && (
            <div className="text-[11px] rounded-md px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>只读：该目标仅项目经理 / 本人可编辑</div>
          )}
          {!isCreate && (businessGoal || alignChain.length > 0) && (
            <div className="text-[10.5px] flex items-center gap-1 flex-wrap rounded-md px-2 py-1.5" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }} title="对齐路径">
              <Compass size={11} style={{ color: '#3B82F6' }} />
              {businessGoal && <><span className="truncate" style={{ maxWidth: 140 }}>{businessGoal}</span><span>›</span></>}
              {alignChain.map((a) => <span key={a.id} className="inline-flex items-center gap-1"><span className="truncate" style={{ maxWidth: 110 }}>{a.title}</span><span>›</span></span>)}
              <span style={{ color: 'var(--text-secondary)' }}>本目标</span>
            </div>
          )}
          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>标题</label>
          <input autoFocus value={draft.title || ''} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} placeholder="目标标题" className={inputCls} style={inputStyle} />
          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>详细描述</label>
          <textarea value={draft.description || ''} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="目标的落地思路 / 可行性说明" rows={5} className={`${inputCls} resize-y`} style={{ ...inputStyle, minHeight: 120 }} />
          <div className="flex gap-2">
            <div className="flex-1 flex flex-col gap-1">
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>一句话指标（可选）</label>
              <input value={draft.metric || ''} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, metric: e.target.value }))} placeholder="如：核心指标达 95%" className={inputCls} style={inputStyle} />
            </div>
            <div className="w-[120px] flex flex-col gap-1">
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>周期(文本)</label>
              <input value={draft.period || ''} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, period: e.target.value }))} placeholder="2026 Q2" className={inputCls} style={inputStyle} />
            </div>
          </div>
          <label className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><CalendarRange size={11} />OKR 周期</label>
          <select value={cycleId} disabled={!canWrite} onChange={(e) => setCycleId(e.target.value)} className={inputCls} style={inputStyle}>
            <option value="">未归类</option>
            {cycles.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'closed' ? '（已归档）' : ''}</option>)}
          </select>

          {/* 设为里程碑：开启后在「里程碑」同步显示，避免重复创建（团队/个人目标都支持）。仅已保存的目标可设 */}
          {!isCreate && canWrite && (
            <div className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: isMilestone ? 'rgba(168,85,247,0.4)' : 'var(--border-subtle)', background: isMilestone ? 'rgba(168,85,247,0.08)' : 'transparent' }}>
              <div className="flex flex-col min-w-0 pr-2">
                <span className="text-[12px] inline-flex items-center gap-1" style={{ color: 'var(--text-primary)' }}><Flag size={12} style={{ color: '#A855F7' }} />设为里程碑</span>
                <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>开启后在「里程碑」同步显示，无需重复创建</span>
              </div>
              <button
                type="button"
                onClick={toggleMilestone}
                disabled={msToggling}
                role="switch"
                aria-checked={isMilestone}
                className="shrink-0 rounded-full transition-colors disabled:opacity-50"
                style={{ width: 38, height: 22, padding: 2, background: isMilestone ? '#A855F7' : 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
              >
                <span className="block rounded-full" style={{ width: 16, height: 16, background: '#fff', transform: isMilestone ? 'translateX(16px)' : 'translateX(0)', transition: 'transform .18s ease' }} />
              </button>
            </div>
          )}

          {/* 关键结果 KR（结构化、可量化） */}
          <div className="flex items-center gap-1.5">
            <Target size={12} style={{ color: '#3B82F6' }} />
            <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>关键结果 KR</span>
            {krAvg != null && <span className="text-[10.5px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>均值 {krAvg}%</span>}
          </div>
          <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>自动模式下有 KR 时，目标进度按 KR 完成度汇总（优先于任务滚动）。</div>
          <div className="flex flex-col gap-2">
            {krs.map((k) => {
              const p = krProgress(k);
              return (
                <div key={k.id} className="rounded-lg border p-2 flex flex-col gap-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                  <div className="flex items-center gap-1.5">
                    <input value={k.title} disabled={!canWrite} onChange={(e) => patchKr(k.id, { title: e.target.value })} placeholder="关键结果标题" className="flex-1 text-[12px] rounded-md px-2 py-1 outline-none border" style={inputStyle} />
                    <select value={k.type} disabled={!canWrite} onChange={(e) => patchKr(k.id, { type: e.target.value as PmKeyResultType })} className="text-[11px] rounded-md px-1 py-1 outline-none border" style={inputStyle}>
                      {KR_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                    {canWrite && <button onClick={() => removeKr(k.id)} style={{ color: 'var(--text-muted)' }}><Trash2 size={12} /></button>}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                    {k.type === 'binary' ? (
                      <label className="flex items-center gap-1"><input type="checkbox" disabled={!canWrite} checked={k.currentValue >= 1} onChange={(e) => patchKr(k.id, { currentValue: e.target.checked ? 1 : 0, targetValue: 1 })} />已完成</label>
                    ) : (
                      <>
                        <span>起</span><input type="number" disabled={!canWrite} value={k.startValue} onChange={(e) => patchKr(k.id, { startValue: Number(e.target.value) })} className="w-14 text-[11px] rounded px-1 py-0.5 outline-none border" style={inputStyle} />
                        <span>当前</span><input type="number" disabled={!canWrite} value={k.currentValue} onChange={(e) => patchKr(k.id, { currentValue: Number(e.target.value) })} className="w-14 text-[11px] rounded px-1 py-0.5 outline-none border" style={inputStyle} />
                        <span>目标</span><input type="number" disabled={!canWrite} value={k.targetValue} onChange={(e) => patchKr(k.id, { targetValue: Number(e.target.value) })} className="w-14 text-[11px] rounded px-1 py-0.5 outline-none border" style={inputStyle} />
                        <input value={k.unit || ''} disabled={!canWrite} onChange={(e) => patchKr(k.id, { unit: e.target.value })} placeholder="单位" className="w-12 text-[11px] rounded px-1 py-0.5 outline-none border" style={inputStyle} />
                      </>
                    )}
                    <span className="ml-auto tabular-nums" style={{ color: p === 100 ? '#10B981' : 'var(--text-secondary)' }}>{p}%</span>
                  </div>
                  <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}><div style={{ width: `${p}%`, height: '100%', background: p === 100 ? '#10B981' : '#3B82F6' }} /></div>
                </div>
              );
            })}
            {krs.length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无 KR，点下方添加</div>}
            {canWrite && <Button variant="ghost" size="sm" className="self-start" onClick={addKr}><Plus size={13} />添加 KR</Button>}
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
          <div className="flex gap-2">
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>状态</label>
              <select value={draft.status || 'on_track'} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as PmGoalStatus }))} className={inputCls} style={inputStyle}>
                {STATUS_KEYS.map((s) => <option key={s} value={s}>{GOAL_STATUS_REGISTRY[s].label}</option>)}
              </select>
            </div>
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <label className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><User size={11} />负责人</label>
              {canWrite
                ? <UserSearchSelect value={leadId} onChange={(uid) => setLeadId(uid || '')} placeholder="指派（可选）" />
                : <div className="text-[12.5px] px-2.5 py-2 rounded-md border" style={inputStyle}>{goal?.leadName || '未指派'}</div>}
            </div>
          </div>

          {!isCreate && (
            <div className="flex flex-col gap-3 pt-3 mt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              {/* 进展 check-in（更新 + 信心 + 讨论） */}
              <div className="flex flex-col gap-1.5">
                <div className="text-[11px] flex items-center gap-1" style={{ color: '#10B981' }}>
                  <TrendingUp size={12} />进展 / 信心（{checkins.length}）
                  {goal?.confidence && <span className="ml-1 px-1.5 rounded" style={{ background: `${CONFIDENCE_META[goal.confidence].color}22`, color: CONFIDENCE_META[goal.confidence].color }}>{CONFIDENCE_META[goal.confidence].label}</span>}
                </div>
                {canWrite && (
                  <div className="rounded-lg border p-2 flex flex-col gap-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                    <textarea value={ciNote} onChange={(e) => setCiNote(e.target.value)} placeholder="本次进展 / 阻塞 / 讨论…" rows={5} className="w-full text-[12px] rounded-md px-2 py-1.5 outline-none border resize-y" style={{ ...inputStyle, minHeight: 120 }} />
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <div className="flex gap-1 rounded-md p-0.5" style={{ background: 'var(--bg-base)' }}>
                        {(['high', 'medium', 'low'] as PmGoalConfidence[]).map((c) => (
                          <button key={c} onClick={() => setCiConfidence((cur) => cur === c ? '' : c)} className="px-1.5 py-0.5 rounded text-[10.5px]"
                            style={{ background: ciConfidence === c ? CONFIDENCE_META[c].color : 'transparent', color: ciConfidence === c ? '#fff' : CONFIDENCE_META[c].color }}>{CONFIDENCE_META[c].label}</button>
                        ))}
                      </div>
                      <input type="number" min={0} max={100} value={ciProgress} onChange={(e) => setCiProgress(e.target.value)} placeholder="进度%" className="w-16 text-[11px] rounded px-1.5 py-1 outline-none border" style={inputStyle} />
                      <Button variant="primary" size="sm" className="ml-auto" onClick={submitCheckIn} disabled={ciSaving}>{ciSaving ? <MapSpinner size={12} /> : <Send size={12} />}记录</Button>
                    </div>
                  </div>
                )}
                {checkins.length === 0 ? (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>还没有进展记录。定期 check-in 让目标进展与信心可追溯。</div>
                ) : checkins.slice(0, 20).map((c) => (
                  <div key={c.id} className="rounded-md px-2 py-1.5 flex flex-col gap-0.5" style={{ background: 'var(--bg-base)' }}>
                    <div className="flex items-center gap-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                      <span>{c.authorName || '成员'}</span>
                      {c.confidence && <span style={{ color: CONFIDENCE_META[c.confidence].color }}>{CONFIDENCE_META[c.confidence].label}</span>}
                      {typeof c.progress === 'number' && <span>进度 {c.progress}%</span>}
                      <span className="ml-auto">{fmtCi(c.createdAt)}</span>
                    </div>
                    {c.note && <div className="text-[12px] whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{c.note}</div>}
                  </div>
                ))}
              </div>
              {/* 期末评分 / 复盘（OKR 0.0-1.0） */}
              <div className="flex flex-col gap-1.5">
                <div className="text-[11px] flex items-center gap-1" style={{ color: '#F59E0B' }}>
                  <Award size={12} />期末评分 / 复盘
                  {goal?.score != null && <span className="ml-1 px-1.5 rounded" style={{ background: 'rgba(245,158,11,0.18)', color: '#F59E0B' }}>{goal.score.toFixed(1)}</span>}
                  {goal?.scoredByName && goal?.scoredAt && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>· {goal.scoredByName} {fmtCi(goal.scoredAt)}</span>}
                </div>
                {canWrite ? (
                  <div className="rounded-lg border p-2 flex flex-col gap-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>评分</span>
                      <select value={scoreVal} onChange={(e) => setScoreVal(e.target.value)} className="text-[12px] rounded-md px-2 py-1 outline-none border" style={inputStyle}>
                        <option value="">未评分</option>
                        {['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0'].map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>0.7 左右为理想达成</span>
                      {krAvg != null && <Button variant="ghost" size="sm" onClick={() => setScoreVal((Math.round(krAvg / 10) / 10).toFixed(1))} title={`按 KR 均值 ${krAvg}% 折算`}>按 KR 算分</Button>}
                    </div>
                    <textarea value={scoreNote} onChange={(e) => setScoreNote(e.target.value)} placeholder="复盘：达成情况 / 经验 / 不足…" rows={2} className="w-full text-[12px] rounded-md px-2 py-1.5 outline-none border resize-y" style={inputStyle} />
                    <div className="flex items-center gap-1.5">
                      {goal?.score != null && <Button variant="ghost" size="sm" onClick={() => submitScore(true)} disabled={scoreSaving}>清除</Button>}
                      <Button variant="primary" size="sm" className="ml-auto" onClick={() => submitScore(false)} disabled={scoreSaving}>{scoreSaving ? <MapSpinner size={12} /> : <Award size={12} />}保存评分</Button>
                    </div>
                  </div>
                ) : goal?.scoreNote ? (
                  <div className="text-[12px] whitespace-pre-wrap break-words rounded-md px-2 py-1.5" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>{goal.scoreNote}</div>
                ) : (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>尚未评分。</div>
                )}
              </div>
              {/* 关联任务（直接挂的 + 里程碑下的） */}
              <div className="flex flex-col gap-1.5">
                <div className="text-[11px] flex items-center gap-1" style={{ color: '#F59E0B' }}><ListTodo size={12} />关联任务（{relTasks.length}）</div>
                {relTasks.length === 0 ? (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无任务关联本目标。在「任务」详情里设置任务的「所属目标」。</div>
                ) : relTasks.map((t) => {
                  const st = TASK_STATUS_REGISTRY[t.status];
                  return (
                    <button key={t.id} onClick={() => { onNavigateTask?.(t.id); onClose(); }} disabled={!onNavigateTask}
                      className="flex items-center gap-2 text-[12px] text-left rounded px-1 -mx-1 disabled:cursor-default enabled:hover:bg-white/5"
                      style={{ color: 'var(--text-secondary)' }} title={onNavigateTask ? '点击跳转到任务' : t.title}>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.color }} />
                      <span className="truncate flex-1">{t.title}</span>
                      <span className="text-[10px] shrink-0" style={{ color: st.color }}>{st.label}</span>
                    </button>
                  );
                })}
              </div>
              {/* 提及本目标的周报（反查 relatedGoalIds） */}
              <div className="flex flex-col gap-1.5">
                <div className="text-[11px] flex items-center gap-1" style={{ color: '#3B82F6' }}><FileText size={12} />提及本目标的周报（{mentionReports.length}）</div>
                {mentionReports.length === 0 ? (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无周报关联本目标。在「周报」里勾选关联目标。</div>
                ) : mentionReports.map((w) => (
                  <button key={w.id} onClick={() => { onNavigateWeekly?.(w.id); onClose(); }} disabled={!onNavigateWeekly}
                    className="text-[12px] truncate text-left rounded px-1 -mx-1 disabled:cursor-default enabled:hover:bg-white/5"
                    style={{ color: 'var(--text-secondary)' }} title={onNavigateWeekly ? '点击跳转到周报' : w.title}>· {w.title}</button>
                ))}
              </div>
              {/* 关联本目标的决策（反查 relatedGoalIds） */}
              <div className="flex flex-col gap-1.5">
                <div className="text-[11px] flex items-center gap-1" style={{ color: '#A855F7' }}><Gavel size={12} />关联本目标的决策（{relDecisions.length}）</div>
                {relDecisions.length === 0 ? (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无决策关联本目标。在「决策」里把决策关联到本目标。</div>
                ) : relDecisions.map((d) => {
                  const dt = DECISION_TYPE_REGISTRY[d.type];
                  return (
                    <div key={d.id} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }} title={d.title}>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dt.color }} />
                      <span className="truncate flex-1">{d.title}</span>
                      <span className="text-[10px] shrink-0" style={{ color: dt.color }}>{dt.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {!isCreate && canWrite && (
            <div className="pt-3 mt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              <Button variant="ghost" size="sm" onClick={remove} style={{ color: '#EF4444' }}><Trash2 size={13} />删除目标（连同子目标）</Button>
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
