import { useEffect, useState } from 'react';
import { ArrowRight, CircleDollarSign } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getCostReconciliations, getLogsSummary, importCostReconciliation } from '@/lib/api';
import type { CostReconciliationSummary, LogsSummaryData } from '@/lib/types';
import { Button, Card, SectionLoader } from '@/components/ui';
import { fmtCost, fmtCompact } from '@/lib/logsHelpers';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

export function UsagePage() {
  const { tenant } = useAuth();
  const [summary, setSummary] = useState<LogsSummaryData | null>(null);
  const [reconciliation, setReconciliation] = useState<CostReconciliationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [provider, setProvider] = useState('');
  const [externalRecordId, setExternalRecordId] = useState('');
  const [providerRequestId, setProviderRequestId] = useState('');
  const [serviceKeyId, setServiceKeyId] = useState('');
  const [windowFrom, setWindowFrom] = useState('');
  const [windowTo, setWindowTo] = useState('');
  const [actualCost, setActualCost] = useState('');
  const [actualCurrency, setActualCurrency] = useState('USD');
  const [fxSnapshotId, setFxSnapshotId] = useState('');
  const [fxRate, setFxRate] = useState('');
  const canImportActual = canUseCapability(tenant?.role, 'configWrite');
  const canReadLogs = canUseCapability(tenant?.role, 'logsRead');

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const params = { from: from.toISOString(), to: to.toISOString() };
    getLogsSummary(params).then((res) => {
      if (res.success) setSummary(res.data);
      else setError(res.error.message);
    });
    getCostReconciliations(params).then((res) => {
      if (res.success) setReconciliation(res.data);
    });
  }, []);

  const submitActual = async () => {
    setImporting(true);
    setError(null);
    const res = await importCostReconciliation({
      provider: provider.trim(),
      externalRecordId: externalRecordId.trim(),
      providerRequestId: providerRequestId.trim() || undefined,
      serviceKeyId: serviceKeyId.trim() || undefined,
      windowFrom: providerRequestId.trim() || !windowFrom ? undefined : new Date(windowFrom).toISOString(),
      windowTo: providerRequestId.trim() || !windowTo ? undefined : new Date(windowTo).toISOString(),
      providerReportedCost: Number(actualCost),
      providerCostCurrency: actualCurrency.trim().toUpperCase(),
      fxSnapshotId: fxSnapshotId.trim() || undefined,
      providerToEstimatedFxRate: fxRate ? Number(fxRate) : undefined,
    });
    setImporting(false);
    if (!res.success) {
      setError(res.error.message || '供应商账单导入失败');
      return;
    }
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const refreshed = await getCostReconciliations({ from: from.toISOString(), to: to.toISOString() });
    if (refreshed.success) setReconciliation(refreshed.data);
    setShowImport(false);
    setExternalRecordId('');
    setProviderRequestId('');
    setActualCost('');
  };

  if (!summary && !error) return <SectionLoader text="正在加载用量…" />;

  return (
    <div className="lg-simple-page">
      <div className="lg-page-heading">
        <div><div className="lg-eyebrow">治理</div><h1>预算与用量</h1><p>最近 30 天的请求用量、费用估算和供应商账单对照。</p></div>
        {canReadLogs ? <Link className="lg-text-link" to="/logs">打开请求记录 <ArrowRight size={14} /></Link> : null}
        {canImportActual ? <Button size="sm" variant="ghost" onClick={() => setShowImport((value) => !value)}>{showImport ? '取消导入' : '导入供应商账单'}</Button> : null}
      </div>
      {error ? <div className="lg-inline-alert">{error}</div> : null}
      <div className="lg-usage-grid">
        <Card><div className="lg-card-kicker"><CircleDollarSign size={15} /> 请求用量</div><strong className="lg-large-value">{fmtCompact(summary?.total)}</strong><p>{fmtCompact(summary?.totalTokens)} tokens</p></Card>
        <Card><div className="lg-card-kicker">价格覆盖率</div><strong className="lg-large-value">{summary?.total ? `${summary.priceCoveragePercent}%` : '暂无请求'}</strong><p>{fmtCompact(summary?.pricedRequests)} 可估算 · {fmtCompact(summary?.unknownCostRequests)} 未知</p></Card>
        {(summary?.estimatedCosts ?? []).map((item) => <Card key={item.currency}><div className="lg-card-kicker">{item.currency} 估算费用</div><strong className="lg-large-value">{fmtCost(item.amount, item.currency)}</strong><p>{fmtCompact(item.requests)} 个请求，未与其他币种相加</p></Card>)}
        {(reconciliation?.providerActualCosts ?? []).map((item) => <Card key={`actual-${item.currency}`}><div className="lg-card-kicker">{item.currency} 供应商实际费用</div><strong className="lg-large-value">{fmtCost(item.amount, item.currency)}</strong><p>{fmtCompact(item.requests)} 条供应商账单记录</p></Card>)}
      </div>
      {showImport && canImportActual ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
        <div style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6 }}><strong>先选一种匹配方式：</strong>供应商给了请求编号，就按单条请求对账；没有编号，就选择账单时间范围。系统只会查当前租户的数据，找不到、命中多条或时间范围重叠都会拒绝写入。</div>
        <label style={labelStyle}>供应商名称<input value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle} placeholder="例如 OpenRouter" /></label>
        <label style={labelStyle}>供应商账单唯一流水号<input value={externalRecordId} onChange={(e) => setExternalRecordId(e.target.value)} style={inputStyle} placeholder="用于防止重复导入" /></label>
        <label style={labelStyle}>供应商请求编号（有则填）<input value={providerRequestId} onChange={(e) => setProviderRequestId(e.target.value)} style={inputStyle} placeholder="填写后按单条请求对账" /></label>
        <label style={labelStyle}>接入密钥编号（可选）<input value={serviceKeyId} onChange={(e) => setServiceKeyId(e.target.value)} style={inputStyle} placeholder="汇总账单可限定一把 key" /></label>
        {!providerRequestId.trim() ? <><label style={labelStyle}>账单窗开始<input type="datetime-local" value={windowFrom} onChange={(e) => setWindowFrom(e.target.value)} style={inputStyle} /></label><label style={labelStyle}>账单窗结束<input type="datetime-local" value={windowTo} onChange={(e) => setWindowTo(e.target.value)} style={inputStyle} /></label></> : null}
        <label style={labelStyle}>供应商实际金额<input type="number" min="0" step="any" value={actualCost} onChange={(e) => setActualCost(e.target.value)} style={inputStyle} /></label>
        <label style={labelStyle}>供应商实际币种<input value={actualCurrency} onChange={(e) => setActualCurrency(e.target.value)} style={inputStyle} maxLength={3} /></label>
        <label style={labelStyle}>汇率凭证编号<input value={fxSnapshotId} onChange={(e) => setFxSnapshotId(e.target.value)} style={inputStyle} placeholder="跨币种时必填" /></label>
        <label style={labelStyle}>实际币种换算到估算币种的汇率<input type="number" min="0" step="any" value={fxRate} onChange={(e) => setFxRate(e.target.value)} style={inputStyle} placeholder="跨币种时必填" /></label>
        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>供应商账单唯一流水号不是 Gateway requestId。CNY 与 USD 不会直接相加；没有汇率凭证时只分别展示，不计算差额。</span><Button variant="primary" disabled={importing || !provider.trim() || !externalRecordId.trim() || !actualCost || (!providerRequestId.trim() && (!windowFrom || !windowTo))} onClick={() => void submitActual()}>{importing ? '导入中' : '确认导入'}</Button></div>
      </div> : null}
      <div className="lg-trust-explanation"><strong>可信度规则</strong><span>估算费用来自请求完成时保存的价格快照，实际费用来自供应商响应或账单导入，两者不会互相覆盖。缺价格保持“未知”，不会显示成 0；CNY 与 USD 只有在提供汇率凭证编号和明确汇率时才计算差额。</span></div>
      {reconciliation ? <div className="lg-trust-explanation"><strong>对账覆盖</strong><span>{reconciliation.totalRecords} 条账单记录，其中逐请求 {reconciliation.requestRecords} 条、时间窗 {reconciliation.windowRecords} 条；最近 30 天仍有 {reconciliation.actualUnavailableRequests} 个请求没有逐请求实际费用。供应商仅提供汇总账单时不会伪装成逐请求费用。</span></div> : null}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'grid', gap: 5, color: 'var(--text-muted)', fontSize: 12 };
const inputStyle: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '8px 9px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' };
