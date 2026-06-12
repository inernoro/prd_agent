import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { Plus, ChevronRight, ChevronDown, Target, Milestone as MilestoneIcon, User, CircleCheck, Lock, Package, Sparkles, CalendarDays, GanttChartSquare, Activity } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { EChart } from '@/components/charts/EChart';
import type { PmMilestone, PmGoal, PmTask } from '@/services/contracts/pmAgent';
import { MILESTONE_HEALTH_REGISTRY, TASK_STATUS_REGISTRY } from './pmConstants';
import { MilestoneDetailDrawer } from './MilestoneDetailDrawer';
import { MilestoneCalendar } from './MilestoneCalendar';
import { MilestoneSuggestPanel } from './MilestoneSuggestPanel';
import { fmtDate } from './materialUtils';

interface Props {
  projectId: string;
  milestones: PmMilestone[];
  goals: PmGoal[];
  tasks: PmTask[];
  canManage: boolean;
  businessGoal: string;
  onChanged: () => void;
}

type ViewMode = 'timeline' | 'calendar' | 'baseline';

function themeColor(name: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 里程碑面板（第一公民）—— 三视图：时间轴卡片 / 月历 / 基线趋势。
 * 负责人 + 验收(DoD) + 前置依赖 + 交付物 + 计划/实际/基线偏差；AI 可建议分阶段里程碑。
 */
export function MilestonesPanel({ projectId, milestones, goals, tasks, canManage, businessGoal, onChanged }: Props) {
  const [view, setView] = useState<ViewMode>('timeline');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<{ open: boolean; milestone: PmMilestone | null }>({ open: false, milestone: null });
  const [suggestOpen, setSuggestOpen] = useState(false);

  const teamGoals = goals.filter((g) => g.scope === 'team');
  const goalTitle = (id?: string | null) => (id ? teamGoals.find((g) => g.id === id)?.title ?? goals.find((g) => g.id === id)?.title ?? null : null);
  const tasksOf = (mId: string) => tasks.filter((t) => t.milestoneId === mId);
  const sorted = useMemo(() => [...milestones].sort((a, b) => {
    const av = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bv = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return av - bv || (a.orderKey ?? 0) - (b.orderKey ?? 0);
  }), [milestones]);

  const toggle = (id: string) => setExpanded((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const openDrawer = (m: PmMilestone | null) => setDrawer({ open: true, milestone: m });
  const closeDrawer = () => setDrawer({ open: false, milestone: null });

  // 基线趋势图：基线计划日 vs 当前计划日 vs 实际达成
  const baselineOption = useMemo<EChartsOption | null>(() => {
    const rows = sorted.filter((m) => m.dueAt || m.baselineDueAt);
    if (rows.length === 0) return null;
    const axis = themeColor('--text-muted', '#94a3b8');
    const label = themeColor('--text-secondary', '#64748b');
    const split = 'rgba(148,163,184,0.18)';
    const ts = (s?: string | null) => (s ? new Date(s).getTime() : null);
    return {
      grid: { left: 56, right: 16, top: 28, bottom: 70 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (typeof v === 'number' ? fmtDate(new Date(v).toISOString()) : '—'),
      },
      legend: { data: ['基线计划', '当前计划', '实际达成'], textStyle: { color: label, fontSize: 11 }, top: 0 },
      xAxis: { type: 'category', data: rows.map((m) => m.title), axisLabel: { color: axis, fontSize: 10, interval: 0, rotate: 30, width: 80, overflow: 'truncate' }, axisLine: { lineStyle: { color: split } } },
      yAxis: { type: 'time', axisLabel: { color: axis, fontSize: 10, formatter: (v: number) => fmtDate(new Date(v).toISOString()) }, splitLine: { lineStyle: { color: split } } },
      series: [
        { name: '基线计划', type: 'line', data: rows.map((m) => ts(m.baselineDueAt) ?? ts(m.dueAt)), itemStyle: { color: '#94a3b8' }, lineStyle: { type: 'dashed' }, symbol: 'circle', symbolSize: 5, connectNulls: true },
        { name: '当前计划', type: 'line', data: rows.map((m) => ts(m.dueAt)), itemStyle: { color: '#A855F7' }, symbol: 'circle', symbolSize: 5, connectNulls: true },
        { name: '实际达成', type: 'scatter', data: rows.map((m) => ts(m.reachedAt)), itemStyle: { color: '#10B981' }, symbolSize: 9 },
      ],
    };
  }, [sorted]);

  const driftedCount = sorted.filter((m) => typeof m.driftDays === 'number' && m.driftDays > 0).length;

  const viewBtn = (key: ViewMode, label: string, Icon: typeof CalendarDays) => {
    const active = view === key;
    return (
      <button key={key} onClick={() => setView(key)} className="px-2.5 py-1 rounded-md text-[12px] inline-flex items-center gap-1.5"
        style={{ background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: active ? 600 : 400 }}>
        <Icon size={13} />{label}
      </button>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <MilestoneIcon size={15} style={{ color: '#A855F7' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>里程碑</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>负责人 + 验收 + 依赖 + 交付物；进度自动滚动</span>
        <div className="flex items-center gap-1 p-0.5 rounded-lg ml-2" style={{ background: 'var(--bg-base)' }}>
          {viewBtn('timeline', '时间轴', GanttChartSquare)}
          {viewBtn('calendar', '日历', CalendarDays)}
          {viewBtn('baseline', '基线趋势', Activity)}
        </div>
        {canManage && (
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setSuggestOpen(true)}><Sparkles size={13} />AI 建议</Button>
            <Button variant="primary" size="sm" onClick={() => openDrawer(null)}><Plus size={13} />新增里程碑</Button>
          </div>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="text-[12px] text-center py-10 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          {canManage ? '还没有里程碑。点「AI 建议」让 AI 依据目标/任务规划分阶段节点，或「新增里程碑」手动创建。' : '暂无里程碑。'}
        </div>
      ) : view === 'calendar' ? (
        <MilestoneCalendar milestones={sorted} onOpen={openDrawer} />
      ) : view === 'baseline' ? (
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-[11.5px] mb-1 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
              <Activity size={12} />基线 vs 当前计划 vs 实际达成
              {driftedCount > 0 && <span style={{ color: '#EF4444' }}>· {driftedCount} 个较基线推迟</span>}
            </div>
            {baselineOption ? <EChart option={baselineOption} height={300} /> : <div className="text-[12px] text-center py-8" style={{ color: 'var(--text-muted)' }}>里程碑均未设日期，无法绘制趋势</div>}
            <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-muted)' }}>当前计划线高于基线线 = 该里程碑较初始计划推迟；绿点为实际达成日。重设基线可在里程碑详情中操作。</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <div className="flex flex-col">
            {sorted.map((m, idx) => {
              const h = MILESTONE_HEALTH_REGISTRY[m.health];
              const kids = tasksOf(m.id);
              const isOpen = expanded.has(m.id);
              const gName = goalTitle(m.goalId);
              const cTotal = m.criteriaTotal ?? 0;
              const cDone = m.criteriaDone ?? 0;
              return (
                <div key={m.id} className="flex gap-3">
                  <div className="flex flex-col items-center shrink-0" style={{ width: 16 }}>
                    <span style={{ width: 12, height: 12, background: h.color, transform: 'rotate(45deg)', display: 'inline-block', borderRadius: 2, marginTop: 14 }} />
                    {idx < sorted.length - 1 && <span className="flex-1" style={{ width: 2, background: 'var(--border-subtle)', marginTop: 4 }} />}
                  </div>
                  <div className="group flex-1 min-w-0 rounded-lg border mb-2 flex flex-col gap-2 p-3 cursor-pointer transition-colors hover:border-[var(--border-strong)]"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
                    onClick={() => openDrawer(m)}>
                    <div className="flex items-center gap-2">
                      {kids.length > 0 && (
                        <button onClick={(e) => { e.stopPropagation(); toggle(m.id); }} style={{ color: 'var(--text-muted)' }} title={isOpen ? '收起任务' : '展开任务'}>
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      )}
                      <span className="text-[13px] font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.title}</span>
                      {m.autoFromGoal && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-1" style={{ background: 'rgba(168,85,247,0.14)', color: '#A855F7' }} title="由目标「设为里程碑」联动创建，与目标同步（取消即移除）"><Target size={9} />来自目标</span>
                      )}
                      {m.blocked && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-1" style={{ background: 'rgba(239,68,68,0.14)', color: '#EF4444' }} title={`受阻：${(m.blockedBy ?? []).join('、')} 未达成`}><Lock size={9} />受阻</span>
                      )}
                      <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${h.color}22`, color: h.color }}>{h.label}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                        <div style={{ width: `${m.progress}%`, height: '100%', background: h.color }} />
                      </div>
                      <span className="text-[11px] tabular-nums w-9 text-right" style={{ color: 'var(--text-muted)' }}>{m.progress}%</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                      {m.dueAt && <span>截止 {fmtDate(m.dueAt)}</span>}
                      <span>任务 {m.taskDone}/{m.taskTotal}</span>
                      {cTotal > 0 && (
                        <span className="inline-flex items-center gap-1" style={{ color: cDone === cTotal ? '#10B981' : 'var(--text-muted)' }}>
                          <CircleCheck size={10} />验收 {cDone}/{cTotal}
                        </span>
                      )}
                      {m.ownerName && <span className="inline-flex items-center gap-1"><User size={10} />{m.ownerName}</span>}
                      {(m.deliverables?.length ?? 0) > 0 && <span className="inline-flex items-center gap-1"><Package size={10} />交付物 {m.deliverables!.length}</span>}
                      {(m.dependsOn?.length ?? 0) > 0 && <span className="inline-flex items-center gap-1"><Lock size={10} />前置 {m.dependsOn!.length}</span>}
                      {gName && <span className="inline-flex items-center gap-1"><Target size={10} />{gName}</span>}
                      {typeof m.driftDays === 'number' && m.driftDays > 0 && <span style={{ color: '#EF4444' }} title="较基线计划推迟">基线 +{m.driftDays} 天</span>}
                      {m.reachedAt && <span style={{ color: '#10B981' }}>已达成 {fmtDate(m.reachedAt)}</span>}
                      {typeof m.slippageDays === 'number' && m.slippageDays !== 0 && (
                        <span style={{ color: m.slippageDays > 0 ? '#EF4444' : '#10B981' }}>
                          {m.slippageDays > 0 ? `延期 ${m.slippageDays} 天` : `提前 ${-m.slippageDays} 天`}
                        </span>
                      )}
                    </div>
                    {isOpen && kids.length > 0 && (
                      <div className="flex flex-col gap-1 pt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
                        {kids.map((t) => {
                          const st = TASK_STATUS_REGISTRY[t.status];
                          return (
                            <div key={t.id} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.color }} />
                              <span className="truncate flex-1" title={t.title}>{t.title}</span>
                              {t.assigneeName && <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.assigneeName}</span>}
                              <span className="text-[10px] shrink-0" style={{ color: st.color }}>{st.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {drawer.open && (
        <MilestoneDetailDrawer
          projectId={projectId} milestone={drawer.milestone} allMilestones={milestones} goals={goals} tasks={tasks}
          canManage={canManage} onClose={closeDrawer}
          onSaved={() => { closeDrawer(); onChanged(); }}
        />
      )}
      {suggestOpen && (
        <MilestoneSuggestPanel projectId={projectId} businessGoal={businessGoal}
          onClose={() => setSuggestOpen(false)} onCreated={() => { setSuggestOpen(false); onChanged(); }} />
      )}
    </div>
  );
}
