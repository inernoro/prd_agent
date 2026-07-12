import { useEffect, useState } from 'react';
import { ArrowRight, CircleDollarSign } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getLogsSummary } from '@/lib/api';
import type { LogsSummaryData } from '@/lib/types';
import { Card, SectionLoader } from '@/components/ui';
import { fmtCost, fmtCompact } from '@/lib/logsHelpers';

export function UsagePage() {
  const [summary, setSummary] = useState<LogsSummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    getLogsSummary({ from: from.toISOString(), to: to.toISOString() }).then((res) => {
      if (res.success) setSummary(res.data);
      else setError(res.error.message);
    });
  }, []);

  if (!summary && !error) return <SectionLoader text="正在加载用量…" />;

  return (
    <div className="lg-simple-page">
      <div className="lg-page-heading">
        <div><div className="lg-eyebrow">Governance</div><h1>预算与用量</h1><p>最近 30 天的请求用量与可审计费用估算。</p></div>
        <Link className="lg-text-link" to="/logs">打开请求记录 <ArrowRight size={14} /></Link>
      </div>
      {error ? <div className="lg-inline-alert">{error}</div> : null}
      <div className="lg-usage-grid">
        <Card><div className="lg-card-kicker"><CircleDollarSign size={15} /> 请求用量</div><strong className="lg-large-value">{fmtCompact(summary?.total)}</strong><p>{fmtCompact(summary?.totalTokens)} tokens</p></Card>
        <Card><div className="lg-card-kicker">价格覆盖率</div><strong className="lg-large-value">{summary?.total ? `${summary.priceCoveragePercent}%` : '暂无请求'}</strong><p>{fmtCompact(summary?.pricedRequests)} 可估算 · {fmtCompact(summary?.unknownCostRequests)} 未知</p></Card>
        {(summary?.estimatedCosts ?? []).map((item) => <Card key={item.currency}><div className="lg-card-kicker">{item.currency} estimated</div><strong className="lg-large-value">{fmtCost(item.amount, item.currency)}</strong><p>{fmtCompact(item.requests)} 个请求，未与其他币种相加</p></Card>)}
      </div>
      <div className="lg-trust-explanation"><strong>可信度规则</strong><span>Actual 供应商账单尚未接入，不展示伪造金额。缺价格不显示为 0；这里只汇总日志写入时的 estimated 价格快照。CNY 与 USD 保持原币种，未配置可审计汇率前不会合并。</span></div>
    </div>
  );
}
