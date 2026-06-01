import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, ShieldAlert, Target, ListTodo, Gavel } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import { listPmRisks, createPmRisk, updatePmRisk, deletePmRisk, listPmDecisions } from '@/services';
import type { PmRisk, PmRiskLevel, PmRiskResponse, PmRiskStatus, SavePmRiskInput, PmGoal, PmTask, PmDecision } from '@/services/contracts/pmAgent';
import { RISK_LEVEL_REGISTRY, RISK_RESPONSE_REGISTRY, RISK_STATUS_REGISTRY, riskScore, riskScoreColor } from './pmConstants';

interface Props {
  projectId: string;
  canManage: boolean;
  goals: PmGoal[];
  tasks: PmTask[];
}

const LEVELS: PmRiskLevel[] = ['high', 'medium', 'low'];
const RESPONSES: PmRiskResponse[] = ['open', 'avoid', 'transfer', 'mitigate', 'accept'];
const STATUSES: PmRiskStatus[] = ['open', 'mitigating', 'closed'];
const inputCls = 'text-[12.5px] rounded-md px-2 py-1.5 outline-none border';
const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' } as const;

/**
 * 风险登记册 —— 概率×影响矩阵热力总览 + 风险列表 + CRUD。
 * 风险等级 = 概率权重×影响权重（1-9，≥6 红/3-4 黄/≤2 绿）。可关联目标/任务、指派责任人、记录应对策略。
 */
