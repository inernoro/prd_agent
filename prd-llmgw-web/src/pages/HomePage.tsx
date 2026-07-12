import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, CircleDollarSign, HeartPulse, KeyRound, Rocket } from 'lucide-react';
import { getHealth, getLogs, getLogsSummary } from '@/lib/api';
import type { LlmLogListItem, LogsSummaryData } from '@/lib/types';
import { Card, Chip, SectionLoader } from '@/components/ui';
import { fmtCost, fmtMs, fmtShortTime, statusBadgeStyle } from '@/lib/logsHelpers';

export function OverviewPage() {
  const [health, setHealth] = useState<{ status: string; commit?: string | null } | null>(null);
  const [summary, setSummary] = useState<LogsSummaryData | null>(null);
  const [recent, setRecent] = useState<LlmLogListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    Promise.all([
      getHealth(),
      getLogsSummary({ from: from.toISOString(), to: to.toISOString() }),
      getLogs({ from: from.toISOString(), to: to.toISOString(), page: 1, pageSize: 5 }),
    ]).then(([healthRes, summaryRes, logsRes]) => {
      if (healthRes.success) setHealth(healthRes.data);
      if (summaryRes.success) setSummary(summaryRes.data);
      if (logsRes.success) setRecent(logsRes.data.items ?? []);
      const firstError = [healthRes, summaryRes, logsRes].find((res) => !res.success);
      if (firstError && !firstError.success) setError(firstError.error.message);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '首页数据加载失败'));
  }, []);

  if (!health && !summary && recent === null && !error) return <SectionLoader text="正在加载工作区…" />;

  const hasRequests = (summary?.total ?? 0) > 0;
  const coverageLabel = hasRequests ? `${summary?.priceCoveragePercent ?? 0}%` : '暂无请求';
  const costs = summary?.estimatedCosts ?? [];

  return (
    <div className="lg-home-page">
      <div className="lg-page-heading">
        <div>
          <div className="lg-eyebrow">Workspace</div>
          <h1>概览</h1>
          <p>从健康状态开始，完成接入并确认最近请求与费用可信度。</p>
        </div>
        <Link className="lg-text-link" to="/logs">打开 Activity <ArrowRight size={14} /></Link>
      </div>

      {error ? <div className="lg-inline-alert" role="status">部分首页数据不可用：{error}</div> : null}

      <div className="lg-home-primary-grid">
        <Card className="lg-home-health-card">
          <div className="lg-card-kicker"><HeartPulse size={15} /> 健康状态</div>
          <div className="lg-health-value">
            <span className={health?.status === 'ok' ? 'lg-status-dot is-ok' : 'lg-status-dot is-warn'} />
            {health?.status === 'ok' ? '网关运行正常' : '状态未知'}
          </div>
          <p>{health?.commit ? `Serving commit ${health.commit.slice(0, 9)}` : '暂未取得 serving 版本信息'}</p>
          <Link className="lg-secondary-link" to="/governance">查看运行状态</Link>
        </Card>

        <Card className="lg-home-quickstart-card">
          <div className="lg-card-kicker"><Rocket size={15} /> Quickstart</div>
          <h2>用一把租户密钥接入四种协议</h2>
          <p>选择现有 SDK，复制可运行示例，再用 requestId 回到 Activity 定位请求。</p>
          <div className="lg-protocol-list" aria-label="支持协议">
            {['OpenAI Chat', 'OpenAI Responses', 'Claude', 'Gemini'].map((item) => <Chip key={item} label={item} color="var(--text-secondary)" bg="var(--bg-elevated)" />)}
          </div>
          <div className="lg-card-actions">
            <Link className="lg-primary-link" to="/quickstart"><Rocket size={14} /> 开始接入</Link>
            <Link className="lg-secondary-link" to="/service-keys"><KeyRound size={14} /> 管理密钥</Link>
          </div>
        </Card>

        <Card className="lg-home-cost-card">
          <div className="lg-card-kicker"><CircleDollarSign size={15} /> 费用可信度</div>
          <div className="lg-coverage-row">
            <strong>{coverageLabel}</strong>
            <span>{hasRequests ? '请求可估算' : '没有可计算样本'}</span>
          </div>
          <div className="lg-coverage-track" aria-label={`价格覆盖率 ${coverageLabel}`}><span style={{ width: `${hasRequests ? summary?.priceCoveragePercent ?? 0 : 0}%` }} /></div>
          {costs.length > 0 ? (
            <div className="lg-currency-list">
              {costs.map((cost) => (
                <div key={cost.currency}><span>{cost.currency} 估算</span><strong>{fmtCost(cost.amount, cost.currency)}</strong></div>
              ))}
            </div>
          ) : <p>费用未知，未将缺价格请求显示为 0。</p>}
          <div className="lg-cost-note">Actual 账单未接入；缺价格 {summary?.unknownCostRequests ?? 0} 个请求；CNY 与 USD 分开呈现。</div>
        </Card>
      </div>

      <Card className="lg-recent-card">
        <div className="lg-section-heading">
          <div><div className="lg-card-kicker"><Activity size={15} /> 最近请求</div><h2>最近 7 天</h2></div>
          <Link className="lg-text-link" to="/logs">查看全部 <ArrowRight size={14} /></Link>
        </div>
        {recent && recent.length > 0 ? (
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
    </div>
  );
}
