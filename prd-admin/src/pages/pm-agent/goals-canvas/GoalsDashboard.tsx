import { useMemo, useState, type ReactNode } from 'react';
import { Target, TrendingUp, Award, AlertTriangle, User, CalendarRange } from 'lucide-react';
import type { PmGoal, PmGoalCycle } from '@/services/contracts/pmAgent';
import { GOAL_STATUS_REGISTRY } from '../pmConstants';

interface Props {
  goals: PmGoal[];
  cycles?: PmGoalCycle[];
  onOpen?: (g: PmGoal) => void;
}

const STATUS_ORDER = ['on_track', 'at_risk', 'done', 'abandoned'] as const;
const CONF_META: Record<string, { label: string; color: string }> = {
  high: { label: '信心高', color: '#10B981' }, medium: { label: '信心中', color: '#F59E0B' }, low: { label: '信心低', color: '#EF4444' },
};

/**
 * OKR 仪表盘 —— 团队目标的进度/达成/信心/评分总览（客户端聚合）。
 * KPI 卡 + 状态分布 + 按负责人/周期聚合 + 需关注（低信心 / 风险 / 落后）目标预警。
 */
export function GoalsDashboard({ goals, cycles = [], onOpen }: Props) {
  const [cycleFilter, setCycleFilter] = useState<string>('all'); // all | none | cycleId
  const team = useMemo(() => goals.filter((g) => {
    if (g.scope !== 'team') return false;
    if (cycleFilter === 'all') return true;
    if (cycleFilter === 'none') return !g.cycleId;
    return g.cycleId === cycleFilter;
  }), [goals, cycleFilter]);

  const stat = useMemo(() => {
    const total = team.length;
    const avg = total ? Math.round(team.reduce((s, g) => s + g.progress, 0) / total) : 0;
    const achieved = team.filter((g) => g.status === 'done' || g.progress >= 100).length;
    const lowConf = team.filter((g) => g.confidence === 'low').length;
    const scored = team.filter((g) => typeof g.score === 'number');
    const avgScore = scored.length ? (scored.reduce((s, g) => s + (g.score ?? 0), 0) / scored.length) : null;
    const statusDist = STATUS_ORDER.map((k) => ({ key: k, n: team.filter((g) => g.status === k).length }));
    const byLead = aggregate(team, (g) => g.leadName || '未指派');
    const cycleName = new Map(cycles.map((c) => [c.id, c.name]));
    const byPeriod = aggregate(team, (g) => g.cycleId ? (cycleName.get(g.cycleId) ?? '已删除周期') : (g.period?.trim() || '未归类'));
    const watch = team
      .filter((g) => g.status !== 'done' && g.status !== 'abandoned' && (g.confidence === 'low' || g.status === 'at_risk' || g.progress < 40))
      .sort((a, b) => a.progress - b.progress).slice(0, 8);
    return { total, avg, achieved, lowConf, scored: scored.length, avgScore, statusDist, byLead, byPeriod, watch };
  }, [team, cycles]);

  const allTeamCount = goals.filter((g) => g.scope === 'team').length;
  if (allTeamCount === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center" style={{ color: 'var(--text-muted)' }}>
        <Target size={30} style={{ opacity: 0.4 }} />
        <div className="text-[13px]">还没有团队目标</div>
        <div className="text-[11.5px]">在「画布 / 列表」创建团队目标后，这里汇总进度、达成率、信心与评分。</div>
      </div>
    );
  }

  const cycleBar = (
    <div className="shrink-0 flex items-center gap-2 flex-wrap">
      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>周期</span>
      <select value={cycleFilter} onChange={(e) => setCycleFilter(e.target.value)} className="text-[12px] rounded-md px-2 py-1 outline-none border"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
        <option value="all">全部周期</option>
        {cycles.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'closed' ? '（已归档）' : ''}</option>)}
        <option value="none">未归类</option>
      </select>
    </div>
  );

  const Kpi = ({ icon, label, value, sub, color }: { icon: ReactNode; label: string; value: string; sub?: string; color?: string }) => (
    <div className="rounded-xl border px-3 py-2.5 flex flex-col gap-0.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="text-[10.5px] inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>{icon}{label}</div>
      <div className="text-[18px] font-semibold tabular-nums" style={{ color: color || 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );

  const Agg = ({ title, icon, rows }: { title: string; icon: ReactNode; rows: { key: string; n: number; avg: number }[] }) => (
    <div className="rounded-xl border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="text-[11.5px] font-medium inline-flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>{icon}{title}</div>
      {rows.length === 0 ? <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无</div> : rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          <span className="text-[11.5px] truncate" style={{ width: 110, color: 'var(--text-secondary)' }} title={r.key}>{r.key}</span>
          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
            <div style={{ width: `${r.avg}%`, height: '100%', background: '#3B82F6' }} />
          </div>
          <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>{r.avg}% · {r.n} 个</span>
        </div>
      ))}
    </div>
  );

  if (team.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col gap-3">
        {cycleBar}
        <div className="flex-1 flex items-center justify-center text-[12.5px]" style={{ color: 'var(--text-muted)' }}>该周期下暂无团队目标</div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3" style={{ overscrollBehavior: 'contain' }}>
      {cycleBar}
      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
        <Kpi icon={<Target size={11} />} label="团队目标" value={String(stat.total)} sub={`平均进度 ${stat.avg}%`} color="#3B82F6" />
        <Kpi icon={<TrendingUp size={11} />} label="达成率" value={`${stat.total ? Math.round(stat.achieved * 100 / stat.total) : 0}%`} sub={`已达成 ${stat.achieved}`} color="#10B981" />
        <Kpi icon={<AlertTriangle size={11} />} label="低信心" value={String(stat.lowConf)} sub="需重点关注" color={stat.lowConf > 0 ? '#EF4444' : undefined} />
        <Kpi icon={<Award size={11} />} label="平均评分" value={stat.avgScore != null ? stat.avgScore.toFixed(2) : '—'} sub={`已评 ${stat.scored}/${stat.total}`} color="#F59E0B" />
      </div>

      {/* 状态分布 */}
      <div className="rounded-xl border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>状态分布</div>
        <div className="flex h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
          {stat.statusDist.map((s) => s.n > 0 && (
            <div key={s.key} style={{ width: `${s.n * 100 / stat.total}%`, background: GOAL_STATUS_REGISTRY[s.key].color }} title={`${GOAL_STATUS_REGISTRY[s.key].label} ${s.n}`} />
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
          {stat.statusDist.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: GOAL_STATUS_REGISTRY[s.key].color }} />{GOAL_STATUS_REGISTRY[s.key].label} {s.n}</span>
          ))}
        </div>
      </div>

      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        <Agg title="按负责人" icon={<User size={12} style={{ color: '#3B82F6' }} />} rows={stat.byLead} />
        <Agg title="按周期" icon={<CalendarRange size={12} style={{ color: '#A855F7' }} />} rows={stat.byPeriod} />
      </div>

      {/* 需关注 */}
      <div className="rounded-xl border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="text-[11.5px] font-medium inline-flex items-center gap-1.5" style={{ color: '#EF4444' }}><AlertTriangle size={12} />需关注（低信心 / 风险 / 进度落后）（{stat.watch.length}）</div>
        {stat.watch.length === 0 ? <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无预警目标，进展良好。</div> : stat.watch.map((g) => (
          <button key={g.id} onClick={() => onOpen?.(g)} disabled={!onOpen}
            className="flex items-center gap-2 text-left rounded px-1 -mx-1 disabled:cursor-default enabled:hover:bg-white/5">
            <span className="text-[12px] truncate flex-1" style={{ color: 'var(--text-secondary)' }}>{g.title}</span>
            {g.confidence === 'low' && <span className="text-[10px]" style={{ color: CONF_META.low.color }}>信心低</span>}
            <span className="text-[10px] px-1.5 rounded" style={{ background: `${GOAL_STATUS_REGISTRY[g.status].color}22`, color: GOAL_STATUS_REGISTRY[g.status].color }}>{GOAL_STATUS_REGISTRY[g.status].label}</span>
            <span className="text-[10.5px] tabular-nums w-9 text-right" style={{ color: 'var(--text-muted)' }}>{g.progress}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function aggregate(goals: PmGoal[], keyOf: (g: PmGoal) => string) {
  const m = new Map<string, { n: number; sum: number }>();
  for (const g of goals) {
    const k = keyOf(g);
    const e = m.get(k) ?? { n: 0, sum: 0 };
    e.n++; e.sum += g.progress; m.set(k, e);
  }
  return [...m.entries()].map(([key, v]) => ({ key, n: v.n, avg: Math.round(v.sum / v.n) })).sort((a, b) => b.n - a.n);
}
