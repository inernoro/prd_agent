// OpenRouter 风格日志主体：紧凑工具栏 + 3 个真实数据视图 + 高密度表格 + 详情抽屉。
// 聚合趋势留在概览与用量页；本页只负责快速定位单次请求。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { RefreshCw, ChevronLeft, ChevronRight, Search, SlidersHorizontal } from 'lucide-react';
import { getLogs, getLogsMeta, getLogsSessions } from '@/lib/api';
import type { LlmLogListItem, SessionItem } from '@/lib/types';
import { Button, Card, Chip, SectionLoader, Spinner, TabBar } from './ui';
import { GenerationDetailsDrawer } from './GenerationDetailsDrawer';
import {
  DASH,
  LOGS_SUBTABS,
  type LogsSubTab,
  TIME_RANGE_PRESETS,
  rangeFromPreset,
  GENERATIONS_COLUMNS,
  UPSTREAM_COLUMNS,
  SESSIONS_COLUMNS,
  type ColumnDef,
  fmtShortTime,
  fmtDate,
  fmtMs,
  fmtCompact,
  fmtCost,
  computeTokPerSec,
  statusBadgeStyle,
  userLabel,
  deriveLifecycle,
  getProtocolMeta,
} from '@/lib/logsHelpers';

const PAGE_SIZE = 30;

