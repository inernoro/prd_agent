/**
 * 项目管理智能体 — 工作台一级导航「报表」页（跨项目执行数据）。
 *
 * 与 NPSS 看板分工：NPSS 管经营评价/奖金（管理层权限），本页管执行数据（所有人可看自己范围）。
 * 数据来自 GET /api/pm/reports/summary?scope=，四区：项目总览 / 任务 / 里程碑 / 风险。
 * 纯 CSS 可视化（与 NPSS 看板同风格），不引图表库。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, CalendarClock, ShieldAlert, Milestone, ListChecks, FolderKanban } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getPmReportSummary } from '@/services';
import type { PmReportSummary, PmProjectScope, PmRiskLevel } from '@/services/contracts/pmAgent';
import {
  PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY, TASK_STATUS_REGISTRY, RISK_LEVEL_REGISTRY,
} from './pmConstants';

const SCOPES: { key: PmProjectScope; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'managed', label: '我管理的' },
  { key: 'related', label: '我相关的' },
];

const RISK_LEVELS: PmRiskLevel[] = ['high', 'medium', 'low'];

export function PmReportsSection() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<PmProjectScope>('all');
  const [data, setData] = useState<PmReportSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getPmReportSummary(scope);
    if (res.success) setData(res.data);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* 头部 + 范围分段 */}
      <div className="shrink-0 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-[18px] font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <BarChart3 size={18} style={{ color: '#3B82F6' }} /> 报表
          </h1>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>跨项目执行数据：项目 / 任务 / 里程碑 / 风险（经营评价见 NPSS 看板）</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg p-1" style={{ background: 'var(--bg-base)' }}>
          {SCOPES.map((s) => (
            <button
              key={s.key}
              onClick={() => setScope(s.key)}
              className="px-3 py-1.5 rounded-md text-[12px] transition-colors"
              style={{ background: scope === s.key ? 'var(--bg-card)' : 'transparent', color: scope === s.key ? 'var(--text-primary)' : 'var(--text-muted)' }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {loading || !data ? (
        <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在汇总执行数据…" /></div>
      ) : data.projectTotal === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
          <BarChart3 size={40} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          <div className="text-[15px] font-medium" style={{ color: 'var(--text-secondary)' }}>该范围内还没有项目</div>
          <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>先去「项目」立项，或切换上方的统计范围。</div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4" style={{ overscrollBehavior: 'contain' }}>
          {/* 指标卡 */}
          <div className="shrink-0 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <StatCard icon={FolderKanban} label="项目数" value={String(data.projectTotal)} color="#3B82F6" />
            <StatCard icon={ListChecks} label="任务完成率" value={`${data.tasks.completionRate}%`} sub={`${data.tasks.done}/${data.tasks.total} 完成`} color="#10B981" />
            <StatCard icon={CalendarClock} label="逾期任务" value={String(data.tasks.overdue)} color={data.tasks.overdue > 0 ? '#EF4444' : '#10B981'} />
            <StatCard icon={Milestone} label="里程碑达成" value={`${data.milestones.reached}/${data.milestones.total}`} sub={data.milestones.overdue > 0 ? `${data.milestones.overdue} 个已过计划日` : undefined} color="#A78BFA" />
            <StatCard icon={ShieldAlert} label="未关闭风险" value={String(data.risks.open)} color={data.risks.open > 0 ? '#F59E0B' : '#10B981'} />
          </div>

          {/* 分布区：项目生命周期 / 项目类型 / 任务状态 */}
          <div className="shrink-0 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            <DistCard
              title="项目生命周期分布"
              total={data.projectTotal}
              rows={data.lifecycleDist.map((d) => ({ label: LIFECYCLE_REGISTRY[d.key].label, color: LIFECYCLE_REGISTRY[d.key].color, count: d.count }))}
            />
            <DistCard
              title="项目类型分布"
              total={data.projectTotal}
              rows={data.typeDist.map((d) => ({ label: PROJECT_TYPE_REGISTRY[d.key].label, color: PROJECT_TYPE_REGISTRY[d.key].color, count: d.count }))}
            />
            <DistCard
              title="任务状态分布"
              total={data.tasks.total}
              rows={data.tasks.statusDist.map((d) => ({ label: TASK_STATUS_REGISTRY[d.key].label, color: TASK_STATUS_REGISTRY[d.key].color, count: d.count }))}
            />
          </div>

          {/* 明细区：负责人负载 / 即将到期里程碑 / 风险 */}
          <div className="shrink-0 grid gap-3 pb-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {/* 负责人负载 Top */}
            <div className="pa-card rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
              <div className="text-[13px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>负责人负载 Top（按任务数）</div>
              {data.tasks.assigneeTop.length === 0 ? (
                <Empty text="任务还没有指派负责人" />
              ) : (
                <div className="flex flex-col gap-1.5">
                  {data.tasks.assigneeTop.map((a) => (
                    <div key={a.name} className="flex items-center gap-2 text-[12px]">
                      <span className="w-20 truncate" style={{ color: 'var(--text-secondary)' }}>{a.name}</span>
                      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                        <div className="h-full rounded-full" style={{ width: `${a.total > 0 ? Math.round((a.done / a.total) * 100) : 0}%`, background: '#10B981' }} />
                      </div>
                      <span className="w-24 text-right" style={{ color: 'var(--text-muted)' }}>
                        {a.done}/{a.total}
                        {a.overdue > 0 && <span style={{ color: '#EF4444' }}>（逾期{a.overdue}）</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 即将到期里程碑 */}
            <div className="pa-card rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
              <div className="text-[13px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>即将到期的里程碑</div>
              {data.milestones.upcoming.length === 0 ? (
                <Empty text="近期没有计划中的里程碑" />
              ) : (
                <div className="flex flex-col gap-1.5">
                  {data.milestones.upcoming.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => navigate(`/pm-agent/p/${m.projectId}?tab=milestones`)}
                      className="pa-row flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <span className="text-[11px] shrink-0 truncate" style={{ color: 'var(--text-muted)', maxWidth: 100 }}>{m.projectTitle}</span>
                      <span className="text-[12px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.title}</span>
                      <span className="text-[11px] shrink-0 inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                        <CalendarClock size={11} />{m.dueAt ? new Date(m.dueAt).toLocaleDateString('zh-CN') : '—'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 风险矩阵 + Top */}
            <div className="pa-card rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
              <div className="text-[13px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>风险（概率 × 影响）</div>
              {data.risks.open === 0 ? (
                <Empty text="没有未关闭的风险" />
              ) : (
                <>
                  {/* 3x3 矩阵：行=概率（高在上），列=影响（低→高） */}
                  <div className="grid mb-3" style={{ gridTemplateColumns: '44px repeat(3, 1fr)', gap: 4 }}>
                    <div />
                    {RISK_LEVELS.slice().reverse().map((l) => (
                      <div key={l} className="text-center text-[10px]" style={{ color: 'var(--text-muted)' }}>影响{RISK_LEVEL_REGISTRY[l].label}</div>
                    ))}
                    {RISK_LEVELS.map((prob) => (
                      [
                        <div key={`${prob}-label`} className="flex items-center text-[10px]" style={{ color: 'var(--text-muted)' }}>概率{RISK_LEVEL_REGISTRY[prob].label}</div>,
                        ...RISK_LEVELS.slice().reverse().map((impact) => {
                          const cell = data.risks.matrix.find((m) => m.probability === prob && m.impact === impact);
                          const score = RISK_LEVEL_REGISTRY[prob].weight * RISK_LEVEL_REGISTRY[impact].weight;
                          const bg = score >= 6 ? 'rgba(239,68,68,0.18)' : score >= 3 ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.12)';
                          const fg = score >= 6 ? '#EF4444' : score >= 3 ? '#F59E0B' : '#10B981';
                          return (
                            <div key={`${prob}-${impact}`} className="rounded-md py-1.5 text-center text-[12px] font-semibold" style={{ background: bg, color: cell ? fg : 'var(--text-muted)' }}>
                              {cell?.count ?? 0}
                            </div>
                          );
                        }),
                      ]
                    ))}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {data.risks.top.slice(0, 5).map((r) => (
                      <button
                        key={r.id}
                        onClick={() => navigate(`/pm-agent/p/${r.projectId}?tab=risks`)}
                        className="pa-row flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: r.score >= 6 ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)', color: r.score >= 6 ? '#EF4444' : '#F59E0B' }}>{r.score}分</span>
                        <span className="text-[11px] shrink-0 truncate" style={{ color: 'var(--text-muted)', maxWidth: 90 }}>{r.projectTitle}</span>
                        <span className="text-[12px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>{r.title}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, color }: { icon: typeof BarChart3; label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="pa-card rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        <Icon size={13} style={{ color }} /> {label}
      </div>
      <div className="text-[22px] font-semibold mt-1" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

/** 分布卡：横向占比条 + 计数 */
function DistCard({ title, total, rows }: { title: string; total: number; rows: Array<{ label: string; color: string; count: number }> }) {
  return (
    <div className="pa-card rounded-xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
      <div className="text-[13px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>{title}</div>
      {rows.length === 0 ? (
        <Empty text="暂无数据" />
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-2 text-[12px]">
              <span className="w-16 truncate" style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
              <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                <div className="h-full rounded-full" style={{ width: `${total > 0 ? Math.max(2, Math.round((r.count / total) * 100)) : 0}%`, background: r.color }} />
              </div>
              <span className="w-8 text-right" style={{ color: 'var(--text-muted)' }}>{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>{text}</div>;
}
