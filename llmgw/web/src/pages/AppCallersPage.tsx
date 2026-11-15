// GW appCaller 注册表：展示 llmgw-serve 被动发现的调用方。
// 这是目标架构里“appCaller 权威迁到 GW”的第一步，只读，不修改 MAP 旧配置。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { bulkUpdateGatewayAppCallers, deleteAppCaller, getGatewayAppCallers, getPools, updateGatewayAppCaller } from '@/lib/api';
import type { GatewayAppCaller, GatewayAppCallersData, ModelPool } from '@/lib/types';
import { Button, Chip, InlineAlert, SectionLoader, ReadOnlyNotice } from '@/components/ui';
import { useDialogs } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { formatPlatformTime } from '@/lib/platformTime';
import { canUseCapability } from '@/lib/access';
import { AppCallerDefaultModel, AppCallerDefaultsProvider } from '@/components/AppCallerDefaultModel';

const PAGE_SIZE = 50;
const STATUSES = ['discovered', 'configured', 'active', 'disabled', 'archived'];
const MODEL_POLICIES = ['auto', 'pool', 'pinned'];
const PARAMETER_POLICIES = ['default-drop', 'strict-require'];
const DRIFT_FILTERS = [
  { value: 'any', label: '有漂移' },
  { value: 'route', label: '路由漂移' },
  { value: 'parameter', label: '参数漂移' },
];
type Draft = {
  status: string;
  allowedModelPoolIds: string[];
  defaultModelPoolId: string;
  allowCrossPoolFallback: boolean;
  modelPolicy: string;
  parameterPolicy: string;
  owner: string;
  monthlyBudgetUsd: string;
  budgetReservationUsd: string;
  rateLimitPerMinute: string;
};
type BulkDraft = {
  targetStatus: string;
  modelPolicy: string;
  parameterPolicy: string;
  owner: string;
  monthlyBudgetUsd: string;
  budgetReservationUsd: string;
  rateLimitPerMinute: string;
};

