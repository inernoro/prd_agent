import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleDollarSign, FileSearch } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getCostReconciliations, getLogsSummary, importCostReconciliation } from '@/lib/api';
import type { CostReconciliationItem, CostReconciliationSummary, LogsSummaryData } from '@/lib/types';
import { Button, Card, SectionLoader } from '@/components/ui';
import { fmtCost, fmtCompact, fmtShortTime } from '@/lib/logsHelpers';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

export function UsagePage() {
  const { tenant } = useAuth();
  const [summary, setSummary] = useState<LogsSummaryData | null>(null);
  const [reconciliation, setReconciliation] = useState<CostReconciliationSummary | null>(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(true);
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<CostReconciliationItem | null>(null);
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
      else setReconciliationError(res.error.message || '供应商账单读取失败');
      setReconciliationLoading(false);
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
    setImportResult(res.data);
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const refreshed = await getCostReconciliations({ from: from.toISOString(), to: to.toISOString() });
    if (refreshed.success) {
      setReconciliation(refreshed.data);
      setReconciliationError(null);
    } else {
      setReconciliationError(refreshed.error.message || '供应商账单刷新失败');
    }
    setShowImport(false);
    setExternalRecordId('');
    setProviderRequestId('');
    setActualCost('');
  };

  if (!summary && !error) return <SectionLoader text="正在加载用量…" />;

  const reconciledCount = countReconciliationStatus(reconciliation, 'reconciled');

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
      <section className="lg-cost-state-section" aria-labelledby="cost-state-title">
        <div className="lg-section-heading">
          <div><div className="lg-card-kicker">费用可信度</div><h2 id="cost-state-title">费用四状态</h2><p>先看金额来自哪里，再决定能否比较。这里展示的是记录数量，不会把不同币种合成一个金额。</p></div>
        </div>
        <div className="lg-cost-state-grid">
          <CostStateCard state="estimated" title="可估算" value={summary?.total ? fmtCompact(summary.pricedRequests) : '暂无请求'} detail="请求具备完整 token 和价格快照；金额仍按原币种分别展示。" />
          <CostStateCard state="actual" kicker="供应商账单" title="供应商实际" value={reconciliationStateValue(reconciliation, reconciliationLoading, reconciliationError, (data) => data.totalRecords)} detail="来自供应商响应或账单导入，不覆盖 Gateway 估算。" />
          <CostStateCard state="unknown" title="估算未知" value={summary?.total ? fmtCompact(summary.unknownCostRequests) : '暂无请求'} detail="缺少 token 或价格时保持未知，绝不显示为费用 0。" />
          <CostStateCard state="reconciled" kicker="可比较记录" title="已对账" value={reconciliationStateValue(reconciliation, reconciliationLoading, reconciliationError, () => reconciledCount)} detail="同币种可直接比较；跨币种只有具备 FX 凭证和汇率才计算差额。" />
        </div>
      </section>
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
      {importResult ? <ImportResult item={importResult} canReadLogs={canReadLogs} /> : null}
      <div className="lg-trust-explanation"><strong>可信度规则</strong><span>估算费用来自请求完成时保存的价格快照，实际费用来自供应商响应或账单导入，两者不会互相覆盖。缺价格保持“未知”，不会显示成 0；CNY 与 USD 只有在提供汇率凭证编号和明确汇率时才计算差额。</span></div>
      {reconciliation ? <div className="lg-trust-explanation"><strong>对账覆盖</strong><span>{reconciliation.totalRecords} 条账单记录，其中逐请求 {reconciliation.requestRecords} 条、时间窗 {reconciliation.windowRecords} 条；最近 30 天仍有 {reconciliation.actualUnavailableRequests} 个请求没有逐请求实际费用。供应商仅提供汇总账单时不会伪装成逐请求费用。</span></div> : null}
      <section className="lg-reconciliation-section" aria-labelledby="reconciliation-title">
        <div className="lg-section-heading">
          <div><div className="lg-card-kicker">双向追溯</div><h2 id="reconciliation-title">最近对账记录</h2><p>逐条查看 Gateway 估算、供应商实际、差额依据和匹配粒度。这里只展示当前租户与当前团队权限范围内的数据。</p></div>
          <span className="lg-record-count">{reconciliationLoading ? '正在读取' : reconciliationError ? '读取失败' : `${fmtCompact(reconciliation?.items.length ?? 0)} 条可见`}</span>
        </div>
        {reconciliationLoading ? (
          <SectionLoader text="正在读取供应商账单…" />
        ) : reconciliationError ? (
          <div className="lg-inline-alert">{reconciliationError}。费用估算仍可查看，但当前不能宣称已完成供应商对账。</div>
        ) : reconciliation && reconciliation.items.length > 0 ? (
          <div className="lg-reconciliation-list">
            {reconciliation.items.map((item) => <ReconciliationRecord key={item.id} item={item} canReadLogs={canReadLogs} />)}
          </div>
        ) : (
          <div className="lg-empty-guidance"><FileSearch size={20} /><div><strong>还没有供应商账单记录</strong><p>{canImportActual ? '点击“导入供应商账单”，有请求编号时按单条请求对账；没有编号时选择明确时间窗。' : '当前角色可以查看费用；请由 Owner 或 Admin 导入供应商账单后再回来核对。'}</p></div></div>
        )}
      </section>
    </div>
  );
}

