// OpenRouter 风格日志主体：同一字号体系、可比较的完整列、3 个真实数据视图和独立详情页。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { RefreshCw, ChevronUp, Search, SlidersHorizontal } from 'lucide-react';
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
  appDisplayName,
  statusBadgeStyle,
  shortModelName,
  userLabel,
  deriveLifecycle,
  getProtocolMeta,
} from '@/lib/logsHelpers';

const PAGE_SIZE = 30;
// v4：默认可见列集合调整（隐藏用途/结束原因/客户端用户）+ 列宽改等比摊分。
// 不升版本号的话，存量用户的 v3 记录会把 12 列全部保留，改动对他们等于没做。
const TABLE_PREFERENCES_KEY = 'llmgw.logs.table-preferences.v4';
const NARROW_TABLE_MIN_WIDTH: Record<LogsSubTab, number> = {
  generations: 1080,
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

const OPERATION_META: Record<string, { label: string; color: string; bg: string }> = {
  invoke: { label: '调用', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  submit: { label: '任务提交', color: 'var(--ok)', bg: 'var(--ok-bg)' },
  status: { label: '状态查询', color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' },
  download: { label: '结果下载', color: 'var(--info)', bg: 'var(--info-bg)' },
  cancel: { label: '取消任务', color: 'var(--err)', bg: 'var(--err-bg)' },
  probe: { label: '健康探测', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
};
function getOperationMeta(operation?: string | null) {
  if (!operation) return { label: '调用', color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' };
  return OPERATION_META[operation.toLowerCase()] ?? { label: operation, color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' };
}
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
  return `/app-callers/view?code=${encodeURIComponent(code)}`;
}


const alignOf = (a?: ColumnDef['align']): CSSProperties['textAlign'] => (a === 'right' ? 'right' : a === 'center' ? 'center' : 'left');

/** 列宽下限：minmax(Npx, …) 取 N，纯 px 取本身，fr/auto 给一个保守值。 */
function columnMinWidth(width: string): number {
  const minmax = /minmax\(\s*([\d.]+)px/.exec(width);
  if (minmax) return Number(minmax[1]);
  const px = /^([\d.]+)px$/.exec(width.trim());
  if (px) return Number(px[1]);
  return 96;
}

/**
 * 日志表格。
 *
 * **必须定义在模块作用域**，不能像原来那样写在 LogsView 函数体里：
 * 内联声明会让组件类型每次渲染都变，React 认成另一个组件，整棵子树卸载重挂。
 * 实测后果是 `.lg-log-table-body` 的 DOM 节点被换掉、scrollTop 从 200 归零——
 * 也就是说滚到一半时任何一次状态变化都会把用户弹回顶部（分页时代不明显，
 * 因为一页只有 30 行；改成瀑布加载后这会直接变成「越滚越回弹 + 反复触底加载」）。
 *
 * 瀑布加载的接线：底部放一个哨兵，用 IntersectionObserver 以滚动容器为 root 观察它，
 * 进入视野就 onLoadMore。哨兵之外**另有一个常驻的「加载更多」按钮**（见 LogTableFooter）,
 * 因为 observer 在键盘操作、reduce-motion、极短列表等场景下不一定会触发——
 * 自动加载是快捷方式，不是唯一入口。
 */
export function LogTable<T>({
  tableKey, columns, items, rowKey, onRow, render, rowTone, empty,
  preferences, onPreferencesChange, settingsOpen, onSettingsOpenChange, settingsTab, onSettingsTabChange,
  isNarrowViewport, hasMore, loadingMore, onLoadMore, paused,
}: {
  tableKey: LogsSubTab;
  columns: ColumnDef[];
  items: T[];
  rowKey: (t: T, idx: number) => string;
  onRow?: (t: T) => void;
  render: (col: ColumnDef, t: T) => ReactNode;
  rowTone?: (t: T) => 'error' | 'running' | null;
  empty: ReactNode;
  preferences: LogTablePreferences;
  onPreferencesChange: (value: LogTablePreferences) => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  settingsTab: 'columns' | 'density';
  onSettingsTabChange: (tab: 'columns' | 'density') => void;
  isNarrowViewport: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** 上一次续取失败：暂停哨兵自动加载，改由用户点「重试」。 */
  paused: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // onLoadMore 每次渲染都是新函数；放进 ref 就不必因为它重建 observer，
  // 否则每次 setState 都会断开重连，触底那一刻正好可能观察不到。
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const body = bodyRef.current;
    const target = sentinelRef.current;
    // paused 时不装 observer：续取失败后哨兵通常还压在视野里，
    // 继续观察就是对着一个正在报错的接口无限重打。
    if (!body || !target || !hasMore || loadingMore || paused) return;
    // root 必须是**真的在裁剪**的那个盒子。
    // 桌面态表体自己是滚动容器；但 ≤680px 的断点把它改成了
    // `overflow: visible !important`（表格整体交给页面滚），此时再拿它当 root，
    // 哨兵永远落在 root 的盒子里 —— 实测「只打开页面什么都不做，6 秒内发了 23 个请求、
    // 拉了 690 行」，大租户等于一进 Logs 就把整个结果集拖下来。
    // 拿不到裁剪盒就退回视口（root: null），那才是移动端真正决定「看没看到底」的东西。
    const clips = (el: HTMLElement) => {
      const overflowY = getComputedStyle(el).overflowY;
      return overflowY === 'auto' || overflowY === 'scroll';
    };
    const root = clips(body) ? body : null;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current();
    }, { root, rootMargin: '240px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
    // isNarrowViewport 进依赖：跨过 680px 断点时表体的 overflow 会翻转，
    // observer 必须按新的 root 重建，否则会一直用旧断点算出来的那个。
  }, [hasMore, loadingMore, paused, isNarrowViewport]);

  const visibleColumns = resolveLogTableColumns(columns, preferences);
  const gridCols = `${visibleColumns.map((column) => column.width).join(' ')} 42px`;
  // 表格最小宽度必须由列自身的下限推出来，不能写死。
  // 以前这里对 generations 硬编码 1832px，无论列怎么配都强制横向滚动，
  // 右侧列被切、齿轮压住表头，中间还空出大片没人用的宽度。
  const contentMinWidth = visibleColumns.reduce((sum, column) => sum + columnMinWidth(column.width), 0)
    + (visibleColumns.length - 1) * 12 // column-gap
    + 32 // 左右内边距
    + 42; // 列设置齿轮
  const tableMinWidth = isNarrowViewport ? NARROW_TABLE_MIN_WIDTH[tableKey] : contentMinWidth;
  const rowHeight = LOG_TABLE_DENSITIES.find((density) => density.key === preferences.density)?.rowHeight ?? 46;

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
            onChange={onPreferencesChange}
            open={settingsOpen}
            onOpenChange={onSettingsOpenChange}
            tab={settingsTab}
            onTabChange={onSettingsTabChange}
          />
        </div>
        <div ref={bodyRef} className="lg-log-table-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
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
                  className={[
                    'lg-log-table-row',
                    onRow ? 'lg-row-clickable' : '',
                    rowTone?.(t) ? `is-${rowTone(t)}` : '',
                  ].filter(Boolean).join(' ')}
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
          {/* 触底提示条。禁止只放一个静止的「加载中…」——这里给的是三行骨架，
              让「还在往下取」这件事在屏幕上持续有形（CLAUDE.md 规则 6）。 */}
          {loadingMore ? (
            <div className="lg-log-loading-more" role="status" aria-live="polite">
              <span className="lg-log-skeleton-row" />
              <span className="lg-log-skeleton-row" />
              <span className="lg-log-skeleton-row" />
              <span className="lg-log-loading-more-text">正在加载更多…</span>
            </div>
          ) : null}
          {hasMore && !paused ? <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 表尾：加载进度 + 手动「加载更多」。
 * 常驻在滚动区之外，所以它同时承担两件事——告诉用户「已加载多少 / 还有没有」，
 * 以及给键盘用户和 observer 没触发时留一条确定能用的路。
 */
function LogTableFooter({ loaded, total, hasMore, busy, error, onLoadMore, onRetry }: {
  loaded: number; total: number; hasMore: boolean; busy: boolean;
  error: string | null; onLoadMore: () => void; onRetry: () => void;
}) {
  return (
    <div className="lg-log-table-footer">
      {error ? (
        // 续取失败必须说清「失败了 + 下一步」。不能只是停住不动——
        // 用户看到的会是「滚到底就再也没有了」，把一次可重试的失败误读成数据到头了。
        <span className="lg-log-footer-error" role="alert">已加载 {loaded} 条，继续加载失败：{error}</span>
      ) : (
        <span>
          {total > 0 ? `已加载 ${loaded} / 共 ${total} 条` : `共 ${loaded} 条`}
          {!hasMore && loaded > 0 ? ' · 已全部加载' : ''}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {error ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRetry}>
            {busy ? <Spinner size={14} /> : null}
            {busy ? '重试中' : '重试'}
          </Button>
        ) : hasMore ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onLoadMore}>
            {busy ? <Spinner size={14} /> : null}
            {busy ? '加载中' : '加载更多'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function LogsView() {
  const location = useLocation();
  const navigate = useNavigate();
  const [subtab, setSubtab] = useState<LogsSubTab>('generations');
  const [trendOpen, setTrendOpen] = useState(true);
  const [presetKey, setPresetKey] = useState('30d');
  const [filterModel, setFilterModel] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterProvider, setFilterProvider] = useState('');
  const [filterAppCaller, setFilterAppCaller] = useState('');
  const [filterTransport, setFilterTransport] = useState('');
  const [filterRequestType, setFilterRequestType] = useState('');
  const [filterOperation, setFilterOperation] = useState('');
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
  // 按上游平台过滤：从平台页「查看日志」深链进来（?platformId=xxx），
  // 用来回答「这条上游到底有没有在被调、报什么错」。provider 会重名，只能用 id。
  const [filterPlatformId, setFilterPlatformId] = useState(() => initialQueryValue('platformId'));

  const [meta, setMeta] = useState<{
    models: string[];
    statuses: string[];
    providers: string[];
    appCallers: string[];
    transports: string[];
    requestTypes: string[];
    operations: string[];
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
    operations: [],
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
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 续取失败的提示。有值时哨兵停止自动取，改由用户点「重试」——
  // 否则哨兵还压在视野里，会对着一个正在报错的接口无限重打。
  const [moreError, setMoreError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessTotal, setSessTotal] = useState(0);
  const [sessLoading, setSessLoading] = useState(false);
  const [sessLoadingMore, setSessLoadingMore] = useState(false);
  const [sessMoreError, setSessMoreError] = useState<string | null>(null);
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
      operation: subtab === 'upstream' ? filterOperation || undefined : undefined,
      view: subtab === 'upstream' ? 'physical' as const : 'logical' as const,
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
      platformId: filterPlatformId.trim() || undefined,
    }),
    [range, subtab, filterModel, filterStatus, filterProvider, filterAppCaller, filterTransport, filterRequestType, filterOperation, filterSourceSystem, filterIngressProtocol, filterModelPolicy, filterReleaseCommit, filterRunId, filterRequestId, filterSessionId, filterModelPoolId, filterServiceKeyId, filterClientCode, filterEnvironment, filterPlatformId],
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
          operations: res.data.operations ?? [],
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
  // 「已成功加载到第几页」。刻意用 ref 而不是 state，且**只在成功时前进**：
  //   - 写成 state + 触底就 setPage(p+1)，失败时页码已经跨过去了，而哨兵通常还在视野里，
  //     下一次触发直接请求再下一页 —— 失败那一页从此永久缺失（Codex P1 抓到的就是这个）。
  //   - 写成 state 还会让「刷新」很难做对：refresh 调 loadList(page)，page>1 时按累加语义
  //     把同一页又追加了一遍，60 行刷成 90 行（另一条 P1）。
  // 现在页码只是取数的入参，刷新一律回第 1 页做替换。
  const loadedPage = useRef(0);
  const loadedSessPage = useRef(0);
  // 刷新令牌：refresh 时递增，驱动首页重取。不用 setPage(1) 是因为 page 已经不是 state，
  // 而且当页码本来就是 1 时 setState 同值不会触发 effect，刷新会静默失效。
  const [refreshToken, setRefreshToken] = useState(0);

  const rowsRef = useRef<LlmLogListItem[]>([]);
  rowsRef.current = rows;
  const sessionsRef = useRef<SessionItem[]>([]);
  sessionsRef.current = sessions;

  const listSeq = useRef(0);
  const sessSeq = useRef(0);
  const insightSeq = useRef(0);
  const openedRequestIdRef = useRef('');

  // 瀑布加载：第 1 页替换，后续页追加。
  // 序号守卫仍然管用——切筛选/切 tab 会让 seq 前进，过期响应直接丢弃，不会把
  // 上一套筛选的行追加到新列表后面（这是分页改累加最容易漏的一个竞态）。
  const loadList = useCallback(
    async (p: number) => {
      const seq = ++listSeq.current;
      if (p === 1) setLoading(true); else setLoadingMore(true);
      const res = await getLogs({ ...baseParams, page: p, pageSize: PAGE_SIZE });
      if (seq !== listSeq.current) return;
      if (res.success && res.data) {
        const incoming = res.data.items ?? [];
        setRows((current) => (p === 1 ? incoming : [...current, ...incoming]));
        setTotal(res.data.total ?? 0);
        setListError(null);
        setMoreError(null);
        loadedPage.current = p; // 只有成功才算「这一页取到了」
        // 后端返回空页时把 total 拉回已加载数，避免 total 偏大导致哨兵反复触发。
        if (incoming.length === 0 && p > 1) setTotal((t) => Math.min(t, rowsRef.current.length));
      } else {
        const message = res.error?.message || '加载日志失败';
        // 首页失败是整屏错误；续取失败只影响底部那一截，两者的出口不同。
        if (p === 1) setListError(message); else setMoreError(message);
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [baseParams],
  );

  const loadSessions = useCallback(
    async (p: number) => {
      const seq = ++sessSeq.current;
      if (p === 1) setSessLoading(true); else setSessLoadingMore(true);
      const res = await getLogsSessions({ ...baseParams, page: p, pageSize: PAGE_SIZE });
      if (seq !== sessSeq.current) return;
      if (res.success && res.data) {
        const incoming = res.data.items ?? [];
        setSessions((current) => (p === 1 ? incoming : [...current, ...incoming]));
        setSessTotal(res.data.total ?? 0);
        setListError(null);
        setSessMoreError(null);
        loadedSessPage.current = p;
        if (incoming.length === 0 && p > 1) setSessTotal((t) => Math.min(t, sessionsRef.current.length));
      } else {
        const message = res.error?.message || '加载会话失败';
        if (p === 1) setListError(message); else setSessMoreError(message);
      }
      setSessLoading(false);
      setSessLoadingMore(false);
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

  // 筛选一变就把累加结果清空；不清空的话新旧两套筛选的行会串在一起。
  useEffect(() => {
    loadedPage.current = 0;
    loadedSessPage.current = 0;
    setRows([]);
    setSessions([]);
    setMoreError(null);
    setSessMoreError(null);
  }, [baseParams]);
  // 切 tab 同理：业务请求与上游调用共用 rows，留着上一个 tab 的行会先闪一屏错数据。
  useEffect(() => {
    loadedPage.current = 0;
    setRows([]);
    setMoreError(null);
  }, [subtab]);
  // 首页取数。后续页不走 effect，由 loadMore 直接调用——页码是「取到第几页」的结果，
  // 不是驱动取数的输入，把它做成 effect 依赖就会出现「失败也算数」的推进。
  useEffect(() => {
    if (subtab === 'generations' || subtab === 'upstream') void loadList(1);
  }, [subtab, loadList, refreshToken]);
  useEffect(() => {
    if (subtab === 'sessions') void loadSessions(1);
  }, [subtab, loadSessions, refreshToken]);
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

  // 刷新 = 回到第 1 页重新取并**替换**列表。
  // 之前写的是 loadList(page)：累加语义下，停在第 2 页时刷新会把第 2 页再追加一遍
  // （实测 60 行刷成 90 行）。刷新是「重新看一眼现在的样子」，不是「再取一次当前页」。
  const refresh = () => {
    void loadInsights();
    setRefreshToken((t) => t + 1);
  };

  // ── 单元格渲染 ──
  const renderGenerationCell = (col: ColumnDef, it: LlmLogListItem): ReactNode => {
    switch (col.key) {
      case 'date':
        return (
          <span style={{ color: 'var(--log-text-muted)', whiteSpace: 'nowrap' }} title={fmtDate(it.startedAt)}>
            {fmtShortTime(it.startedAt)}
          </span>
        );
      case 'generation':
        return (
          <span
            className="lg-truncate"
            style={{ fontSize: 'var(--fs-secondary)', color: 'var(--log-text-muted)', fontFamily: 'var(--font-mono)' }}
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
            <span className="lg-log-entity" title={[`完整标识 ${modelName}`, it.logicalModelPublicId ? `实际上游 ${it.model}` : null, proto ? `协议 ${proto.label}` : null, tp ? `传输 ${tp.label}` : null].filter(Boolean).join('；')}>
              <ModelEntityIcon model={modelName} />
              <span className="lg-truncate lg-log-model-name">{shortModelName(modelName)}</span>
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
        const title = `应用：${appDisplayName(it)}；调用身份：${it.clientCode || '历史未标注'}${it.environment ? `；环境：${it.environment}` : ''}`;
        const code = it.appCallerCode?.trim();
        if (!code) {
          return <span className="lg-log-entity" title={title}><AppEntityIcon app={appDisplayName(it)} sourceSystem={it.sourceSystem} /><span className="lg-truncate">{appDisplayName(it)}</span></span>;
        }
        return (
          <LogEntityHoverCard
            href={appDetailsHref(code)}
            label={appDisplayName(it)}
            subtitle={[code, it.sourceSystem || 'App', it.environment].filter(Boolean).join(' · ')}
            description={it.clientCode
              ? `调用身份 ${it.clientCode}。进入详情可查看模型路由、预算、速率治理与最近请求。`
              : '进入详情可查看调用身份、模型路由、预算、速率治理与最近请求。'}
            actionLabel="查看 App"
            icon={<AppEntityIcon app={appDisplayName(it)} sourceSystem={it.sourceSystem} size="lg" />}
          >
            <span className="lg-log-entity" title={title}>
              <AppEntityIcon app={appDisplayName(it)} sourceSystem={it.sourceSystem} />
              <span className="lg-truncate">{appDisplayName(it)}</span>
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
        // quiet = 成功。渲染成普通小字而不是 chip，把 chip 这种「亮起来」的
        // 表达留给真正需要人看一眼的失败与进行中（风格调性原则 4）。
        if (s.quiet) return <span className="tabular" style={{ color: 'var(--text-muted)' }}>{s.label}</span>;
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
        return <span style={{ fontSize: 'var(--fs-body)', color: 'var(--log-text-muted)' }}>{fmtShortTime(it.startedAt)}</span>;
      case 'operation': {
        const operation = getOperationMeta(it.operation);
        return <Chip label={operation.label} color={operation.color} bg={operation.bg} />;
      }
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
              <span className="lg-truncate lg-log-model-name">{shortModelName(it.logicalModelPublicId || it.model)}</span>
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
          <span className="lg-truncate" style={{ fontSize: 'var(--fs-secondary)', color: 'var(--log-text-muted)', fontFamily: 'var(--font-mono)' }} title={it.requestId}>
            {it.requestId || DASH}
          </span>
        );
      case 'status': {
        const s = statusBadgeStyle(it.status, it.statusCode);
        // quiet = 成功。渲染成普通小字而不是 chip，把 chip 这种「亮起来」的
        // 表达留给真正需要人看一眼的失败与进行中（风格调性原则 4）。
        if (s.quiet) return <span className="tabular" style={{ color: 'var(--text-muted)' }}>{s.label}</span>;
        return <Chip label={s.label} color={s.color} bg={s.bg} />;
      }
      case 'attempts':
        return <span style={{ fontSize: 'var(--fs-body)', color: 'var(--log-text-muted)' }}>{DASH}</span>;
      case 'fallback':
        return it.isFallback ? (
          <Chip label="已降级" color="#fbbf24" bg="rgba(251,191,36,0.16)" title={it.expectedModel ? `期望 ${it.expectedModel}` : undefined} />
        ) : (
          <span style={{ fontSize: 'var(--fs-body)', color: 'var(--log-text-muted)' }}>否</span>
        );
      case 'latency':
        return <span className="tabular" style={{ fontSize: 'var(--fs-body)', color: 'var(--log-text-muted)' }}>{fmtMs(it.durationMs)}</span>;
      default:
        return null;
    }
  };

  const renderSessionCell = (col: ColumnDef, it: SessionItem): ReactNode => {
    switch (col.key) {
      case 'date':
        return (
          <span style={{ fontSize: 'var(--fs-body)', color: 'var(--log-text-muted)' }}>
            {fmtDate(it.start)}
            {it.end && it.end !== it.start ? ` ~ ${fmtShortTime(it.end)}` : ''}
          </span>
        );
      case 'sessionId':
        return (
          <span className="lg-truncate" style={{ fontSize: 'var(--fs-secondary)', color: 'var(--log-text-muted)', fontFamily: 'var(--font-mono)' }} title={it.sessionId || ''}>
            {it.sessionId || DASH}
          </span>
        );
      case 'app':
        return it.appCallerCode ? (
          <LogEntityHoverCard
            href={appDetailsHref(it.appCallerCode)}
            label={it.appCallerCode}
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
          <span style={{ fontSize: 'var(--fs-body)', color: 'var(--log-text-muted)' }}>{DASH}</span>
        );
      case 'requests':
        return <span className="tabular" style={{ fontSize: 'var(--fs-body)', color: 'var(--log-text-muted)' }}>{it.requestCount}</span>;
      default:
        return null;
    }
  };

  // ── 表格渲染器 ──
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
    subtab === 'upstream' ? filterOperation : '',
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
    filterPlatformId.trim(),
  ].filter(Boolean).length;
  const clearFilters = () => {
    setFilterModel('');
    setFilterStatus('');
    setFilterProvider('');
    setFilterAppCaller('');
    setFilterTransport('');
    setFilterRequestType('');
    setFilterOperation('');
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
    setFilterPlatformId('');
  };
  const hasMoreRows = rows.length < total;
  const hasMoreSessions = sessions.length < sessTotal;
  // 取「已成功加载到的页 + 1」。失败时 loadedPage 不动，所以重试打的还是同一页。
  const loadMoreRows = useCallback(() => {
    if (loading || loadingMore || !hasMoreRows || moreError) return;
    void loadList(loadedPage.current + 1);
  }, [hasMoreRows, loadList, loading, loadingMore, moreError]);
  const retryMoreRows = useCallback(() => {
    setMoreError(null);
    void loadList(loadedPage.current + 1);
  }, [loadList]);
  const loadMoreSessions = useCallback(() => {
    if (sessLoading || sessLoadingMore || !hasMoreSessions || sessMoreError) return;
    void loadSessions(loadedSessPage.current + 1);
  }, [hasMoreSessions, loadSessions, sessLoading, sessLoadingMore, sessMoreError]);
  const retryMoreSessions = useCallback(() => {
    setSessMoreError(null);
    void loadSessions(loadedSessPage.current + 1);
  }, [loadSessions]);

  const successRate = summary?.total
    ? `${Math.round((summary.succeeded / summary.total) * 1000) / 10}%`
    : DASH;
  // 汇总条只列拿得到的事实。fmtCompact / fmtCost 在无值时返回 DASH，
  // 这里据此过滤掉整项——「没有」不该占着一个位置显示成「—」。
  const summaryFacts = [
    { label: '业务请求', value: fmtCompact(summary?.total) },
    { label: '上游调用', value: fmtCompact(summary?.upstreamCalls) },
    { label: '状态查询', value: fmtCompact(summary?.statusQueries) },
    { label: '成功率', value: successRate },
    { label: 'Token', value: fmtCompact(summary?.totalTokens) },
    { label: '费用', value: fmtCost(summary?.estimatedCostUsd, 'USD') },
  ].filter((fact) => fact.value !== DASH);

  return (
    <div className="lg-logs-view" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header className="lg-logs-heading">
        <div>
          <h1>Logs</h1>
          {/* 汇总条：拿不到值的项**整条不渲染**，而不是渲染成「上游调用 —」。
              一排破折号既不承载信息，又和真实数字抢同样的横向位置，
              读起来是「这里坏了」而不是「这里没有」。过滤在 summaryFacts 里做。 */}
          {subtab === 'generations' ? (
            <p className="lg-log-summary-strip">
              {summaryFacts.map((fact) => (
                <span key={fact.label}>{fact.label} <strong className="tabular">{fact.value}</strong></span>
              ))}
              {summary?.unknownCostRequests ? <span className="lg-log-summary-warn">{summary.unknownCostRequests} 条费用未知</span> : null}
            </p>
          ) : null}
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
              {/* 平台页「查看日志」深链会填上它。必须可见可清，否则用户看到一份被过滤的列表却不知道为什么少了记录 */}
              <input aria-label="上游平台 ID" value={filterPlatformId} onChange={(event) => setFilterPlatformId(event.target.value)} placeholder="上游平台 ID" spellCheck={false} />
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
              {subtab === 'upstream' ? (
                <select aria-label="操作类型" value={filterOperation} onChange={(event) => setFilterOperation(event.target.value)}>
                  <option value="">全部操作类型</option>
                  {meta.operations.map((value) => <option key={value} value={value}>{getOperationMeta(value).label}</option>)}
                </select>
              ) : null}
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
            fontSize: 'var(--fs-secondary)',
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

      <Card className="lg-log-table-card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        {subtab === 'generations' && (
          <>
            {/* 趋势是余光信息：无边框、无标题、无坐标轴，直接坐在表头上方，可折叠。
                没有数据点时整块不渲染——空图占位比没有更糟。 */}
            {series.length > 0 ? (
            <div className={`lg-log-trend${trendOpen ? '' : ' is-collapsed'}`} aria-label="请求趋势">
              {trendOpen ? <MiniBarChart data={series} height={78} /> : null}
              <button
                type="button"
                className="lg-log-trend-toggle"
                aria-label={trendOpen ? '收起趋势' : '展开趋势'}
                title={trendOpen ? '收起趋势' : '展开趋势'}
                onClick={() => setTrendOpen((v) => !v)}
              >
                <ChevronUp size={15} style={{ transform: trendOpen ? 'none' : 'rotate(180deg)', transition: 'transform .18s ease' }} />
              </button>
            </div>
            ) : null}
            {loading && rows.length === 0 ? (
              <SectionLoader text="正在加载…" />
            ) : (
              <LogTable
                tableKey="generations"
                preferences={normalizeLogTablePreferences(GENERATIONS_COLUMNS, tablePreferences['generations'])}
                onPreferencesChange={(value) => setTablePreferences((current) => ({ ...current, generations: value }))}
                settingsOpen={settingsOpen === 'generations'}
                onSettingsOpenChange={(open) => setSettingsOpen(open ? 'generations' : null)}
                settingsTab={settingsTab}
                onSettingsTabChange={setSettingsTab}
                isNarrowViewport={isNarrowViewport}
                hasMore={hasMoreRows}
                loadingMore={loadingMore}
                onLoadMore={loadMoreRows}
                paused={moreError != null}
                columns={GENERATIONS_COLUMNS}
                items={rows}
                rowKey={(it) => it.id}
                onRow={(it) => openLogDetail(it.id)}
                render={renderGenerationCell}
                rowTone={(it) => {
                  const lc = deriveLifecycle(it);
                  if (lc.pulse) return 'running';
                  return lc.key === 'failed' || lc.key === 'blackhole' ? 'error' : null;
                }}
                empty={emptyCell('该时间范围内还没有请求记录', true)}
              />
            )}
            <LogTableFooter loaded={rows.length} total={total} hasMore={hasMoreRows} busy={loadingMore} error={moreError} onLoadMore={loadMoreRows} onRetry={retryMoreRows} />
          </>
        )}
        {subtab === 'upstream' && (
          <>
            {loading && rows.length === 0 ? (
              <SectionLoader text="正在加载…" />
            ) : (
              <LogTable
                tableKey="upstream"
                preferences={normalizeLogTablePreferences(UPSTREAM_COLUMNS, tablePreferences['upstream'])}
                onPreferencesChange={(value) => setTablePreferences((current) => ({ ...current, upstream: value }))}
                settingsOpen={settingsOpen === 'upstream'}
                onSettingsOpenChange={(open) => setSettingsOpen(open ? 'upstream' : null)}
                settingsTab={settingsTab}
                onSettingsTabChange={setSettingsTab}
                isNarrowViewport={isNarrowViewport}
                hasMore={hasMoreRows}
                loadingMore={loadingMore}
                onLoadMore={loadMoreRows}
                paused={moreError != null}
                columns={UPSTREAM_COLUMNS}
                items={rows}
                rowKey={(it) => it.id}
                onRow={(it) => openLogDetail(it.id)}
                render={renderUpstreamCell}
                empty={emptyCell('该时间范围内还没有上游调用记录', true)}
              />
            )}
            <LogTableFooter loaded={rows.length} total={total} hasMore={hasMoreRows} busy={loadingMore} error={moreError} onLoadMore={loadMoreRows} onRetry={retryMoreRows} />
          </>
        )}
        {subtab === 'sessions' && (
          <>
            {sessLoading && sessions.length === 0 ? (
              <SectionLoader text="正在聚合会话…" />
            ) : (
              <LogTable
                tableKey="sessions"
                preferences={normalizeLogTablePreferences(SESSIONS_COLUMNS, tablePreferences['sessions'])}
                onPreferencesChange={(value) => setTablePreferences((current) => ({ ...current, sessions: value }))}
                settingsOpen={settingsOpen === 'sessions'}
                onSettingsOpenChange={(open) => setSettingsOpen(open ? 'sessions' : null)}
                settingsTab={settingsTab}
                onSettingsTabChange={setSettingsTab}
                isNarrowViewport={isNarrowViewport}
                hasMore={hasMoreSessions}
                loadingMore={sessLoadingMore}
                onLoadMore={loadMoreSessions}
                paused={sessMoreError != null}
                columns={SESSIONS_COLUMNS}
                items={sessions}
                rowKey={(it, idx) => it.sessionId || String(idx)}
                render={renderSessionCell}
                empty={emptyCell('该时间范围内暂无带会话 ID 的请求')}
              />
            )}
            <LogTableFooter loaded={sessions.length} total={sessTotal} hasMore={hasMoreSessions} busy={sessLoadingMore} error={sessMoreError} onLoadMore={loadMoreSessions} onRetry={retryMoreSessions} />
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
