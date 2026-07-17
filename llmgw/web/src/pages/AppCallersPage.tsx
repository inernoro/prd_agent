// GW appCaller 注册表：展示 llmgw-serve 被动发现的调用方。
// 这是目标架构里“appCaller 权威迁到 GW”的第一步，只读，不修改 MAP 旧配置。
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { bulkUpdateGatewayAppCallers, getGatewayAppCallers, getPools, updateGatewayAppCaller } from '@/lib/api';
import type { GatewayAppCaller, GatewayAppCallersData, ModelPool } from '@/lib/types';
import { Button, Chip, SectionLoader, ReadOnlyNotice } from '@/components/ui';
import { EntityPreviewDrawer } from '@/components/EntityPreviewDrawer';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

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
  modelPoolId: string;
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
  const key = (status || 'discovered').toLowerCase();
  if (key === 'active') return { label: '已启用', color: '#3fb950', bg: 'rgba(63,185,80,0.14)' };
  if (key === 'configured') return { label: '已配置', color: '#7aa2ff', bg: 'rgba(122,162,255,0.14)' };
  if (key === 'disabled') return { label: '已停用', color: '#f85149', bg: 'rgba(248,81,73,0.14)' };
  if (key === 'archived') return { label: '已归档', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' };
  return { label: '待配置', color: '#d29922', bg: 'rgba(210,153,34,0.14)' };
}

function statusLabel(value: string) {
  return ({ discovered: '待配置', configured: '已配置', active: '已启用', disabled: '已停用', archived: '已归档' } as Record<string, string>)[value] ?? value;
}

function modelPolicyLabel(value: string) {
  return ({ auto: '自动选择', pool: '指定模型池', pinned: '固定模型' } as Record<string, string>)[value] ?? value;
}

function parameterPolicyLabel(value: string) {
  return ({ 'default-drop': '忽略不支持参数', 'strict-require': '参数不支持就拒绝' } as Record<string, string>)[value] ?? value;
}