function statusChip(status: string) {
  const key = (status || '').toLowerCase();
  if (['discovered', 'configured', 'active'].includes(key)) return { label: '允许调用', color: 'var(--text-primary)', bg: 'var(--bg-elevated)' };
  if (key === 'disabled') return { label: '已停用', color: 'var(--warn)', bg: 'var(--warn-bg)' };
  if (key === 'archived') return { label: '已归档', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' };
  return { label: '状态未知', color: 'var(--warn)', bg: 'var(--warn-bg)' };
}
function registrationStage(status: string) {
  return ({ discovered: '自动发现', configured: '已登记配置', active: '已启用' } as Record<string, string>)[status];
}
function statusLabel(value: string) {
  return ({ discovered: '已发现（允许调用）', configured: '已配置（允许调用）', active: '已启用（允许调用）', disabled: '已停用', archived: '已归档' } as Record<string, string>)[value] ?? value;
}

function modelPolicyLabel(value: string) {
  return ({ auto: '自动选择', pool: '指定模型池', pinned: '固定模型' } as Record<string, string>)[value] ?? value;
}

function parameterPolicyLabel(value: string) {
  return ({ 'default-drop': '忽略不支持参数', 'strict-require': '参数不支持就拒绝' } as Record<string, string>)[value] ?? value;
}

function fmtTime(value?: string | null) {
  return value ? formatPlatformTime(value) : '—';
}

function logsHref(key: 'requestId' | 'sessionId' | 'runId', value?: string | null) {
  if (!value) return '';
  return `/logs?${key}=${encodeURIComponent(value)}`;
}

export function AppCallersPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'appCallerWrite');
  const canManagePromptPolicy = canUseCapability(tenant?.role, 'configWrite');
  const { confirm, promptText } = useDialogs();
  const [searchParams] = useSearchParams();
  // 与 App 详情页同一口径：精确优先，削 `G-` 前缀只作兜底。
  // 详情页现在会原样保留真实的 `G-` 开头 code，它的「打开治理配置」链接把该 code
  // 作为 focus 传到这里；这边若无条件削前缀，要么定位不到、要么定位到另一个没前缀的同名记录。
  const focusedAppCallerCode = (searchParams.get('focus') || '').trim();
  const focusedRequestType = (searchParams.get('focusType') || '').trim();
  const focusedLegacyCode = focusedAppCallerCode.replace(/^G-/, '');
  const [data, setData] = useState<GatewayAppCallersData | null>(null);
  const [pools, setPools] = useState<ModelPool[]>([]);
  const listRequest = useRef(0);
  const [loadingList, setLoadingList] = useState(true);
  const [focusLookup, setFocusLookup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [bulkDraft, setBulkDraft] = useState<BulkDraft>({
    targetStatus: '',
    modelPolicy: '',
    parameterPolicy: '',
    owner: '',
    monthlyBudgetUsd: '',
    budgetReservationUsd: '',
    rateLimitPerMinute: '',
  });
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('page') || '1') || 1));
  const [search, setSearch] = useState(() => searchParams.get('search') || '');
  const [status, setStatus] = useState(() => searchParams.get('status') || '');
  const [sourceSystem, setSourceSystem] = useState(() => searchParams.get('sourceSystem') || '');
  const [ingressProtocol, setIngressProtocol] = useState(() => searchParams.get('ingressProtocol') || '');
  const [requestType, setRequestType] = useState(() => searchParams.get('requestType') || '');
  const [drift, setDrift] = useState(() => searchParams.get('drift') || '');
  const [modelPoolId, setModelPoolId] = useState(() => searchParams.get('modelPoolId') || '');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadCurrentPage = async () => {
    const request = ++listRequest.current;
    setLoadingList(true); setError(null);
    try {
      const res = await getGatewayAppCallers({
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
      status: status || undefined,
      sourceSystem: sourceSystem || undefined,
      ingressProtocol: ingressProtocol || undefined,
      requestType: requestType || undefined,
      drift: drift || undefined,
      modelPoolId: modelPoolId || undefined,
    });
      if (request !== listRequest.current) return;
      if (res.success) setData(res.data); else setError(res.error?.message || '加载失败');
    } catch { if (request === listRequest.current) setError('调用方读取未完成，请重新读取。'); }
    finally { if (request === listRequest.current) setLoadingList(false); }
  };

  useEffect(() => {
    let alive = true;
    const request = ++listRequest.current;
    setLoadingList(true);
    setError(null);
    getGatewayAppCallers({
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
      status: status || undefined,
      sourceSystem: sourceSystem || undefined,
      ingressProtocol: ingressProtocol || undefined,
      requestType: requestType || undefined,
      drift: drift || undefined,
      modelPoolId: modelPoolId || undefined,
    }).then((res) => {
      if (!alive || request !== listRequest.current) return;
      if (res.success) setData(res.data);
      else setError(res.error?.message || '加载失败');
    }).catch(() => { if (alive && request === listRequest.current) setError('调用方读取未完成，请重新读取。'); })
      .finally(() => { if (alive && request === listRequest.current) setLoadingList(false); });
    return () => { alive = false; listRequest.current++; };
  }, [page, search, status, sourceSystem, ingressProtocol, requestType, drift, modelPoolId]);

  useEffect(() => {
    if (!focusedAppCallerCode || !data?.items.length) return;
    const focused = data.items.find((item) => item.appCallerCode === focusedAppCallerCode && (!focusedRequestType || item.requestType === focusedRequestType))
      ?? data.items.find((item) => item.appCallerCode === focusedLegacyCode && (!focusedRequestType || item.requestType === focusedRequestType));
    if (focused) setExpandedId(focused.id);
  }, [data?.items, focusedAppCallerCode, focusedLegacyCode, focusedRequestType]);

  useEffect(() => {
    let alive = true;
    getPools().then((res) => {
      if (!alive) return;
      if (res.success) setPools(res.data.items);
    });
    return () => {
      alive = false;
    };
  }, []);

  const pages = useMemo(() => Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE)), [data?.total]);
  const hasBulkFilter = !!(search || status || sourceSystem || ingressProtocol || requestType || drift || modelPoolId);
  const activePoolName = pools.find((pool) => pool.id === modelPoolId)?.name || modelPoolId;
  const hasBulkUpdate = !!(
    bulkDraft.targetStatus ||
    bulkDraft.modelPolicy ||
    bulkDraft.parameterPolicy ||
    bulkDraft.owner.trim() ||
    bulkDraft.monthlyBudgetUsd.trim() ||
    bulkDraft.budgetReservationUsd.trim() ||
    bulkDraft.rateLimitPerMinute.trim()
  );
  const th: React.CSSProperties = { height: 46, textAlign: 'left', padding: '10px 12px', fontSize: 'var(--fs-body)', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { minHeight: 46, padding: '10px 12px', fontSize: 'var(--fs-body)', color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };
  const selectStyle: React.CSSProperties = {
    height: 38,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    padding: '0 10px',
    fontSize: 'var(--fs-body)',
  };

  if (!data) return error ? <InlineAlert tone="error">{error}<Button size="sm" variant="ghost" onClick={() => void loadCurrentPage()}>重新读取</Button></InlineAlert> : <SectionLoader text="正在加载 appCaller 注册表…" />;

  const focusFound = data.items.some(item => (item.appCallerCode === focusedAppCallerCode || item.appCallerCode === focusedLegacyCode) && (!focusedRequestType || item.requestType === focusedRequestType));
  function findFocusedCaller() {
    setFocusLookup(true); setPage(1); setSearch(focusedAppCallerCode); setRequestType(focusedRequestType);
    setStatus(''); setSourceSystem(''); setIngressProtocol(''); setDrift(''); setModelPoolId('');
  }
  function restoreCallerFilters() {
    setFocusLookup(false);
    setPage(Math.max(1, Number(searchParams.get('page') || '1') || 1)); setSearch(searchParams.get('search') || '');
    setStatus(searchParams.get('status') || ''); setSourceSystem(searchParams.get('sourceSystem') || '');
    setIngressProtocol(searchParams.get('ingressProtocol') || ''); setRequestType(searchParams.get('requestType') || '');
    setDrift(searchParams.get('drift') || ''); setModelPoolId(searchParams.get('modelPoolId') || '');
  }

  const getDraft = (item: GatewayAppCaller): Draft => drafts[item.id] ?? {
    status: item.status || '',
    allowedModelPoolIds: item.allowedModelPoolIds?.length ? item.allowedModelPoolIds : (item.modelPoolId ? [item.modelPoolId] : []),
    defaultModelPoolId: item.defaultModelPoolId || item.modelPoolId || '',
    allowCrossPoolFallback: item.allowCrossPoolFallback ?? false,
    modelPolicy: item.modelPolicy || 'auto',
    parameterPolicy: item.parameterPolicy || 'default-drop',
    owner: item.owner || '',
    monthlyBudgetUsd: item.monthlyBudgetUsd ? String(item.monthlyBudgetUsd) : '',
    budgetReservationUsd: item.budgetReservationUsd ? String(item.budgetReservationUsd) : '',
    rateLimitPerMinute: item.rateLimitPerMinute ? String(item.rateLimitPerMinute) : '',
  };
  const patchDraft = (item: GatewayAppCaller, patch: Partial<Draft>) => setDrafts((prev) => ({
    ...prev,
    [item.id]: { ...(prev[item.id] ?? getDraft(item)), ...patch },
  }));
  const saveItem = async (item: GatewayAppCaller) => {
    const draft = getDraft(item);
    if (!STATUSES.includes(draft.status)) { setActionError('调用方状态未知，请明确选择管理状态后再保存。'); return; }
    setSavingId(item.id);
    setActionError(null);
    setActionNotice(null);
    const res = await updateGatewayAppCaller(item.id, {
      status: draft.status,
      allowedModelPoolIds: draft.allowedModelPoolIds,
      defaultModelPoolId: draft.defaultModelPoolId,
      allowCrossPoolFallback: draft.allowCrossPoolFallback,
      modelPolicy: draft.modelPolicy,
      parameterPolicy: draft.parameterPolicy,
      owner: draft.owner,
      monthlyBudgetUsd: parseNonNegativeNumber(draft.monthlyBudgetUsd),
      budgetReservationUsd: parseNonNegativeNumber(draft.budgetReservationUsd),
      rateLimitPerMinute: parseNonNegativeInteger(draft.rateLimitPerMinute),
    });
    setSavingId(null);
    if (!res.success) {
      setActionError(res.error?.message || '保存失败');
      return;
    }
    setData((prev) => prev ? { ...prev, items: prev.items.map((x) => (x.id === item.id ? res.data : x)) } : prev);
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
  };

  // appCaller 是被动发现的：删掉它，下一条同 code 的请求会把它重新登记回来。
  // 所以这里删的是「治理配置」不是「调用权限」，确认文案必须说清，免得运维以为删了就断流。
  const removeItem = async (item: GatewayAppCaller) => {
    const typed = await promptText({
      title: `删除 appCaller「${item.appCallerCode}」`,
      description: '它的注册与治理配置（模型池绑定、预算、限流）一并消失，名下的提示词策略版本也会一起删掉。\n这只是被动发现的登记，下一次同名调用会重新出现，但配置不会回来。',
      inputLabel: '确认请输入 appCallerCode',
      requireExact: item.appCallerCode,
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (typed === null) return;
    if (typed.trim() !== item.appCallerCode) {
      setActionError('输入的 appCallerCode 不一致，已取消删除');
      return;
    }
    setSavingId(item.id);
    setActionError(null);
    setActionNotice(null);
    const res = await deleteAppCaller(item.id);
    setSavingId(null);
    if (!res.success) {
      setActionError(res.error?.message || '删除失败');
      return;
    }
    setExpandedId((prev) => (prev === item.id ? null : prev));
    setData((prev) => (prev ? { ...prev, items: prev.items.filter((x) => x.id !== item.id), total: Math.max(0, prev.total - 1) } : prev));
    // 连带删掉的提示词策略要报出来：它会改写系统提示词，删了却不说等于静默改行为
    const policies = res.data?.promptPolicyVersionsDeleted ?? 0;
    setActionNotice(
      `已删除 appCaller「${item.appCallerCode}」`
      + (policies > 0 ? `，连带删除提示词策略 ${policies} 版` : ''),
    );
  };

  const applyBulkGovernance = async () => {
    if (!hasBulkFilter || !hasBulkUpdate || bulkSaving || loadingList || error) return;
    const confirmed = await confirm({ title: `按当前筛选批量更新 ${data.total} 个 appCaller？`, description: '范围内每一条的治理配置都会被改写。', tone: 'danger', confirmLabel: '批量更新' });
    if (!confirmed) return;
    setBulkSaving(true);
    setActionError(null);
    setActionNotice(null);
    const res = await bulkUpdateGatewayAppCallers({
      filterStatus: status || undefined,
      sourceSystem: sourceSystem || undefined,
      ingressProtocol: ingressProtocol || undefined,
      requestType: requestType || undefined,
      drift: drift || undefined,
      search: search || undefined,
      modelPoolId: modelPoolId || undefined,
      targetStatus: bulkDraft.targetStatus || undefined,
      modelPolicy: bulkDraft.modelPolicy || undefined,
      parameterPolicy: bulkDraft.parameterPolicy || undefined,
      owner: bulkDraft.owner.trim() || undefined,
      monthlyBudgetUsd: parseOptionalNonNegativeNumber(bulkDraft.monthlyBudgetUsd),
      budgetReservationUsd: parseOptionalNonNegativeNumber(bulkDraft.budgetReservationUsd),
      rateLimitPerMinute: parseOptionalNonNegativeInteger(bulkDraft.rateLimitPerMinute),
    });
    setBulkSaving(false);
    if (!res.success) {
      setActionError(res.error?.message || '批量治理失败');
      return;
    }
    setActionNotice(`批量治理完成：匹配 ${res.data.matchedCount} 个，修改 ${res.data.modifiedCount} 个`);
    setBulkDraft({
      targetStatus: '',
      modelPolicy: '',
      parameterPolicy: '',
      owner: '',
      monthlyBudgetUsd: '',
      budgetReservationUsd: '',
      rateLimitPerMinute: '',
    });
    await loadCurrentPage();
  };

  return (
    <AppCallerDefaultsProvider returnSearch={new URLSearchParams({ page: String(page), search, status, sourceSystem, ingressProtocol, requestType, drift, modelPoolId }).toString()}><div className="lg-app-caller-page">
      <header className="lg-app-caller-header">
        <div><h1>调用方</h1><p>查看调用方的默认模型、预算与限流。</p></div>
        <span>共 {data.total} 个</span>
      </header>
      {error ? <InlineAlert tone="error">筛选结果未更新：{error}<Button size="sm" variant="ghost" onClick={() => void loadCurrentPage()}>重新读取</Button></InlineAlert> : null}
      {focusedAppCallerCode && !loadingList && !focusFound ? <InlineAlert tone="info">当前未找到 {focusedAppCallerCode} · {focusedRequestType || '原用途'}，原筛选已保留。<Button size="sm" variant="ghost" onClick={findFocusedCaller}>按此身份查找（切换筛选）</Button></InlineAlert> : null}
      {focusLookup ? <Button size="sm" variant="ghost" onClick={restoreCallerFilters}>恢复原筛选</Button> : null}
      <div className="lg-app-caller-toolbar">
        <input
          value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }}
          placeholder="搜索 appCaller、标题或 requestId"
          aria-label="搜索 appCaller"
        />
        {modelPoolId ? <div className="lg-app-caller-active-filter"><span>模型池</span><strong title={modelPoolId}>{activePoolName}</strong><button type="button" onClick={() => { setPage(1); setModelPoolId(''); }}>移除</button></div> : null}
        <details className="lg-app-caller-filters">
          <summary>筛选{hasBulkFilter ? '（已启用）' : ''}</summary>
          <div>
            <FilterSelect label="全部状态" value={status} options={data.statuses} onChange={(v) => { setPage(1); setStatus(v); }} style={selectStyle} />
            <FilterSelect label="全部来源" value={sourceSystem} options={data.sourceSystems} onChange={(v) => { setPage(1); setSourceSystem(v); }} style={selectStyle} />
            <FilterSelect label="全部入口" value={ingressProtocol} options={data.ingressProtocols} onChange={(v) => { setPage(1); setIngressProtocol(v); }} style={selectStyle} />
            <FilterSelect label="全部类型" value={requestType} options={data.requestTypes} onChange={(v) => { setPage(1); setRequestType(v); }} style={selectStyle} />
            <select value={drift} onChange={(e) => { setPage(1); setDrift(e.target.value); }} style={selectStyle}><option value="">全部漂移</option>{DRIFT_FILTERS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
            {hasBulkFilter ? <Button size="sm" variant="ghost" onClick={() => { setPage(1); setSearch(''); setStatus(''); setSourceSystem(''); setIngressProtocol(''); setRequestType(''); setDrift(''); setModelPoolId(''); }}>清除筛选</Button> : null}
          </div>
        </details>
        {canWrite ? <details className="lg-app-caller-bulk">
          <summary>批量治理</summary>
          <div>
            <span>只更新当前筛选命中的 appCaller；未填写字段保持不变。</span>
            <select value={bulkDraft.targetStatus} onChange={(e) => setBulkDraft((prev) => ({ ...prev, targetStatus: e.target.value }))} style={selectStyle}><option value="">状态不改</option>{STATUSES.map((x) => <option key={x} value={x}>{statusLabel(x)}</option>)}</select>
            <select value={bulkDraft.modelPolicy} onChange={(e) => setBulkDraft((prev) => ({ ...prev, modelPolicy: e.target.value }))} style={selectStyle}><option value="">路由不改</option>{MODEL_POLICIES.map((x) => <option key={x} value={x}>{modelPolicyLabel(x)}</option>)}</select>
            <select value={bulkDraft.parameterPolicy} onChange={(e) => setBulkDraft((prev) => ({ ...prev, parameterPolicy: e.target.value }))} style={selectStyle}><option value="">参数策略不改</option>{PARAMETER_POLICIES.map((x) => <option key={x} value={x}>{parameterPolicyLabel(x)}</option>)}</select>
            <input value={bulkDraft.owner} onChange={(e) => setBulkDraft((prev) => ({ ...prev, owner: e.target.value }))} placeholder="负责人" aria-label="批量负责人" />
            <input value={bulkDraft.monthlyBudgetUsd} onChange={(e) => setBulkDraft((prev) => ({ ...prev, monthlyBudgetUsd: e.target.value }))} placeholder="预算 USD/月" inputMode="decimal" aria-label="批量月预算 USD" />
            <input value={bulkDraft.budgetReservationUsd} onChange={(e) => setBulkDraft((prev) => ({ ...prev, budgetReservationUsd: e.target.value }))} placeholder="单次预占 USD" inputMode="decimal" aria-label="批量单次预算预占 USD" />
            <input value={bulkDraft.rateLimitPerMinute} onChange={(e) => setBulkDraft((prev) => ({ ...prev, rateLimitPerMinute: e.target.value }))} placeholder="RPM" inputMode="numeric" aria-label="批量每分钟限流" />
            <Button size="sm" variant="secondary" disabled={!hasBulkFilter || !hasBulkUpdate || bulkSaving || data.total === 0} onClick={() => void applyBulkGovernance()}>{bulkSaving ? '应用中' : `应用到 ${data.total} 个`}</Button>
          </div>
        </details> : <ReadOnlyNotice>当前角色可以查看 appCaller、路由和最近请求，但不能修改治理配置。</ReadOnlyNotice>}
      </div>
      {actionError ? (
        <div className="lg-app-caller-notice is-error">
          {actionError}
        </div>
      ) : null}
      {actionNotice ? (
        <div className="lg-app-caller-notice is-ok">
          {actionNotice}
        </div>
      ) : null}

      <div className="lg-app-caller-table-wrap" aria-busy={loadingList}>
        <table className="lg-data-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
          <colgroup>
            <col style={{ width: 240 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 160 }} />
            <col style={{ width: 120 }} />
          </colgroup>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
            <tr>
              <th style={th}>appCaller</th>
              <th style={th}>调用管理</th>
              <th style={th}>调用方式</th>
              <th style={th}>未点名默认模型</th>
              <th style={th}>治理</th>
              <th style={th}>最近请求</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <AppCallerRow
                key={`${item.appCallerCode}:${item.requestType}`}
                item={item}
                td={td}
                pools={pools}
                draft={getDraft(item)}
                selectStyle={selectStyle}
                saving={savingId === item.id}
                canWrite={canWrite}
                canManagePromptPolicy={canManagePromptPolicy}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId((current) => current === item.id ? null : item.id)}
                onDraft={(patch) => patchDraft(item, patch)}
                onSave={() => saveItem(item)}
                onDelete={() => removeItem(item)}
              />
            ))}
          </tbody>
        </table>
        {data.items.length === 0 ? <EmptyBlock text="没有匹配的 appCaller" /> : null}
      </div>

      <div className="lg-app-caller-mobile-list">
        {data.items.map((item) => (
          <AppCallerMobileCard
            key={`${item.appCallerCode}:${item.requestType}:mobile`}
            item={item}
            pools={pools}
            draft={getDraft(item)}
            selectStyle={selectStyle}
            saving={savingId === item.id}
            canWrite={canWrite}
            canManagePromptPolicy={canManagePromptPolicy}
            expanded={expandedId === item.id}
            onToggle={() => setExpandedId((current) => current === item.id ? null : item.id)}
            onDraft={(patch) => patchDraft(item, patch)}
            onSave={() => saveItem(item)}
            onDelete={() => removeItem(item)}
          />
        ))}
        {data.items.length === 0 ? <EmptyBlock text="没有匹配的 appCaller" /> : null}
      </div>

      {pages > 1 ? <div className="lg-app-caller-pagination">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
        <span>{page} / {pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>下一页</Button>
      </div> : null}
    </div></AppCallerDefaultsProvider>
  );
}

