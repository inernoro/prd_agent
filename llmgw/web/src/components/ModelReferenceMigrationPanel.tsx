import { useEffect, useRef, useState } from 'react';
import { createModelReferenceMigrationPlan, createModelReferenceMigrationFromUsage, getRepairableModelUsages, getLogicalModels, getModelReferenceCoverage, getModelReferenceMigrationPlan, getModelReferenceMigrationPlanByRequest, getModelReferenceMigrationPlans, runModelReferenceMigrationAction } from '@/lib/api';
import type { LogicalModelItem, ReferenceCoverage, ReferenceMigrationPlan, RepairableModelUsage } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { CollectionFacts, CollectionView } from '@/components/CollectionView';
import { DetailsBlock } from '@/components/PageShell';
import { Button, Chip, InlineAlert, ReadOnlyNotice, Spinner } from '@/components/ui';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE } from '@/lib/typography';
import { GAP } from '@/lib/surface';

const PLAN_LABELS: Record<ReferenceMigrationPlan['status'], string> = { planned: '等待确认升级', blocked: '存在阻断', applying: '正在更新使用位置', conflict: '配置已变化，需重新扫描', completed: '等待核验结果' };
const ITEM_LABELS: Record<string, string> = { affected: '需要升级', migrated: '已升级', blocked: '已阻断', unknown: '未确认', residual: '旧引用残留', unchanged: '无需变更', verified: '已核验' };
const METRICS = ['affected', 'migrated', 'blocked', 'unknown', 'residual'] as const;
type Pending = { intentId?: string; clientRequestId?: string; operation: 'create' | 'apply' | 'verify' };

function hasCoverage(value: ReferenceCoverage | null): value is ReferenceCoverage {
  return Boolean(value && typeof value.registryVersion === 'string' && value.registryVersion.trim()
    && typeof value.registryHash === 'string' && value.registryHash.trim()
    && Array.isArray(value.consumers) && value.consumers.length && Array.isArray(value.items)
    && METRICS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && new Set(value.consumers.map(row => row.key)).size === value.consumers.length
    && value.consumers.every(row => row.key && Number.isSafeInteger(row.count) && row.count >= 0
      && Array.isArray(row.reasons) && METRICS.every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)));
}
function canApplyCoverage(value: ReferenceCoverage | null): boolean {
  return hasCoverage(value) && value.canComplete === true && value.blocked === 0 && value.unknown === 0
    && value.consumers.every(row => row.blocked === 0 && row.unknown === 0);
}
export function isReferenceCoverageVerified(coverage: ReferenceCoverage | null, now = Date.now()): boolean {
  return canApplyCoverage(coverage) && coverage!.verified === true && coverage!.residual === 0
    && coverage!.consumers.every(row => row.residual === 0)
    && typeof coverage!.validUntil === 'string' && Date.parse(coverage!.validUntil) > now;
}
function isVerified(plan: ReferenceMigrationPlan, now = Date.now()): boolean {
  return plan.status === 'completed' && isReferenceCoverageVerified(plan.coverage, now);
}