function fmtTime(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function logsHref(key: 'requestId' | 'sessionId' | 'runId', value?: string | null) {
  if (!value) return '';
  return `/logs?${key}=${encodeURIComponent(value)}`;
}

export function AppCallersPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'appCallerWrite');
  const canManagePromptPolicy = canUseCapability(tenant?.role, 'configWrite');
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<GatewayAppCallersData | null>(null);
  const [pools, setPools] = useState<ModelPool[]>([]);
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
    setError(null);
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
    if (res.success) setData(res.data);
    else setError(res.error?.message || '加载失败');
  };

  useEffect(() => {
    let alive = true;
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
      if (!alive) return;
      if (res.success) setData(res.data);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, [page, search, status, sourceSystem, ingressProtocol, requestType, drift, modelPoolId]);

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
  const th: React.CSSProperties = { height: 46, textAlign: 'left', padding: '10px 12px', fontSize: 14, color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { minHeight: 46, padding: '10px 12px', fontSize: 14, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };
  const selectStyle: React.CSSProperties = {
    height: 38,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    padding: '0 10px',
    fontSize: 14,
  };

  if (error) return <Empty text={error} />;
  if (!data) return <SectionLoader text="正在加载 appCaller 注册表…" />;

  const getDraft = (item: GatewayAppCaller): Draft => drafts[item.id] ?? {
    status: item.status || 'discovered',
    modelPoolId: item.modelPoolId || '',
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
    setSavingId(item.id);
    setActionError(null);
    setActionNotice(null);
    const res = await updateGatewayAppCaller(item.id, {
      status: draft.status,
      modelPoolId: draft.modelPoolId,
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

  const applyBulkGovernance = async () => {
    if (!hasBulkFilter || !hasBulkUpdate || bulkSaving) return;
    const confirmed = window.confirm(`按当前筛选批量更新 ${data.total} 个 appCaller？`);
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
    <div className="lg-app-caller-page">
      <header className="lg-app-caller-header">
        <div><h1>appCaller</h1><p>查看每类业务为什么调用、会走哪个模型池，以及预算和速率由谁负责。</p></div>
        <span>共 {data.total} 个</span>
      </header>
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

      <div className="lg-app-caller-table-wrap">
        <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
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
              <th style={th}>状态</th>
              <th style={th}>调用方式</th>
              <th style={th}>路由</th>
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
          />
        ))}
        {data.items.length === 0 ? <EmptyBlock text="没有匹配的 appCaller" /> : null}
      </div>

      <div className="lg-app-caller-pagination">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
        <span>{page} / {pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>下一页</Button>
      </div>
    </div>
  );
}

function FilterSelect({ label, value, options, onChange, style }: { label: string; value: string; options: string[]; onChange: (v: string) => void; style: React.CSSProperties }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
      <option value="">{label}</option>
      {options.map((x) => <option key={x} value={x}>{x}</option>)}
    </select>
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
}) {
  const chip = statusChip(item.status);
  const compatiblePools = pools.filter((p) => !item.requestType || p.modelType.toLowerCase() === item.requestType.toLowerCase());
  const selectedPool = compatiblePools.find((pool) => pool.id === draft.modelPoolId);
  const observedPolicy = [item.lastObservedModelPolicy, item.lastObservedModelPoolId].filter(Boolean).join(' / ');
  const observedParameter = item.lastObservedParameterPolicy ? `参数 ${item.lastObservedParameterPolicy}` : '';
  const observedIngressProtocols = item.observedIngressProtocols?.length ? item.observedIngressProtocols : (item.ingressProtocol ? [item.ingressProtocol] : []);
  const routeDrift = Boolean(item.lastObservedModelPolicy && item.lastObservedModelPolicy !== item.modelPolicy)
    || Boolean(item.lastObservedModelPoolId && item.lastObservedModelPoolId !== item.modelPoolId);
  const parameterDrift = Boolean(item.lastObservedParameterPolicy && item.lastObservedParameterPolicy !== item.parameterPolicy);
  return (
    <>
      <tr>
        <td style={td}><div className="lg-app-caller-identity"><code>{item.appCallerCode}</code><span>{item.title || '未填写标题'} · {item.sourceSystem || '未知来源'}</span></div></td>
        <td style={td}><Chip label={chip.label} color={chip.color} bg={chip.bg} /></td>
        <td style={td}><div className="lg-app-caller-stack"><strong>{requestTypeLabelForTable(item.requestType)}</strong><span>{observedIngressProtocols.join('、') || '未观察到协议'}</span></div></td>
        <td style={td}><div className="lg-app-caller-stack"><strong>{selectedPool?.name || item.modelPoolId || '未绑定模型池'}</strong><span>{modelPolicyLabel(item.modelPolicy || 'auto')} · {parameterPolicyLabel(item.parameterPolicy || 'default-drop')}</span>{routeDrift || parameterDrift ? <span className="lg-app-caller-warning">配置与最近请求不一致</span> : null}</div></td>
        <td style={td}><div className="lg-app-caller-stack"><strong>{item.owner || '未指定负责人'}</strong><span>{formatGovernanceSummary(item)}</span></div></td>
        <td style={td}><div className="lg-app-caller-recent"><TraceLinks item={item} /><span>{item.totalSeen} 次 · {fmtTime(item.lastSeenAt)}</span></div></td>
        <td style={td}><div className="lg-app-caller-row-actions"><Button size="sm" variant="ghost" onClick={onToggle}>{expanded ? '收起' : canWrite ? '配置' : '查看'}</Button>{canManagePromptPolicy && ['chat', 'vision'].includes(item.requestType.toLowerCase()) ? <Link to={`/app-callers/${encodeURIComponent(item.id)}/prompt-policy`}>提示词策略</Link> : null}</div></td>
      </tr>
      {expanded ? <tr className="lg-app-caller-expanded-row"><td colSpan={7}>
        <div className="lg-app-caller-editor">
          <div className="lg-app-caller-editor-heading"><div><strong>{canWrite ? '配置路由与治理' : '路由与治理详情'}</strong><span>复杂配置集中在当前 appCaller 内，不影响列表阅读。保存后下一条请求生效。</span></div>{selectedPool ? <EntityPreviewDrawer buttonLabel="预览模型池" kicker="appCaller 关联的模型池" title={selectedPool.name || selectedPool.code || selectedPool.id} summary={`“${item.appCallerCode}”会从这个池的可用成员中选择实际上游。`} status={[{ label: poolHealthLabel(selectedPool.health), tone: selectedPool.health === 'healthy' ? 'good' : 'warning' }, { label: selectedPool.isDefaultForType ? `${selectedPool.modelType} 默认池` : '专用模型池' }, { label: `${selectedPool.models.length} 个模型成员` }]} sections={[{ title: '路由角色', fields: [{ label: '模型类型', value: selectedPool.modelType || '未配置' }, { label: '选择策略', value: poolStrategyLabel(selectedPool.strategyType) }, { label: '池优先级', value: selectedPool.priority }, { label: '绑定 appCaller', value: `${selectedPool.boundAppCallerCount ?? 0} 个` }] }, { title: '候选模型', description: '按优先级展示前六个成员。', fields: selectedPool.models.slice().sort((a, b) => a.priority - b.priority).slice(0, 6).map((model) => ({ label: model.modelId, value: `${model.healthStatusLabel || '状态未知'} · 优先级 ${model.priority}${model.protocol ? ` · ${model.protocol}` : ''}` })) }, { title: '最近运行', fields: [{ label: '近 7 天请求', value: selectedPool.recentRequests ?? 0 }, { label: '成功率', value: selectedPool.recentSuccessRatePercent == null ? '暂无数据' : `${selectedPool.recentSuccessRatePercent}%` }, { label: '健康成员', value: `${selectedPool.healthyMembers ?? 0} 个` }, { label: '不可用成员', value: `${selectedPool.unavailableMembers ?? 0} 个` }] }]} /> : null}</div>
          <div className="lg-app-caller-editor-grid">
            <label>状态<select disabled={!canWrite} value={draft.status} onChange={(e) => onDraft({ status: e.target.value })} style={selectStyle}>{STATUSES.map((x) => <option key={x} value={x}>{statusLabel(x)}</option>)}</select></label>
            <label>模型池<select disabled={!canWrite} value={draft.modelPoolId} onChange={(e) => onDraft({ modelPoolId: e.target.value, modelPolicy: e.target.value ? 'pool' : draft.modelPolicy })} style={selectStyle}><option value="">未绑定</option>{compatiblePools.map((p) => <option key={p.id} value={p.id}>{p.name || p.code || p.id}</option>)}</select></label>
            <label>模型策略<select disabled={!canWrite} value={draft.modelPolicy} onChange={(e) => onDraft({ modelPolicy: e.target.value })} style={selectStyle}>{MODEL_POLICIES.map((x) => <option key={x} value={x}>{modelPolicyLabel(x)}</option>)}</select></label>
            <label>参数策略<select disabled={!canWrite} value={draft.parameterPolicy} onChange={(e) => onDraft({ parameterPolicy: e.target.value })} style={selectStyle}>{PARAMETER_POLICIES.map((x) => <option key={x} value={x}>{parameterPolicyLabel(x)}</option>)}</select></label>
            <label>负责人<input disabled={!canWrite} value={draft.owner} onChange={(e) => onDraft({ owner: e.target.value })} placeholder="例如 platform-team" /></label>
            <label>月预算（USD）<input disabled={!canWrite} value={draft.monthlyBudgetUsd} onChange={(e) => onDraft({ monthlyBudgetUsd: e.target.value })} placeholder="未设置" inputMode="decimal" /></label>
            <label>单次预算预占（USD）<input disabled={!canWrite} value={draft.budgetReservationUsd} onChange={(e) => onDraft({ budgetReservationUsd: e.target.value })} placeholder="未设置" inputMode="decimal" /></label>
            <label>每分钟请求上限<input disabled={!canWrite} value={draft.rateLimitPerMinute} onChange={(e) => onDraft({ rateLimitPerMinute: e.target.value })} placeholder="未设置" inputMode="numeric" /></label>
          </div>
          {observedPolicy || observedParameter ? <p className="lg-app-caller-observed">最近请求实际观察：{[observedPolicy, observedParameter].filter(Boolean).join('；')}</p> : null}
          <div className="lg-app-caller-editor-actions">{canWrite ? <Button variant="primary" disabled={saving} onClick={onSave}>{saving ? '保存中' : '保存配置'}</Button> : null}<Button variant="ghost" onClick={onToggle}>关闭</Button></div>
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
}) {
  const chip = statusChip(item.status);
  const compatiblePools = pools.filter((pool) => !item.requestType || pool.modelType.toLowerCase() === item.requestType.toLowerCase());
  const selectedPool = compatiblePools.find((pool) => pool.id === draft.modelPoolId);
  const observedIngressProtocols = item.observedIngressProtocols?.length ? item.observedIngressProtocols : (item.ingressProtocol ? [item.ingressProtocol] : []);
  const routeDrift = Boolean(item.lastObservedModelPolicy && item.lastObservedModelPolicy !== item.modelPolicy)
    || Boolean(item.lastObservedModelPoolId && item.lastObservedModelPoolId !== item.modelPoolId)
    || Boolean(item.lastObservedParameterPolicy && item.lastObservedParameterPolicy !== item.parameterPolicy);
  return (
    <article className="lg-app-caller-mobile-card">
      <div className="lg-app-caller-mobile-heading">
        <div className="lg-app-caller-identity"><code title={item.appCallerCode}>{item.appCallerCode}</code><span>{item.title || '未填写标题'} · {item.sourceSystem || '未知来源'}</span></div>
        <Chip label={chip.label} color={chip.color} bg={chip.bg} />
      </div>
      <dl className="lg-app-caller-mobile-facts">
        <div><dt>调用方式</dt><dd>{requestTypeLabelForTable(item.requestType)}<small>{observedIngressProtocols.join('、') || '未观察到协议'}</small></dd></div>
        <div><dt>当前路由</dt><dd>{selectedPool?.name || item.modelPoolId || '未绑定模型池'}<small>{modelPolicyLabel(item.modelPolicy || 'auto')} · {parameterPolicyLabel(item.parameterPolicy || 'default-drop')}</small>{routeDrift ? <small className="lg-app-caller-warning">配置与最近请求不一致</small> : null}</dd></div>
        <div><dt>治理</dt><dd>{item.owner || '未指定负责人'}<small>{formatGovernanceSummary(item)}</small></dd></div>
        <div><dt>最近请求</dt><dd><TraceLinks item={item} /><small>{item.totalSeen} 次 · {fmtTime(item.lastSeenAt)}</small></dd></div>
      </dl>
      <div className="lg-app-caller-mobile-actions">
        <Button size="sm" variant="secondary" onClick={onToggle}>{expanded ? '收起配置' : canWrite ? '配置' : '查看'}</Button>
        {canManagePromptPolicy && ['chat', 'vision'].includes(item.requestType.toLowerCase()) ? <Link to={`/app-callers/${encodeURIComponent(item.id)}/prompt-policy`}>提示词策略</Link> : null}
      </div>
      {expanded ? <div className="lg-app-caller-mobile-editor">
        <div><strong>{canWrite ? '配置路由与治理' : '路由与治理详情'}</strong><span>保存后从下一条请求开始生效。</span></div>
        {selectedPool ? <div className="lg-app-caller-mobile-pool"><span>当前模型池</span><strong>{selectedPool.name || selectedPool.code || selectedPool.id}</strong><small>{poolHealthLabel(selectedPool.health)} · {selectedPool.models.length} 个模型成员</small></div> : null}
        <div className="lg-app-caller-editor-grid">
          <label>状态<select disabled={!canWrite} value={draft.status} onChange={(e) => onDraft({ status: e.target.value })} style={selectStyle}>{STATUSES.map((x) => <option key={x} value={x}>{statusLabel(x)}</option>)}</select></label>
          <label>模型池<select disabled={!canWrite} value={draft.modelPoolId} onChange={(e) => onDraft({ modelPoolId: e.target.value, modelPolicy: e.target.value ? 'pool' : draft.modelPolicy })} style={selectStyle}><option value="">未绑定</option>{compatiblePools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name || pool.code || pool.id}</option>)}</select></label>
          <label>模型策略<select disabled={!canWrite} value={draft.modelPolicy} onChange={(e) => onDraft({ modelPolicy: e.target.value })} style={selectStyle}>{MODEL_POLICIES.map((x) => <option key={x} value={x}>{modelPolicyLabel(x)}</option>)}</select></label>
          <label>参数策略<select disabled={!canWrite} value={draft.parameterPolicy} onChange={(e) => onDraft({ parameterPolicy: e.target.value })} style={selectStyle}>{PARAMETER_POLICIES.map((x) => <option key={x} value={x}>{parameterPolicyLabel(x)}</option>)}</select></label>
          <label>负责人<input disabled={!canWrite} value={draft.owner} onChange={(e) => onDraft({ owner: e.target.value })} placeholder="例如 platform-team" /></label>
          <label>月预算（USD）<input disabled={!canWrite} value={draft.monthlyBudgetUsd} onChange={(e) => onDraft({ monthlyBudgetUsd: e.target.value })} placeholder="未设置" inputMode="decimal" /></label>
          <label>单次预算预占（USD）<input disabled={!canWrite} value={draft.budgetReservationUsd} onChange={(e) => onDraft({ budgetReservationUsd: e.target.value })} placeholder="未设置" inputMode="decimal" /></label>
          <label>每分钟请求上限<input disabled={!canWrite} value={draft.rateLimitPerMinute} onChange={(e) => onDraft({ rateLimitPerMinute: e.target.value })} placeholder="未设置" inputMode="numeric" /></label>
        </div>
        <div className="lg-app-caller-editor-actions">{canWrite ? <Button variant="primary" disabled={saving} onClick={onSave}>{saving ? '保存中' : '保存配置'}</Button> : null}<Button variant="ghost" onClick={onToggle}>关闭</Button></div>
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
        <a
          key={link.label}
          href={link.href}
          style={{
            color: 'var(--accent)',
            fontSize: 13,
            fontFamily: 'ui-monospace, monospace',
            textDecoration: 'none',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={link.value ?? ''}
        >
          {link.label}: {link.value}
        </a>
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

function poolHealthLabel(value: ModelPool['health']) {
  return ({ healthy: '运行健康', degraded: '部分模型异常', unavailable: '无可用模型', empty: '尚未配置模型' } as Record<ModelPool['health'], string>)[value] ?? '状态未知';
}

function poolStrategyLabel(value: number) {
  return ({ 0: '优先级', 1: '轮询', 2: '加权', 3: '最少连接', 4: '随机', 5: '故障转移' } as Record<number, string>)[value] || `策略 ${value}`;
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

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}

function EmptyBlock({ text }: { text: string }) {
  return <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{text}</div>;
}
