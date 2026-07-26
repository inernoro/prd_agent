// OpenRouter 风格日志主体：同一字号体系、可比较的完整列、3 个真实数据视图和独立详情页。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { RefreshCw, ChevronLeft, ChevronRight, Search, SlidersHorizontal } from 'lucide-react';
import { getLogs, getLogsMeta, getLogsSessions, getLogsSummary, getLogsTimeseries } from '@/lib/api';
import type { LlmLogListItem, LogsSummaryData, SessionItem, TimeseriesPoint } from '@/lib/types';
import { Button, Card, Chip, SectionLoader, Spinner, TabBar } from './ui';
import { MiniBarChart } from './MiniBarChart';
import { GenerationDetailsDrawer } from './GenerationDetailsDrawer';
import { AppEntityIcon, ModelEntityIcon, ProviderEntityIcon } from './LogEntityIcon';
import { LogEntityHoverCard } from './LogEntityHoverCard';
import { LogTableSettings } from './LogTableSettings';
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
  type LogTablePreferences,
  defaultLogTablePreferences,
  normalizeLogTablePreferences,
  resolveLogTableColumns,
  LOG_TABLE_DENSITIES,
  fmtShortTime,
  fmtDate,
  fmtMs,
  fmtCompact,
  fmtCost,
  statusBadgeStyle,
  userLabel,
  deriveLifecycle,
  getProtocolMeta,
} from '@/lib/logsHelpers';

const PAGE_SIZE = 30;
const TABLE_PREFERENCES_KEY = 'llmgw.logs.table-preferences.v3';
const NARROW_TABLE_MIN_WIDTH: Record<LogsSubTab, number> = {
  generations: 1832,
  upstream: 980,
  sessions: 1080,
};

function initialTablePreferences(): Record<LogsSubTab, LogTablePreferences> {
  const defaults = {
    generations: defaultLogTablePreferences(GENERATIONS_COLUMNS),
    upstream: defaultLogTablePreferences(UPSTREAM_COLUMNS),
    sessions: defaultLogTablePreferences(SESSIONS_COLUMNS),
  };
  if (typeof window === 'undefined') return defaults;
  try {
    const saved = JSON.parse(window.localStorage.getItem(TABLE_PREFERENCES_KEY) || '{}') as Partial<Record<LogsSubTab, LogTablePreferences>>;
    return {
      generations: normalizeLogTablePreferences(GENERATIONS_COLUMNS, saved.generations),
      upstream: normalizeLogTablePreferences(UPSTREAM_COLUMNS, saved.upstream),
      sessions: normalizeLogTablePreferences(SESSIONS_COLUMNS, saved.sessions),
    };
  } catch {
    return defaults;
  }
}

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

function isImageGeneration(item: LlmLogListItem) {
  const requestType = item.requestType?.toLowerCase() ?? '';
  const model = item.model?.toLowerCase() ?? '';
  return requestType === 'generation'
    || requestType === 'image'
    || requestType === 'image-gen'
    || /(image|imagen|dall-e|banana|flux|sdxl)/.test(model);
}

function formatInputUsage(item: LlmLogListItem) {
  if (item.inputTokens != null) return `${fmtCompact(item.inputTokens)} tok`;
  return DASH;
}

function formatOutputUsage(item: LlmLogListItem) {
  if (isImageGeneration(item) && item.imageSuccessCount != null)
    return `${item.imageSuccessCount} ${item.imageSuccessCount === 1 ? 'image' : 'images'}`;
  if (item.outputTokens != null) return `${fmtCompact(item.outputTokens)} tok`;
  return DASH;
}

function formatRecordedCost(it: LlmLogListItem) {
  if (it.providerReportedCost != null)
    return fmtCost(it.providerReportedCost, it.providerCostCurrency || 'USD');
  if (it.estimatedCost != null)
    return fmtCost(it.estimatedCost, it.estimatedCostCurrency);
  return '未计价';
}

