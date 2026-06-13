/**
 * 全局总览（管理层只读洞察）—— 跨全公司项目，不论是否干系人/成员。
 * 给老板/管理层「掌控全局、洞察风险」的视角：四块内容
 *   1) 项目总表（多维筛选 + 分页）
 *   2) 健康预警（逾期里程碑 / 超预算 / 停滞 / 高风险）
 *   3) 经营汇总（预算执行 / 任务完成 / 生命周期与健康分布）
 *   4) 负载分析（按负责人聚合在手项目与任务负载）
 * 纯只读，不含任何写操作；点项目跳详情页查看。权限 pm-agent.global（仅管理层）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe, Search, AlertTriangle, TrendingDown, Clock, ShieldAlert, Wallet, ListChecks, Users, ExternalLink } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getPmGlobalProjects, getPmGlobalSummary } from '@/services';
import type { PmGlobalFilters, PmGlobalHealth, PmGlobalProjectRow, PmGlobalSummary } from '@/services/contracts/pmAgent';
import type { PmProjectLifecycle, PmProjectType } from '@/services/contracts/pmAgent';
import { PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY } from './pmConstants';
import { fmtDate } from './materialUtils';

const HEALTH_META: Record<PmGlobalHealth, { label: string; color: string }> = {
  on_track: { label: '正常', color: '#3B82F6' },
  at_risk: { label: '有风险', color: '#F59E0B' },
  overdue: { label: '逾期/超预算', color: '#EF4444' },
  closed: { label: '已结案', color: '#64748B' },
};

type SubTab = 'projects' | 'warnings' | 'business' | 'load';
const SUBTABS: { key: SubTab; label: string; icon: typeof Globe }[] = [
  { key: 'projects', label: '项目总表', icon: ListChecks },
  { key: 'warnings', label: '健康预警', icon: AlertTriangle },
  { key: 'business', label: '经营汇总', icon: Wallet },
  { key: 'load', label: '负载分析', icon: Users },
];

const yuan = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : `${n}`);

export function GlobalView({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<SubTab>('projects');
  const [filters, setFilters] = useState<PmGlobalFilters>({});
  const [qInput, setQInput] = useState('');
  const [sort, setSort] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 30;

  const [rows, setRows] = useState<PmGlobalProjectRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<PmGlobalSummary | null>(null);
  const [loadingRows, setLoadingRows] = useState(true);
  const [loadingSum, setLoadingSum] = useState(true);

  const loadRows = useCallback(async () => {
    setLoadingRows(true);
    const res = await getPmGlobalProjects({ ...filters, page, pageSize, sort });
    if (res.success) { setRows(res.data.items); setTotal(res.data.total); }
    else toast.error('加载失败', res.error?.message || '');
    setLoadingRows(false);
  }, [filters, page, sort]);

  const loadSummary = useCallback(async () => {
    setLoadingSum(true);
    const res = await getPmGlobalSummary(filters);
    if (res.success) setSummary(res.data);
    else toast.error('加载失败', res.error?.message || '');
    setLoadingSum(false);
  }, [filters]);

  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  // 筛选变化回到第一页
  const patchFilter = (patch: Partial<PmGlobalFilters>) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };
  const applySearch = () => patchFilter({ q: qInput.trim() || undefined });

  const leaderOptions = useMemo(() => summary?.leaderLoad.map((l) => ({ id: l.leaderId, name: l.leaderName })) ?? [], [summary]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const selStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' } as const;
  const selCls = 'text-[12px] rounded-md px-2 py-1.5 outline-none border';

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* 头部 */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap">
        <Globe size={16} style={{ color: '#3B82F6' }} />
        <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>全局总览</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>全公司项目 —— 掌控全局、洞察风险</span>
      </div>

      {/* 子 tab */}
      <div className="shrink-0 flex items-center gap-1 rounded-lg p-1 w-fit" style={{ background: 'var(--bg-base)' }}>
        {SUBTABS.map((t) => {
          const active = tab === t.key;
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className="px-3 py-1.5 rounded-md text-[12px] inline-flex items-center gap-1.5 transition-colors"
              style={{ background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: active ? 600 : 400 }}>
              <Icon size={13} />{t.label}
            </button>
          );
        })}
      </div>

      {/* 筛选条（对四个 tab 都生效） */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 rounded-md border px-2 py-1" style={selStyle}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
            placeholder="搜项目名 / 编号 / 负责人" className="bg-transparent outline-none text-[12px] w-44" style={{ color: 'var(--text-primary)' }} />
        </div>
        <select className={selCls} style={selStyle} value={filters.lifecycle ?? ''} onChange={(e) => patchFilter({ lifecycle: (e.target.value || undefined) as PmProjectLifecycle | undefined })}>
          <option value="">全部生命周期</option>
          {(Object.keys(LIFECYCLE_REGISTRY) as PmProjectLifecycle[]).map((k) => <option key={k} value={k}>{LIFECYCLE_REGISTRY[k].label}</option>)}
        </select>
        <select className={selCls} style={selStyle} value={filters.type ?? ''} onChange={(e) => patchFilter({ type: (e.target.value || undefined) as PmProjectType | undefined })}>
          <option value="">全部类型</option>
          {(Object.keys(PROJECT_TYPE_REGISTRY) as PmProjectType[]).map((k) => <option key={k} value={k}>{PROJECT_TYPE_REGISTRY[k].label}</option>)}
        </select>
        <select className={selCls} style={selStyle} value={filters.health ?? ''} onChange={(e) => patchFilter({ health: (e.target.value || undefined) as PmGlobalHealth | undefined })}>
          <option value="">全部健康度</option>
          {(Object.keys(HEALTH_META) as PmGlobalHealth[]).map((k) => <option key={k} value={k}>{HEALTH_META[k].label}</option>)}
        </select>
        <select className={selCls} style={selStyle} value={filters.leaderId ?? ''} onChange={(e) => patchFilter({ leaderId: e.target.value || undefined })}>
          <option value="">全部负责人</option>
          {leaderOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {(filters.lifecycle || filters.type || filters.health || filters.leaderId || filters.q) && (
          <button onClick={() => { setFilters({}); setQInput(''); setPage(1); }} className="text-[12px] px-2 py-1.5 rounded-md hover:opacity-70" style={{ color: 'var(--text-muted)' }}>清除筛选</button>
        )}
      </div>

      {/* 顶部概览卡（始终展示） */}
      <div className="shrink-0 grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <StatCard label="项目总数" value={summary ? String(summary.projectTotal) : '—'} icon={<Globe size={14} />} color="#3B82F6" />
        <StatCard label="任务完成率" value={summary ? `${summary.business.completionRate}%` : '—'} sub={summary ? `${summary.business.taskDone}/${summary.business.taskTotal}` : ''} icon={<ListChecks size={14} />} color="#10B981" />
        <StatCard label="预算执行率" value={summary ? `${summary.business.budgetExecutionRate}%` : '—'} sub={summary ? `${yuan(summary.business.totalActual)}/${yuan(summary.business.totalBudget)}` : ''} icon={<Wallet size={14} />} color="#A855F7" />
        <StatCard label="逾期里程碑" value={summary ? String(summary.warnings.overdueMilestones) : '—'} icon={<Clock size={14} />} color="#EF4444" />
        <StatCard label="超预算项目" value={summary ? String(summary.warnings.overBudget.length) : '—'} icon={<TrendingDown size={14} />} color="#EF4444" />
        <StatCard label="高风险项目" value={summary ? String(summary.warnings.highRisk.length) : '—'} icon={<ShieldAlert size={14} />} color="#F59E0B" />
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        {tab === 'projects' && (
          loadingRows ? <MapSectionLoader text="正在加载项目…" /> : rows.length === 0 ? (
            <Empty text="没有符合筛选条件的项目" />
          ) : (
            <div className="flex flex-col gap-2">
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
                <table className="w-full text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
                      <Th>项目</Th><Th>类型</Th><Th>阶段</Th><Th>负责人</Th><Th className="text-right">完成率</Th>
                      <Th className="text-right">预算执行</Th><Th className="text-center">健康</Th><Th className="text-right">截止</Th><Th></Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const tm = PROJECT_TYPE_REGISTRY[r.projectType];
                      const lm = LIFECYCLE_REGISTRY[r.lifecycle];
                      const hm = HEALTH_META[r.health];
                      return (
                        <tr key={r.id} className="border-t hover:bg-[var(--bg-base)] cursor-pointer" style={{ borderColor: 'var(--border-subtle)' }} onClick={() => onOpen(r.id)}>
                          <Td>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="truncate font-medium" style={{ color: 'var(--text-primary)', maxWidth: 220 }} title={r.title}>{r.title}</span>
                              {r.stalled && <span className="text-[10px] px-1 py-0.5 rounded shrink-0" style={{ background: 'rgba(245,158,11,0.15)', color: '#F59E0B' }}>停滞</span>}
                            </div>
                          </Td>
                          <Td><span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ background: `${tm.color}22`, color: tm.color }}>{tm.short}</span></Td>
                          <Td><span style={{ color: lm.color }}>{lm.label}</span></Td>
                          <Td>{r.leaderName || '—'}</Td>
                          <Td className="text-right tabular-nums">{r.completionRate}%</Td>
                          <Td className="text-right tabular-nums">
                            <span style={{ color: r.overBudget ? '#EF4444' : 'var(--text-secondary)' }}>{r.budget > 0 ? `${yuan(r.actualCost)}/${yuan(r.budget)}` : '—'}</span>
                          </Td>
                          <Td className="text-center"><span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${hm.color}22`, color: hm.color }}>{hm.label}</span></Td>
                          <Td className="text-right">{r.plannedEndAt ? fmtDate(r.plannedEndAt) : '—'}</Td>
                          <Td><ExternalLink size={12} style={{ color: 'var(--text-muted)' }} /></Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* 排序 + 分页 */}
              <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <span>共 {total} 个项目</span>
                <select className={selCls} style={selStyle} value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
                  <option value="">最近更新</option>
                  <option value="completion">完成率高→低</option>
                  <option value="completionAsc">完成率低→高</option>
                  <option value="endAt">截止近→远</option>
                  <option value="budget">成本高→低</option>
                </select>
                <div className="ml-auto flex items-center gap-2">
                  <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 rounded disabled:opacity-40 hover:opacity-70" style={{ color: 'var(--text-secondary)' }}>上一页</button>
                  <span>{page} / {totalPages}</span>
                  <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 rounded disabled:opacity-40 hover:opacity-70" style={{ color: 'var(--text-secondary)' }}>下一页</button>
                </div>
              </div>
            </div>
          )
        )}

        {tab === 'warnings' && (
          loadingSum || !summary ? <MapSectionLoader text="正在汇总预警…" /> : (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
              <WarnList title="超预算项目" icon={<TrendingDown size={14} />} color="#EF4444" empty="暂无超预算项目"
                items={summary.warnings.overBudget.map((p) => ({ id: p.id, title: p.title, sub: `${p.leaderName || '—'} · 实际 ${yuan(p.actualCost)} / 预算 ${yuan(p.budget)}` }))} onOpen={onOpen} />
              <WarnList title="停滞项目（14 天无更新）" icon={<Clock size={14} />} color="#F59E0B" empty="暂无停滞项目"
                items={summary.warnings.stalled.map((p) => ({ id: p.id, title: p.title, sub: `${p.leaderName || '—'} · 已 ${p.idleDays} 天无更新` }))} onOpen={onOpen} />
              <WarnList title="高风险项目" icon={<ShieldAlert size={14} />} color="#F59E0B" empty="暂无高风险项目"
                items={summary.warnings.highRisk.map((p) => ({ id: p.id, title: p.title, sub: `${p.leaderName || '—'} · ${p.highRisks} 项高风险` }))} onOpen={onOpen} />
            </div>
          )
        )}

        {tab === 'business' && (
          loadingSum || !summary ? <MapSectionLoader text="正在汇总经营数据…" /> : (
            <div className="flex flex-col gap-3">
              <Panel title="生命周期分布">
                <DistBars items={summary.lifecycleDist.map((d) => ({ label: LIFECYCLE_REGISTRY[d.key].label, count: d.count, color: LIFECYCLE_REGISTRY[d.key].color }))} total={summary.projectTotal} />
              </Panel>
              <Panel title="项目类型分布">
                <DistBars items={summary.typeDist.map((d) => ({ label: PROJECT_TYPE_REGISTRY[d.key].label, count: d.count, color: PROJECT_TYPE_REGISTRY[d.key].color }))} total={summary.projectTotal} />
              </Panel>
              <Panel title="健康度分布">
                <DistBars items={summary.healthDist.map((d) => ({ label: HEALTH_META[d.key].label, count: d.count, color: HEALTH_META[d.key].color }))} total={summary.projectTotal} />
              </Panel>
              <Panel title="预算与任务">
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                  <StatCard label="总预算" value={`${yuan(summary.business.totalBudget)} 元`} color="#A855F7" />
                  <StatCard label="总实际成本" value={`${yuan(summary.business.totalActual)} 元`} color="#A855F7" />
                  <StatCard label="预算执行率" value={`${summary.business.budgetExecutionRate}%`} color="#A855F7" />
                  <StatCard label="任务完成率" value={`${summary.business.completionRate}%`} sub={`${summary.business.taskDone}/${summary.business.taskTotal}`} color="#10B981" />
                </div>
              </Panel>
            </div>
          )
        )}

        {tab === 'load' && (
          loadingSum || !summary ? <MapSectionLoader text="正在汇总负载…" /> : summary.leaderLoad.length === 0 ? (
            <Empty text="暂无负责人负载数据" />
          ) : (
            <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
              <table className="w-full text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
                    <Th>负责人</Th><Th className="text-right">在手项目</Th><Th className="text-right">项目总数</Th>
                    <Th className="text-right">任务(完成/总)</Th><Th className="text-right">逾期里程碑</Th><Th className="text-right">超预算项目</Th>
                  </tr>
                </thead>
                <tbody>
                  {summary.leaderLoad.map((l) => (
                    <tr key={l.leaderId} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                      <Td><span className="font-medium" style={{ color: 'var(--text-primary)' }}>{l.leaderName}</span></Td>
                      <Td className="text-right tabular-nums">{l.activeCount}</Td>
                      <Td className="text-right tabular-nums">{l.projectCount}</Td>
                      <Td className="text-right tabular-nums">{l.taskDone}/{l.taskTotal}</Td>
                      <Td className="text-right tabular-nums"><span style={{ color: l.overdueMilestones > 0 ? '#EF4444' : 'inherit' }}>{l.overdueMilestones}</span></Td>
                      <Td className="text-right tabular-nums"><span style={{ color: l.overBudget > 0 ? '#EF4444' : 'inherit' }}>{l.overBudget}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, icon, color }: { label: string; value: string; sub?: string; icon?: React.ReactNode; color: string }) {
  return (
    <div className="rounded-lg border p-3 flex flex-col gap-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {icon && <span style={{ color }}>{icon}</span>}{label}
      </div>
      <div className="text-[20px] font-semibold tabular-nums" style={{ color }}>{value}</div>
      {sub && <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3 flex flex-col gap-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{title}</div>
      {children}
    </div>
  );
}

function DistBars({ items, total }: { items: { label: string; count: number; color: string }[]; total: number }) {
  if (items.length === 0) return <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无数据</div>;
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-2">
          <span className="text-[11px] w-20 shrink-0" style={{ color: 'var(--text-secondary)' }}>{it.label}</span>
          <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
            <div style={{ width: `${total > 0 ? (it.count / total) * 100 : 0}%`, height: '100%', background: it.color }} />
          </div>
          <span className="text-[11px] w-8 text-right tabular-nums" style={{ color: 'var(--text-muted)' }}>{it.count}</span>
        </div>
      ))}
    </div>
  );
}

function WarnList({ title, icon, color, items, empty, onOpen }: { title: string; icon: React.ReactNode; color: string; items: { id: string; title: string; sub: string }[]; empty: string; onOpen: (id: string) => void }) {
  return (
    <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
        <span style={{ color }}>{icon}</span>{title}
        <span className="ml-auto text-[11px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{empty}</div>
      ) : items.map((it) => (
        <button key={it.id} onClick={() => onOpen(it.id)} className="text-left flex flex-col rounded-md px-2 py-1.5 hover:bg-[var(--bg-base)] transition-colors">
          <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }} title={it.title}>{it.title}</span>
          <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{it.sub}</span>
        </button>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex flex-col items-center justify-center py-16 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{text}</div>;
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={`text-left font-medium px-3 py-2 ${className ?? ''}`}>{children}</th>;
}
function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className ?? ''}`}>{children}</td>;
}