export function ModelReferenceMigrationPanel({ source, onChanged, initialPlan, usage, sourceUnavailable = false }: { source: Pick<LogicalModelItem, 'id' | 'name' | 'publicId' | 'modelType' | 'enabled'>; onChanged?: () => void; initialPlan?: ReferenceMigrationPlan | null; usage?: RepairableModelUsage | null; sourceUnavailable?: boolean }) {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [models, setModels] = useState<LogicalModelItem[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [targetId, setTargetId] = useState(initialPlan?.mapping.target.logicalId || '');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  const [coverage, setCoverage] = useState<ReferenceCoverage | null>(null);
  const [plan, setPlan] = useState<ReferenceMigrationPlan | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const generation = useRef(0);
  const scopeKey = JSON.stringify([tenant?.id || '', source.id, targetId, usage?.consumerKey, usage?.recordId, usage?.path, initialPlan?.intentId]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const currentPlan = useRef<ReferenceMigrationPlan | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const startedAt = useRef(Date.now());
  const readFlight = useRef<symbol | null>(null);
  const notified = useRef('');
  const resumeAttemptedFor = useRef<string | null>(null);
  const target = models.find(item => item.id === targetId && item.modelType === source.modelType && item.enabled);
  const validScope = Boolean(target && target.id !== source.id && !catalogError && (!usage || (usage.status === 'orphan' && usage.modelType)));
  const observing = Boolean(pending || plan?.status === 'applying');
  const active = Boolean(busy || observing);

  async function loadModels() {
    const key = currentScope.current;
    try {
      const result = await getLogicalModels();
      if (key !== currentScope.current) return;
      setCatalogError(!result.success);
      if (result.success) setModels(result.data.items);
    } catch { if (key === currentScope.current) setCatalogError(true); }
  }
  useEffect(() => { void loadModels(); }, [source.id, tenant?.id]);

  function accept(next: ReferenceMigrationPlan, fromRead: boolean, key: string, epoch: number): boolean {
    if (key !== currentScope.current || epoch !== generation.current) return false;
    if ((!usage && (next?.mapping?.source?.logicalId || '') !== source.id) || next?.mapping?.target?.logicalId !== targetId
      || !next.intentId || !(next.status in PLAN_LABELS) || !Number.isSafeInteger(next.revision) || next.revision < 0 || !hasCoverage(next.coverage)) {
      setError('升级计划与当前选择不一致或覆盖清单不完整，请重新核对原计划。');
      return false;
    }
    const previous = currentPlan.current;
    if (previous?.intentId === next.intentId && next.revision < previous.revision) return false;
    currentPlan.current = next;
    setPlan(next); setCoverage(next.coverage);
    const completed = fromRead && isVerified(next);
    setConfirmed(completed);
    const operation = pendingRef.current?.operation;
    if (fromRead && (operation === 'create' || ['completed', 'blocked', 'conflict'].includes(next.status))) setPending(null);
    if (fromRead && (completed || next.coverage.migrated > 0) && notified.current !== `${next.intentId}:${next.revision}`) {
      notified.current = `${next.intentId}:${next.revision}`;
      onChanged?.();
    }
    return true;
  }

  async function readPlan(locator: Pending, key = currentScope.current, epoch = generation.current) {
    if (readFlight.current || key !== currentScope.current || epoch !== generation.current) return;
    const flight = Symbol(); readFlight.current = flight;
    try {
      const result = locator.intentId ? await getModelReferenceMigrationPlan(locator.intentId)
        : await getModelReferenceMigrationPlanByRequest(locator.clientRequestId!);
      if (key !== currentScope.current || epoch !== generation.current) return;
      if (result.success && accept(result.data, true, key, epoch)) setError(null);
      else { setConfirmed(false); setError('原计划的状态暂未确认，请继续查询；请勿重复提交升级。'); }
    } catch { if (key === currentScope.current && epoch === generation.current) { setConfirmed(false); setError('原计划的状态暂未确认，请继续查询；请勿重复提交升级。'); } }
    finally { if (readFlight.current === flight) readFlight.current = null; }
  }

  async function scan(key = currentScope.current, epoch = generation.current) {
    if (!targetId || !validScope || usage || !source.id || sourceUnavailable) return;
    setBusy('正在扫描使用位置'); setError(null); setConfirmed(false);
    try {
      const result = await getModelReferenceCoverage(source.id, targetId);
      if (key !== currentScope.current || epoch !== generation.current) return;
      if (result.success && hasCoverage(result.data)) setCoverage(result.data);
      else { setCoverage(null); setError('使用位置尚未完整扫描，请重新扫描后再生成升级计划。'); }
    } catch { if (key === currentScope.current && epoch === generation.current) { setCoverage(null); setError('范围读取未完成，请重新扫描。'); } }
    finally { if (key === currentScope.current && epoch === generation.current) setBusy(null); }
  }

  useEffect(() => {
    generation.current++; readFlight.current = null; currentPlan.current = null; notified.current = ''; resumeAttemptedFor.current = null;
    setCoverage(null); setPlan(null); setPending(null); setConfirmed(false); setError(null); setBusy(null); setSeconds(0);
    if (initialPlan && initialPlan.mapping.target.logicalId === targetId) void readPlan({ intentId: initialPlan.intentId, operation: 'verify' }, scopeKey, generation.current);
    else if (validScope && !usage && source.id && !sourceUnavailable) void scan(scopeKey, generation.current);
    return () => { generation.current++; };
  }, [source.id, source.modelType, targetId, tenant?.id, validScope, usage?.consumerKey, usage?.recordId, usage?.path, initialPlan?.intentId]);

  useEffect(() => {
    if (!active) return;
    startedAt.current = Date.now(); setSeconds(0);
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  useEffect(() => {
    const locator = pending || (plan?.status === 'applying' ? { intentId: plan.intentId, operation: 'apply' as const } : null);
    if (!locator) return;
    const key = scopeKey; const epoch = generation.current;
    const timer = window.setInterval(() => { void readPlan(locator, key, epoch); }, 2000);
    return () => window.clearInterval(timer);
  }, [pending?.intentId, pending?.clientRequestId, pending?.operation, plan?.intentId, plan?.status, scopeKey]);

  useEffect(() => {
    if (!plan || observing) return;
    const key = scopeKey; const epoch = generation.current; const intentId = plan.intentId;
    const timer = window.setInterval(() => { void readPlan({ intentId, operation: 'verify' }, key, epoch); }, 30000);
    return () => window.clearInterval(timer);
  }, [plan?.intentId, observing, scopeKey]);

  async function perform(action: 'create' | 'apply' | 'verify', resume = false) {
    const resuming = resume && action === 'apply' && plan?.status === 'applying' && plan.canResume === true
      && resumeAttemptedFor.current !== plan.intentId;
    if (resume && !resuming) return;
    if (!canWrite || busy || (observing && !resuming) || (!validScope && action !== 'verify')) return;
    if (action === 'create' && (!usage && (sourceUnavailable || !source.id || !canApplyCoverage(coverage)))) return;
    if (action !== 'create' && !hasCoverage(coverage)) return;
    if (action === 'apply' && (error || !plan || (plan.status !== 'planned' && !resuming) || !canApplyCoverage(plan.coverage))) return;
    if (action !== 'create' && !plan) return;
    // 显式恢复只提交一次；未知结果即使读到旧可恢复标志，也只继续 GET 原计划。
    if (resuming) resumeAttemptedFor.current = plan!.intentId;
    const key = scopeKey; const epoch = generation.current;
    const locator: Pending = action === 'create' ? { clientRequestId: crypto.randomUUID(), operation: action }
      : { intentId: plan!.intentId, operation: action };
    setPending(locator); pendingRef.current = locator; setBusy(action === 'create' ? '正在生成升级计划' : action === 'apply' ? '正在更新活动使用配置' : '正在重新扫描核验');
    setError(null); setConfirmed(false);
    try {
      const result = action === 'create'
        ? usage ? await createModelReferenceMigrationFromUsage({ consumerKey: usage.consumerKey, recordId: usage.recordId, path: usage.path, targetLogicalId: targetId, clientRequestId: locator.clientRequestId! })
          : await createModelReferenceMigrationPlan({ sourceLogicalId: source.id, targetLogicalId: targetId, clientRequestId: locator.clientRequestId! })
        : await runModelReferenceMigrationAction(plan!.intentId, action, plan!.revision);
      if (key !== currentScope.current || epoch !== generation.current) return;
      if (result.success && accept(result.data, false, key, epoch)) {
        const nextLocator = { intentId: result.data.intentId, operation: action };
        setPending(nextLocator); pendingRef.current = nextLocator;
        await readPlan(nextLocator, key, epoch);
      } else {
        // 此拒绝发生在端点创建持久计划之前，不存在需要恢复的未知写入。
        if (!result.success && action === 'create' && result.error.code === 'REFERENCE_DEPLOYMENT_BLOCKED') {
          setPending(null); pendingRef.current = null;
          setError(result.error.message || '当前部署不允许修改模型配置，请切换到主环境后再试。');
          return;
        }
        if (!result.success && result.error.code === 'REFERENCE_PLAN_BUSY') { setPending(null); pendingRef.current = null; }
        setError('本次提交的结果尚未确认，正在查询原计划；请勿重复提交。');
        await readPlan(locator, key, epoch);
      }
    } catch {
      if (key === currentScope.current && epoch === generation.current) {
        setError('本次提交的结果尚未确认，正在查询原计划；请勿重复提交。');
        await readPlan(locator, key, epoch);
      }
    } finally { if (key === currentScope.current && epoch === generation.current) setBusy(null); }
  }

  const scanned = hasCoverage(coverage);
  const safe = canApplyCoverage(coverage);
  const complete = confirmed && plan && isVerified(plan, now);
  return <section aria-label="使用位置与升级" data-testid="model-reference-migration-panel" style={{ display: 'flex', flexDirection: 'column', gap: GAP.section, padding: 14, minWidth: 0 }}>
    <h3 style={SECTION_TITLE}>全量使用位置</h3>
    <div style={HINT_TEXT}>仅更新活动使用配置，历史记录保持原样。阻断、未确认或未扫描的位置都会阻止完成。</div>
    <div style={HINT_TEXT}>已更新按配置记录计数，旧引用残留按使用位置计数。</div>
    {usage && (usage.status === 'unknown' || !usage.modelType) ? <InlineAlert tone="error">此位置的结构或用途尚未确认，当前不能自动迁移；请先核对原配置。</InlineAlert> : null}
    {usage ? <InlineAlert>只修改所选使用位置，不会更改同名的其他业务字段。生成计划后才核对完整覆盖范围。</InlineAlert> : null}
    {!canWrite ? <ReadOnlyNotice /> : null}
    <CollectionFacts items={[{ label: '当前模型', value: <>{source.name} <code>{source.publicId}</code>{sourceUnavailable ? ' · 目录身份失效' : !source.enabled && !usage && source.id ? ' · 已停用' : ''}</> }]} />
    <label style={FIELD_LABEL}>升级到同用途模型<select aria-label="升级到同用途模型" style={FIELD_INPUT} value={targetId} disabled={Boolean(busy && busy !== '正在扫描使用位置')} onChange={event => setTargetId(event.target.value)}><option value="">请选择目标模型</option>{models.filter(item => item.id !== source.id && item.modelType === source.modelType).map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name} · {item.publicId}{!item.enabled ? ' · 已停用' : ''}</option>)}{targetId && !models.some(item => item.id === targetId) ? <option value={targetId}>当前目标暂不可用，请重新选择</option> : null}</select></label>
    {sourceUnavailable ? <InlineAlert>原模型目录身份已失效；已有计划仍可核对，新计划请从失效引用清单选择具体使用位置。</InlineAlert> : null}
    {catalogError ? <InlineAlert tone="error">目标模型清单读取失败，原选择已保留。<Button size="sm" onClick={() => void loadModels()}>重新读取模型</Button></InlineAlert> : null}
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    {active ? <div aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: GAP.normal }}><Spinner size={14} /><span style={HINT_TEXT}>{busy || '正在继续查询原计划'} · 已用 {seconds} 秒</span></div> : null}
    {plan ? <div><Chip label={complete ? '已完成核验' : plan.status === 'completed' ? '需重新核对' : PLAN_LABELS[plan.status] || '状态待确认'} color={complete ? 'var(--ok)' : 'var(--info)'} bg={complete ? 'var(--ok-bg)' : 'var(--info-bg)'} /><span style={HINT_TEXT}> · 最近更新 {new Date(plan.updatedAt).toLocaleString()}</span></div> : null}
    {complete ? <InlineAlert tone={plan.coverage.migrated > 0 ? 'ok' : 'info'}>{plan.coverage.migrated > 0 ? '升级全部使用位置完成' : '核验结束，未发现需要迁移的活动使用位置；未执行使用位置升级。'}</InlineAlert> : null}
    {plan?.status === 'completed' && !complete && !active ? <InlineAlert>需重新核对：当前没有有效的全量核验结果，请重新扫描核验。</InlineAlert> : null}
    {usage && scanned && coverage.migrated > 0 && coverage.residual > 0 ? <InlineAlert>当前位置已更新，其他位置待迁移。请继续选择失效使用位置，直至全量核验通过。</InlineAlert> : null}
    {scanned ? <>
      <CollectionFacts items={[{ label: '受影响', value: coverage.affected }, { label: '已升级', value: coverage.migrated }, { label: '阻断', value: coverage.blocked }, { label: '未确认', value: coverage.unknown }, { label: '旧引用残留', value: coverage.residual }]} />
      {!safe ? <InlineAlert tone="error">覆盖检查尚未通过，请先处理下方阻断或未确认的位置，再重新扫描。</InlineAlert> : null}
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', fontSize: 'var(--fs-secondary)', borderCollapse: 'collapse' }} aria-label="使用位置覆盖清单"><thead><tr>{['使用方', '扫描数', '受影响', '已升级', '阻断', '未确认', '旧引用残留'].map(label => <th key={label} style={{ textAlign: 'left', padding: 6 }}>{label}</th>)}</tr></thead><tbody>{coverage.consumers.map(row => <tr key={row.key}><td style={{ padding: 6 }}>{row.label || row.key}{row.reasons.map((reason, index) => <div key={index} style={HINT_TEXT}>{reason}</div>)}</td>{[row.count, row.affected, row.migrated, row.blocked, row.unknown, row.residual].map((value, index) => <td key={index} style={{ padding: 6 }}>{value}</td>)}</tr>)}</tbody></table></div>
      <DetailsBlock title="受影响位置与处理原因"><CollectionView items={coverage.items} searchText={item => `${item.consumerKey} ${item.recordId} ${item.path} ${item.reason || ''}`} placeholder="搜索使用位置或原因" emptyText="扫描未返回逐条位置，请以覆盖清单及核验结果为准">{rows => <>{rows.map((item, index) => <div key={`${item.consumerKey}:${item.recordId}:${item.path}:${index}`} style={{ padding: 8, borderBottom: '1px solid var(--border)' }}><strong>{ITEM_LABELS[item.status] || '待核对'}</strong><div style={HINT_TEXT}>{item.reason || '未提供处理原因，请重新核验。'}</div><div style={MONO_META}>{item.consumerKey} · {item.collection} · {item.recordId} · {item.path}</div></div>)}</>}</CollectionView></DetailsBlock>
      <div style={HINT_TEXT}>覆盖清单版本 {coverage.registryVersion} · <code>{coverage.registryHash}</code></div>
    </> : targetId && !busy ? <InlineAlert>尚未取得完整覆盖清单，不会执行使用位置升级。</InlineAlert> : null}
    <div style={{ display: 'flex', gap: GAP.normal, flexWrap: 'wrap' }}>
      <Button size="sm" variant="ghost" disabled={Boolean(busy) || (!plan && !pending && (!validScope || Boolean(usage || !source.id || sourceUnavailable)))} onClick={() => { if (pending || plan) void readPlan(pending || { intentId: plan!.intentId, operation: 'verify' }); else void scan(); }}>{pending || plan ? '继续查询原计划' : '重新扫描范围'}</Button>
      {!plan ? <Button size="sm" disabled={!canWrite || !validScope || (!usage && (!safe || sourceUnavailable)) || active || Boolean(error)} onClick={() => void perform('create')}>{usage ? '生成修复计划' : '生成升级计划'}</Button> : <>
        <Button size="sm" disabled={!canWrite || active || !validScope || !safe || Boolean(error) || plan.status !== 'planned'} onClick={() => void perform('apply')}>{usage ? '升级所选使用位置' : '升级全部使用位置'}</Button>
        {plan.status === 'applying' ? <Button size="sm" disabled={!canWrite || Boolean(busy) || !validScope || !safe || Boolean(error) || plan.canResume !== true || resumeAttemptedFor.current === plan.intentId} onClick={() => void perform('apply', true)}>继续原升级计划</Button> : null}
        <Button size="sm" variant="ghost" disabled={!canWrite || active} onClick={() => void perform('verify')}>重新扫描核验</Button>
        <Button size="sm" variant="ghost" disabled={active} onClick={() => { generation.current++; currentPlan.current = null; setPlan(null); setCoverage(null); setConfirmed(false); void scan(scopeKey, generation.current); }}>重新生成计划</Button>
      </>}
    </div>
  </section>;
}