function formatThroughput(item: LlmLogListItem) {
  if (isImageGeneration(item) && item.imageSuccessCount != null && item.imageSuccessCount > 0 && item.durationMs && item.durationMs > 0) {
    const secondsPerImage = Math.round((item.durationMs / item.imageSuccessCount) / 100) / 10;
    return `${secondsPerImage}s/image`;
  }
  if (item.outputTokens != null && item.durationMs && item.durationMs > 0) {
    const tokensPerSecond = Math.round((item.outputTokens / item.durationMs) * 1000 * 10) / 10;
    return `${tokensPerSecond} tok/s`;
  }
  return DASH;
}

function initialQueryValue(key: string) {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(key) ?? '';
}

function appLabel(item: Pick<LlmLogListItem, 'appCallerCode' | 'appCallerCodeDisplayName' | 'appCallerTitle'>) {
  const displayName = item.appCallerCodeDisplayName?.trim() || item.appCallerTitle?.trim();
  if (displayName) return displayName;
  const code = item.appCallerCode?.trim();
  if (code) return code.startsWith('G-') ? code : `G-${code}`;
  return DASH;
}

function modelDetailsHref(item: Pick<LlmLogListItem, 'logicalModelId' | 'logicalModelPublicId' | 'model' | 'platformId'>) {
  const query = new URLSearchParams();
  if (item.logicalModelId) query.set('logicalModelId', item.logicalModelId);
  if (item.logicalModelPublicId || item.model) query.set('model', item.logicalModelPublicId || item.model);
  if (item.platformId) query.set('platformId', item.platformId);
  return `/models/view?${query.toString()}`;
}

function isExchangeProvider(item: Pick<LlmLogListItem, 'platformName' | 'provider'>) {
  return /^exchange\s*:/i.test((item.platformName || item.provider || '').trim());
}

function providerDetailsHref(item: Pick<LlmLogListItem, 'platformId' | 'platformName' | 'provider'>) {
  const query = new URLSearchParams();
  if (isExchangeProvider(item)) {
    if (item.platformId) query.set('exchangeId', item.platformId);
    if (item.platformName || item.provider) query.set('name', item.platformName || item.provider);
    return `/exchanges?${query.toString()}`;
  }
  if (item.platformId) query.set('id', item.platformId);
  if (item.platformName || item.provider) query.set('name', item.platformName || item.provider);
  return `/platforms/view?${query.toString()}`;
}

function appDetailsHref(code: string) {
  return `/app-callers/view?code=${encodeURIComponent(code.replace(/^G-/, ''))}`;
}

