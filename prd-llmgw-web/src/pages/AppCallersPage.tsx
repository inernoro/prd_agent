// GW appCaller 注册表：展示 llmgw-serve 被动发现的调用方。
// 这是目标架构里“appCaller 权威迁到 GW”的第一步，只读，不修改 MAP 旧配置。
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { bulkUpdateGatewayAppCallers, getGatewayAppCallers, getPools, updateGatewayAppCaller } from '@/lib/api';
import type { GatewayAppCaller, GatewayAppCallersData, ModelPool } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

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
  if (key === 'active') return { label: 'active', color: '#3fb950', bg: 'rgba(63,185,80,0.14)' };
  if (key === 'configured') return { label: 'configured', color: '#7aa2ff', bg: 'rgba(122,162,255,0.14)' };
  if (key === 'disabled') return { label: 'disabled', color: '#f85149', bg: 'rgba(248,81,73,0.14)' };
  if (key === 'archived') return { label: 'archived', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' };
  return { label: key || 'discovered', color: '#d29922', bg: 'rgba(210,153,34,0.14)' };
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
    }).then((res) => {
      if (!alive) return;
      if (res.success) setData(res.data);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, [page, search, status, sourceSystem, ingressProtocol, requestType, drift]);

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
  const hasBulkFilter = !!(search || status || sourceSystem || ingressProtocol || requestType || drift);
  const hasBulkUpdate = !!(
    bulkDraft.targetStatus ||
    bulkDraft.modelPolicy ||
    bulkDraft.parameterPolicy ||
    bulkDraft.owner.trim() ||
    bulkDraft.monthlyBudgetUsd.trim() ||
    bulkDraft.budgetReservationUsd.trim() ||
    bulkDraft.rateLimitPerMinute.trim()
  );
  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '9px 12px', fontSize: 12, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };
  const selectStyle: React.CSSProperties = {
    height: 32,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    padding: '0 8px',
    fontSize: 12,
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
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          placeholder="搜索 appCallerCode / title / requestId"
          style={{ ...selectStyle, width: 260 }}
        />
        <FilterSelect label="全部状态" value={status} options={data.statuses} onChange={(v) => { setPage(1); setStatus(v); }} style={selectStyle} />
        <FilterSelect label="全部来源" value={sourceSystem} options={data.sourceSystems} onChange={(v) => { setPage(1); setSourceSystem(v); }} style={selectStyle} />
        <FilterSelect label="全部入口" value={ingressProtocol} options={data.ingressProtocols} onChange={(v) => { setPage(1); setIngressProtocol(v); }} style={selectStyle} />
        <FilterSelect label="全部类型" value={requestType} options={data.requestTypes} onChange={(v) => { setPage(1); setRequestType(v); }} style={selectStyle} />
        <select value={drift} onChange={(e) => { setPage(1); setDrift(e.target.value); }} style={selectStyle}>
          <option value="">全部漂移</option>
          {DRIFT_FILTERS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>共 {data.total} 个</span>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>按当前筛选批量治理</span>
        <select value={bulkDraft.targetStatus} onChange={(e) => setBulkDraft((prev) => ({ ...prev, targetStatus: e.target.value }))} style={{ ...selectStyle, width: 124 }}>
          <option value="">状态不改</option>
          {STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={bulkDraft.modelPolicy} onChange={(e) => setBulkDraft((prev) => ({ ...prev, modelPolicy: e.target.value }))} style={{ ...selectStyle, width: 112 }}>
          <option value="">路由不改</option>
          {MODEL_POLICIES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={bulkDraft.parameterPolicy} onChange={(e) => setBulkDraft((prev) => ({ ...prev, parameterPolicy: e.target.value }))} style={{ ...selectStyle, width: 156 }}>
          <option value="">参数策略不改</option>
          {PARAMETER_POLICIES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <input
          value={bulkDraft.owner}
          onChange={(e) => setBulkDraft((prev) => ({ ...prev, owner: e.target.value }))}
          placeholder="owner"
          style={{ ...selectStyle, width: 120 }}
          aria-label="批量负责人"
        />
        <input
          value={bulkDraft.monthlyBudgetUsd}
          onChange={(e) => setBulkDraft((prev) => ({ ...prev, monthlyBudgetUsd: e.target.value }))}
          placeholder="预算 USD/月"
          inputMode="decimal"
          style={{ ...selectStyle, width: 120 }}
          aria-label="批量月预算 USD"
        />
        <input
          value={bulkDraft.budgetReservationUsd}
          onChange={(e) => setBulkDraft((prev) => ({ ...prev, budgetReservationUsd: e.target.value }))}
          placeholder="单次预占 USD"
          inputMode="decimal"
          style={{ ...selectStyle, width: 112 }}
          aria-label="批量单次预算预占 USD"
        />
        <input
          value={bulkDraft.rateLimitPerMinute}
          onChange={(e) => setBulkDraft((prev) => ({ ...prev, rateLimitPerMinute: e.target.value }))}
          placeholder="RPM"
          inputMode="numeric"
          style={{ ...selectStyle, width: 78 }}
          aria-label="批量每分钟限流"
        />
        <Button size="sm" variant="ghost" disabled={!hasBulkFilter || !hasBulkUpdate || bulkSaving || data.total === 0} onClick={() => void applyBulkGovernance()}>
          {bulkSaving ? '应用中' : '应用'}
        </Button>
        {!hasBulkFilter ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>先选择至少一个筛选条件</span> : null}
      </div>
      {actionError ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: '#f85149', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(248,81,73,0.35)', background: 'rgba(248,81,73,0.08)' }}>
          {actionError}
        </div>
      ) : null}
      {actionNotice ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: '#3fb950', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(63,185,80,0.35)', background: 'rgba(63,185,80,0.08)' }}>
          {actionNotice}
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
            <tr>
              <th style={th}>appCaller</th>
              <th style={th}>状态</th>
              <th style={th}>类型</th>
              <th style={th}>入口</th>
              <th style={th}>来源</th>
              <th style={th}>模型池</th>
              <th style={th}>策略</th>
              <th style={th}>治理</th>
              <th style={th}>最近请求</th>
              <th style={th}>次数</th>
              <th style={th}>最近发现</th>
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
                onDraft={(patch) => patchDraft(item, patch)}
                onSave={() => saveItem(item)}
              />
            ))}
          </tbody>
        </table>
        {data.items.length === 0 ? <EmptyBlock text="没有匹配的 appCaller" /> : null}
      </div>

      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{page} / {pages}</span>
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
  onDraft,
  onSave,
}: {
  item: GatewayAppCaller;
  td: React.CSSProperties;
  pools: ModelPool[];
  draft: Draft;
  selectStyle: React.CSSProperties;
  saving: boolean;
  onDraft: (patch: Partial<Draft>) => void;
  onSave: () => void;
}) {
  const chip = statusChip(item.status);
  const compatiblePools = pools.filter((p) => !item.requestType || p.modelType.toLowerCase() === item.requestType.toLowerCase());
  const observedPolicy = [item.lastObservedModelPolicy, item.lastObservedModelPoolId].filter(Boolean).join(' / ');
  const observedParameter = item.lastObservedParameterPolicy ? `参数 ${item.lastObservedParameterPolicy}` : '';
  const observedIngressProtocols = item.observedIngressProtocols?.length ? item.observedIngressProtocols : (item.ingressProtocol ? [item.ingressProtocol] : []);
  const routeDrift = Boolean(item.lastObservedModelPolicy && item.lastObservedModelPolicy !== item.modelPolicy)
    || Boolean(item.lastObservedModelPoolId && item.lastObservedModelPoolId !== item.modelPoolId);
  const parameterDrift = Boolean(item.lastObservedParameterPolicy && item.lastObservedParameterPolicy !== item.parameterPolicy);
  return (
    <tr>
      <td style={td}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 260 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 650 }}>{item.appCallerCode}</span>
          <span style={{ color: 'var(--text-muted)' }}>{item.title || '—'}</span>
        </div>
      </td>
      <td style={td}><Chip label={chip.label} color={chip.color} bg={chip.bg} /></td>
      <td style={td}>{item.requestType || '—'}</td>
      <td style={td}>
        {observedIngressProtocols.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 220 }}>
            {observedIngressProtocols.map((protocol) => (
              <Chip key={protocol} label={protocol} color="var(--text)" bg="var(--surface-muted)" />
            ))}
          </div>
        ) : '—'}
      </td>
      <td style={td}>{item.sourceSystem || '—'}</td>
      <td style={td}>
        <select value={draft.modelPoolId} onChange={(e) => onDraft({ modelPoolId: e.target.value, modelPolicy: e.target.value ? 'pool' : draft.modelPolicy })} style={{ ...selectStyle, width: 180 }}>
          <option value="">默认 auto</option>
          {compatiblePools.map((p) => <option key={p.id} value={p.id}>{p.name || p.code || p.id}</option>)}
        </select>
      </td>
      <td style={td}>
        <div style={{ display: 'flex', gap: 6 }}>
          <select value={draft.status} onChange={(e) => onDraft({ status: e.target.value })} style={{ ...selectStyle, width: 112 }}>
            {STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={draft.modelPolicy} onChange={(e) => onDraft({ modelPolicy: e.target.value })} style={{ ...selectStyle, width: 92 }}>
            {MODEL_POLICIES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={draft.parameterPolicy} onChange={(e) => onDraft({ parameterPolicy: e.target.value })} style={{ ...selectStyle, width: 142 }}>
            {PARAMETER_POLICIES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        {observedPolicy || observedParameter ? (
          <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)', maxWidth: 360, wordBreak: 'break-word' }}>
            最近请求：{[observedPolicy, observedParameter].filter(Boolean).join('；')}
          </div>
        ) : null}
        {routeDrift || parameterDrift ? (
          <div style={{ marginTop: 5, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {routeDrift ? <Chip label="路由漂移" color="#d29922" bg="rgba(210,153,34,0.14)" /> : null}
            {parameterDrift ? <Chip label="参数漂移" color="#d29922" bg="rgba(210,153,34,0.14)" /> : null}
          </div>
        ) : null}
      </td>
      <td style={td}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 420 }}>
          <input
            value={draft.owner}
            onChange={(e) => onDraft({ owner: e.target.value })}
            placeholder="owner"
            style={{ ...selectStyle, width: 110 }}
            aria-label="负责人"
          />
          <input
            value={draft.monthlyBudgetUsd}
            onChange={(e) => onDraft({ monthlyBudgetUsd: e.target.value })}
            placeholder="预算 USD/月"
            inputMode="decimal"
            style={{ ...selectStyle, width: 112 }}
            aria-label="月预算 USD"
          />
          <input
            value={draft.budgetReservationUsd}
            onChange={(e) => onDraft({ budgetReservationUsd: e.target.value })}
            placeholder="单次预占 USD"
            inputMode="decimal"
            style={{ ...selectStyle, width: 112 }}
            aria-label="单次预算预占 USD"
          />
          <input
            value={draft.rateLimitPerMinute}
            onChange={(e) => onDraft({ rateLimitPerMinute: e.target.value })}
            placeholder="RPM"
            inputMode="numeric"
            style={{ ...selectStyle, width: 78 }}
            aria-label="每分钟限流"
          />
        </div>
      </td>
      <td style={td}>
        <TraceLinks item={item} />
      </td>
      <td style={td}>{item.totalSeen}</td>
      <td style={td}>{fmtTime(item.lastSeenAt)}</td>
      <td style={td}><div style={{ display: 'flex', gap: 5 }}><Button size="sm" variant="ghost" disabled={saving} onClick={onSave}>{saving ? '保存中' : '保存'}</Button>{['chat', 'vision'].includes(item.requestType.toLowerCase()) ? <Link to={`/app-callers/${encodeURIComponent(item.id)}/prompt-policy`} style={{ color: 'var(--accent)', fontSize: 11, alignSelf: 'center' }}>提示词</Link> : null}</div></td>
    </tr>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          style={{
            color: 'var(--accent)',
            fontSize: 11,
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