export function ModelReferenceMigrationOverview({ onOpen, onStatus }: { onOpen: (plan: ReferenceMigrationPlan) => void; onStatus?: (value: { pending: number | null; failed: boolean }) => void }) {
  const { tenant } = useAuth();
  const [plans, setPlans] = useState<ReferenceMigrationPlan[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [unresolvedTotal, setUnresolvedTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const readVersion = useRef(0);
  async function refresh() {
    const version = ++readVersion.current;
    try {
      const result = await getModelReferenceMigrationPlans();
      if (version !== readVersion.current) return;
      if (result.success && Array.isArray(result.data.items) && result.data.items.every(item => item?.intentId && item.mapping?.source && item.mapping?.target)) {
        setPlans(result.data.items); setFailed(false); setLoaded(true);
        setUnresolvedTotal(Number.isSafeInteger(result.data.unresolvedTotal) ? result.data.unresolvedTotal! : null);
        setHasMore(result.data.hasMore === true);
      }
      else setFailed(true);
    } catch { if (version === readVersion.current) setFailed(true); }
  }
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 30000);
    return () => { readVersion.current++; window.clearInterval(timer); };
  }, [tenant?.id]);
  const unresolved = plans.filter(plan => plan.status !== 'completed' || !isReferenceCoverageVerified(plan.coverage, now));
  const unresolvedCount = Math.max(unresolved.length, unresolvedTotal ?? 0);
  useEffect(() => { onStatus?.({ pending: loaded ? unresolvedCount : null, failed }); }, [loaded, unresolvedCount, failed, onStatus]);
  return <div data-testid="model-reference-migration-overview" style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}><Button size="sm" variant="ghost" onClick={() => setOpen(value => !value)}>升级记录与遗漏</Button><span style={HINT_TEXT}>{failed ? '升级记录需重新核对' : !loaded ? '正在读取升级记录' : `显示 ${plans.length} 个计划 · 待处理 ${unresolvedCount}`}</span><Button size="sm" variant="ghost" onClick={() => void refresh()}>刷新升级记录</Button></div>
    {!loaded && !failed ? <Spinner size={14} /> : null}
    {failed ? <InlineAlert tone="error">升级记录读取失败，不能确认全量完成，请重新读取。</InlineAlert> : null}
    {unresolvedCount && !failed ? <InlineAlert tone="error">仍有 {unresolvedCount} 个计划需处理或重新核对，请查看阻断、未确认与旧引用残留。</InlineAlert> : null}
    {hasMore && !failed ? <InlineAlert tone="info">当前优先展示待处理计划，尚有更多记录；处理后刷新继续查看，不能将当前列表当作全部记录。</InlineAlert> : null}
    {open ? <CollectionView items={plans} searchText={plan => `${plan.mapping.source.publicId} ${plan.mapping.target.publicId} ${plan.status}`} placeholder="搜索升级计划" emptyText="尚无升级计划；这不代表已完成全量覆盖。">{rows => <>{rows.map(plan => <div key={plan.intentId} style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, padding: 8, flexWrap: 'wrap' }}><span style={MONO_META}>{plan.mapping.source.publicId || plan.mapping.source.logicalId} → {plan.mapping.target.publicId || plan.mapping.target.logicalId}</span><span style={HINT_TEXT}>{failed ? '需重新核对' : plan.status === 'completed' && isReferenceCoverageVerified(plan.coverage, now) ? '有效核验' : PLAN_LABELS[plan.status] || '需重新核对'} · 阻断 {plan.coverage?.blocked ?? '未扫描'} · 未确认 {plan.coverage?.unknown ?? '未扫描'} · 残留 {plan.coverage?.residual ?? '未扫描'}</span><Button size="sm" onClick={() => onOpen(plan)}>查看使用位置计划</Button></div>)}</>}</CollectionView> : null}
  </div>;
}


