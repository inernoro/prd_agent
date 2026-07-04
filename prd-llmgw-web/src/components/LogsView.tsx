// OpenRouter 风格日志主体：顶部柱状图 + 时间范围 + 4 子 tab + 表格 + 详情抽屉。
// 自包含拉数据（走 @/lib/api），数据缺失项「—」。移植自 prd-admin LlmGenerationsView。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, Activity, Clock, GitBranch, Gauge, Layers, Zap } from 'lucide-react';
import { getLogs, getLogsMeta, getLogsTimeseries, getLogsSessions, getLogsSummary } from '@/lib/api';
import type { LlmLogListItem, LogsSummaryData, SessionItem, TimeseriesPoint } from '@/lib/types';
import { Button, Card, Chip, SectionLoader, Spinner, TabBar } from './ui';
import { MiniBarChart } from './MiniBarChart';
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
  computeTokPerSec,
  statusBadgeStyle,
  userLabel,
  deriveLifecycle,
  getProtocolMeta,
} from '@/lib/logsHelpers';

const PAGE_SIZE = 30;

// 网关传输通道（GatewayTransport）chip：这次调用走进程内 / 跨进程 HTTP / 影子 / 直连。
// 是翻 http 前后排障「这条走了哪条路」的关键标记。历史日志为 null → 不显示 chip。
const TRANSPORT_META: Record<string, { label: string; color: string; bg: string }> = {
  inproc: { label: 'inproc', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
  http: { label: 'http', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  shadow: { label: 'shadow', color: '#d29922', bg: 'rgba(210,153,34,0.14)' },
  direct: { label: 'direct', color: '#f85149', bg: 'rgba(248,81,73,0.14)' },
};
function getTransportMeta(t?: string | null) {
  if (!t) return null;
  return TRANSPORT_META[t.toLowerCase()] ?? { label: t, color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' };
}

export function LogsView() {
  const [subtab, setSubtab] = useState<LogsSubTab>('generations');
  const [presetKey, setPresetKey] = useState('30d');
  const [filterModel, setFilterModel] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterProvider, setFilterProvider] = useState('');
  const [filterAppCaller, setFilterAppCaller] = useState('');
  const [filterTransport, setFilterTransport] = useState('');
  const [filterRequestType, setFilterRequestType] = useState('');

  const [meta, setMeta] = useState<{ models: string[]; statuses: string[]; providers: string[]; appCallers: string[]; transports: string[]; requestTypes: string[] }>({
    models: [],
    statuses: [],
    providers: [],
    appCallers: [],
    transports: [],
    requestTypes: [],
  });
  const [metaError, setMetaError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [rows, setRows] = useState<LlmLogListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessTotal, setSessTotal] = useState(0);
  const [sessPage, setSessPage] = useState(1);
  const [sessLoading, setSessLoading] = useState(false);

  const [series, setSeries] = useState<TimeseriesPoint[]>([]);
  const [summary, setSummary] = useState<LogsSummaryData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
    }),
    [range, filterModel, filterStatus, filterProvider, filterAppCaller, filterTransport, filterRequestType],
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
  const seriesSeq = useRef(0);
  const summarySeq = useRef(0);

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

  const loadSeries = useCallback(async () => {
    const seq = ++seriesSeq.current;
    const res = await getLogsTimeseries(baseParams);
    if (seq !== seriesSeq.current) return;
    if (res.success && res.data) setSeries(res.data.items ?? []);
  }, [baseParams]);

  const loadSummary = useCallback(async () => {
    const seq = ++summarySeq.current;
    const res = await getLogsSummary(baseParams);
    if (seq !== summarySeq.current) return;
    if (res.success && res.data) {
      setSummary(res.data);
      setSummaryError(null);
    } else {
      setSummary(null);
      setSummaryError(res.error?.message || '加载汇总失败');
    }
  }, [baseParams]);

  useEffect(() => {
    setPage(1);
    setSessPage(1);
  }, [baseParams]);
  useEffect(() => {
    loadSeries();
  }, [loadSeries]);
  useEffect(() => {
    loadSummary();
  }, [loadSummary]);
  useEffect(() => {
    if (subtab === 'generations' || subtab === 'upstream') loadList(page);
  }, [subtab, page, loadList]);
  useEffect(() => {
    if (subtab === 'sessions') loadSessions(sessPage);
  }, [subtab, sessPage, loadSessions]);

  const refresh = () => {
    loadSeries();
    loadSummary();
    if (subtab === 'sessions') loadSessions(sessPage);
    else loadList(page);
  };

  const totalReq = useMemo(() => series.reduce((a, s) => a + s.count, 0), [series]);

  // ── 单元格渲染 ──
  const renderGenerationCell = (col: ColumnDef, it: LlmLogListItem): ReactNode => {
    switch (col.key) {
      case 'date': {
        const lc = deriveLifecycle(it);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
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
            style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            title={it.requestId || it.id}
          >
            {it.requestId || it.id || DASH}
          </span>
        );
      case 'model': {
        const proto = getProtocolMeta(it.protocol);
        const tp = getTransportMeta(it.transport);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <span className="lg-truncate" style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }} title={it.model}>
              {it.model || DASH}
            </span>
            {proto ? <Chip label={proto.label} color={proto.color} bg={proto.bg} /> : null}
            {tp ? <Chip label={tp.label} color={tp.color} bg={tp.bg} title={`网关传输通道：${tp.label}`} /> : null}
          </span>
        );
      }
      case 'provider':
        return (
          <span className="lg-truncate" style={{ fontSize: 11, color: 'var(--text-secondary)' }} title={it.platformName || it.provider}>
            {it.platformName || it.provider || DASH}
          </span>
        );
      case 'app':
        return (
          <span
            className="lg-truncate"
            style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}
            title={it.appCallerCode || ''}
          >
            {it.appCallerCodeDisplayName || it.appCallerCode || DASH}
          </span>
        );
      case 'input':
        return <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmtCompact(it.inputTokens)}</span>;
      case 'output':
        return <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmtCompact(it.outputTokens)}</span>;
      case 'tokens':
        return (
          <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {it.inputTokens == null && it.outputTokens == null ? DASH : fmtCompact((it.inputTokens ?? 0) + (it.outputTokens ?? 0))}
          </span>
        );
      case 'cost':
        return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{DASH}</span>;
      case 'latency':
        return <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmtMs(it.durationMs)}</span>;
      case 'status': {
        const s = statusBadgeStyle(it.status, it.statusCode);
        return <Chip label={s.label} color={s.color} bg={s.bg} />;
      }
      case 'usage':
        return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.requestType || DASH}</span>;
      case 'speed': {
        const t = computeTokPerSec(it.outputTokens, it.durationMs);
        return <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t == null ? DASH : `${t}`}</span>;
      }
      case 'finish':
        return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.finishReason || DASH}</span>;
      case 'user':
        return (
          <span className="lg-truncate" style={{ fontSize: 11, color: 'var(--text-secondary)' }} title={userLabel(it)}>
            {userLabel(it)}
          </span>
        );
      case 'stream':
        return (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
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
        return <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmtShortTime(it.startedAt)}</span>;
      case 'model':
        return (
          <span className="lg-truncate" style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }} title={it.model}>
            {it.model || DASH}
          </span>
        );
      case 'provider':
        return <span className="lg-truncate" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{it.platformName || it.provider || DASH}</span>;
      case 'genId':
        return (
          <span className="lg-truncate" style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }} title={it.requestId}>
            {it.requestId || DASH}
          </span>
        );
      case 'status': {
        const s = statusBadgeStyle(it.status, it.statusCode);
        return <Chip label={s.label} color={s.color} bg={s.bg} />;
      }
      case 'attempts':
        return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{DASH}</span>;
      case 'fallback':
        return it.isFallback ? (
          <Chip label="已降级" color="#fbbf24" bg="rgba(251,191,36,0.16)" title={it.expectedModel ? `期望 ${it.expectedModel}` : undefined} />
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>否</span>
        );
      case 'latency':
        return <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmtMs(it.durationMs)}</span>;
      default:
        return null;
    }
  };

  const renderSessionCell = (col: ColumnDef, it: SessionItem): ReactNode => {
    switch (col.key) {
      case 'date':
        return (
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {fmtDate(it.start)}
            {it.end && it.end !== it.start ? ` ~ ${fmtShortTime(it.end)}` : ''}
          </span>
        );
      case 'sessionId':
        return (
          <span className="lg-truncate" style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'ui-monospace, monospace' }} title={it.sessionId || ''}>
            {it.sessionId || DASH}
          </span>
        );
      case 'app':
        return (
          <span className="lg-truncate" style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
            {it.appCallerCode || DASH}
          </span>
        );
      case 'primaryModel':
        return <span className="lg-truncate" style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>{it.primaryModel || DASH}</span>;
      case 'primaryProvider':
        return <span className="lg-truncate" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{it.primaryProvider || DASH}</span>;
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
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{DASH}</span>
        );
      case 'requests':
        return <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{it.requestCount}</span>;
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
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: Math.max(980, columns.length * 92) }}>
          <div
            style={{
              display: 'grid',
              gap: 10,
              padding: '9px 12px',
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
                style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0, textAlign: alignOf(c.align), color: 'var(--text-muted)' }}
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
                      gap: 10,
                      minHeight: 42,
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
          padding: '8px 12px',
          fontSize: 11,
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

  const selectStyle: CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    height: 32,
    padding: '0 9px',
    fontSize: 12,
  };

  const emptyCell = (text: string) => (
    <div style={{ padding: '64px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>{text}</div>
  );

  const activeFilterCount = [filterModel, filterStatus, filterProvider, filterAppCaller, filterTransport, filterRequestType].filter(Boolean).length;
  const clearFilters = () => {
    setFilterModel('');
    setFilterStatus('');
    setFilterProvider('');
    setFilterAppCaller('');
    setFilterTransport('');
    setFilterRequestType('');
  };

  function SummaryTile({
    icon,
    label,
    value,
    sub,
  }: {
    icon: ReactNode;
    label: string;
    value: string;
    sub: string;
  }) {
    return (
      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-input)',
          padding: '8px 10px',
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          {icon}
          {label}
        </div>
        <div className="tabular" style={{ marginTop: 5, fontSize: 18, lineHeight: 1.15, fontWeight: 650, color: 'var(--text-primary)' }}>
          {value}
        </div>
        <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text-muted)' }}>{sub}</div>
      </div>
    );
  }

  const primaryTransport = summary?.transportDistribution?.[0];

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Observability</div>
          <div style={{ fontSize: 22, lineHeight: 1.15, fontWeight: 650, color: 'var(--text-primary)' }}>Activity</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>{fmtCompact(summary?.total ?? totalReq)} requests in the selected window</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
            {TIME_RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPresetKey(p.key)}
                style={{
                  padding: '0 10px',
                  height: 32,
                  fontSize: 11,
                  fontWeight: 500,
                  border: 'none',
                  borderLeft: p.key === TIME_RANGE_PRESETS[0].key ? 'none' : '1px solid var(--border-subtle)',
                  background: presetKey === p.key ? 'var(--accent-soft)' : 'transparent',
                  color: presetKey === p.key ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading || sessLoading}>
            {loading || sessLoading ? <Spinner size={14} /> : <RefreshCw size={14} />}
            Refresh
          </Button>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          flexShrink: 0,
          padding: 8,
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius)',
          background: 'var(--bg-surface)',
        }}
      >
          <select value={filterProvider} onChange={(e) => setFilterProvider(e.target.value)} style={selectStyle}>
            <option value="">All providers</option>
            {meta.providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)} style={selectStyle}>
            <option value="">All models</option>
            {meta.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={selectStyle}>
            <option value="">All statuses</option>
            {meta.statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select value={filterAppCaller} onChange={(e) => setFilterAppCaller(e.target.value)} style={selectStyle}>
            <option value="">All apps</option>
            {meta.appCallers.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select value={filterTransport} onChange={(e) => setFilterTransport(e.target.value)} style={selectStyle}>
            <option value="">All transports</option>
            {meta.transports.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select value={filterRequestType} onChange={(e) => setFilterRequestType(e.target.value)} style={selectStyle}>
            <option value="">All types</option>
            {meta.requestTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {activeFilterCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear {activeFilterCount}
            </Button>
          ) : null}
      </div>

      {metaError || listError || summaryError ? (
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
          {metaError || listError || summaryError}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, flexShrink: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(126px, 1fr))', gap: 8 }}>
          <SummaryTile icon={<Activity size={13} />} label="Requests" value={fmtCompact(summary?.total)} sub={`${fmtCompact(summary?.succeeded)} ok · ${fmtCompact(summary?.failed)} failed`} />
          <SummaryTile icon={<Zap size={13} />} label="Tokens" value={fmtCompact(summary?.totalTokens)} sub={`${fmtCompact(summary?.inputTokens)} in · ${fmtCompact(summary?.outputTokens)} out`} />
          <SummaryTile icon={<Clock size={13} />} label="Avg latency" value={fmtMs(summary?.averageDurationMs)} sub="completed requests" />
          <SummaryTile icon={<GitBranch size={13} />} label="Fallbacks" value={fmtCompact(summary?.fallbacks)} sub="fallback requests" />
          <SummaryTile icon={<Layers size={13} />} label="Transport" value={primaryTransport?.key ?? DASH} sub={primaryTransport ? `${fmtCompact(primaryTransport.count)} requests` : 'no marks'} />
          <SummaryTile icon={<Gauge size={13} />} label="Running" value={fmtCompact(summary?.running)} sub={`${fmtCompact(summary?.cancelled)} cancelled`} />
        </div>
        <Card style={{ padding: 8, minHeight: 92, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <MiniBarChart data={series} height={82} />
        </Card>
      </div>

      <TabBar items={LOGS_SUBTABS} activeKey={subtab} onChange={(k) => setSubtab(k)} />

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
                empty={emptyCell('该时间范围内暂无请求')}
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
                empty={emptyCell('该时间范围内暂无请求')}
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
        {subtab === 'jobs' && (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: '64px 24px',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary)' }}>Jobs（批处理任务）</div>
            <div style={{ fontSize: 12, maxWidth: 420, color: 'var(--text-muted)' }}>
              当前网关没有 OpenRouter 意义上的批处理（Batch）任务概念，此处不展示占位假数据。待后端定义批任务后接入。
            </div>
          </div>
        )}
      </Card>

      {selectedId ? <GenerationDetailsDrawer logId={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
