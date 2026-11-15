// 预算与用量。
//
// 按「控制台风格调性 v1.2」原则 6 / 7 迁移：此前是全站文字最多的一页
// （7 段 / 575 汉字，基准页请求记录是 1 段 / 220 字）。四张费用状态卡每张都挂着
// 一整句解释、两块 .lg-trust-explanation 是纯说明、10 字段的账单导入表单直接摊在页面上。
// 现在：解释收进 HelpPopover 与 DetailsBlock，导入表单改成抽屉（本路由未被漂移检测监测，
// 允许抽屉），「对账覆盖」那句原本是派生数据冒充说明，改成页头的一行汇总指标。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleDollarSign, FileSearch, Gauge, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { getCostReconciliations, getLogsSummary, getTenantGovernance, importCostReconciliation, updateTenantGovernance } from '@/lib/api';
import type { CostReconciliationItem, CostReconciliationSummary, LogsSummaryData, TenantGovernanceData } from '@/lib/types';
import { Button, Card, InlineAlert, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import { fmtCost, fmtCompact, fmtShortTime } from '@/lib/logsHelpers';
import { useAuth } from '@/lib/auth';
import { useDialogFocus } from '@/lib/useDialogFocus';
import { canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP } from '@/lib/surface';
import { FIELD_INPUT, FIELD_LABEL, SECTION_TITLE } from '@/lib/typography';

export function UsagePage() {
  const { tenant } = useAuth();
  const [summary, setSummary] = useState<LogsSummaryData | null>(null);
  const [reconciliation, setReconciliation] = useState<CostReconciliationSummary | null>(null);
  const [governance, setGovernance] = useState<TenantGovernanceData | null>(null);
  const [governanceError, setGovernanceError] = useState<string | null>(null);
  const governanceRead = useRef(0);
  const [governanceUncertain, setGovernanceUncertain] = useState(false);
  const [governanceDraftNotice, setGovernanceDraftNotice] = useState<string | null>(null);
  const [governanceSavedAt, setGovernanceSavedAt] = useState<number | null>(null);
  const [governanceLoading, setGovernanceLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [governanceSaving, setGovernanceSaving] = useState(false);
  const [monthlyBudget, setMonthlyBudget] = useState('');
  const [budgetReservation, setBudgetReservation] = useState('');
  const [tenantRateLimit, setTenantRateLimit] = useState('');
  const [reconciliationLoading, setReconciliationLoading] = useState(true);
  const reconciliationRead = useRef(0);
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<CostReconciliationItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  // 抽屉自己的失败信息。页面级 error 渲染在 PageBody 里，会被 z-index 1100 的
  // 固定抽屉和它的毛玻璃背板整块盖住——导入被拒时用户只看到按钮停止转圈、
  // 没有任何解释，然后原样再试一次（Codex P2）。
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importUncertain, setImportUncertain] = useState(false);
  const [importConfirmed, setImportConfirmed] = useState(false);
  const [importChecking, setImportChecking] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const importSubmission = useRef<Parameters<typeof importCostReconciliation>[0] | null>(null);
  const importDialog = useRef<HTMLElement>(null);
  useDialogFocus(importDialog, () => setShowImport(false), importing, '[data-import-billing]', showImport);

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
    if (showImport || !importResult) return;
    const receipt = document.getElementById(`billing-${importResult.id}`);
    receipt?.focus({ preventScroll: true }); receipt?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [showImport, importResult]);

  const loadGovernance = useCallback(async (preserveDraft = false) => {
    const seq = ++governanceRead.current;
    setGovernanceSavedAt(null);
    setGovernanceLoading(true); setGovernance(null); setGovernanceError(null);
    const res = await getTenantGovernance().catch(() => ({ success: false as const, data: null, error: { code: 'NETWORK_ERROR', message: '租户硬限制连接失败' } }));
    if (seq !== governanceRead.current) return;
    setGovernanceLoading(false);
    if (!res.success || !res.data) {
      setGovernanceError(res.error?.message || '租户硬限制读取失败');
      return;
    }
    setGovernance(res.data);
    setGovernanceUncertain(false);
    if (preserveDraft) { setGovernanceDraftNotice('已重新读取服务端限制。本次草稿仍保留，请核对后再保存。'); return; }
    setGovernanceDraftNotice(null);
    setMonthlyBudget(res.data.monthlyBudgetUsd != null ? String(res.data.monthlyBudgetUsd) : '');
    setBudgetReservation(res.data.budgetReservationUsd != null ? String(res.data.budgetReservationUsd) : '');
    setTenantRateLimit(res.data.rateLimitPerMinute != null ? String(res.data.rateLimitPerMinute) : '');
  }, [tenant?.id]);

  useEffect(() => { void loadGovernance(); return () => { ++governanceRead.current; }; }, [loadGovernance]);
  useEffect(() => {
    let active = true;
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const params = { from: from.toISOString(), to: to.toISOString() };
    setError(null); setSummary(null); setReconciliationLoading(true); setReconciliationError(null);
    getLogsSummary({ ...params, view: 'logical' }).then((res) => {
      if (!active) return;
      if (res.success) setSummary(res.data);
      else setError(res.error.message);
    });
    const billSeq = ++reconciliationRead.current;
    setImportChecking(false); // This general read supersedes any outstanding import check.
    getCostReconciliations(params).catch(() => ({ success: false as const, data: null, error: { code: 'NETWORK_ERROR', message: '供应商账单读取中断' } })).then((res) => {
      if (!active || billSeq !== reconciliationRead.current) return;
      if (res.success) setReconciliation(res.data);
      else { setReconciliation(null); setReconciliationError(res.error.message || '供应商账单读取失败'); }
      setReconciliationLoading(false);
    });
    return () => { active = false; };
  }, [refresh]);

  const saveTenantGovernance = async () => {
    if (!governance || governanceUncertain || governanceLoading || governanceSaving || !canImportActual) return;
    setGovernanceSaving(true);
    setGovernanceSavedAt(null);
    setGovernanceDraftNotice(null);
    setGovernanceError(null);
    let res: Awaited<ReturnType<typeof updateTenantGovernance>>;
    try {
      res = await updateTenantGovernance({
        monthlyBudgetUsd: monthlyBudget ? Number(monthlyBudget) : null,
        budgetReservationUsd: budgetReservation ? Number(budgetReservation) : null,
        rateLimitPerMinute: tenantRateLimit ? Number(tenantRateLimit) : null,
      });
    } catch {
      res = { success: false, data: null, error: { code: 'NETWORK_ERROR', message: '保存响应读取中断' } };
    } finally { setGovernanceSaving(false); }
    if (!res.success) {
      // Only validation/authorization rejections prove no write happened. A lost response does not.
      const rejected = ['INVALID_INPUT', 'TENANT_NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(res.error.code);
      if (!rejected) {
        setGovernanceUncertain(true); setGovernance(null);
        setGovernanceError('保存结果未确认，服务端可能已更新。草稿已保留，请重新读取限制核对。');
      } else setGovernanceError(res.error.message || '租户硬限制保存被拒绝');
      return;
    }
    setGovernanceSavedAt(Date.now());
    setGovernance((current) => current ? {
      ...current,
      monthlyBudgetUsd: res.data.monthlyBudgetUsd,
      budgetReservationUsd: res.data.budgetReservationUsd,
      rateLimitPerMinute: res.data.rateLimitPerMinute,
    } : res.data);
  };

  const readImportedBill = async (checkSubmitted = false) => {
    const seq = ++reconciliationRead.current;
    setImportChecking(true); setReconciliationLoading(true); setReconciliationError(null);
    try {
      const to = new Date(), from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const res = await getCostReconciliations({ from: from.toISOString(), to: to.toISOString() });
      if (seq !== reconciliationRead.current) return;
      if (!res.success) throw new Error(res.error.message || '供应商账单读取失败');
      setReconciliation(res.data);
      if (checkSubmitted && importSubmission.current) {
        const submitted = importSubmission.current;
        const match = res.data.items.find(item => importedBillMatches(item, submitted));
        if (match) {
          setImportResult(match); setImportUncertain(false); setImportConfirmed(true);
          setImportError(null); setImportNotice('已找到与本次提交内容匹配的账单记录，请核对金额与关联请求。');
        } else setImportError('当前近30天可见记录中尚未找到匹配账单，不能据此认定导入未生效。已保留提交内容，请核对供应商流水及账单范围，暂不重复导入。');
      }
    } catch (error) {
      if (seq !== reconciliationRead.current) return;
      setReconciliationError(error instanceof Error ? error.message : '供应商账单读取中断');
      if (checkSubmitted) setImportError('账单核对未完成，导入结果仍未确认。提交内容已保留，请稍后重新读取。');
    } finally { if (seq === reconciliationRead.current) { setImportChecking(false); setReconciliationLoading(false); } }
  };

  const openImport = () => {
    if (importConfirmed) {
      setImportConfirmed(false); setImportResult(null); setImportError(null); setImportNotice(null);
      setExternalRecordId(''); setProviderRequestId(''); setActualCost(''); importSubmission.current = null;
    }
    setShowImport(true);
  };
  const submitActual = async () => {
    if (importing || importUncertain || importConfirmed || !canImportActual) return;
    const payload: Parameters<typeof importCostReconciliation>[0] = {
      provider: provider.trim(), externalRecordId: externalRecordId.trim(),
      providerRequestId: providerRequestId.trim() || undefined, serviceKeyId: serviceKeyId.trim() || undefined,
      windowFrom: providerRequestId.trim() || !windowFrom ? undefined : new Date(windowFrom).toISOString(),
      windowTo: providerRequestId.trim() || !windowTo ? undefined : new Date(windowTo).toISOString(),
      providerReportedCost: Number(actualCost), providerCostCurrency: actualCurrency.trim().toUpperCase(),
      fxSnapshotId: fxSnapshotId.trim() || undefined, providerToEstimatedFxRate: fxRate ? Number(fxRate) : undefined,
    };
    importSubmission.current = payload;
    setImporting(true); setImportError(null); setImportNotice(null);
    try {
      const res = await importCostReconciliation(payload);
      if (!res.success) {
        if (IMPORT_REJECTIONS.has(res.error.code)) setImportError(res.error.message || '账单导入被拒绝');
        else { setImportUncertain(true); setImportError('导入结果未确认，服务端可能已记录账单。提交内容已保留，请重新读取账单核对，暂不重复导入。'); }
        return;
      }
      setImportResult(res.data); setImportConfirmed(true);
      setImportNotice('供应商账单已导入。请核对下方回执；列表读取失败不会改变本次已确认结果。');
      await readImportedBill();
      setShowImport(false);
    } catch {
      setImportUncertain(true); setImportError('导入结果未确认，响应读取中断，服务端可能已记录账单。提交内容已保留，请重新读取账单核对。');
    } finally { setImporting(false); }
  };

  if (!summary && !error) return <SectionLoader text="正在加载用量…" />;

  const reconciledCount = countReconciliationStatus(reconciliation, 'reconciled');

  const summaryStrip = (
    <>
      <span>业务请求 <strong>{fmtCompact(summary?.total)}</strong></span>
      <span>价格覆盖 <strong>{summary?.total ? `${summary.priceCoveragePercent}%` : '—'}</strong></span>
      {/* 原来这一串是「对账覆盖」那段说明文字，其实全是派生数据——数据就该以指标呈现，
          而不是写成一句话让人读。 */}
      {reconciliation ? (
        <span>
          账单 <strong>{fmtCompact(reconciliation.totalRecords)}</strong> 条
          （逐请求 {fmtCompact(reconciliation.requestRecords)} · 时间窗 {fmtCompact(reconciliation.windowRecords)}）
        </span>
      ) : null}
      {reconciliation?.actualUnavailableRequests ? (
        <span>未标记对账的调用日志 <strong>{fmtCompact(reconciliation.actualUnavailableRequests)}</strong> 条<HelpPopover label="调用日志对账范围">此处统计同时间范围内未标记对账的非历史汇总调用日志，包含查询、下载及探测等操作；口径与业务请求量不同，不能相减。未标记对账不等于未返回实际费用。</HelpPopover></span>
      ) : null}
    </>
  );

  return (
    <PageShell>
      <PageHeader
        title="预算与用量"
        subtitle="近30天用量、Gateway 估算与供应商账单。"
        summary={summaryStrip}
        actions={(
          <>
            {canReadLogs ? <Link className="lg-text-link" to="/logs">打开请求记录 <ArrowRight size={14} /></Link> : null}
            {canImportActual ? <Button size="sm" variant="secondary" data-import-billing onClick={openImport}>{importUncertain ? '核对未确认账单' : '导入供应商账单'}</Button> : null}
          </>
        )}
      />
      <PageBody>
      {error ? <InlineAlert tone="error">用量暂不可用：{error} <Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>重新读取用量</Button></InlineAlert> : null}
      <Card style={CARD_BODY} aria-labelledby="tenant-governance-title">
        <div style={cardHeadStyle}>
          <h2 id="tenant-governance-title" style={SECTION_TITLE}>
            租户硬限制
            <HelpPopover label="租户硬限制">
              跨全部团队、Service Key 和 appCaller 聚合执行。租户层与 appCaller 层任一触顶都会拒绝请求，
              预占在服务端原子完成。清空三项并保存即可关闭租户总限制，已有 appCaller 与 Service Key 限制不受影响。
            </HelpPopover>
          </h2>
          <span style={countStyle}>服务端原子预占</span>
        </div>
        {governanceError ? <InlineAlert tone="error">{governanceError}{!governance && !governanceUncertain ? '。当前限制未知，不能按空值保存。' : ''} <Button size="sm" variant="ghost" disabled={governanceLoading || governanceSaving} onClick={() => void loadGovernance(governanceUncertain)}>重新读取限制</Button></InlineAlert> : null}
        <div className="lg-usage-grid">
          <Card><div className="lg-card-kicker">本月预算占用</div><strong className="lg-large-value">{!governance ? (governanceLoading ? '正在读取' : '未知') : governance.monthlyBudgetUsd ? fmtCost(governance.spentUsd, 'USD') : '未设上限'}</strong><p>{governance?.monthlyBudgetUsd ? `预算 ${fmtCost(governance.monthlyBudgetUsd, 'USD')}，剩余 ${fmtCost(governance.remainingBudgetUsd, 'USD')}` : '不代表供应商实际结算，不影响 appCaller 自身预算'}</p></Card>
          <Card><div className="lg-card-kicker">并发预占</div><strong className="lg-large-value">{!governance ? (governanceLoading ? '正在读取' : '未知') : governance.monthlyBudgetUsd ? fmtCost(governance.reservedUsd, 'USD') : '未启用'}</strong><p>{governance?.budgetReservationUsd ? `每请求保守预占 ${fmtCost(governance.budgetReservationUsd, 'USD')}` : '设置总月预算时必须同时设置'}</p></Card>
          <Card><div className="lg-card-kicker"><Gauge size={15} /> 当前分钟</div><strong className="lg-large-value">{!governance ? (governanceLoading ? '正在读取' : '未知') : governance.rateLimitPerMinute ? `${fmtCompact(governance.currentMinuteCount)} / ${fmtCompact(governance.rateLimitPerMinute)}` : '未设上限'}</strong><p>所有实际调用合计，分钟窗口原子计数</p></Card>
        </div>
        {canImportActual ? <DetailsBlock title="调整租户硬限制">
          {governanceDraftNotice ? <div role="status">{governanceDraftNotice}</div> : null}
          <fieldset disabled={!governance || governanceUncertain || governanceLoading || governanceSaving} style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
          <FormGrid>
            <label style={labelStyle}>租户总月预算（USD）<input type="number" min="0" step="any" value={monthlyBudget} onChange={(e) => { setMonthlyBudget(e.target.value); setGovernanceSavedAt(null); }} style={inputStyle} placeholder="留空表示不限制" /></label>
            <label style={labelStyle}>单请求原子预占（USD）<input type="number" min="0" step="any" value={budgetReservation} onChange={(e) => { setBudgetReservation(e.target.value); setGovernanceSavedAt(null); }} style={inputStyle} placeholder="总预算启用时必填" /></label>
            <label style={labelStyle}>租户每分钟总请求数<input type="number" min="0" step="1" value={tenantRateLimit} onChange={(e) => { setTenantRateLimit(e.target.value); setGovernanceSavedAt(null); }} style={inputStyle} placeholder="留空表示不限制" /></label>
            <Button variant="primary" size="sm" disabled={!governance || governanceUncertain || governanceLoading || governanceSaving || (!!monthlyBudget !== !!budgetReservation)} onClick={() => void saveTenantGovernance()}>{governanceSaving ? '保存中' : '保存硬限制'}</Button>
            {governanceSavedAt ? <span role="status">已保存 · {new Date(governanceSavedAt).toLocaleTimeString('zh-CN', { hourCycle: 'h23' })}</span> : null}
          </FormGrid>
          </fieldset>
        </DetailsBlock> : <div style={{ marginTop: GAP.section }}><ReadOnlyNotice>Owner 或 Admin 可修改租户总限制；当前角色仍可查看实时使用量。</ReadOnlyNotice></div>}
      </Card>
      <div className="lg-usage-grid">
        <Card><div className="lg-card-kicker"><CircleDollarSign size={15} /> 请求用量</div><strong className="lg-large-value">{fmtCompact(summary?.total)}</strong><p>{fmtCompact(summary?.totalTokens)} tokens</p></Card>
        <Card><div className="lg-card-kicker">价格覆盖率</div><strong className="lg-large-value">{!summary ? '未知' : summary.total ? `${summary.priceCoveragePercent}%` : '暂无请求'}</strong><p>{fmtCompact(summary?.pricedRequests)} 可估算 · {fmtCompact(summary?.unknownCostRequests)} 未知</p></Card>
        {summary?.cacheSavingsUsd != null ? (
          <Card>
            <div className="lg-card-kicker">缓存节省</div>
            <strong className="lg-large-value">{fmtCost(summary.cacheSavingsUsd, 'USD')}</strong>
            <p>命中缓存的输入按缓存价计，比全价省下这些</p>
          </Card>
        ) : null}
        {(summary?.estimatedCosts ?? []).map((item) => <Card key={item.currency}><div className="lg-card-kicker">{item.currency} Gateway 估算</div><strong className="lg-large-value">{fmtCost(item.amount, item.currency)}</strong><p>{fmtCompact(item.requests)} 个请求，未与其他币种相加</p></Card>)}
        {(reconciliation?.providerActualCosts ?? []).map((item) => <Card key={`actual-${item.currency}`}><div className="lg-card-kicker">{item.currency} 供应商实际账单</div><strong className="lg-large-value">{fmtCost(item.amount, item.currency)}</strong><p>{fmtCompact(item.requests)} 条供应商账单记录</p></Card>)}
      </div>
      <Card style={CARD_BODY} aria-labelledby="cost-state-title">
        <div style={cardHeadStyle}>
          <h2 id="cost-state-title" style={SECTION_TITLE}>
            金额证据四状态
            {/* 四张卡原本各挂一整句解释，一屏就是四段说明。解释收进这里，卡片只留数字。 */}
            <HelpPopover label="金额证据四状态">
              <dl>
                <dt>可估算</dt><dd>请求具备完整 token 和价格快照；金额仍按原币种分别展示。</dd>
                <dt>供应商实际</dt><dd>来自供应商响应或账单导入，不覆盖 Gateway 估算。</dd>
                <dt>估算未知</dt><dd>缺少 token 或价格时保持未知，绝不显示为金额 0。</dd>
                <dt>已对账</dt><dd>同币种可直接比较；跨币种只有具备 FX 凭证和汇率才计算差额。</dd>
              </dl>
            </HelpPopover>
          </h2>
          <span style={countStyle}>数量按记录，金额分币种</span>
        </div>
        <div className="lg-cost-state-grid">
          <CostStateCard state="estimated" title="可估算" value={!summary ? '未知' : summary.total ? fmtCompact(summary.pricedRequests) : '暂无请求'} />
          <CostStateCard state="actual" kicker="供应商账单" title="供应商实际" value={reconciliationStateValue(reconciliation, reconciliationLoading, reconciliationError, (data) => data.totalRecords)} />
          <CostStateCard state="unknown" title="估算未知" value={!summary ? '未知' : summary.total ? fmtCompact(summary.unknownCostRequests) : '暂无请求'} />
          <CostStateCard state="reconciled" kicker="可比较记录" title="已对账" value={reconciliationStateValue(reconciliation, reconciliationLoading, reconciliationError, () => reconciledCount)} />
        </div>
      </Card>
      {(summary?.topUnpricedModels?.length ?? 0) > 0 ? (
        <Card style={CARD_BODY} aria-labelledby="unpriced-title">
          <div style={cardHeadStyle}>
            <h2 id="unpriced-title" style={SECTION_TITLE}>待补价调用</h2>
            <span style={countStyle}>
              {fmtCompact(summary?.unpricedRequests)} 次缺价 · {fmtCompact(summary?.staleCurrencyRequests)} 次币种待换算
            </span>
          </div>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)', lineHeight: 'var(--lh-body)' }}>
            缺价调用不计入限额，补价后计入。
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight, marginTop: GAP.normal }}>
            {(summary?.topUnpricedModels ?? []).map((item) => (
              <div key={`${item.model}:${item.provider ?? ''}:${item.status}`} style={unpricedRowStyle}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block' }}>{item.model}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-caption)' }}>
                    {item.provider || '未知 Provider'}
                    {item.reason ? ` · ${item.reason}` : ''}
                  </span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.tight, flexWrap: 'nowrap' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{fmtCompact(item.requests)} 次</span>
                  <Link to={`/models/view?model=${encodeURIComponent(item.model)}`} style={{ color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                    查看模型详情
                    <ArrowRight size={13} style={{ verticalAlign: 'middle', marginLeft: 3 }} />
                  </Link>
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {importUncertain && !showImport ? <InlineAlert tone="info">导入结果未确认，提交内容已保留。<Button size="sm" variant="ghost" onClick={() => setShowImport(true)}>继续核对账单</Button></InlineAlert> : null}
      {importNotice && !showImport ? <div role="status">{importNotice}</div> : null}
      {importResult && (reconciliationError || !reconciliation?.items.some(item => item.id === importResult.id)) ? <ImportResult item={importResult} canReadLogs={canReadLogs} /> : null}
      <Card style={CARD_BODY} aria-labelledby="reconciliation-title">
        <div style={cardHeadStyle}>
          <h2 id="reconciliation-title" style={SECTION_TITLE}>
            最近对账记录
            <HelpPopover label="对账记录">
              逐条查看 Gateway 估算、供应商实际、差额依据和匹配粒度。这里只展示当前租户与当前团队权限范围内的数据。
            </HelpPopover>
          </h2>
          <span style={countStyle}>{reconciliationLoading ? '正在读取' : reconciliationError ? '读取失败' : `${fmtCompact(reconciliation?.items.length ?? 0)} 条可见`}</span>
        </div>
        {reconciliationLoading ? (
          <SectionLoader text="正在读取供应商账单…" />
        ) : reconciliationError ? (
          <InlineAlert tone="error">{reconciliationError}。估算仍可查看，供应商对账状态未知。 <Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>重新读取账单</Button></InlineAlert>
        ) : reconciliation && reconciliation.items.length > 0 ? (
          <div className="lg-reconciliation-list">
            {reconciliation.items.map((item) => <ReconciliationRecord key={item.id} item={item} canReadLogs={canReadLogs} selected={item.id === importResult?.id} />)}
          </div>
        ) : (
          <div className="lg-empty-guidance"><FileSearch size={20} /><div><strong>还没有供应商账单记录</strong><p>{canImportActual ? '点击“导入供应商账单”，有请求编号时按单条请求对账；没有编号时选择明确时间窗。' : '当前角色可以查看费用；请由 Owner 或 Admin 导入供应商账单后再回来核对。'}</p></div></div>
        )}
      </Card>

      <DetailsBlock title="工作原理：费用为什么不会被算成 0">
        <Prose>
          估算费用来自请求完成时保存的价格快照，实际费用来自供应商响应或账单导入，两者不会互相覆盖。
          缺价格保持“未知”，不会显示成 0；CNY 与 USD 只有在提供汇率凭证编号和明确汇率时才计算差额。
        </Prose>
        <TutorialLink chapter="chapter-23">查看教程：第 23 章 费用与对账</TutorialLink>
      </DetailsBlock>
      </PageBody>

      {showImport && canImportActual ? createPortal(
        <div className="lg-side-drawer-portal">
          <button className="lg-side-drawer-backdrop" type="button" aria-label="关闭" disabled={importing} onClick={() => setShowImport(false)} />
          <aside ref={importDialog} tabIndex={-1} className="lg-side-drawer" role="dialog" aria-modal="true" aria-label="导入供应商账单">
            <header className="lg-side-drawer-header">
              <div className="lg-side-drawer-title">
                <span className="lg-side-drawer-icon"><CircleDollarSign size={17} /></span>
                <div><small>导入供应商账单</small><h2>与 Gateway 估算对账</h2></div>
              </div>
              <button type="button" aria-label="关闭" disabled={importing} onClick={() => setShowImport(false)}><X size={18} /></button>
            </header>
            <div className="lg-side-drawer-body">
        {importError ? <InlineAlert tone="error">{importError}</InlineAlert> : null}
        {importNotice ? <div role="status">{importNotice}</div> : null}
        <fieldset disabled={importing || importUncertain || importConfirmed} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
        <label style={labelStyle}>
          供应商名称
          <HelpPopover label="匹配方式">
            <strong>先选一种匹配方式：</strong>供应商给了请求编号，就按单条请求对账；没有编号，就选择账单时间范围。系统只会查当前租户的数据，找不到、命中多条或时间范围重叠都会拒绝写入。
          </HelpPopover>
          <input value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle} placeholder="例如 OpenRouter" /></label>
        <label style={labelStyle}>供应商账单唯一流水号<input value={externalRecordId} onChange={(e) => setExternalRecordId(e.target.value)} style={inputStyle} placeholder="用于防止重复导入" /></label>
        <label style={labelStyle}>供应商请求编号（有则填）<input value={providerRequestId} onChange={(e) => setProviderRequestId(e.target.value)} style={inputStyle} placeholder="填写后按单条请求对账" /></label>
        <label style={labelStyle}>接入密钥编号（可选）<input value={serviceKeyId} onChange={(e) => setServiceKeyId(e.target.value)} style={inputStyle} placeholder="汇总账单可限定一把 key" /></label>
        {!providerRequestId.trim() ? <><label style={labelStyle}>账单窗开始<input type="datetime-local" value={windowFrom} onChange={(e) => setWindowFrom(e.target.value)} style={inputStyle} /></label><label style={labelStyle}>账单窗结束<input type="datetime-local" value={windowTo} onChange={(e) => setWindowTo(e.target.value)} style={inputStyle} /></label></> : null}
        <label style={labelStyle}>供应商实际金额<input type="number" min="0" step="any" value={actualCost} onChange={(e) => setActualCost(e.target.value)} style={inputStyle} /></label>
        <label style={labelStyle}>供应商实际币种<input value={actualCurrency} onChange={(e) => setActualCurrency(e.target.value)} style={inputStyle} maxLength={3} /></label>
        <label style={labelStyle}>汇率凭证编号<input value={fxSnapshotId} onChange={(e) => setFxSnapshotId(e.target.value)} style={inputStyle} placeholder="跨币种时必填" /></label>
        <label style={labelStyle}>
          实际币种 → 估算币种汇率
          <HelpPopover label="汇率与币种" align="end">
            供应商账单唯一流水号不是 Gateway requestId。CNY 与 USD 不会直接相加；没有汇率凭证时只分别展示，不计算差额。
          </HelpPopover>
          <input type="number" min="0" step="any" value={fxRate} onChange={(e) => setFxRate(e.target.value)} style={inputStyle} placeholder="跨币种时必填" /></label>
        </fieldset>
            </div>
            <div className="lg-side-drawer-footer">
              <Button variant="primary" size="sm" disabled={importing || importUncertain || importConfirmed || !provider.trim() || !externalRecordId.trim() || !actualCost || (!providerRequestId.trim() && (!windowFrom || !windowTo))} onClick={() => void submitActual()}>{importing ? '导入中' : '确认导入'}</Button>
              {importUncertain ? <Button size="sm" variant="secondary" disabled={importChecking} onClick={() => void readImportedBill(true)}>{importChecking ? '正在核对' : '重新读取账单核对'}</Button> : null}
              {importConfirmed ? <Button size="sm" variant="secondary" onClick={() => setShowImport(false)}>查看账单回执</Button> : null}
            </div>
          </aside>
        </div>,
        document.body,
      ) : null}
    </PageShell>
  );
}

const cardHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: GAP.section,
  flexWrap: 'wrap',
  marginBottom: GAP.normal,
};
const countStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' };

function CostStateCard({ state, kicker, title, value }: { state: 'estimated' | 'actual' | 'unknown' | 'reconciled'; kicker?: string; title: string; value: string }) {
  const defaultKicker = { estimated: 'Gateway 估算', actual: '供应商账单', unknown: '不可估算请求', reconciled: '可比较记录' }[state];
  return <article className={`lg-cost-state-card is-${state}`}><small>{kicker || defaultKicker}</small><strong>{value}</strong><h3>{title}</h3></article>;
}

function ImportResult({ item, canReadLogs }: { item: CostReconciliationItem; canReadLogs: boolean }) {
  const status = reconciliationStatusMeta(item.reconciliationStatus);
  return (
    <div id={`billing-${item.id}`} tabIndex={-1} className="lg-reconciliation-result" role="status">
      <CheckCircle2 size={18} />
      <div><strong>供应商账单已导入</strong><span>{item.granularity === 'request' ? '已按单条请求匹配' : '已按明确时间窗记录为汇总账单'} · {item.provider} · {item.externalRecordId}</span></div>
      <div className="lg-reconciliation-result-values"><span>估算 {formatKnownCost(item.estimatedCost, item.estimatedCostCurrency, '未知')}</span><span>实际 {formatKnownCost(item.providerReportedCost, item.providerCostCurrency, '缺失')}</span><span style={{ color: status.color }}>{status.label}</span><span>差额 {formatDelta(item)}</span></div>
      {canReadLogs && item.requestId ? <Link className="lg-text-link" to={`/logs?requestId=${encodeURIComponent(item.requestId)}`}>打开 requestId <ArrowRight size={13} /></Link> : null}
    </div>
  );
}

function ReconciliationRecord({ item, canReadLogs, selected = false }: { item: CostReconciliationItem; canReadLogs: boolean; selected?: boolean }) {
  const status = reconciliationStatusMeta(item.reconciliationStatus);
  const matchLabel = item.granularity === 'request'
    ? `单条请求${item.providerRequestId ? ` · Provider ${item.providerRequestId}` : ''}`
    : `时间窗汇总 · ${fmtShortTime(item.windowFrom)} 至 ${fmtShortTime(item.windowTo)}`;
  return (
    <article id={`billing-${item.id}`} tabIndex={-1} className="lg-reconciliation-card" aria-label={selected ? `本次核对账单 ${item.externalRecordId}` : undefined}>
      <div className="lg-reconciliation-card-head">
        <div><strong>{item.provider}{selected ? ' · 本次核对' : ''}</strong><span>{item.externalRecordId}</span></div>
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
  // statusDistribution 缺失时整页白屏：`summary?.` 只护住了 summary，没护住这个数组。
  // 后端少给一个字段就让「预算与用量」变空白页，代价与收益完全不成比例。
  return summary?.statusDistribution
    ?.filter((item) => item.key.toLowerCase() === status)
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
  if (status === 'actual-invalid') return { label: '金额无效', explanation: '供应商币种或金额证据无效', color: 'var(--err)', background: 'var(--err-bg)' };
  return { label: status || '未知状态', explanation: '状态尚未形成可比较差额', color: 'var(--text-muted)', background: 'var(--bg-elevated)' };
}

const labelStyle: React.CSSProperties = FIELD_LABEL;
const inputStyle: React.CSSProperties = FIELD_INPUT;

const unpricedRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.normal,
  padding: 10,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  fontSize: 'var(--fs-body)',
};

// These input/scope rejections occur before writes in the import endpoint. Unfamiliar errors
// (including network errors and post-write failures) never prove the bill was not recorded.
const IMPORT_REJECTIONS = new Set(['INVALID_PROVIDER_COST', 'INVALID_FX_SNAPSHOT', 'PROVIDER_REQUEST_NOT_FOUND', 'PROVIDER_REQUEST_AMBIGUOUS', 'PROVIDER_REQUEST_COVERED_BY_WINDOW', 'INVALID_BILLING_WINDOW', 'SERVICE_KEY_NOT_FOUND', 'BILLING_WINDOW_EMPTY', 'BILLING_WINDOW_TOO_LARGE', 'BILLING_WINDOW_TEAM_AMBIGUOUS', 'BILLING_WINDOW_CONTAINS_RECONCILED_REQUEST', 'BILLING_WINDOW_OVERLAP', 'COST_IMPORT_SCOPE_BUSY']);
function importedBillMatches(item: CostReconciliationItem, submitted: Parameters<typeof importCostReconciliation>[0]) {
  const sameInstant = (actual: string | null | undefined, expected: string | undefined) => !expected ? !actual : !!actual && new Date(actual).getTime() === new Date(expected).getTime();
  return item.provider === submitted.provider && item.externalRecordId === submitted.externalRecordId
    && item.providerReportedCost === submitted.providerReportedCost && item.providerCostCurrency === submitted.providerCostCurrency
    && (item.providerRequestId || '') === (submitted.providerRequestId || '')
    && (!submitted.serviceKeyId || item.serviceKeyId === submitted.serviceKeyId)
    && (item.fxSnapshotId || '') === (submitted.fxSnapshotId || '')
    && (item.providerToEstimatedFxRate ?? null) === (submitted.providerToEstimatedFxRate ?? null)
    && (submitted.providerRequestId ? item.granularity === 'request' : item.granularity === 'window' && sameInstant(item.windowFrom, submitted.windowFrom) && sameInstant(item.windowTo, submitted.windowTo));
}