// 网关传输通道（GatewayTransport）chip：这次调用走进程内 / 跨进程 HTTP / 影子 / 管理探测 / 直连。
// 是翻 http 前后排障「这条走了哪条路」的关键标记。历史日志为 null → 不显示 chip。
const TRANSPORT_META: Record<string, { label: string; color: string; bg: string }> = {
  inproc: { label: 'inproc', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
  http: { label: 'http', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  shadow: { label: 'shadow', color: '#d29922', bg: 'rgba(210,153,34,0.14)' },
  'admin-probe': { label: 'admin-probe', color: '#6e7681', bg: 'rgba(110,118,129,0.14)' },
  direct: { label: 'direct', color: '#f85149', bg: 'rgba(248,81,73,0.14)' },
};
function getTransportMeta(t?: string | null) {
  if (!t) return null;
  return TRANSPORT_META[t.toLowerCase()] ?? { label: t, color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' };
}

function initialQueryValue(key: string) {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(key) ?? '';
}

function appLabel(item: Pick<LlmLogListItem, 'appCallerCode' | 'appCallerCodeDisplayName' | 'appCallerTitle'>) {
  const code = item.appCallerCode?.trim();
  if (code) return code.startsWith('G-') ? code : `G-${code}`;
  return item.appCallerCodeDisplayName || item.appCallerTitle || DASH;
}

export function LogsView() {
  const location = useLocation();
  const [subtab, setSubtab] = useState<LogsSubTab>('generations');
  const [presetKey, setPresetKey] = useState('30d');
  const [filterModel, setFilterModel] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterProvider, setFilterProvider] = useState('');
  const [filterAppCaller, setFilterAppCaller] = useState('');
  const [filterTransport, setFilterTransport] = useState('');
  const [filterRequestType, setFilterRequestType] = useState('');
  const [filterSourceSystem, setFilterSourceSystem] = useState('');
  const [filterIngressProtocol, setFilterIngressProtocol] = useState('');
  const [filterModelPolicy, setFilterModelPolicy] = useState('');
  const [filterReleaseCommit, setFilterReleaseCommit] = useState(() => initialQueryValue('releaseCommit'));
  const [filterRunId, setFilterRunId] = useState(() => initialQueryValue('runId'));
  const [filterRequestId, setFilterRequestId] = useState(() => initialQueryValue('requestId'));
  const [requestIdDraft, setRequestIdDraft] = useState(() => initialQueryValue('requestId'));
  const [filterSessionId, setFilterSessionId] = useState(() => initialQueryValue('sessionId'));
  const [filterModelPoolId, setFilterModelPoolId] = useState(() => initialQueryValue('modelPoolId'));
  const [filterServiceKeyId, setFilterServiceKeyId] = useState(() => initialQueryValue('serviceKeyId'));
  const [filterClientCode, setFilterClientCode] = useState(() => initialQueryValue('clientCode'));
  const [filterEnvironment, setFilterEnvironment] = useState(() => initialQueryValue('environment'));

  const [meta, setMeta] = useState<{
    models: string[];
    statuses: string[];
    providers: string[];
    appCallers: string[];
    transports: string[];
    requestTypes: string[];
    sourceSystems: string[];
    ingressProtocols: string[];
    modelPolicies: string[];
    serviceKeyIds: string[];
    clientCodes: string[];
    environments: string[];
  }>({
    models: [],
    statuses: [],
    providers: [],
    appCallers: [],
    transports: [],
    requestTypes: [],
    sourceSystems: [],
    ingressProtocols: [],
    modelPolicies: [],
    serviceKeyIds: [],
    clientCodes: [],
    environments: [],
  });
  const [metaError, setMetaError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [rows, setRows] = useState<LlmLogListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessTotal, setSessTotal] = useState(0);
  const [sessPage, setSessPage] = useState(1);
  const [sessLoading, setSessLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showExampleGuide, setShowExampleGuide] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    setFilterSourceSystem(query.get('sourceSystem') ?? '');
    setFilterIngressProtocol(query.get('ingressProtocol') ?? '');
    setFilterModelPolicy(query.get('modelPolicy') ?? '');
    setFilterReleaseCommit(query.get('releaseCommit') ?? '');
    setFilterRunId(query.get('runId') ?? '');
    setFilterRequestId(query.get('requestId') ?? '');
    setRequestIdDraft(query.get('requestId') ?? '');
    setFilterSessionId(query.get('sessionId') ?? '');
    setFilterModelPoolId(query.get('modelPoolId') ?? '');
    setFilterStatus(query.get('status') ?? '');
    setFilterAppCaller(query.get('appCallerCode') ?? '');
    setFilterServiceKeyId(query.get('serviceKeyId') ?? '');
    setFilterClientCode(query.get('clientCode') ?? '');
    setFilterEnvironment(query.get('environment') ?? '');
  }, [location.search]);

  const range = useMemo(() => {
    const p = TIME_RANGE_PRESETS.find((x) => x.key === presetKey) ?? TIME_RANGE_PRESETS[2];
    return rangeFromPreset(p.days);
  }, [presetKey]);

  const baseParams = useMemo(
    () => ({
      from: range.from,
      to: range.to,
      model: filterModel || undefined,
      status: filterStatus || undefined,
      provider: filterProvider || undefined,
      appCallerCode: filterAppCaller || undefined,
      transport: filterTransport || undefined,
      requestType: filterRequestType || undefined,
      sourceSystem: filterSourceSystem || undefined,
      ingressProtocol: filterIngressProtocol || undefined,
      modelPolicy: filterModelPolicy || undefined,
      releaseCommit: filterReleaseCommit.trim() || undefined,
      runId: filterRunId.trim() || undefined,
      requestId: filterRequestId.trim() || undefined,
      sessionId: filterSessionId.trim() || undefined,
      modelPoolId: filterModelPoolId.trim() || undefined,
      serviceKeyId: filterServiceKeyId || undefined,
      clientCode: filterClientCode || undefined,
      environment: filterEnvironment || undefined,
    }),
    [range, filterModel, filterStatus, filterProvider, filterAppCaller, filterTransport, filterRequestType, filterSourceSystem, filterIngressProtocol, filterModelPolicy, filterReleaseCommit, filterRunId, filterRequestId, filterSessionId, filterModelPoolId, filterServiceKeyId, filterClientCode, filterEnvironment],
  );

  useEffect(() => {
    getLogsMeta().then((res) => {
      if (res.success && res.data) {
        setMeta({
          models: res.data.models ?? [],
          statuses: res.data.statuses ?? [],
          providers: res.data.providers ?? [],
          appCallers: res.data.appCallers ?? [],
          transports: res.data.transports ?? [],
          requestTypes: res.data.requestTypes ?? [],
          sourceSystems: res.data.sourceSystems ?? [],
          ingressProtocols: res.data.ingressProtocols ?? [],
          modelPolicies: res.data.modelPolicies ?? [],
          serviceKeyIds: res.data.serviceKeyIds ?? [],
          clientCodes: res.data.clientCodes ?? [],
          environments: res.data.environments ?? [],
        });
        setMetaError(null);
      } else {
        setMetaError(res.error?.message || '加载筛选项失败');
      }
    });
  }, []);

  // 请求序号守卫：切筛选/翻页/tab 时丢弃过期响应，避免乱序覆盖（竞态）。
  const listSeq = useRef(0);
  const sessSeq = useRef(0);
  const openedRequestIdRef = useRef('');

  const loadList = useCallback(
    async (p: number) => {
      const seq = ++listSeq.current;
      setLoading(true);
      const res = await getLogs({ ...baseParams, page: p, pageSize: PAGE_SIZE });
      if (seq !== listSeq.current) return;
      if (res.success && res.data) {
        setRows(res.data.items ?? []);
        setTotal(res.data.total ?? 0);
        setListError(null);
      } else {
        setListError(res.error?.message || '加载日志失败');
      }
      setLoading(false);
    },
    [baseParams],
  );

  const loadSessions = useCallback(
    async (p: number) => {
      const seq = ++sessSeq.current;
      setSessLoading(true);
      const res = await getLogsSessions({ ...baseParams, page: p, pageSize: PAGE_SIZE });
      if (seq !== sessSeq.current) return;
      if (res.success && res.data) {
        setSessions(res.data.items ?? []);
        setSessTotal(res.data.total ?? 0);
        setListError(null);
      } else {
        setListError(res.error?.message || '加载会话失败');
      }
      setSessLoading(false);
    },
    [baseParams],
  );

  useEffect(() => {
    setPage(1);
    setSessPage(1);
  }, [baseParams]);
  useEffect(() => {
    if (subtab === 'generations' || subtab === 'upstream') loadList(page);
  }, [subtab, page, loadList]);
  useEffect(() => {
    if (subtab === 'sessions') loadSessions(sessPage);
  }, [subtab, sessPage, loadSessions]);

  useEffect(() => {
    const requestId = filterRequestId.trim();
    if (!requestId) {
      openedRequestIdRef.current = '';
      return;
    }
    if (loading || openedRequestIdRef.current === requestId) return;
    const matched = rows.find((item) => item.requestId === requestId || item.id === requestId);
    if (!matched) return;
    openedRequestIdRef.current = requestId;
    setSelectedId(matched.id);
  }, [filterRequestId, loading, rows]);

  const refresh = () => {
    if (subtab === 'sessions') loadSessions(sessPage);
    else loadList(page);
  };

  // ── 单元格渲染 ──
  const renderGenerationCell = (col: ColumnDef, it: LlmLogListItem): ReactNode => {
    switch (col.key) {
      case 'date': {
        const lc = deriveLifecycle(it);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            <span
              title={`生命周期：${lc.label}`}
              className={lc.pulse ? 'lg-pulse' : undefined}
              style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, flexShrink: 0, background: lc.color }}
            />
            {fmtShortTime(it.startedAt)}
          </span>
        );
      }
      case 'generation':
        return (
          <span
            className="lg-truncate"
            style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            title={it.requestId || it.id}
          >
            {it.requestId || it.id || DASH}
          </span>
        );
      case 'model': {
        const proto = getProtocolMeta(it.protocol);
        const tp = getTransportMeta(it.transport);
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
            <span className="lg-truncate" style={{ minWidth: 0, flex: 1, fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }} title={it.logicalModelPublicId ? `逻辑模型 ${it.logicalModelPublicId}；实际上游 ${it.model}` : it.model}>
              {it.logicalModelPublicId || it.model || DASH}
            </span>
            {proto ? <Chip label={proto.label} color={proto.color} bg={proto.bg} /> : null}
            {tp ? <Chip label={tp.label} color={tp.color} bg={tp.bg} title={`网关传输通道：${tp.label}`} /> : null}
          </span>
        );
      }
      case 'provider':
        return (
          <span className="lg-truncate" style={{ fontSize: 12, color: 'var(--text-secondary)' }} title={it.platformName || it.provider}>
            {it.platformName || it.provider || DASH}
          </span>
        );
      case 'app':
        return (
          <span className="lg-truncate" style={{ display: 'block', minWidth: 0, fontSize: 12, color: 'var(--text-primary)', fontFamily: 'ui-monospace, monospace' }} title={`应用：${appLabel(it)}；调用身份：${it.clientCode || '历史未标注'}${it.environment ? `；环境：${it.environment}` : ''}`}>
            {appLabel(it)}
          </span>
        );
      case 'input':
        return <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtCompact(it.inputTokens)}</span>;
      case 'output':
        return <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtCompact(it.outputTokens)}</span>;
      case 'tokens':
        return (
          <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {it.inputTokens == null && it.outputTokens == null ? DASH : fmtCompact((it.inputTokens ?? 0) + (it.outputTokens ?? 0))}
          </span>
        );
      case 'cost':
        return <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtCost(it.estimatedCost, it.estimatedCostCurrency)}</span>;
      case 'latency':
        return <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtMs(it.durationMs)}</span>;
      case 'status': {
        const s = statusBadgeStyle(it.status, it.statusCode);
        return <Chip label={s.label} color={s.color} bg={s.bg} />;
      }
      case 'usage':
        return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{it.requestType || DASH}</span>;
      case 'speed': {
        const t = computeTokPerSec(it.outputTokens, it.durationMs);
        return <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t == null ? DASH : `${t}`}</span>;
      }
      case 'finish':
        return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{it.finishReason || DASH}</span>;
      case 'user':
        return (
          <span className="lg-truncate" style={{ fontSize: 12, color: 'var(--text-secondary)' }} title={userLabel(it)}>
            {userLabel(it)}
          </span>
        );
      case 'stream':
        return (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {it.isStreaming == null ? DASH : it.isStreaming ? '流式' : '非流'}
          </span>
        );
      default:
        return null;
    }
  };

  const renderUpstreamCell = (col: ColumnDef, it: LlmLogListItem): ReactNode => {
    switch (col.key) {
      case 'date':
        return <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtShortTime(it.startedAt)}</span>;
      case 'model':
        return (
          <span className="lg-truncate" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }} title={it.logicalModelPublicId ? `逻辑模型 ${it.logicalModelPublicId}；实际上游 ${it.model}` : it.model}>
            {it.logicalModelPublicId || it.model || DASH}
          </span>
        );
      case 'provider':
        return <span className="lg-truncate" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.platformName || it.provider || DASH}</span>;
      case 'genId':
        return (
          <span className="lg-truncate" style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }} title={it.requestId}>
            {it.requestId || DASH}
          </span>
        );
      case 'status': {
        const s = statusBadgeStyle(it.status, it.statusCode);
        return <Chip label={s.label} color={s.color} bg={s.bg} />;
      }
      case 'attempts':
        return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{DASH}</span>;
      case 'fallback':
        return it.isFallback ? (
          <Chip label="已降级" color="#fbbf24" bg="rgba(251,191,36,0.16)" title={it.expectedModel ? `期望 ${it.expectedModel}` : undefined} />
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>否</span>
        );
      case 'latency':
        return <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtMs(it.durationMs)}</span>;
      default:
        return null;
    }
  };

  const renderSessionCell = (col: ColumnDef, it: SessionItem): ReactNode => {
    switch (col.key) {
      case 'date':
        return (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {fmtDate(it.start)}
            {it.end && it.end !== it.start ? ` ~ ${fmtShortTime(it.end)}` : ''}
          </span>
        );
      case 'sessionId':
        return (
          <span className="lg-truncate" style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'ui-monospace, monospace' }} title={it.sessionId || ''}>
            {it.sessionId || DASH}
          </span>
        );
      case 'app':
        return (
          <span className="lg-truncate" style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
            {it.appCallerCode || DASH}
          </span>
        );
      case 'primaryModel':
        return <span className="lg-truncate" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{it.primaryModel || DASH}</span>;
      case 'primaryProvider':
        return <span className="lg-truncate" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.primaryProvider || DASH}</span>;
      case 'supporting':
        return it.supportingModels.length ? (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {it.supportingModels.slice(0, 3).map((m) => (
              <Chip key={m} label={m} color="var(--text-secondary)" bg="rgba(148,163,184,0.14)" />
            ))}
            {it.supportingModels.length > 3 ? (
              <Chip label={`+${it.supportingModels.length - 3}`} color="var(--text-muted)" bg="rgba(148,163,184,0.1)" />
            ) : null}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{DASH}</span>
        );
      case 'requests':
        return <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.requestCount}</span>;
      default:
        return null;
    }
  };

  // ── 表格渲染器 ──
  function Table<T>({
    columns,
    items,
    rowKey,
    onRow,
    render,
    empty,
  }: {
    columns: ColumnDef[];
    items: T[];
    rowKey: (t: T, idx: number) => string;
    onRow?: (t: T) => void;
    render: (col: ColumnDef, t: T) => ReactNode;
    empty: ReactNode;
  }) {
    const gridCols = columns.map((c) => c.width).join(' ');
    const alignOf = (a?: ColumnDef['align']): CSSProperties['textAlign'] => (a === 'right' ? 'right' : a === 'center' ? 'center' : 'left');
    return (
      <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overscrollBehavior: 'contain' }}>
        <div className="lg-log-table" style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: Math.max(980, columns.length * 92) }}>
          <div
            style={{
              display: 'grid',
              gap: 8,
              minHeight: 34,
              padding: '8px 12px',
              flexShrink: 0,
              gridTemplateColumns: gridCols,
              borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
            }}
          >
            {columns.map((c) => (
              <div
                key={c.key}
                title={c.tip}
                style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0, textAlign: alignOf(c.align), color: 'var(--text-muted)' }}
              >
                {c.label}
                {c.tip ? <span style={{ opacity: 0.6 }}> (i)</span> : null}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {items.length === 0
              ? empty
              : items.map((t, idx) => (
                  <div
                    key={rowKey(t, idx)}
                    onClick={onRow ? () => onRow(t) : undefined}
                    className={onRow ? 'lg-row-clickable' : undefined}
                    style={{
                      display: 'grid',
                      gap: 8,
                      minHeight: 38,
                      padding: '7px 12px',
                      alignItems: 'center',
                      cursor: onRow ? 'pointer' : 'default',
                      gridTemplateColumns: gridCols,
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    {columns.map((c) => (
                      <div key={c.key} style={{ minWidth: 0, textAlign: alignOf(c.align) }}>
                        {render(c, t)}
                      </div>
                    ))}
                  </div>
                ))}
          </div>
        </div>
      </div>
    );
  }

  const Pager = ({ p, setP, tot, busy }: { p: number; setP: (n: number) => void; tot: number; busy: boolean }) => {
    const pages = Math.max(1, Math.ceil(tot / PAGE_SIZE));
    return (
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '5px 10px',
          fontSize: 12,
          color: 'var(--text-muted)',
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        <span>
          共 {tot} 条 · 第 {p}/{pages} 页
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Button variant="ghost" size="sm" disabled={busy || p <= 1} onClick={() => setP(p - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <Button variant="ghost" size="sm" disabled={busy || p >= pages} onClick={() => setP(p + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    );
  };

  const emptyCell = (text: string, showActions = false) => (
    <div className="lg-log-empty">
      <strong>{text}</strong>
      <span>{activeFilterCount > 0 ? '当前筛选条件没有匹配记录，可清除筛选后重试。' : '当当前租户使用接入密钥或平台内部身份调用 Gateway 后，请求会记录在这里。'}</span>
      {showActions ? <div><Link className="lg-primary-link" to="/quickstart">去快速接入</Link><button className="lg-secondary-action" type="button" onClick={() => setShowExampleGuide(true)}>查看示例说明</button>{activeFilterCount > 0 ? <button className="lg-secondary-action" type="button" onClick={clearFilters}>清除筛选</button> : null}</div> : null}
    </div>
  );

  const activeFilterCount = [
    filterModel,
    filterStatus,
    filterProvider,
    filterAppCaller,
    filterTransport,
    filterRequestType,
    filterSourceSystem,
    filterIngressProtocol,
    filterModelPolicy,
    filterReleaseCommit.trim(),
    filterRunId.trim(),
    filterRequestId.trim(),
    filterSessionId.trim(),
    filterModelPoolId.trim(),
    filterServiceKeyId,
    filterClientCode,
    filterEnvironment,
  ].filter(Boolean).length;
  const clearFilters = () => {
    setFilterModel('');
    setFilterStatus('');
    setFilterProvider('');
    setFilterAppCaller('');
    setFilterTransport('');
    setFilterRequestType('');
    setFilterSourceSystem('');
    setFilterIngressProtocol('');
    setFilterModelPolicy('');
    setFilterReleaseCommit('');
    setFilterRunId('');
    setFilterRequestId('');
    setRequestIdDraft('');
    setFilterSessionId('');
    setFilterModelPoolId('');
    setFilterServiceKeyId('');
    setFilterClientCode('');
    setFilterEnvironment('');
  };
  const advancedFilterCount = [
    filterAppCaller,
    filterTransport,
    filterRequestType,
    filterSourceSystem,
    filterIngressProtocol,
    filterModelPolicy,
    filterReleaseCommit.trim(),
    filterRunId.trim(),
    filterSessionId.trim(),
    filterModelPoolId.trim(),
    filterServiceKeyId,
    filterClientCode,
    filterEnvironment,
  ].filter(Boolean).length;

  return (
    <div className="lg-logs-view" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <header className="lg-logs-heading">
        <div>
          <h1>Logs</h1>
          <p>逐条查看模型、Provider、Token、费用与耗时。</p>
        </div>
        <span className="tabular">{subtab === 'sessions' ? sessTotal : total} 条</span>
      </header>

      <TabBar items={LOGS_SUBTABS} activeKey={subtab} onChange={(k) => setSubtab(k)} />

      <div className="lg-log-toolbar">
        <form
          className="lg-log-search"
          onSubmit={(event) => {
            event.preventDefault();
            setFilterRequestId(requestIdDraft.trim());
          }}
        >
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="按请求 ID 查找"
            value={requestIdDraft}
            onChange={(event) => setRequestIdDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setRequestIdDraft('');
                setFilterRequestId('');
              }
            }}
            placeholder="查找 requestId"
            spellCheck={false}
          />
          <button type="submit">查找</button>
        </form>
        <select aria-label="状态" value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}>
          <option value="">全部状态</option>
          {meta.statuses.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="模型" value={filterModel} onChange={(event) => setFilterModel(event.target.value)}>
          <option value="">全部模型</option>
          {meta.models.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="Provider" value={filterProvider} onChange={(event) => setFilterProvider(event.target.value)}>
          <option value="">全部 Provider</option>
          {meta.providers.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="时间范围" value={presetKey} onChange={(event) => setPresetKey(event.target.value)}>
          {TIME_RANGE_PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
        </select>
        {activeFilterCount > 0 ? <button className="lg-log-clear" type="button" onClick={clearFilters}>清除 {activeFilterCount}</button> : null}
        <Button variant="ghost" size="sm" aria-label="刷新日志" title="刷新日志" onClick={refresh} disabled={loading || sessLoading}>
          {loading || sessLoading ? <Spinner size={14} /> : <RefreshCw size={14} />}
        </Button>
      </div>

      <details className="lg-log-filters">
        <summary><SlidersHorizontal size={13} aria-hidden="true" />更多筛选{advancedFilterCount > 0 ? ` ${advancedFilterCount}` : ''}</summary>
        <div>
          <select aria-label="调用方" value={filterClientCode} onChange={(event) => setFilterClientCode(event.target.value)}>
            <option value="">全部调用方</option>
            {meta.clientCodes.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="环境" value={filterEnvironment} onChange={(event) => setFilterEnvironment(event.target.value)}>
            <option value="">全部环境</option>
            {meta.environments.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="接入密钥" value={filterServiceKeyId} onChange={(event) => setFilterServiceKeyId(event.target.value)}>
            <option value="">全部接入密钥</option>
            {meta.serviceKeyIds.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="来源系统" value={filterSourceSystem} onChange={(event) => setFilterSourceSystem(event.target.value)}>
            <option value="">全部来源系统</option>
            {meta.sourceSystems.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="入口协议" value={filterIngressProtocol} onChange={(event) => setFilterIngressProtocol(event.target.value)}>
            <option value="">全部入口协议</option>
            {meta.ingressProtocols.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="路由策略" value={filterModelPolicy} onChange={(event) => setFilterModelPolicy(event.target.value)}>
            <option value="">全部路由策略</option>
            {meta.modelPolicies.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <input aria-label="发布提交" value={filterReleaseCommit} onChange={(event) => setFilterReleaseCommit(event.target.value)} placeholder="发布提交" spellCheck={false} />
          <input aria-label="运行 ID" value={filterRunId} onChange={(event) => setFilterRunId(event.target.value)} placeholder="运行 ID" spellCheck={false} />
          <input aria-label="会话 ID" value={filterSessionId} onChange={(event) => setFilterSessionId(event.target.value)} placeholder="会话 ID" spellCheck={false} />
          <input aria-label="模型池 ID" value={filterModelPoolId} onChange={(event) => setFilterModelPoolId(event.target.value)} placeholder="模型池 ID" spellCheck={false} />
          <select aria-label="应用" value={filterAppCaller} onChange={(event) => setFilterAppCaller(event.target.value)}>
            <option value="">全部应用</option>
            {meta.appCallers.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="传输方式" value={filterTransport} onChange={(event) => setFilterTransport(event.target.value)}>
            <option value="">全部传输方式</option>
            {meta.transports.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="请求类型" value={filterRequestType} onChange={(event) => setFilterRequestType(event.target.value)}>
            <option value="">全部请求类型</option>
            {meta.requestTypes.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
      </details>

      {metaError || listError ? (
        <div
          style={{
            flexShrink: 0,
            fontSize: 12,
            color: 'var(--err)',
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid rgba(248,113,113,0.35)',
            background: 'var(--err-bg)',
          }}
        >
          {metaError || listError}
        </div>
      ) : null}

      <Card style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        {subtab === 'generations' && (
          <>
            {loading && rows.length === 0 ? (
              <SectionLoader text="正在加载…" />
            ) : (
              <Table
                columns={GENERATIONS_COLUMNS}
                items={rows}
                rowKey={(it) => it.id}
                onRow={(it) => setSelectedId(it.id)}
                render={renderGenerationCell}
                empty={emptyCell('该时间范围内还没有请求记录', true)}
              />
            )}
            <Pager p={page} setP={setPage} tot={total} busy={loading} />
          </>
        )}
        {subtab === 'upstream' && (
          <>
            {loading && rows.length === 0 ? (
              <SectionLoader text="正在加载…" />
            ) : (
              <Table
                columns={UPSTREAM_COLUMNS}
                items={rows}
                rowKey={(it) => it.id}
                onRow={(it) => setSelectedId(it.id)}
                render={renderUpstreamCell}
                empty={emptyCell('该时间范围内还没有上游调用记录', true)}
              />
            )}
            <Pager p={page} setP={setPage} tot={total} busy={loading} />
          </>
        )}
        {subtab === 'sessions' && (
          <>
            {sessLoading && sessions.length === 0 ? (
              <SectionLoader text="正在聚合会话…" />
            ) : (
              <Table
                columns={SESSIONS_COLUMNS}
                items={sessions}
                rowKey={(it, idx) => it.sessionId || String(idx)}
                render={renderSessionCell}
                empty={emptyCell('该时间范围内暂无带会话 ID 的请求')}
              />
            )}
            <Pager p={sessPage} setP={setSessPage} tot={sessTotal} busy={sessLoading} />
          </>
        )}
      </Card>

      {showExampleGuide ? <div className="lg-example-guide" role="dialog" aria-modal="true" aria-label="请求记录示例说明"><button className="lg-example-backdrop" type="button" aria-label="关闭示例说明" onClick={() => setShowExampleGuide(false)} /><Card><div className="lg-section-heading"><div><div className="lg-card-kicker">示例说明</div><h2>一条请求记录能回答什么</h2></div><button className="lg-secondary-action" type="button" onClick={() => setShowExampleGuide(false)}>关闭</button></div><div className="lg-example-fields"><div><strong>请求 ID</strong><span>用于从客户端错误定位到这一条调用。</span></div><div><strong>应用与模型</strong><span>说明谁发起请求，以及平台最终选择了哪个模型。</span></div><div><strong>状态与耗时</strong><span>判断调用是否成功、失败发生在哪里、响应用了多久。</span></div><div><strong>Token 与费用</strong><span>有完整价格快照时显示估算；缺价格保持未知，不显示为 0。</span></div></div><p>这只是字段说明，不会在当前租户中写入或伪造示例数据。</p></Card></div> : null}

      {selectedId ? <GenerationDetailsDrawer logId={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