function CostStateCard({ state, kicker, title, value, detail }: { state: 'estimated' | 'actual' | 'unknown' | 'reconciled'; kicker?: string; title: string; value: string; detail: string }) {
  const defaultKicker = { estimated: 'Gateway 估算', actual: '供应商账单', unknown: '不可估算请求', reconciled: '可比较记录' }[state];
  return <article className={`lg-cost-state-card is-${state}`}><small>{kicker || defaultKicker}</small><strong>{value}</strong><h3>{title}</h3><p>{detail}</p></article>;
}

function ImportResult({ item, canReadLogs }: { item: CostReconciliationItem; canReadLogs: boolean }) {
  const status = reconciliationStatusMeta(item.reconciliationStatus);
  return (
    <div className="lg-reconciliation-result" role="status">
      <CheckCircle2 size={18} />
      <div><strong>供应商账单已导入</strong><span>{item.granularity === 'request' ? '已按单条请求匹配' : '已按明确时间窗记录为汇总账单'} · {item.provider} · {item.externalRecordId}</span></div>
      <div className="lg-reconciliation-result-values"><span>估算 {formatKnownCost(item.estimatedCost, item.estimatedCostCurrency, '未知')}</span><span>实际 {formatKnownCost(item.providerReportedCost, item.providerCostCurrency, '缺失')}</span><span style={{ color: status.color }}>{status.label}</span><span>差额 {formatDelta(item)}</span></div>
      {canReadLogs && item.requestId ? <Link className="lg-text-link" to={`/logs?requestId=${encodeURIComponent(item.requestId)}`}>打开 requestId <ArrowRight size={13} /></Link> : null}
    </div>
  );
}