export function LogsView() {
  const location = useLocation();
  const navigate = useNavigate();
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
  const [summary, setSummary] = useState<LogsSummaryData | null>(null);
  const [series, setSeries] = useState<TimeseriesPoint[]>([]);

  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [tablePreferences, setTablePreferences] = useState(initialTablePreferences);
  const [settingsOpen, setSettingsOpen] = useState<LogsSubTab | null>(null);
  const [settingsTab, setSettingsTab] = useState<'columns' | 'density'>('columns');
  const [showExampleGuide, setShowExampleGuide] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 680px)').matches
  ));

  useEffect(() => {
    const media = window.matchMedia('(max-width: 680px)');
    const update = () => setIsNarrowViewport(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(TABLE_PREFERENCES_KEY, JSON.stringify(tablePreferences));
  }, [tablePreferences]);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    setSelectedLogId(query.get('transaction'));
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

  const openLogDetail = useCallback((id: string) => {
    const query = new URLSearchParams(location.search);
    query.set('transaction', id);
    navigate({ pathname: location.pathname, search: `?${query.toString()}` });
  }, [location.pathname, location.search, navigate]);

  const closeLogDetail = useCallback(() => {
    const query = new URLSearchParams(location.search);
    query.delete('transaction');
    navigate({ pathname: location.pathname, search: query.size ? `?${query.toString()}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

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
  const insightSeq = useRef(0);
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

  const loadInsights = useCallback(async () => {
    const seq = ++insightSeq.current;
    const [summaryResult, seriesResult] = await Promise.all([
      getLogsSummary(baseParams),
      getLogsTimeseries(baseParams),
    ]);
    if (seq !== insightSeq.current) return;
    setSummary(summaryResult.success && summaryResult.data ? summaryResult.data : null);
    setSeries(seriesResult.success && seriesResult.data ? seriesResult.data.items ?? [] : []);
  }, [baseParams]);

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
    void loadInsights();
  }, [loadInsights]);

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
    openLogDetail(matched.id);
  }, [filterRequestId, loading, openLogDetail, rows]);

  const refresh = () => {
    void loadInsights();
    if (subtab === 'sessions') loadSessions(sessPage);
    else loadList(page);
  };

  // ── 单元格渲染 ──
  const renderGenerationCell = (col: ColumnDef, it: LlmLogListItem): ReactNode => {
    switch (col.key) {
      case 'date': {
        const lc = deriveLifecycle(it);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--log-text-muted)', whiteSpace: 'nowrap' }}>
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
            style={{ fontSize: 13, color: 'var(--log-text-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            title={it.requestId || it.id}
          >
            {it.requestId || it.id || DASH}
          </span>
        );
      case 'model': {
        const proto = getProtocolMeta(it.protocol);
        const tp = getTransportMeta(it.transport);
        const modelName = it.logicalModelPublicId || it.model || DASH;
        return (
          <LogEntityHoverCard
            href={modelDetailsHref(it)}
            label={modelName}
            subtitle={[it.logicalModelPublicId ? '逻辑模型' : '上游模型', proto?.label, tp?.label].filter(Boolean).join(' · ')}
            description={it.logicalModelPublicId && it.model !== it.logicalModelPublicId
              ? `本次请求解析到上游模型 ${it.model}。进入详情可查看 Provider、能力、价格、路由与最近请求。`
              : '进入详情可查看 Provider、能力、价格、路由与最近请求。'}
            actionLabel="查看模型"
            icon={<ModelEntityIcon model={modelName} size="lg" />}
          >
            <span className="lg-log-entity" title={[it.logicalModelPublicId ? `实际上游 ${it.model}` : null, proto ? `协议 ${proto.label}` : null, tp ? `传输 ${tp.label}` : null].filter(Boolean).join('；')}>
              <ModelEntityIcon model={modelName} />
              <span className="lg-truncate lg-log-model-name">{modelName}</span>
            </span>
          </LogEntityHoverCard>
        );
      }
      case 'provider': {
        const providerName = it.platformName || it.provider || DASH;
        const exchangeProvider = isExchangeProvider(it);
        return (
          <LogEntityHoverCard
            href={providerDetailsHref(it)}
            label={providerName}
            subtitle={[exchangeProvider ? 'Exchange' : it.protocol || 'Provider', it.transport].filter(Boolean).join(' · ')}
            description={exchangeProvider
              ? '进入详情可查看 adapter、目标接口、认证边界与模型映射；不会显示密钥明文，也不会试连上游。'
              : '进入详情可查看连接方式、托管模型、并发与最近请求；不会显示密钥明文。'}
            actionLabel={exchangeProvider ? '查看 Exchange' : '查看 Provider'}
            icon={<ProviderEntityIcon provider={providerName} size="lg" />}
          >
            <span className="lg-log-entity" title={providerName}>
              <ProviderEntityIcon provider={providerName} />
              <span className="lg-truncate">{providerName}</span>
            </span>
          </LogEntityHoverCard>
        );
      }
      case 'app': {
        const title = `应用：${appLabel(it)}；调用身份：${it.clientCode || '历史未标注'}${it.environment ? `；环境：${it.environment}` : ''}`;
        const code = it.appCallerCode?.trim();
        if (!code) {
          return <span className="lg-log-entity" title={title}><AppEntityIcon app={appLabel(it)} sourceSystem={it.sourceSystem} /><span className="lg-truncate">{appLabel(it)}</span></span>;
        }
        return (
          <LogEntityHoverCard
            href={appDetailsHref(code)}
            label={appLabel(it)}
            subtitle={[code.startsWith('G-') ? code : `G-${code}`, it.sourceSystem || 'App', it.environment].filter(Boolean).join(' · ')}
            description={it.clientCode
              ? `调用身份 ${it.clientCode}。进入详情可查看模型路由、预算、速率治理与最近请求。`
              : '进入详情可查看调用身份、模型路由、预算、速率治理与最近请求。'}
            actionLabel="查看 App"
            icon={<AppEntityIcon app={appLabel(it)} sourceSystem={it.sourceSystem} size="lg" />}
          >
            <span className="lg-log-entity" title={title}>
              <AppEntityIcon app={appLabel(it)} sourceSystem={it.sourceSystem} />
              <span className="lg-truncate">{appLabel(it)}</span>
            </span>
          </LogEntityHoverCard>
        );
      }
      case 'input':
        return <span className="tabular" style={{ color: 'var(--log-text-muted)' }}>{formatInputUsage(it)}</span>;
      case 'output':
        return <span className="tabular" style={{ color: 'var(--log-text-muted)' }}>{formatOutputUsage(it)}</span>;
      case 'tokens':
        return (
          <span className="tabular" style={{ color: 'var(--log-text-muted)' }}>
            {it.inputTokens == null && it.outputTokens == null ? DASH : fmtCompact((it.inputTokens ?? 0) + (it.outputTokens ?? 0))}
          </span>
        );
      case 'cost':
        return (
          <span
            className="tabular"
            style={{ color: 'var(--log-text-muted)' }}
            title={it.providerReportedCost == null && it.estimatedCost == null ? '上游未返回费用，且当前模型尚未配置计价规则' : undefined}
          >
            {formatRecordedCost(it)}
          </span>
        );
      case 'latency':
        return <span className="tabular" style={{ color: 'var(--log-text-muted)' }}>{fmtMs(it.durationMs)}</span>;
      case 'status': {
        const s = statusBadgeStyle(it.status, it.statusCode);
        return <Chip label={s.label} color={s.color} bg={s.bg} />;
      }
      case 'usage':
        return <span style={{ color: 'var(--log-text-muted)' }}>{it.requestType || DASH}</span>;
      case 'speed': {
        return <span className="tabular" style={{ color: 'var(--log-text-muted)' }}>{formatThroughput(it)}</span>;
      }
      case 'finish':
        return <span style={{ color: 'var(--log-text-muted)' }}>{it.finishReason || DASH}</span>;
      case 'user':
        return (
          <span className="lg-truncate" style={{ color: 'var(--log-text-muted)' }} title={userLabel(it)}>
            {userLabel(it)}
          </span>
        );
      case 'stream':
        return (
          <span style={{ color: 'var(--log-text-muted)' }}>
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
        return <span style={{ fontSize: 14, color: 'var(--log-text-muted)' }}>{fmtShortTime(it.startedAt)}</span>;
      case 'model':
        return (
          <LogEntityHoverCard
            href={modelDetailsHref(it)}
            label={it.logicalModelPublicId || it.model || DASH}
            subtitle={[it.logicalModelPublicId ? '逻辑模型' : '上游模型', it.protocol].filter(Boolean).join(' · ')}
            description="进入详情可查看该模型的能力、Provider、路由和最近请求。"
            actionLabel="查看模型"
            icon={<ModelEntityIcon model={it.logicalModelPublicId || it.model} size="lg" />}
          >
            <span className="lg-log-entity" title={it.logicalModelPublicId ? `逻辑模型 ${it.logicalModelPublicId}；实际上游 ${it.model}` : it.model}>
              <ModelEntityIcon model={it.logicalModelPublicId || it.model} />
              <span className="lg-truncate lg-log-model-name">{it.logicalModelPublicId || it.model || DASH}</span>
            </span>
          </LogEntityHoverCard>
        );
      case 'provider': {
        const providerName = it.platformName || it.provider || DASH;
        const exchangeProvider = isExchangeProvider(it);
        return (
          <LogEntityHoverCard
            href={providerDetailsHref(it)}
            label={providerName}
            subtitle={[exchangeProvider ? 'Exchange' : it.protocol || 'Provider', it.transport].filter(Boolean).join(' · ')}
            description={exchangeProvider
              ? '进入详情可查看 adapter、目标接口、认证边界与模型映射。'
              : '进入详情可查看连接方式、托管模型、并发与最近请求。'}
            actionLabel={exchangeProvider ? '查看 Exchange' : '查看 Provider'}
            icon={<ProviderEntityIcon provider={providerName} size="lg" />}
          >
            <span className="lg-log-entity"><ProviderEntityIcon provider={providerName} /><span className="lg-truncate">{providerName}</span></span>
          </LogEntityHoverCard>
        );
      }
      case 'genId':
        return (
          <span className="lg-truncate" style={{ fontSize: 13, color: 'var(--log-text-muted)', fontFamily: 'ui-monospace, monospace' }} title={it.requestId}>
            {it.requestId || DASH}
          </span>
        );
      case 'status': {
        const s = statusBadgeStyle(it.status, it.statusCode);
        return <Chip label={s.label} color={s.color} bg={s.bg} />;
      }
      case 'attempts':
        return <span style={{ fontSize: 14, color: 'var(--log-text-muted)' }}>{DASH}</span>;
      case 'fallback':
        return it.isFallback ? (
          <Chip label="已降级" color="#fbbf24" bg="rgba(251,191,36,0.16)" title={it.expectedModel ? `期望 ${it.expectedModel}` : undefined} />
        ) : (
          <span style={{ fontSize: 14, color: 'var(--log-text-muted)' }}>否</span>
        );
      case 'latency':
        return <span className="tabular" style={{ fontSize: 14, color: 'var(--log-text-muted)' }}>{fmtMs(it.durationMs)}</span>;
      default:
        return null;
    }
  };

  const renderSessionCell = (col: ColumnDef, it: SessionItem): ReactNode => {
    switch (col.key) {
      case 'date':
        return (
          <span style={{ fontSize: 14, color: 'var(--log-text-muted)' }}>
            {fmtDate(it.start)}
            {it.end && it.end !== it.start ? ` ~ ${fmtShortTime(it.end)}` : ''}
          </span>
        );
      case 'sessionId':
        return (
          <span className="lg-truncate" style={{ fontSize: 13, color: 'var(--log-text-muted)', fontFamily: 'ui-monospace, monospace' }} title={it.sessionId || ''}>
            {it.sessionId || DASH}
          </span>
        );
      case 'app':
        return it.appCallerCode ? (
          <LogEntityHoverCard
            href={appDetailsHref(it.appCallerCode)}
            label={it.appCallerCode.startsWith('G-') ? it.appCallerCode : `G-${it.appCallerCode}`}
            subtitle="会话调用 App"
            description="进入详情可查看调用身份、路由、治理和该 App 的最近请求。"
            actionLabel="查看 App"
            icon={<AppEntityIcon app={it.appCallerCode} size="lg" />}
          >
            <span className="lg-log-entity"><AppEntityIcon app={it.appCallerCode} /><span className="lg-truncate">{it.appCallerCode}</span></span>
          </LogEntityHoverCard>
        ) : <span className="lg-log-app-label">{DASH}</span>;
      case 'primaryModel':
        return it.primaryModel ? (
          <LogEntityHoverCard
            href={`/models/view?model=${encodeURIComponent(it.primaryModel)}`}
            label={it.primaryModel}
            subtitle="会话主要模型"
            description="进入详情可查看该模型的能力、Provider、路由和最近请求。"
            actionLabel="查看模型"
            icon={<ModelEntityIcon model={it.primaryModel} size="lg" />}
          >
            <span className="lg-log-entity"><ModelEntityIcon model={it.primaryModel} /><span className="lg-truncate lg-log-model-name">{it.primaryModel}</span></span>
          </LogEntityHoverCard>
        ) : <span className="lg-log-app-label">{DASH}</span>;
      case 'primaryProvider':
        return it.primaryProvider ? (
          <LogEntityHoverCard
            href={`/platforms/view?name=${encodeURIComponent(it.primaryProvider)}`}
            label={it.primaryProvider}
            subtitle="会话主要 Provider"
            description="进入详情可查看连接方式、托管模型、并发与最近请求。"
            actionLabel="查看 Provider"
            icon={<ProviderEntityIcon provider={it.primaryProvider} size="lg" />}
          >
            <span className="lg-log-entity"><ProviderEntityIcon provider={it.primaryProvider} /><span className="lg-truncate">{it.primaryProvider}</span></span>
          </LogEntityHoverCard>
        ) : <span className="lg-log-app-label">{DASH}</span>;
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
          <span style={{ fontSize: 14, color: 'var(--log-text-muted)' }}>{DASH}</span>
        );
      case 'requests':
        return <span className="tabular" style={{ fontSize: 14, color: 'var(--log-text-muted)' }}>{it.requestCount}</span>;
      default:
        return null;
    }
  };

  // ── 表格渲染器 ──
  function Table<T>({
    tableKey,
    columns,
    items,
    rowKey,
    onRow,
    render,
    empty,
  }: {
    tableKey: LogsSubTab;
    columns: ColumnDef[];
    items: T[];
    rowKey: (t: T, idx: number) => string;
    onRow?: (t: T) => void;
    render: (col: ColumnDef, t: T) => ReactNode;
    empty: ReactNode;
  }) {
    const preferences = normalizeLogTablePreferences(columns, tablePreferences[tableKey]);
    const configuredColumns = resolveLogTableColumns(columns, preferences);
    const visibleColumns = configuredColumns;
    const gridCols = `${visibleColumns.map((column) => column.width).join(' ')} 42px`;
    const tableMinWidth = isNarrowViewport
      ? NARROW_TABLE_MIN_WIDTH[tableKey]
      : tableKey === 'generations'
        ? 1832
        : Math.max(920, visibleColumns.length * 132 + 42);
    const rowHeight = LOG_TABLE_DENSITIES.find((density) => density.key === preferences.density)?.rowHeight ?? 46;
    const alignOf = (a?: ColumnDef['align']): CSSProperties['textAlign'] => (a === 'right' ? 'right' : a === 'center' ? 'center' : 'left');
    const updatePreferences = (value: LogTablePreferences) => setTablePreferences((current) => ({ ...current, [tableKey]: value }));
    return (
      <div className="lg-log-table-scroll">
        <div className="lg-log-table" data-density={preferences.density} style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: tableMinWidth || undefined }}>
          <div
            className="lg-log-table-head"
            style={{
              display: 'grid',
              minHeight: 42,
              flexShrink: 0,
              gridTemplateColumns: gridCols,
            }}
          >
            {visibleColumns.map((c) => (
              <div
                key={c.key}
                title={c.tip}
                style={{ textAlign: alignOf(c.align) }}
              >
                {c.label}
                {c.tip ? <span className="lg-log-column-info" aria-hidden="true">i</span> : null}
              </div>
            ))}
            <LogTableSettings
              columns={columns}
              preferences={preferences}
              onChange={updatePreferences}
              open={settingsOpen === tableKey}
              onOpenChange={(open) => setSettingsOpen(open ? tableKey : null)}
              tab={settingsTab}
              onTabChange={setSettingsTab}
            />
          </div>
          <div className="lg-log-table-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {items.length === 0
              ? empty
              : items.map((t, idx) => (
                  <div
                    key={rowKey(t, idx)}
                    onClick={onRow ? () => onRow(t) : undefined}
                    onKeyDown={onRow ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRow(t);
                      }
                    } : undefined}
                    role={onRow ? 'button' : undefined}
                    tabIndex={onRow ? 0 : undefined}
                    className={onRow ? 'lg-row-clickable lg-log-table-row' : 'lg-log-table-row'}
                    style={{
                      display: 'grid',
                      minHeight: rowHeight,
                      alignItems: 'center',
                      cursor: onRow ? 'pointer' : 'default',
                      gridTemplateColumns: gridCols,
                    }}
                  >
                    {visibleColumns.map((c) => (
                      <div key={c.key} style={{ minWidth: 0, textAlign: alignOf(c.align) }}>
                        {render(c, t)}
                      </div>
                    ))}
                    <span aria-hidden="true" />
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
          padding: '7px 12px',
          fontSize: 13,
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
  const successRate = summary?.total
    ? `${Math.round((summary.succeeded / summary.total) * 1000) / 10}%`
    : DASH;

  return (
    <div className="lg-logs-view" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header className="lg-logs-heading">
        <div>
          <h1>Logs</h1>
          <p>逐条查看模型、Provider、Token、费用与耗时。</p>
        </div>
        <div className="lg-log-page-actions">
          <span className="tabular">{subtab === 'sessions' ? sessTotal : total} 条</span>
          <Button variant="ghost" size="sm" aria-label="刷新日志" title="刷新日志" onClick={refresh} disabled={loading || sessLoading}>
            {loading || sessLoading ? <Spinner size={15} /> : <RefreshCw size={15} />}
          </Button>
          <details className="lg-log-filters lg-log-filter-menu">
            <summary aria-label="筛选日志" title="筛选日志">
              <SlidersHorizontal size={16} aria-hidden="true" />
              {activeFilterCount > 0 ? <span className="lg-log-filter-count">{activeFilterCount}</span> : null}
            </summary>
            <div>
              <form
                className="lg-log-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  setFilterRequestId(requestIdDraft.trim());
                }}
              >
                <Search size={15} aria-hidden="true" />
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
              {activeFilterCount > 0 ? <button className="lg-log-clear" type="button" onClick={clearFilters}>清除 {activeFilterCount} 个筛选</button> : null}
            </div>
          </details>
          <select className="lg-log-range" aria-label="时间范围" value={presetKey} onChange={(event) => setPresetKey(event.target.value)}>
            {TIME_RANGE_PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
          </select>
        </div>
      </header>

      <div className="lg-logs-tabs">
        <TabBar items={LOGS_SUBTABS} activeKey={subtab} onChange={(k) => setSubtab(k)} />
      </div>

      {metaError || listError ? (
        <div
          style={{
            flexShrink: 0,
            fontSize: 13,
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

      {subtab === 'generations' ? (
        <section className="lg-log-insights" aria-label="请求汇总趋势">
          <div className="lg-log-insight-chart">
            <div><strong>请求趋势</strong><span>{TIME_RANGE_PRESETS.find((preset) => preset.key === presetKey)?.label}</span></div>
            <MiniBarChart data={series} height={82} />
          </div>
          <div className="lg-log-insight-metrics">
            <div><span>请求</span><strong className="tabular">{fmtCompact(summary?.total)}</strong></div>
            <div><span>成功率</span><strong className="tabular">{successRate}</strong></div>
            <div><span>Token</span><strong className="tabular">{fmtCompact(summary?.totalTokens)}</strong></div>
            <div><span>估算费用</span><strong className="tabular">{fmtCost(summary?.estimatedCostUsd, 'USD')}</strong><small>{summary?.unknownCostRequests ? `${summary.unknownCostRequests} 条费用未知` : '已记录费用范围'}</small></div>
          </div>
        </section>
      ) : null}

      <Card className="lg-log-table-card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        {subtab === 'generations' && (
          <>
            {loading && rows.length === 0 ? (
              <SectionLoader text="正在加载…" />
            ) : (
              <Table
                tableKey="generations"
                columns={GENERATIONS_COLUMNS}
                items={rows}
                rowKey={(it) => it.id}
                onRow={(it) => openLogDetail(it.id)}
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
                tableKey="upstream"
                columns={UPSTREAM_COLUMNS}
                items={rows}
                rowKey={(it) => it.id}
                onRow={(it) => openLogDetail(it.id)}
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
                tableKey="sessions"
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

      {selectedLogId ? (
        <GenerationDetailsDrawer
          logId={selectedLogId}
          onClose={closeLogDetail}
          onPrevious={(() => {
            const index = rows.findIndex((item) => item.id === selectedLogId);
            return index > 0 ? () => openLogDetail(rows[index - 1].id) : undefined;
          })()}
          onNext={(() => {
            const index = rows.findIndex((item) => item.id === selectedLogId);
            return index >= 0 && index < rows.length - 1 ? () => openLogDetail(rows[index + 1].id) : undefined;
          })()}
        />
      ) : null}

    </div>
  );
}