function StatusOptions() {
  return <><option value="" disabled>未知，请选择</option>{STATUSES.map((x) => <option key={x} value={x}>{statusLabel(x)}</option>)}</>;
}

function FilterSelect({ label, value, options, onChange, style }: { label: string; value: string; options: string[]; onChange: (v: string) => void; style: React.CSSProperties }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
      <option value="">{label}</option>
      {options.map((x) => <option key={x} value={x}>{x}</option>)}
    </select>
  );
}

/*
  模型池绑定已退役——这里只剩「你以前配过什么」的只读回执，外加一句下一步。

  为什么不是直接删掉：库里还留着 AllowedModelPoolIds / DefaultModelPoolId / AllowCrossPoolFallback
  这几个字段，运维需要看得见自己当初配的是什么，才对得上「为什么这个调用方现在走的是别的模型」。
  为什么不能留着可编辑：解析器已经不读这几个字段了，保存成功却什么都不改变——
  一次成功的保存变成静默空操作，而页面还写着「下一条请求生效」（Codex P1，2026-09-16）。

  文案按 external-cause-first：第一句说清这是谁的哪个配置不再生效、于是现在按什么走，
  要不要紧写进人读的那句话里，下一步是可执行的动作，不是一句「请知悉」。
*/
function ModelPoolContractFields({
  compatiblePools,
  draft,
}: {
  compatiblePools: ModelPool[];
  draft: Draft;
  selectStyle: React.CSSProperties;
  canWrite: boolean;
  onDraft: (patch: Partial<Draft>) => void;
}) {
  const selectedPools = compatiblePools.filter((pool) => draft.allowedModelPoolIds.includes(pool.id));
  const defaultPool = compatiblePools.find((pool) => pool.id === draft.defaultModelPoolId);
  const hasLegacyBinding = draft.allowedModelPoolIds.length > 0 || Boolean(draft.defaultModelPoolId);
  const poolNames = selectedPools.length
    ? selectedPools.map((pool) => pool.name || pool.code || pool.id).join('、')
    : draft.allowedModelPoolIds.join('、');

  if (!hasLegacyBinding) return null;
  return (
    <details className="lg-app-caller-retired-pool">
      <summary>旧模型池配置（不参与当前路由）</summary>
      <p>{poolNames || '未记录名称'}{defaultPool ? `；旧默认：${defaultPool.name || defaultPool.code || defaultPool.id}` : ''}。当前默认模型以上方读取结果为准。</p>
    </details>
  );
}

