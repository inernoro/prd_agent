import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, ArrowRight, BookOpen, Bot, CircleDollarSign, Clock3, Gauge, HeartPulse,
  KeyRound, Rocket, UsersRound, Waypoints, Zap,
} from 'lucide-react';
import { getHealth, getTenantOverview } from '@/lib/api';
import type { OverviewRankItem, TenantOverviewData } from '@/lib/types';
import { Card, Chip, SectionLoader } from '@/components/ui';
import { fmtCost, fmtMs, fmtShortTime, statusBadgeStyle } from '@/lib/logsHelpers';
import { useAuth } from '@/lib/auth';

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
  const [rangeDays, setRangeDays] = useState(7);
  const [health, setHealth] = useState<{ status: string; commit?: string | null } | null>(null);
  const [overview, setOverview] = useState<TenantOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    setLoading(true);
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
  }, [rangeDays]);

  if (!health && !overview && loading && !error) return <SectionLoader text="正在加载当前租户工作区…" />;

  const hasRequests = (overview?.totalRequests ?? 0) > 0;
  const coverageLabel = hasRequests ? `${overview?.priceCoveragePercent ?? 0}%` : '暂无请求';
  const costs = overview?.estimatedCosts ?? [];
  const recent = overview?.recentRequests ?? [];
  const keys = overview?.serviceKeys;

  return (
    <div className="lg-home-page">
      <div className="lg-page-heading lg-home-heading">
        <div>
          <div className="lg-eyebrow">{tenant?.name ?? '当前租户'} · 工作区</div>
          <h1>概览</h1>
          <p>查看当前租户的调用、用户、应用、模型、密钥和费用可信度。</p>
        </div>
        <div className="lg-range-switch" aria-label="统计时间范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.days}
              className={rangeDays === option.days ? 'is-active' : undefined}
              aria-pressed={rangeDays === option.days}
              onClick={() => setRangeDays(option.days)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {loading && overview ? <div className="lg-refreshing" role="status">正在刷新当前时间范围…</div> : null}
      {error ? <div className="lg-inline-alert" role="status">部分首页数据不可用：{error}</div> : null}

      <div className="lg-home-primary-grid">
        <Card className="lg-home-health-card">
          <div className="lg-card-kicker"><HeartPulse size={15} /> 健康状态</div>
          <div className="lg-health-value">
            <span className={health?.status === 'ok' ? 'lg-status-dot is-ok' : 'lg-status-dot is-warn'} />
            {health?.status === 'ok' ? '网关运行正常' : '状态未知'}
          </div>
          <p>{health?.status === 'ok' ? '当前租户可以创建密钥并发送请求。' : '健康信息暂不可用，请稍后刷新。'}</p>
          {tenant?.isInternal ? <Link className="lg-secondary-link" to="/governance">打开系统运维</Link> : null}
        </Card>

        <Card className="lg-home-quickstart-card">
          <div className="lg-card-kicker"><Rocket size={15} /> 快速接入</div>
          <h2>三步完成第一条请求</h2>
          <p>创建租户密钥、选择兼容协议、执行安全直测，再用 requestId 定位完整链路。</p>
          <div className="lg-protocol-list" aria-label="支持协议">
            {['GW Native', 'OpenAI', 'Claude', 'Gemini'].map((item) => <Chip key={item} label={item} color="var(--text-secondary)" bg="var(--bg-elevated)" />)}
          </div>
          <div className="lg-card-actions">
            <Link className="lg-primary-link" to="/quickstart"><Rocket size={14} /> 开始接入</Link>
            <Link className="lg-secondary-link" to="/learn#first-request"><BookOpen size={14} /> 先了解链路</Link>
          </div>
        </Card>

        <Card className="lg-home-cost-card">
          <div className="lg-card-kicker"><CircleDollarSign size={15} /> 费用可信度</div>
          <div className="lg-coverage-row">
            <strong>{coverageLabel}</strong>
            <span>{hasRequests ? '请求可估算' : '没有可计算样本'}</span>
          </div>
          <div className="lg-coverage-track" aria-label={`价格覆盖率 ${coverageLabel}`}><span style={{ width: `${hasRequests ? overview?.priceCoveragePercent ?? 0 : 0}%` }} /></div>
          {costs.length > 0 ? (
            <div className="lg-currency-list">
              {costs.map((cost) => (
                <div key={cost.currency}><span>{cost.currency} 估算</span><strong>{fmtCost(cost.amount, cost.currency)}</strong></div>
              ))}
            </div>
          ) : <p>费用未知，未将缺价格请求显示为 0。</p>}
          <div className="lg-cost-note">缺价格 {overview ? overview.unknownCostRequests : '—'} 个请求；CNY 与 USD 不做无汇率相加。 <Link to="/learn#cost">了解口径</Link></div>
        </Card>
      </div>

      <Card className="lg-recent-card">
        <div className="lg-section-heading">
          <div><div className="lg-card-kicker"><Activity size={15} /> 最近请求</div><h2>当前时间范围</h2></div>
          <Link className="lg-text-link" to="/logs">查看全部 <ArrowRight size={14} /></Link>
        </div>
        {overview && !overview.canReadRecentRequests ? (
          <div className="lg-empty-guidance"><strong>当前角色只显示聚合用量</strong><span>最近请求需要请求记录读取权限。</span><Link to="/learn#request-log">了解权限与请求记录</Link></div>
        ) : recent.length > 0 ? (
          <div className="lg-recent-list">
            {recent.map((item) => {
              const badge = statusBadgeStyle(item.status, item.statusCode);
              return (
                <Link key={item.id} to={`/logs?requestId=${encodeURIComponent(item.requestId)}`} className="lg-recent-row">
                  <span className="lg-recent-time">{fmtShortTime(item.startedAt)}</span>
                  <span className="lg-recent-model"><strong>{item.model || '未知模型'}</strong><small>{item.appCallerTitle || item.appCallerCode || '未知调用方'}</small></span>
                  <span className="lg-recent-meta">{fmtMs(item.durationMs)}</span>
                  <Chip label={badge.label} color={badge.color} bg={badge.bg} />
                </Link>
              );
            })}
          </div>
        ) : <div className="lg-empty-guidance"><strong>还没有请求</strong><span>先完成 Quickstart，首个 requestId 会出现在这里。</span><Link to="/quickstart">打开接入指南</Link></div>}
      </Card>

      <section className="lg-overview-section" aria-labelledby="usage-heading">
        <div className="lg-section-heading">
          <div><div className="lg-eyebrow">租户使用情况</div><h2 id="usage-heading">关键指标</h2></div>
          <span className="lg-section-note">统计不包含健康探针</span>
        </div>
        <div className="lg-overview-metrics">
          <Card><Activity size={16} /><span>请求量</span><strong>{formatNumber(overview?.totalRequests ?? 0)}</strong><small>当前时间范围</small></Card>
          <Card><Gauge size={16} /><span>成功率</span><strong>{overview?.successRatePercent == null ? '—' : `${overview.successRatePercent}%`}</strong><small>无请求时不显示 0%</small></Card>
          <Card><Clock3 size={16} /><span>P95 耗时</span><strong>{overview?.p95DurationMs == null ? '—' : fmtMs(overview.p95DurationMs)}</strong><small>95% 请求不超过此值</small></Card>
          <Card><Zap size={16} /><span>近期速率</span><strong>{overview ? `${overview.requestRatePerMinute} / 分` : '—'}</strong><small>窗口尾部 {overview?.rateWindowMinutes ?? 15} 分钟</small></Card>
          <Card><Waypoints size={16} /><span>Token</span><strong>{formatNumber(overview?.totalTokens ?? 0)}</strong><small>输入与输出合计</small></Card>
          <Card><UsersRound size={16} /><span>活跃身份</span><strong>{formatNumber(overview?.activeUsers ?? 0)}</strong><small>存在 UserId 的去重调用身份</small></Card>
        </div>
      </section>

      <section className="lg-overview-section" aria-labelledby="distribution-heading">
        <div className="lg-section-heading">
          <div><div className="lg-eyebrow">谁在调用什么</div><h2 id="distribution-heading">使用分布</h2></div>
          <Link className="lg-text-link" to="/learn#app-caller">理解 appCaller <ArrowRight size={14} /></Link>
        </div>
        <div className="lg-overview-insights">
          <Card>
            <div className="lg-insight-heading"><UsersRound size={16} /><div><strong>活跃用户或身份</strong><span>按请求中的 UserId 统计</span></div></div>
            <RankList items={overview?.topUsers ?? []} emptyText="还没有可识别的用户调用" />
          </Card>
          <Card>
            <div className="lg-insight-heading"><Bot size={16} /><div><strong>Top appCaller</strong><span>业务应用调用身份</span></div></div>
            <RankList items={overview?.topAppCallers ?? []} emptyText="还没有 appCaller 请求" />
          </Card>
          <Card>
            <div className="lg-insight-heading"><Waypoints size={16} /><div><strong>Top 模型</strong><span>实际执行模型</span></div></div>
            <RankList items={overview?.topModels ?? []} emptyText="还没有模型调用" />
          </Card>
          <Card>
            <div className="lg-insight-heading"><KeyRound size={16} /><div><strong>租户接入密钥</strong><span>外部系统使用，不含平台内部身份</span></div></div>
            {keys && keys.total > 0 ? (
              <div className="lg-key-overview">
                <div><strong>{keys.total}</strong><span>总数</span></div>
                <div><strong>{keys.active}</strong><span>可用</span></div>
                <div><strong>{keys.disabled}</strong><span>已停用</span></div>
                <div><strong>{keys.expiringSoon}</strong><span>7 天内到期</span></div>
                <div><strong>{keys.expired}</strong><span>已过期</span></div>
                <div><strong>{keys.neverUsed}</strong><span>从未使用</span></div>
              </div>
            ) : <div className="lg-overview-empty">当前租户外部密钥为 0</div>}
            <Link className="lg-secondary-link" to="/service-keys">{keys?.total ? '管理接入密钥' : '创建第一把密钥'} <ArrowRight size={13} /></Link>
          </Card>
        </div>
      </section>

      <Card className="lg-learn-banner">
        <div><BookOpen size={19} /><span><strong>第一次使用 Gateway？</strong><small>学习中心用一条完整链路解释租户、团队、用户、appCaller、密钥、模型池、Provider、请求记录与费用。</small></span></div>
        <Link className="lg-primary-link" to="/learn">打开学习中心 <ArrowRight size={14} /></Link>
      </Card>
    </div>
  );
}