const USAGE_LABELS = { available: '目录身份存在', orphan: '目录身份失效', unknown: '结构待核对' };
export function ModelReferenceUsageRepairPanel() {
  const { tenant } = useAuth();
  const [items, setItems] = useState<RepairableModelUsage[]>([]);
  const [selected, setSelected] = useState<RepairableModelUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const version = useRef(0);
  async function refresh() {
    const request = ++version.current; setLoading(true);
    try {
      const result = await getRepairableModelUsages();
      if (request !== version.current) return;
      if (result.success && Array.isArray(result.data.items)) { setItems(result.data.items); setFailed(false); }
      else setFailed(true);
    } catch { if (request === version.current) setFailed(true); }
    finally { if (request === version.current) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => { version.current++; }; }, [tenant?.id]);
  return <section aria-label="修复失效引用" style={{ display: 'flex', flexDirection: 'column', gap: GAP.section }}>
    <div style={HINT_TEXT}>此清单仅用于选择可修复位置，不代表全量覆盖，也不代表模型服务验证通过。</div>
    <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>重新读取失效引用</Button>
    {loading ? <div style={HINT_TEXT}><Spinner size={14} /> 正在读取可修复位置</div> : null}
    {failed ? <InlineAlert tone="error">使用位置读取未完成，不能确认是否存在遗漏，请重新读取。</InlineAlert> : null}
    <CollectionView items={items.filter(item => item.status === 'orphan' || item.status === 'unknown')} searchText={item => `${item.consumerKey} ${item.recordId} ${item.path} ${item.value}`} placeholder="搜索失效使用位置" emptyText="当前候选清单没有失效项；这不代表全量核验通过。">{rows => <>{rows.map(item => <div key={`${item.consumerKey}:${item.recordId}:${item.path}`} style={{ padding: 8, display: 'flex', gap: GAP.normal, flexWrap: 'wrap', alignItems: 'center' }}><span>{USAGE_LABELS[item.status]} · {item.value}</span><span style={MONO_META}>{item.consumerKey} · {item.recordId} · {item.path}</span><Button size="sm" onClick={() => setSelected(item)}>选择使用位置</Button></div>)}</>}</CollectionView>
    {selected ? <ModelReferenceMigrationPanel key={`${selected.consumerKey}:${selected.recordId}:${selected.path}`} usage={selected} source={{ id: selected.logicalId || '', publicId: selected.value, name: '所选使用位置', modelType: selected.modelType, enabled: false }} onChanged={() => void refresh()} /> : null}
  </section>;
}