function AppCallerRow({
  item,
  td,
  pools,
  draft,
  selectStyle,
  saving,
  canWrite,
  canManagePromptPolicy,
  expanded,
  onToggle,
  onDraft,
  onSave,
  onDelete,
}: {
  item: GatewayAppCaller;
  td: React.CSSProperties;
  pools: ModelPool[];
  draft: Draft;
  selectStyle: React.CSSProperties;
  saving: boolean;
  canWrite: boolean;
  canManagePromptPolicy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDraft: (patch: Partial<Draft>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const chip = statusChip(item.status);
  const compatiblePools = pools.filter((p) => !item.requestType || p.modelType.toLowerCase() === item.requestType.toLowerCase());
  const observedPolicy = [item.lastObservedModelPolicy, item.lastObservedModelPoolId].filter(Boolean).join(' / ');
  const observedParameter = item.lastObservedParameterPolicy ? `参数 ${item.lastObservedParameterPolicy}` : '';
  const observedIngressProtocols = item.observedIngressProtocols?.length ? item.observedIngressProtocols : (item.ingressProtocol ? [item.ingressProtocol] : []);
  const routeDrift = Boolean(item.lastObservedModelPolicy && item.lastObservedModelPolicy !== item.modelPolicy)
    || Boolean(item.lastObservedModelPoolId && !draft.allowedModelPoolIds.includes(item.lastObservedModelPoolId));
  const parameterDrift = Boolean(item.lastObservedParameterPolicy && item.lastObservedParameterPolicy !== item.parameterPolicy);
  return (
    <>
      <tr>
        <td style={td}><div className="lg-app-caller-identity"><strong>{item.title?.trim() || item.clientCode || '未命名调用方'}</strong><code>{item.appCallerCode}</code><span>{item.sourceSystem || '未知来源'}</span></div></td>
        <td style={td}><div className="lg-app-caller-stack"><Chip label={chip.label} color={chip.color} bg={chip.bg} />{registrationStage(item.status) ? <span>{registrationStage(item.status)}</span> : null}</div></td>
        <td style={td}><div className="lg-app-caller-stack"><strong>{requestTypeLabelForTable(item.requestType)}</strong><span>{observedIngressProtocols.join('、') || '未观察到协议'}</span></div></td>
        <td style={td}><div className="lg-app-caller-stack"><AppCallerDefaultModel item={item} /><span>{parameterPolicyLabel(item.parameterPolicy || 'default-drop')}</span>{routeDrift || parameterDrift ? <span className="lg-app-caller-warning">配置与最近请求不一致</span> : null}</div></td>
        <td style={td}><div className="lg-app-caller-stack"><strong>{item.owner || '未指定负责人'}</strong><span>{formatGovernanceSummary(item)}</span></div></td>
        <td style={td}><div className="lg-app-caller-recent"><TraceLinks item={item} /><span>{item.totalSeen} 次 · {fmtTime(item.lastSeenAt)}</span></div></td>
        <td style={td}><div className="lg-app-caller-row-actions"><Button size="sm" variant="ghost" onClick={onToggle}>{expanded ? '收起' : canWrite ? '编辑治理' : '查看治理'}</Button>{canManagePromptPolicy && ['chat', 'vision'].includes(item.requestType.toLowerCase()) ? <Link to={`/app-callers/${encodeURIComponent(item.id)}/prompt-policy`}>提示词策略</Link> : null}</div></td>
      </tr>
      {expanded ? <tr className="lg-app-caller-expanded-row"><td colSpan={7}>
        <div className="lg-app-caller-editor">
          <div className="lg-app-caller-editor-heading"><div><strong>{canWrite ? '编辑治理' : '治理详情'}</strong><span>预算、限流与参数策略对新请求生效。</span></div></div>
          <div className="lg-app-caller-editor-grid">
            <label>状态<select disabled={!canWrite} value={draft.status} onChange={(e) => onDraft({ status: e.target.value })} style={selectStyle}><StatusOptions /></select></label>
            <ModelPoolContractFields compatiblePools={compatiblePools} draft={draft} selectStyle={selectStyle} canWrite={canWrite} onDraft={onDraft} />
            <label>模型策略<select disabled={!canWrite} value={draft.modelPolicy} onChange={(e) => onDraft({ modelPolicy: e.target.value })} style={selectStyle}>{MODEL_POLICIES.map((x) => <option key={x} value={x}>{modelPolicyLabel(x)}</option>)}</select></label>
            <label>参数策略<select disabled={!canWrite} value={draft.parameterPolicy} onChange={(e) => onDraft({ parameterPolicy: e.target.value })} style={selectStyle}>{PARAMETER_POLICIES.map((x) => <option key={x} value={x}>{parameterPolicyLabel(x)}</option>)}</select></label>
            <label>负责人<input disabled={!canWrite} value={draft.owner} onChange={(e) => onDraft({ owner: e.target.value })} placeholder="例如 platform-team" /></label>
            <label>月预算（USD）<input disabled={!canWrite} value={draft.monthlyBudgetUsd} onChange={(e) => onDraft({ monthlyBudgetUsd: e.target.value })} placeholder="未设置" inputMode="decimal" /></label>
            <label>单次预算预占（USD）<input disabled={!canWrite} value={draft.budgetReservationUsd} onChange={(e) => onDraft({ budgetReservationUsd: e.target.value })} placeholder="未设置" inputMode="decimal" /></label>
            <label>每分钟请求上限<input disabled={!canWrite} value={draft.rateLimitPerMinute} onChange={(e) => onDraft({ rateLimitPerMinute: e.target.value })} placeholder="未设置" inputMode="numeric" /></label>
          </div>
          {observedPolicy || observedParameter ? <p className="lg-app-caller-observed">最近请求实际观察：{[observedPolicy, observedParameter].filter(Boolean).join('；')}</p> : null}
          <div className="lg-app-caller-editor-actions">{canWrite ? <Button variant="primary" disabled={saving} onClick={onSave}>{saving ? '保存中' : '保存配置'}</Button> : null}{canWrite ? <Button variant="ghost" disabled={saving} onClick={onDelete}>删除</Button> : null}<Button variant="ghost" onClick={onToggle}>关闭</Button></div>
        </div>
      </td></tr> : null}
    </>
  );
}

function AppCallerMobileCard({
  item,
  pools,
  draft,
  selectStyle,
  saving,
  canWrite,
  canManagePromptPolicy,
  expanded,
  onToggle,
  onDraft,
  onSave,
  onDelete,
}: {
  item: GatewayAppCaller;
  pools: ModelPool[];
  draft: Draft;
  selectStyle: React.CSSProperties;
  saving: boolean;
  canWrite: boolean;
  canManagePromptPolicy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDraft: (patch: Partial<Draft>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const chip = statusChip(item.status);
  const compatiblePools = pools.filter((pool) => !item.requestType || pool.modelType.toLowerCase() === item.requestType.toLowerCase());
  const observedIngressProtocols = item.observedIngressProtocols?.length ? item.observedIngressProtocols : (item.ingressProtocol ? [item.ingressProtocol] : []);
  const routeDrift = Boolean(item.lastObservedModelPolicy && item.lastObservedModelPolicy !== item.modelPolicy)
    || Boolean(item.lastObservedModelPoolId && !draft.allowedModelPoolIds.includes(item.lastObservedModelPoolId))
    || Boolean(item.lastObservedParameterPolicy && item.lastObservedParameterPolicy !== item.parameterPolicy);
  return (
    <article className="lg-app-caller-mobile-card">
      <div className="lg-app-caller-mobile-heading">
        <div className="lg-app-caller-identity"><strong>{item.title?.trim() || item.clientCode || '未命名调用方'}</strong><code>{item.appCallerCode}</code><span>{item.sourceSystem || '未知来源'}</span></div>
        <Chip label={chip.label} color={chip.color} bg={chip.bg} />
      </div>
      <dl className="lg-app-caller-mobile-facts">
        <div><dt>调用方式</dt><dd>{requestTypeLabelForTable(item.requestType)}<small>{observedIngressProtocols.join('、') || '未观察到协议'}</small></dd></div>
        <div><dt>未点名默认模型</dt><dd><AppCallerDefaultModel item={item} /><small>{parameterPolicyLabel(item.parameterPolicy || 'default-drop')}</small>{routeDrift ? <small className="lg-app-caller-warning">配置与最近请求不一致</small> : null}</dd></div>
        <div><dt>治理</dt><dd>{item.owner || '未指定负责人'}<small>{formatGovernanceSummary(item)}</small></dd></div>
        <div><dt>最近请求</dt><dd><TraceLinks item={item} /><small>{item.totalSeen} 次 · {fmtTime(item.lastSeenAt)}</small></dd></div>
      </dl>
      <div className="lg-app-caller-mobile-actions">
        <Button size="sm" variant="secondary" onClick={onToggle}>{expanded ? '收起配置' : canWrite ? '编辑治理' : '查看治理'}</Button>
        {canManagePromptPolicy && ['chat', 'vision'].includes(item.requestType.toLowerCase()) ? <Link to={`/app-callers/${encodeURIComponent(item.id)}/prompt-policy`}>提示词策略</Link> : null}
      </div>
      {expanded ? <div className="lg-app-caller-mobile-editor">
        <div><strong>{canWrite ? '配置路由与治理' : '路由与治理详情'}</strong><span>保存后从下一条请求开始生效。</span></div>
        <div className="lg-app-caller-editor-grid">
          <label>状态<select disabled={!canWrite} value={draft.status} onChange={(e) => onDraft({ status: e.target.value })} style={selectStyle}><StatusOptions /></select></label>
          <ModelPoolContractFields compatiblePools={compatiblePools} draft={draft} selectStyle={selectStyle} canWrite={canWrite} onDraft={onDraft} />
          <label>模型策略<select disabled={!canWrite} value={draft.modelPolicy} onChange={(e) => onDraft({ modelPolicy: e.target.value })} style={selectStyle}>{MODEL_POLICIES.map((x) => <option key={x} value={x}>{modelPolicyLabel(x)}</option>)}</select></label>
          <label>参数策略<select disabled={!canWrite} value={draft.parameterPolicy} onChange={(e) => onDraft({ parameterPolicy: e.target.value })} style={selectStyle}>{PARAMETER_POLICIES.map((x) => <option key={x} value={x}>{parameterPolicyLabel(x)}</option>)}</select></label>
          <label>负责人<input disabled={!canWrite} value={draft.owner} onChange={(e) => onDraft({ owner: e.target.value })} placeholder="例如 platform-team" /></label>
          <label>月预算（USD）<input disabled={!canWrite} value={draft.monthlyBudgetUsd} onChange={(e) => onDraft({ monthlyBudgetUsd: e.target.value })} placeholder="未设置" inputMode="decimal" /></label>
          <label>单次预算预占（USD）<input disabled={!canWrite} value={draft.budgetReservationUsd} onChange={(e) => onDraft({ budgetReservationUsd: e.target.value })} placeholder="未设置" inputMode="decimal" /></label>
          <label>每分钟请求上限<input disabled={!canWrite} value={draft.rateLimitPerMinute} onChange={(e) => onDraft({ rateLimitPerMinute: e.target.value })} placeholder="未设置" inputMode="numeric" /></label>
        </div>
        <div className="lg-app-caller-editor-actions">{canWrite ? <Button variant="primary" disabled={saving} onClick={onSave}>{saving ? '保存中' : '保存配置'}</Button> : null}{canWrite ? <Button variant="ghost" disabled={saving} onClick={onDelete}>删除</Button> : null}<Button variant="ghost" onClick={onToggle}>关闭</Button></div>
      </div> : null}
    </article>
  );
}

function TraceLinks({ item }: { item: GatewayAppCaller }) {
  const links = [
    { label: 'request', href: logsHref('requestId', item.lastObservedRequestId), value: item.lastObservedRequestId },
    { label: 'session', href: logsHref('sessionId', item.lastObservedSessionId), value: item.lastObservedSessionId },
    { label: 'run', href: logsHref('runId', item.lastObservedRunId), value: item.lastObservedRunId },
  ].filter((x) => x.value && x.href);

  if (links.length === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      {links.map((link) => (
        <Link
          key={link.label}
          to={link.href}
          style={{
            color: 'var(--accent)',
            fontSize: 'var(--fs-secondary)',
            fontFamily: 'var(--font-mono)',
            textDecoration: 'none',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={link.value ?? ''}
        >
          {link.label}: {link.value}
        </Link>
      ))}
    </div>
  );
}

function requestTypeLabelForTable(value: string) {
  return ({ chat: '文字对话', vision: '图片理解', generation: '图片生成', intent: '意图识别', embedding: '向量嵌入', rerank: '重排序' } as Record<string, string>)[value] ?? (value || '未设置类型');
}

function formatGovernanceSummary(item: GatewayAppCaller) {
  const parts = [
    item.monthlyBudgetUsd ? `预算 ${item.monthlyBudgetUsd} USD/月` : '预算未设置',
    item.rateLimitPerMinute ? `${item.rateLimitPerMinute} RPM` : '速率未设置',
  ];
  return parts.join(' · ');
}



function parseNonNegativeNumber(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseNonNegativeInteger(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseOptionalNonNegativeNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseOptionalNonNegativeInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}


function EmptyBlock({ text }: { text: string }) {
  return <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' }}>{text}</div>;
}
