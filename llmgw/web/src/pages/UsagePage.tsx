// 财务任务先行：金额与证据 → 账单回查 → 租户限制；读取与未确认写入各自保留真实状态。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleDollarSign, FileSearch, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { buildLogRequestHref } from '@/lib/logNavigation';
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
import './UsagePage.css';

export function UsagePage() {
  const { tenant } = useAuth();
  const location = useLocation();
  const [windowRange, setWindowRange] = useState(() => usageWindow(location.search));
  const restoredBillingAnchor = useRef('');
  const [returnNotice, setReturnNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<LogsSummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
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
  const nextBillCheck = useRef(false);
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

  useEffect(() => {
    const marker = `${location.key}|${location.hash}`;
    if (!location.hash.startsWith('#billing-') || marker === restoredBillingAnchor.current || reconciliationLoading || !reconciliation || reconciliationError) return;
    let id: string;
    try { id = decodeURIComponent(location.hash.slice('#billing-'.length)); } catch { return; }
    if (!id || id.length > 256 || /[\u0000-\u001f]/.test(id)) return;
    restoredBillingAnchor.current = marker;
    const target = document.getElementById(`billing-${id}`);
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'nearest' }); }
    else setReturnNotice('刚才的账单不在当前时间范围最新500条可见记录中，请核对时间与权限范围。');
  }, [location.key, location.hash, reconciliationLoading, reconciliation, reconciliationError]);

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
    const params = windowRange;
    setError(null); setSummary(null); setSummaryLoading(true); setReconciliationLoading(true); setReconciliationError(null);
    getLogsSummary({ ...params, view: 'logical' }).catch(() => ({ success: false as const, data: null, error: { code: 'NETWORK_ERROR', message: '业务用量读取中断' } })).then((res) => {
      if (!active) return;
      setSummaryLoading(false);
      if (res.success && res.data) setSummary(res.data);
      else setError(res.error?.message || '业务用量响应不完整');
    });
    const billSeq = ++reconciliationRead.current;
    const checkSubmitted = nextBillCheck.current; nextBillCheck.current = false;
    setImportChecking(checkSubmitted); // A new window/general refresh owns both slices and check busy state.
    getCostReconciliations(params).catch(error => ({ success: false as const, data: null, error: { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : '供应商账单读取中断' } })).then((res) => {
      if (!active || billSeq !== reconciliationRead.current) return;
      if (res.success) {
        setReconciliation(res.data);
        if (checkSubmitted && importSubmission.current) {
          const match = res.data.items.find(item => importedBillMatches(item, importSubmission.current!));
          if (match) { setImportResult(match); setImportUncertain(false); setImportConfirmed(true); setImportError(null); setImportNotice('已找到与本次提交内容匹配的账单记录，请核对金额与关联请求。'); }
          else setImportError('当前近30天可见记录中尚未找到匹配账单，不能据此认定导入未生效。已保留提交内容，请核对供应商流水及账单范围，暂不重复导入。');
        }
      } else {
        setReconciliation(null); setReconciliationError(res.error.message || '供应商账单读取失败');
        if (checkSubmitted) setImportError('账单核对未完成，导入结果仍未确认。提交内容已保留，请稍后重新读取。');
      }
      setReconciliationLoading(false); setImportChecking(false);
    });
    return () => { active = false; };
  }, [refresh, windowRange]);

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

  const readImportedBill = (checkSubmitted = false) => {
    if (importChecking) return;
    // New imports are billed after the previous "to". Advance one shared window,
    // then let the same read session refresh request estimates and bills together.
    nextBillCheck.current = checkSubmitted;
    setImportChecking(true); setReconciliationLoading(true); setReconciliationError(null);
    setWindowRange(usageWindow(''));
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


  const reconciledCount = countReconciliationStatus(reconciliation, 'reconciled');

  const summaryStrip = (
    <>
      <span>业务请求 <strong>{summary ? fmtCompact(summary.total) : summaryLoading ? '正在读取' : '未知'}</strong></span>
      {/* 原来这一串是「对账覆盖」那段说明文字，其实全是派生数据——数据就该以指标呈现，
          而不是写成一句话让人读。 */}
      {reconciliationLoading ? <span>账单正在读取</span> : reconciliation ? (
        <span>
          {importUncertain ? '上次读取账单 ' : '账单 '}<strong>{fmtCompact(reconciliation.totalRecords)}</strong> 条
          （逐请求 {fmtCompact(reconciliation.requestRecords)} · 时间窗 {fmtCompact(reconciliation.windowRecords)}）
        </span>
      ) : null}
      {!reconciliationLoading && reconciliation?.actualUnavailableRequests ? (
        <span>{importUncertain ? '上次读取：未标记对账的调用日志 ' : '未标记对账的调用日志 '}<strong>{fmtCompact(reconciliation.actualUnavailableRequests)}</strong> 条<HelpPopover label="调用日志对账范围">此处统计同时间范围内未标记对账的非历史汇总调用日志，包含查询、下载及探测等操作；口径与业务请求量不同，不能相减。未标记对账不等于未返回实际费用。</HelpPopover></span>
      ) : null}
    </>
  );

  return (
    <PageShell className="lg-usage-page">
      <PageHeader
        title="预算与用量"
        subtitle={<><time dateTime={windowRange.from}>{fmtShortTime(windowRange.from)}</time> — <time dateTime={windowRange.to}>{fmtShortTime(windowRange.to)}</time></>}
        summary={summaryStrip}
        actions={(
          <>
            {canReadLogs ? <Link className="lg-text-link" to="/logs">请求记录 <ArrowRight size={14} /></Link> : null}
            <a className="lg-text-link" href="#tenant-governance-title" onClick={() => document.getElementById('tenant-governance-title')?.focus({ preventScroll: true })}>租户限制</a>
            {canImportActual ? <Button size="sm" variant="secondary" data-import-billing onClick={openImport}>{importUncertain ? '核对未确认账单' : '导入供应商账单'}</Button> : null}
          </>
        )}
      />
      <PageBody>
      {error ? <InlineAlert tone="error">用量暂不可用：{error} <Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>重新读取用量</Button></InlineAlert> : null}
      <section className="lg-usage-finance" aria-labelledby="usage-finance-title">
        <div style={cardHeadStyle}><h2 id="usage-finance-title" style={SECTION_TITLE}>费用</h2><span style={countStyle}>分币种展示，估算与账单不相加</span></div>
        <div className="lg-usage-amounts">
          <div><h3>Gateway 估算 · 请求时间</h3><dl>{!summary ? <div><dt>金额</dt><dd>{summaryLoading ? '正在读取' : '未知'}</dd></div> : summary.estimatedCosts?.length ? summary.estimatedCosts.map(item => <div key={item.currency}><dt>{item.currency} · {fmtCompact(item.requests)} 个业务请求</dt><dd>{fmtCost(item.amount, item.currency)}</dd></div>) : <div><dt>金额</dt><dd>{summary.total ? '未返回估算金额' : '暂无业务请求'}</dd></div>}</dl><div className="lg-usage-amount-note">Token {summary ? fmtCompact(summary.totalTokens) : summaryLoading ? '正在读取' : '未知'}{summary?.cacheSavingsUsd != null ? <span> · 缓存节省 {fmtCost(summary.cacheSavingsUsd, 'USD')}<HelpPopover label="缓存节省">按记录的缓存命中价格与输入全价差额估算，不是供应商结算折扣。</HelpPopover></span> : null}</div></div>
          <div><h3>供应商账单 · 账单时间{importUncertain ? <small className="lg-usage-last-read">上次读取 · 待核实</small> : null}</h3><dl>{reconciliationLoading ? <div><dt>金额</dt><dd>正在读取</dd></div> : reconciliationError || !reconciliation ? <div><dt>金额</dt><dd>未知</dd></div> : reconciliation.providerActualCosts?.length ? reconciliation.providerActualCosts.map(item => <div key={item.currency}><dt>{item.currency} · {fmtCompact(item.requests)} 条账单记录</dt><dd>{fmtCost(item.amount, item.currency)}</dd></div>) : <div><dt>金额</dt><dd>{reconciliation.totalRecords ? '未返回账单金额' : '尚无账单'}</dd></div>}</dl></div>
        </div>
        <div className="lg-usage-evidence-heading"><strong>费用证据</strong><HelpPopover label="金额证据四状态"><dl><dt>可估算</dt><dd>具备完整 token 与请求时价格快照，按原币种显示。</dd><dt>供应商实际</dt><dd>可来自供应商响应或账单导入，不覆盖估算；本页账单金额统计已导入记录。</dd><dt>估算未知</dt><dd>缺 token 或价格保持未知，不显示为金额 0。</dd><dt>已对账</dt><dd>同币种或具备明确 FX 凭证才计算差额。</dd></dl></HelpPopover></div>
        <dl className="lg-usage-evidence"><div><dt>可估算业务请求</dt><dd>{!summary ? (summaryLoading ? '正在读取' : '未知') : fmtCompact(summary.pricedRequests)}</dd></div><div><dt>业务估算未知</dt><dd>{!summary ? (summaryLoading ? '正在读取' : '未知') : fmtCompact(summary.unknownCostRequests)}</dd></div><div><dt>价格覆盖率</dt><dd>{!summary ? (summaryLoading ? '正在读取' : '未知') : summary.total ? `${summary.priceCoveragePercent}%` : '暂无请求'}</dd></div><div><dt>可比较账单</dt><dd>{reconciliationStateValue(reconciliation, reconciliationLoading, reconciliationError, () => reconciledCount)}</dd></div></dl>
      </section>
      {(summary?.topUnpricedModels?.length ?? 0) > 0 ? (
        <Card style={CARD_BODY} aria-labelledby="unpriced-title">
          <div style={cardHeadStyle}>
            <h2 id="unpriced-title" style={SECTION_TITLE}>待补价调用</h2>
            <span style={countStyle}>
              {fmtCompact(summary?.unpricedRequests)} 次缺价 · {fmtCompact(summary?.staleCurrencyRequests)} 次币种待换算
            </span>
          </div>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)', lineHeight: 'var(--lh-body)' }}>
            历史估算沿用请求时的价格快照。
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
                  <Link to={`/models?${new URLSearchParams({ search: item.model })}`} style={{ color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                    查找上游模型
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
      {importResult && (reconciliationError || !reconciliation?.items.some(item => item.id === importResult.id)) ? <ImportResult item={importResult} canReadLogs={canReadLogs} windowRange={windowRange} /> : null}
      <section className="lg-usage-ledger" aria-labelledby="reconciliation-title">
        {returnNotice ? <InlineAlert tone="info">{returnNotice}</InlineAlert> : null}
        <div style={cardHeadStyle}>
          <h2 id="reconciliation-title" style={SECTION_TITLE}>
            最近对账记录
            <HelpPopover label="对账记录">
              逐条查看 Gateway 估算、供应商实际、差额依据和匹配粒度。这里只展示当前租户与当前团队权限范围内的数据。
            </HelpPopover>
          </h2>
          <span style={countStyle}>{reconciliationLoading ? '正在读取' : reconciliationError ? '读取失败' : `${fmtCompact(reconciliation?.items.length ?? 0)} 条可见`}</span>
        </div>
        {reconciliation && reconciliation.totalRecords > reconciliation.items.length ? <div style={countStyle}>当前范围仅列最新 {reconciliation.items.length} 条，金额与状态按权限内全量统计。</div> : null}
        {reconciliationLoading ? (
          <SectionLoader text="正在读取供应商账单…" />
        ) : reconciliationError ? (
          <InlineAlert tone="error">{reconciliationError}。{summary ? '估算仍可查看，供应商对账状态未知。' : '业务用量也未读取，金额保持未知。'} <Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>重新读取账单</Button></InlineAlert>
        ) : reconciliation && reconciliation.items.length > 0 ? (
          <div className="lg-reconciliation-list">
            {reconciliation.items.map((item) => <ReconciliationRecord key={item.id} item={item} canReadLogs={canReadLogs} selected={item.id === importResult?.id} windowRange={windowRange} />)}
          </div>
        ) : (
          <div className="lg-empty-guidance"><FileSearch size={20} /><div><strong>还没有供应商账单记录</strong><p>{canImportActual ? '点击“导入供应商账单”，有请求编号时按单条请求对账；没有编号时选择明确时间窗。' : '当前角色可以查看费用；请由 Owner 或 Admin 导入供应商账单后再回来核对。'}</p></div></div>
        )}
      </section>

      <section className="lg-usage-budget" aria-labelledby="tenant-governance-title">
        <div style={cardHeadStyle}>
          <h2 id="tenant-governance-title" tabIndex={-1} style={SECTION_TITLE}>
            租户硬限制
            <HelpPopover label="租户硬限制">
              跨全部团队、Service Key 和 appCaller 聚合执行。租户层与 appCaller 层任一触顶都会拒绝请求，
              预占在服务端原子完成。清空三项并保存即可关闭租户总限制，已有 appCaller 与 Service Key 限制不受影响。
            </HelpPopover>
          </h2>
          <span style={countStyle}>按服务端窗口执行</span>
        </div>
        {governanceError ? <InlineAlert tone="error">{governanceError}{!governance && !governanceUncertain ? '。当前限制未知，不能按空值保存。' : ''} <Button size="sm" variant="ghost" disabled={governanceLoading || governanceSaving} onClick={() => void loadGovernance(governanceUncertain)}>重新读取限制</Button></InlineAlert> : null}
        <dl className="lg-usage-limit-facts">
          <div><dt>本月预算占用</dt><dd>{!governance ? (governanceLoading ? '正在读取' : '未知') : governance.monthlyBudgetUsd ? `${fmtCost(governance.spentUsd, 'USD')} / ${fmtCost(governance.monthlyBudgetUsd, 'USD')}` : '未设上限'}</dd><span>{governance?.monthlyBudgetUsd ? `剩余 ${fmtCost(governance.remainingBudgetUsd, 'USD')}` : '不代表供应商结算'}</span></div>
          <div><dt>并发预占</dt><dd>{!governance ? (governanceLoading ? '正在读取' : '未知') : governance.monthlyBudgetUsd ? fmtCost(governance.reservedUsd, 'USD') : '未启用'}</dd><span>{governance?.budgetReservationUsd ? `每请求预占 ${fmtCost(governance.budgetReservationUsd, 'USD')}` : '设置月预算时须一并设置'}</span></div>
          <div><dt>当前分钟调用</dt><dd>{!governance ? (governanceLoading ? '正在读取' : '未知') : governance.rateLimitPerMinute ? `${fmtCompact(governance.currentMinuteCount)} / ${fmtCompact(governance.rateLimitPerMinute)}` : '未设上限'}</dd><span>租户全部实际调用</span></div>
        </dl>
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
        </DetailsBlock> : <div style={{ marginTop: GAP.section }}><ReadOnlyNotice>只读，修改需 Owner 或 Admin。</ReadOnlyNotice></div>}
      </section>

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

function ImportResult({ item, canReadLogs, windowRange }: { item: CostReconciliationItem; canReadLogs: boolean; windowRange: UsageWindow }) {
  const status = reconciliationStatusMeta(item.reconciliationStatus);
  return (
    <div id={`billing-${item.id}`} tabIndex={-1} className="lg-reconciliation-result" role="status">
      <CheckCircle2 size={18} />
      <div><strong>供应商账单已导入</strong><span>{item.granularity === 'request' ? '已按单条请求匹配' : '已按明确时间窗记录为汇总账单'} · {item.provider} · {item.externalRecordId}</span></div>
      <div className="lg-reconciliation-result-values"><span>估算 {formatKnownCost(item.estimatedCost, item.estimatedCostCurrency, '未知')}</span><span>实际 {formatKnownCost(item.providerReportedCost, item.providerCostCurrency, '缺失')}</span><span style={{ color: status.color }}>{status.label}</span><span>差额 {formatDelta(item)}</span></div>
      {canReadLogs && item.requestId ? <Link className="lg-text-link" to={buildLogRequestHref(item.requestId)} onClick={event => rememberBillingAnchor(event, item.id, windowRange)}>打开 requestId <ArrowRight size={13} /></Link> : null}
    </div>
  );
}

function ReconciliationRecord({ item, canReadLogs, selected = false, windowRange }: { item: CostReconciliationItem; canReadLogs: boolean; selected?: boolean; windowRange: UsageWindow }) {
  const status = reconciliationStatusMeta(item.reconciliationStatus);
  const sameCurrency = !!item.estimatedCostCurrency && !!item.providerCostCurrency && item.estimatedCostCurrency.toUpperCase() === item.providerCostCurrency.toUpperCase();
  const matchLabel = item.granularity === 'request'
    ? item.providerRequestId ? `Provider ${item.providerRequestId}` : '未记录供应商请求编号'
    : `${fmtShortTime(item.windowFrom)} 至 ${fmtShortTime(item.windowTo)}`;
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
        <CostMetric label="汇率凭证" value={item.fxSnapshotId || (sameCurrency ? '同币种无需换算' : '未提供')} note={item.providerToEstimatedFxRate ? `汇率 ${item.providerToEstimatedFxRate}` : sameCurrency ? '按原币种比较' : item.estimatedCostCurrency ? '前端不猜测汇率' : '估算币种未知'} />
      </div>
      <div className="lg-reconciliation-footer">
        <span>{item.model || '未限定模型'} · {item.serviceKeyId ? `Key ${item.serviceKeyId}` : '未限定接入密钥'} · 账单时间 {fmtShortTime(item.billedAt || item.createdAt)}</span>
        {canReadLogs && item.requestId ? <Link className="lg-text-link" to={buildLogRequestHref(item.requestId)} onClick={event => rememberBillingAnchor(event, item.id, windowRange)}>回查请求 {item.requestId} <ArrowRight size={13} /></Link> : <span>{item.granularity === 'window' ? '汇总记录没有单条 requestId' : '当前角色不读取请求内容'}</span>}
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
  if (summary?.totalRecords === 0) return 0;
  if (!summary?.statusDistribution?.length) return null;
  return summary.statusDistribution.filter(item => item.key.toLowerCase() === status).reduce((total, item) => total + item.count, 0);
}

function reconciliationStateValue(
  reconciliation: CostReconciliationSummary | null,
  loading: boolean,
  error: string | null,
  read: (data: CostReconciliationSummary) => number | null,
) {
  if (loading) return '正在读取';
  if (error) return '不可用';
  if (!reconciliation) return '暂无账单';
  const value = read(reconciliation);
  return value == null ? '未知' : fmtCompact(value);
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

type UsageWindow = { from: string; to: string };
function usageWindow(search: string): UsageWindow {
  const query = new URLSearchParams(search);
  const from = Date.parse(query.get('from') || ''); const to = Date.parse(query.get('to') || '');
  if (Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 31 * 86_400_000) return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  const now = Date.now(); return { from: new Date(now - 30 * 86_400_000).toISOString(), to: new Date(now).toISOString() };
}
function rememberBillingAnchor(event: React.MouseEvent<HTMLAnchorElement>, id: string, windowRange: UsageWindow) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const query = new URLSearchParams(window.location.search); query.set('from', windowRange.from); query.set('to', windowRange.to);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}?${query}#billing-${encodeURIComponent(id)}`);
}
