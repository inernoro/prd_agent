import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, ArrowRight, BookOpen, HeartPulse, Rocket } from 'lucide-react';
import { getHealth, getTenantOverview } from '@/lib/api';
import type { OverviewRankItem, TenantOverviewData } from '@/lib/types';
import { Card, Chip, SectionLoader } from '@/components/ui';
import { DetailsBlock } from '@/components/PageShell';
import './HomePage.css';
import { OnboardingChecklist } from '@/components/OnboardingChecklist';
import { appDisplayName, fmtCost, fmtMs, fmtShortTime, statusBadgeStyle } from '@/lib/logsHelpers';
import { useAuth } from '@/lib/auth';
import { buildLogDetailHref, buildLogListHref } from '@/lib/logNavigation';
import { canAccessPage, canUseCapability } from '@/lib/access';

const RANGE_OPTIONS = [
  { days: 1, label: '24 小时' },
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
];

const compactNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

function formatNumber(value: number) {
  return Number.isFinite(value) ? compactNumber.format(value) : '—';
}

function compactIdentity(value: string) {
  if (value.length <= 22) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function RankList({ items, emptyText }: { items: OverviewRankItem[]; emptyText: string }) {
  if (items.length === 0) return <div className="lg-overview-empty">{emptyText}</div>;
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <div className="lg-rank-list">
      {items.map((item) => (
        <div key={item.key} className="lg-rank-row" title={item.key}>
          <div><strong>{compactIdentity(item.label)}</strong><span>{formatNumber(item.count)} 次</span></div>
          <div className="lg-rank-track"><span style={{ width: `${Math.max(8, item.count * 100 / max)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export function OverviewPage() {
  const { tenant } = useAuth();
  const [params, setParams] = useSearchParams();
  const rangeDays = params.get('range') === '1d' ? 1 : params.get('range') === '30d' ? 30 : 7;
  const setRangeDays = (days: number) => setParams({ range: `${days}d` });
  const fixedFrom = params.get('from');
  const fixedTo = params.get('to');
  const [refresh, setRefresh] = useState(0);
  const [health, setHealth] = useState<{ status: string; commit?: string | null } | null>(null);
  const [overview, setOverview] = useState<TenantOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const to = fixedTo && Number.isFinite(Date.parse(fixedTo)) ? new Date(fixedTo) : new Date();
    const from = fixedFrom && Number.isFinite(Date.parse(fixedFrom)) ? new Date(fixedFrom) : new Date(to.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    setLoading(true);
    setOverview(null);
    setHealth(null);
    setError(null);
    Promise.all([
      getHealth(),
      getTenantOverview({ from: from.toISOString(), to: to.toISOString() }),
    ]).then(([healthRes, overviewRes]) => {
      if (cancelled) return;
      if (healthRes.success) setHealth(healthRes.data);
      if (overviewRes.success) setOverview(overviewRes.data);
      else setOverview(null);
      const firstError = [healthRes, overviewRes].find((res) => !res.success);
      if (firstError && !firstError.success) setError(firstError.error.message);
    }).catch((reason) => {
      if (!cancelled) {
        setOverview(null);
        setError(reason instanceof Error ? reason.message : '首页数据加载失败');
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [rangeDays, fixedFrom, fixedTo, refresh]);

  if (!health && !overview && loading && !error) return <SectionLoader text="正在加载当前租户工作区…" />;

  const hasRequests = (overview?.totalRequests ?? 0) > 0;
  const taskContext = { source: 'overview' as const, range: `${rangeDays}d`, from: overview?.from, to: overview?.to };
  const coverageLabel = !overview ? '—' : hasRequests ? (overview.priceCoveragePercent == null ? '未知' : `${overview.priceCoveragePercent}%`) : '暂无请求';
  const costs = overview?.estimatedCosts ?? [];
  const recent = overview?.recentRequests ?? [];
  const keys = overview?.serviceKeys;
  const canReadLogs = canAccessPage(tenant, 'logs');
  const canUseQuickstart = canAccessPage(tenant, 'quickstart');
  const canManageKeys = canUseCapability(tenant?.role, 'serviceKeyWrite');
  const canOpenGovernance = canAccessPage(tenant, 'governance');

  const metricFacts = [
    { label: '请求量', value: overview ? formatNumber(overview.totalRequests) : '—' },
    { label: '成功率', value: !overview ? '未知' : !overview.totalRequests ? '暂无请求' : overview.successRatePercent == null ? '未知' : `${overview.successRatePercent}%` },
    { label: 'P95 耗时', value: overview?.p95DurationMs == null ? '—' : fmtMs(overview.p95DurationMs) },
    { label: `速率（末 ${overview?.rateWindowMinutes ?? 15} 分钟）`, value: overview ? `${overview.requestRatePerMinute} / 分` : '—' },
    { label: 'Token（输入 + 输出）', value: overview ? formatNumber(overview.totalTokens) : '—' },
    { label: '调用身份（UserID）', value: overview ? formatNumber(overview.activeUsers) : '—' },
  ];

  return (
    <div className="lg-home-page lg-home-operations">
      <header className="lg-page-heading lg-home-heading">
        <div><h1>概览</h1></div>
        <div className="lg-range-switch" aria-label="统计时间范围">
          {RANGE_OPTIONS.map(option => <button type="button" key={option.days} className={rangeDays === option.days ? 'is-active' : undefined} aria-pressed={rangeDays === option.days} onClick={() => setRangeDays(option.days)}>{option.label}</button>)}
        </div>
      </header>
      {error ? <div className="lg-inline-alert" role="alert">部分概览数据不可用：{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></div> : null}
      <section className="lg-home-pulse" aria-label="调用概况">
        <dl>{metricFacts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
        <div className="lg-home-pulse-footer">
          <span>{overview ? `更新于 ${new Date(overview.generatedAt).toLocaleString('zh-CN', { hourCycle: 'h23' })} · 不含健康探针` : loading ? '正在读取当前范围…' : '调用概况暂不可用'}</span>
          {canReadLogs && overview?.successRatePercent != null && overview.successRatePercent < 100 ? <Link className="lg-primary-link" to={buildLogListHref({ ...taskContext, status: 'failed' })}>排查失败请求 <ArrowRight size={14} /></Link> : null}
        </div>
      </section>
      <Card className="lg-recent-card">
        <div className="lg-section-heading"><h2><Activity size={16} aria-hidden="true" /> 最近请求</h2>{canReadLogs ? <Link className="lg-text-link" to={buildLogListHref(taskContext)}>查看全部 <ArrowRight size={14} /></Link> : null}</div>
        {!overview ? <div className="lg-empty-guidance" role="status"><strong>{loading ? '正在读取最近请求…' : '最近请求暂不可用'}</strong><span>无法据此判断当前范围是否有请求。</span></div> : !overview.canReadRecentRequests ? <div className="lg-empty-guidance"><strong>当前角色只显示聚合用量</strong><span>最近请求需要请求记录读取权限。</span><Link to="/learn#request-log">了解权限与请求记录</Link></div> : recent.length ? <div className="lg-recent-list">
          {recent.map(item => { const badge = statusBadgeStyle(item.status, item.statusCode); return <Link key={item.id} to={buildLogDetailHref(item.id, { ...taskContext, selectedLogId: item.id })} className="lg-recent-row"><span className="lg-recent-time">{fmtShortTime(item.startedAt)}</span><span className="lg-recent-model"><strong>{item.model || '未知模型'}</strong><small>{appDisplayName(item)}</small></span><span className="lg-recent-meta">{fmtMs(item.durationMs)}</span><Chip label={badge.label} color={badge.color} bg={badge.bg} /></Link>; })}
        </div> : <div className="lg-empty-guidance"><strong>当前时间范围暂无业务请求</strong><span>{canReadLogs ? '请选择其他时间范围，或在请求记录中继续查询。' : '请选择其他时间范围继续查看聚合用量。'}</span>{rangeDays !== 30 ? <button type="button" className="lg-secondary-action" onClick={() => setRangeDays(30)}>查看近 30 天</button> : canReadLogs ? <Link to={buildLogListHref(taskContext)}>打开请求记录</Link> : null}{canManageKeys && keys?.total === 0 ? <><span>当前可见范围没有外部接入密钥。</span><Link to="/service-keys">创建接入密钥</Link></> : null}</div>}
      </Card>
      <section className="lg-home-evidence" aria-label="费用与连通状态">
        <div><h2>费用可信度</h2><div className="lg-home-cost-facts"><span>价格覆盖 <strong>{coverageLabel}</strong></span><span>缺价格 <strong>{overview ? overview.unknownCostRequests : '—'}</strong> 个请求</span>{costs.map(cost => <span key={cost.currency}>{cost.currency} 估算 <strong>{fmtCost(cost.amount, cost.currency)}</strong></span>)}</div><p>{!overview ? '费用数据暂不可用。' : !hasRequests ? '当前范围没有费用样本。' : !costs.length ? '费用未知，未将缺价格请求显示为 0。' : '估算按请求时价格快照计算；CNY 与 USD 不做无汇率相加。'} <Link to="/learn#cost">了解口径</Link></p></div>
        <div><h2><HeartPulse size={15} aria-hidden="true" /> 网关健康状态</h2><div className="lg-home-connectivity"><span className={health?.status === 'ok' ? 'lg-status-dot is-ok' : 'lg-status-dot is-warn'} />{health?.status === 'ok' ? '网关服务可连接' : '状态未知'}{canOpenGovernance ? <Link className="lg-text-link" to="/governance">系统运维 <ArrowRight size={13} /></Link> : null}</div><p>服务连通不代表所有上游可用，请结合请求结果判断。</p></div>
      </section>
      <section className="lg-home-distributions" aria-label="调用分布与接入密钥">
        <div><h2>活跃调用身份</h2><RankList items={overview?.topUsers ?? []} emptyText={overview ? '还没有可识别的用户调用' : '统计暂不可用'} /></div>
        <div><h2>调用方</h2><RankList items={overview?.topAppCallers ?? []} emptyText={overview ? '还没有调用方请求' : '统计暂不可用'} /></div>
        <div><h2>模型</h2><RankList items={overview?.topModels ?? []} emptyText={overview ? '还没有模型调用' : '统计暂不可用'} /></div>
        <div><h2>接入密钥</h2>{keys ? <div className="lg-home-key-facts"><span>可用 {keys.active} / 共 {keys.total}</span><span>已停用 {keys.disabled} · 已过期 {keys.expired}</span><span>7 天内到期 {keys.expiringSoon} · 从未使用 {keys.neverUsed}</span></div> : <p>接入密钥统计暂不可用</p>}{canManageKeys ? <Link className="lg-text-link" to="/service-keys">管理接入密钥 <ArrowRight size={13} /></Link> : null}</div>
      </section>
      <DetailsBlock title="接入与使用帮助">{overview && overview.totalRequests > 0 ? <OnboardingChecklist /> : null}<div className="lg-home-help"><span>接口协议：GW Native、OpenAI、Claude、Gemini</span>{canUseQuickstart ? <Link className="lg-secondary-link" to="/quickstart"><Rocket size={14} />快速接入</Link> : null}<Link className="lg-secondary-link" to="/learn"><BookOpen size={14} />学习中心</Link></div></DetailsBlock>
    </div>
  );
}