export function RiskPanel({ projectId, canManage, goals, tasks }: Props) {
  const [risks, setRisks] = useState<PmRisk[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null); // 'new' | id
  const [draft, setDraft] = useState<SavePmRiskInput>({});
  const [busy, setBusy] = useState(false);
  const [cellFilter, setCellFilter] = useState<{ p: PmRiskLevel; i: PmRiskLevel } | null>(null);
  const [decisions, setDecisions] = useState<PmDecision[]>([]);

  const load = useCallback(async () => {
    const res = await listPmRisks(projectId);
    if (res.success) setRisks(res.data.items); else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { listPmDecisions(projectId).then((r) => { if (r.success) setDecisions(r.data.items); }); }, [projectId]);

  const teamGoals = goals.filter((g) => g.scope === 'team');
  const goalTitle = (id?: string | null) => (id ? goals.find((g) => g.id === id)?.title : null);
  const taskTitle = (id?: string | null) => (id ? tasks.find((t) => t.id === id)?.title : null);
  const decisionTitle = (id?: string | null) => (id ? decisions.find((d) => d.id === id)?.title : null);

  // 矩阵单元格统计（开放风险，已关闭不计入热力）
  const activeRisks = useMemo(() => risks.filter((r) => r.status !== 'closed'), [risks]);
  const cellCount = (p: PmRiskLevel, i: PmRiskLevel) => activeRisks.filter((r) => r.probability === p && r.impact === i).length;

  const filtered = useMemo(() => {
    const list = cellFilter ? risks.filter((r) => r.probability === cellFilter.p && r.impact === cellFilter.i) : risks;
    return [...list].sort((a, b) => riskScore(b.probability, b.impact) - riskScore(a.probability, a.impact));
  }, [risks, cellFilter]);

  const startNew = () => { setEditing('new'); setDraft({ probability: 'medium', impact: 'medium', response: 'open', status: 'open' }); };
  const startEdit = (r: PmRisk) => { setEditing(r.id); setDraft({ title: r.title, description: r.description || '', probability: r.probability, impact: r.impact, response: r.response, status: r.status, ownerId: r.ownerId || undefined, relatedGoalId: r.relatedGoalId || undefined, relatedTaskId: r.relatedTaskId || undefined, relatedDecisionId: r.relatedDecisionId || undefined }); };
  const cancel = () => { setEditing(null); setDraft({}); };

  const save = async () => {
    if (!draft.title?.trim()) { toast.error('请填写风险标题', ''); return; }
    setBusy(true);
    const res = editing === 'new' ? await createPmRisk(projectId, draft) : await updatePmRisk(editing!, draft);
    setBusy(false);
    if (res.success) { toast.success(editing === 'new' ? '已登记' : '已保存', ''); cancel(); load(); }
    else toast.error('保存失败', res.error?.message || '');
  };
  const remove = async (r: PmRisk) => {
    if (!window.confirm(`删除风险「${r.title}」？`)) return;
    const res = await deletePmRisk(r.id);
    if (res.success) { setRisks((prev) => prev.filter((x) => x.id !== r.id)); } else toast.error('删除失败', res.error?.message || '');
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载风险登记册…" /></div>;

  const editor = (
    <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-elevated)' }}>
      <input autoFocus value={draft.title || ''} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} placeholder="风险标题（如：核心供应商交付延迟）" className={`w-full ${inputCls}`} style={inputStyle} />
      <textarea value={draft.description || ''} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="触发条件 / 影响说明（可选）" rows={2} className={`w-full resize-y ${inputCls}`} style={inputStyle} />
      <div className="flex gap-2 flex-wrap items-center">
        <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>概率
          <select value={draft.probability || 'medium'} onChange={(e) => setDraft((d) => ({ ...d, probability: e.target.value as PmRiskLevel }))} className={inputCls} style={inputStyle}>
            {LEVELS.map((l) => <option key={l} value={l}>{RISK_LEVEL_REGISTRY[l].label}</option>)}
          </select>
        </label>
        <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>影响
          <select value={draft.impact || 'medium'} onChange={(e) => setDraft((d) => ({ ...d, impact: e.target.value as PmRiskLevel }))} className={inputCls} style={inputStyle}>
            {LEVELS.map((l) => <option key={l} value={l}>{RISK_LEVEL_REGISTRY[l].label}</option>)}
          </select>
        </label>
        <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>应对
          <select value={draft.response || 'open'} onChange={(e) => setDraft((d) => ({ ...d, response: e.target.value as PmRiskResponse }))} className={inputCls} style={inputStyle}>
            {RESPONSES.map((r) => <option key={r} value={r}>{RISK_RESPONSE_REGISTRY[r].label}</option>)}
          </select>
        </label>
        <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>状态
          <select value={draft.status || 'open'} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as PmRiskStatus }))} className={inputCls} style={inputStyle}>
            {STATUSES.map((s) => <option key={s} value={s}>{RISK_STATUS_REGISTRY[s].label}</option>)}
          </select>
        </label>
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <div className="min-w-[180px]"><UserSearchSelect value={draft.ownerId || ''} onChange={(uid) => setDraft((d) => ({ ...d, ownerId: uid || undefined }))} placeholder="责任人（可选）" /></div>
        <select value={draft.relatedGoalId || ''} onChange={(e) => setDraft((d) => ({ ...d, relatedGoalId: e.target.value || undefined }))} className={inputCls} style={inputStyle} title="关联目标">
          <option value="">不关联目标</option>
          {teamGoals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
        </select>
        <select value={draft.relatedTaskId || ''} onChange={(e) => setDraft((d) => ({ ...d, relatedTaskId: e.target.value || undefined }))} className={inputCls} style={inputStyle} title="关联任务">
          <option value="">不关联任务</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <select value={draft.relatedDecisionId || ''} onChange={(e) => setDraft((d) => ({ ...d, relatedDecisionId: e.target.value || undefined }))} className={inputCls} style={inputStyle} title="来源决策">
          <option value="">无来源决策</option>
          {decisions.map((dc) => <option key={dc.id} value={dc.id}>{dc.title}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}><X size={13} />取消</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={busy}>{busy ? <MapSpinner size={13} /> : <Check size={13} />}保存</Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      <div className="flex items-center gap-2 shrink-0">
        <ShieldAlert size={15} style={{ color: '#EF4444' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>风险登记册</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>概率×影响定级，记录应对策略与责任人</span>
        {canManage && editing !== 'new' && <Button variant="primary" size="sm" className="ml-auto" onClick={startNew}><Plus size={13} />登记风险</Button>}
      </div>

      {/* 概率×影响 热力矩阵 */}
      <div className="shrink-0 rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>风险矩阵（点格子筛选，仅统计未关闭风险）</div>
        <div className="flex">
          <div className="flex flex-col justify-center pr-2 text-[10px]" style={{ color: 'var(--text-muted)', writingMode: 'vertical-rl' as const }}>概率</div>
          <div className="flex-1">
            <div className="grid" style={{ gridTemplateColumns: '48px repeat(3, 1fr)', gap: 4 }}>
              <div />
              {LEVELS.slice().reverse().map((i) => <div key={i} className="text-[10.5px] text-center" style={{ color: 'var(--text-muted)' }}>影响{RISK_LEVEL_REGISTRY[i].label}</div>)}
              {LEVELS.map((p) => (
                <Fragment key={p}>
                  <div className="text-[10.5px] flex items-center justify-end pr-1" style={{ color: 'var(--text-muted)' }}>{RISK_LEVEL_REGISTRY[p].label}</div>
                  {LEVELS.slice().reverse().map((i) => {
                    const score = riskScore(p, i);
                    const n = cellCount(p, i);
                    const active = cellFilter?.p === p && cellFilter?.i === i;
                    return (
                      <button key={i} onClick={() => setCellFilter(active ? null : { p, i })}
                        className="rounded h-12 flex items-center justify-center text-[13px] font-semibold transition-all"
                        style={{ background: `${riskScoreColor(score)}${n > 0 ? '33' : '12'}`, color: n > 0 ? riskScoreColor(score) : 'var(--text-muted)', outline: active ? `2px solid ${riskScoreColor(score)}` : 'none' }}>
                        {n > 0 ? n : ''}
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
        {cellFilter && (
          <button onClick={() => setCellFilter(null)} className="mt-2 text-[11px]" style={{ color: '#3B82F6' }}>清除筛选（概率{RISK_LEVEL_REGISTRY[cellFilter.p].label}×影响{RISK_LEVEL_REGISTRY[cellFilter.i].label}）</button>
        )}
      </div>

      {editing === 'new' && editor}

      {/* 风险列表 */}
      {filtered.length === 0 && editing !== 'new' ? (
        <div className="text-[12px] text-center py-10 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          {cellFilter ? '该格子下暂无风险' : (canManage ? '还没有风险。点「登记风险」记录第一条，按概率×影响定级。' : '暂无风险')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((r) => {
            if (editing === r.id) return <div key={r.id}>{editor}</div>;
            const score = riskScore(r.probability, r.impact);
            const st = RISK_STATUS_REGISTRY[r.status];
            const gName = goalTitle(r.relatedGoalId);
            const tName = taskTitle(r.relatedTaskId);
            const dName = decisionTitle(r.relatedDecisionId);
            return (
              <div key={r.id} className="group rounded-lg border p-3 flex flex-col gap-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', opacity: r.status === 'closed' ? 0.6 : 1 }}>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[11px] font-semibold w-6 h-6 rounded flex items-center justify-center" style={{ background: `${riskScoreColor(score)}22`, color: riskScoreColor(score) }} title={`风险值 ${score}`}>{score}</span>
                  <span className="text-[13px] font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{r.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${st.color}22`, color: st.color }}>{st.label}</span>
                  {canManage && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                      <button onClick={() => startEdit(r)} title="编辑" style={{ color: 'var(--text-muted)' }}><Pencil size={13} /></button>
                      <button onClick={() => remove(r)} title="删除" style={{ color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
                    </div>
                  )}
                </div>
                {r.description && <div className="text-[11.5px] whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{r.description}</div>}
                <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                  <span>概率{RISK_LEVEL_REGISTRY[r.probability].label} · 影响{RISK_LEVEL_REGISTRY[r.impact].label}</span>
                  <span>应对：{RISK_RESPONSE_REGISTRY[r.response].label}</span>
                  {r.ownerName && <span>责任人：{r.ownerName}</span>}
                  {gName && <span className="inline-flex items-center gap-1"><Target size={10} />{gName}</span>}
                  {tName && <span className="inline-flex items-center gap-1"><ListTodo size={10} />{tName}</span>}
                  {dName && <span className="inline-flex items-center gap-1" style={{ color: '#A855F7' }} title="来源决策"><Gavel size={10} />{dName}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