function ReconciliationRecord({ item, canReadLogs }: { item: CostReconciliationItem; canReadLogs: boolean }) {
  const status = reconciliationStatusMeta(item.reconciliationStatus);
  const matchLabel = item.granularity === 'request'
    ? `单条请求${item.providerRequestId ? ` · Provider ${item.providerRequestId}` : ''}`
    : `时间窗汇总 · ${fmtShortTime(item.windowFrom)} 至 ${fmtShortTime(item.windowTo)}`;
  return (
    <article className="lg-reconciliation-card">
      <div className="lg-reconciliation-card-head">
        <div><strong>{item.provider}</strong><span>{item.externalRecordId}</span></div>
        <span className="lg-reconciliation-status" style={{ color: status.color, background: status.background }}>{status.label}</span>
      </div>
      <div className="lg-reconciliation-match"><span>{item.granularity === 'request' ? '逐请求' : '时间窗'}</span><strong>{matchLabel}</strong></div>
      <div className="lg-reconciliation-metrics">
        <CostMetric label="Gateway 估算" value={formatKnownCost(item.estimatedCost, item.estimatedCostCurrency, '未知')} note={item.estimatedCost == null ? '缺 token 或价格快照' : '请求时价格快照'} />
        <CostMetric label="供应商实际" value={formatKnownCost(item.providerReportedCost, item.providerCostCurrency, '实际金额缺失')} note="供应商账单证据" />
        <CostMetric label="对账差额" value={formatDelta(item)} note={status.explanation} />
        <CostMetric label="汇率凭证" value={item.fxSnapshotId || '不适用或未提供'} note={item.providerToEstimatedFxRate ? `汇率 ${item.providerToEstimatedFxRate}` : '前端不猜测汇率'} />
      </div>
      <div className="lg-reconciliation-footer">
        <span>{item.model || '未限定模型'} · {item.serviceKeyId ? `Key ${item.serviceKeyId}` : '未限定接入密钥'} · 账单时间 {fmtShortTime(item.billedAt || item.createdAt)}</span>
        {canReadLogs && item.requestId ? <Link className="lg-text-link" to={`/logs?requestId=${encodeURIComponent(item.requestId)}`}>回查请求 {item.requestId} <ArrowRight size={13} /></Link> : <span>{item.granularity === 'window' ? '汇总记录没有单条 requestId' : '当前角色不读取请求内容'}</span>}
      </div>
    </article>
  );
}

function CostMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div><small>{label}</small><strong>{value}</strong><span>{note}</span></div>;
}

function countReconciliationStatus(summary: CostReconciliationSummary | null, status: string) {
  return summary?.statusDistribution
    .filter((item) => item.key.toLowerCase() === status)
    .reduce((total, item) => total + item.count, 0) ?? 0;
}

function reconciliationStateValue(
  reconciliation: CostReconciliationSummary | null,
  loading: boolean,
  error: string | null,
  read: (data: CostReconciliationSummary) => number,
) {
  if (loading) return '正在读取';
  if (error) return '不可用';
  return reconciliation ? fmtCompact(read(reconciliation)) : '暂无账单';
}

function formatKnownCost(value: number | null | undefined, currency: string | null | undefined, unknownLabel: string) {
  return value == null ? unknownLabel : fmtCost(value, currency);
}

function formatDelta(item: CostReconciliationItem) {
  if (item.reconciliationStatus !== 'reconciled' || item.reconciliationDelta == null) return '不计算';
  const value = fmtCost(item.reconciliationDelta, item.deltaCurrency);
  return item.reconciliationDelta > 0 ? `+${value}` : value;
}

function reconciliationStatusMeta(status: string) {
  if (status === 'reconciled') return { label: '已对账', explanation: '相同币种，或已使用可审计 FX 凭证', color: 'var(--ok)', background: 'var(--ok-bg)' };
  if (status === 'estimated-unavailable') return { label: '估算未知', explanation: '缺少完整 token 或价格快照，差额保持未知', color: 'var(--warn)', background: 'var(--warn-bg)' };
  if (status === 'fx-unavailable') return { label: '缺汇率凭证', explanation: '币种不同且没有可审计 FX，禁止计算差额', color: 'var(--warn)', background: 'var(--warn-bg)' };
  if (status === 'actual-invalid') return { label: '实际金额无效', explanation: '供应商币种或金额证据无效', color: 'var(--err)', background: 'var(--err-bg)' };
  return { label: status || '未知状态', explanation: '状态尚未形成可比较差额', color: 'var(--text-muted)', background: 'var(--bg-elevated)' };
}

const labelStyle: React.CSSProperties = { display: 'grid', gap: 5, color: 'var(--text-muted)', fontSize: 12 };
const inputStyle: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '8px 9px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' };
