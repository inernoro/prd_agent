// OpenRouter 风格大模型日志页主体：顶部柱状图 + 时间范围 + 4 子 tab + 表格 + 详情抽屉。
// 自包含（自己拉数据），挂在「大模型日志」tab 下。视觉走本系统 token，数据缺失项「—」。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import type { EChartsOption } from 'echarts';
import { EChart } from '@/components/charts/EChart';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { getLlmLogs, getLlmLogsMeta, getLlmLogsTimeseries, getLlmLogsSessions, getLlmLogsAppSummary } from '@/services';
import type { LlmRequestLogListItem } from '@/types/admin';
import type { LlmLogsSessionItem, LlmLogsTimeseriesPoint, LlmLogsAppSummaryItem } from '@/services/contracts/llmLogs';
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { getProtocolMeta } from '@/lib/protocolRegistry';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { GenerationDetailsDrawer } from './GenerationDetailsDrawer';
import {
  DASH, LOGS_SUBTABS, type LogsSubTab, TIME_RANGE_PRESETS, rangeFromPreset,
  GENERATIONS_COLUMNS, UPSTREAM_COLUMNS, SESSIONS_COLUMNS, APP_SUMMARY_COLUMNS, type ColumnDef,
  GENERATIONS_COLUMNS_MOBILE, UPSTREAM_COLUMNS_MOBILE, SESSIONS_COLUMNS_MOBILE, APP_SUMMARY_COLUMNS_MOBILE,
  fmtShortTime, fmtDate, fmtMs, fmtCompact, fmtRate, computeTokPerSec, statusBadgeStyle, successRateStyle, userLabel,
  deriveLifecycle,
} from './llmLogsView.helpers';

const PAGE_SIZE = 30;

function Chip({ label, color, bg, title }: { label: string; color: string; bg: string; title?: string }) {
  return <span title={title} className="inline-flex items-center rounded-full px-1.5 h-[18px] text-[10px] font-semibold shrink-0" style={{ color, background: bg }}>{label}</span>;
}

export function LlmGenerationsView() {
  const isMobile = useIsMobile();
  const [subtab, setSubtab] = useState<LogsSubTab>('generations');
  const [presetKey, setPresetKey] = useState('30d');
  const [filterModel, setFilterModel] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [meta, setMeta] = useState<{ models: string[]; statuses: string[] }>({ models: [], statuses: [] });

  // generations / upstream 共用列表数据
  const [rows, setRows] = useState<LlmRequestLogListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // sessions
  const [sessions, setSessions] = useState<LlmLogsSessionItem[]>([]);
  const [sessTotal, setSessTotal] = useState(0);
  const [sessPage, setSessPage] = useState(1);
  const [sessLoading, setSessLoading] = useState(false);

  // 应用聚合矩阵
  const [appRows, setAppRows] = useState<LlmLogsAppSummaryItem[]>([]);
  const [appLoading, setAppLoading] = useState(false);

  // 柱状图
  const [series, setSeries] = useState<LlmLogsTimeseriesPoint[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const range = useMemo(() => {
    const p = TIME_RANGE_PRESETS.find((x) => x.key === presetKey) ?? TIME_RANGE_PRESETS[2];
    return rangeFromPreset(p.days);
  }, [presetKey]);

  const baseParams = useMemo(() => ({
    from: range.from, to: range.to,
    model: filterModel || undefined,
    status: filterStatus || undefined,
  }), [range, filterModel, filterStatus]);

  useEffect(() => {
    getLlmLogsMeta().then((res) => {
      if (res.success && res.data) setMeta({ models: res.data.models ?? [], statuses: res.data.statuses ?? [] });
    });
  }, []);

  // 请求序号守卫：快速切筛选/翻页/tab 时丢弃过期响应，避免乱序覆盖（竞态）
  const listSeq = useRef(0);
  const sessSeq = useRef(0);
  const appSeq = useRef(0);
  const seriesSeq = useRef(0);

  const loadList = useCallback(async (p: number) => {
    const seq = ++listSeq.current;
    setLoading(true);
    const res = await getLlmLogs({ ...baseParams, page: p, pageSize: PAGE_SIZE });
    if (seq !== listSeq.current) return; // 已有更新的请求，丢弃本次
    if (res.success && res.data) { setRows(res.data.items ?? []); setTotal(res.data.total ?? 0); }
    setLoading(false);
  }, [baseParams]);

  const loadSessions = useCallback(async (p: number) => {
    const seq = ++sessSeq.current;
    setSessLoading(true);
    const res = await getLlmLogsSessions({ from: range.from, to: range.to, page: p, pageSize: PAGE_SIZE });
    if (seq !== sessSeq.current) return;
    if (res.success && res.data) { setSessions(res.data.items ?? []); setSessTotal(res.data.total ?? 0); }
    setSessLoading(false);
  }, [range]);

  const loadApps = useCallback(async () => {
    const seq = ++appSeq.current;
    setAppLoading(true);
    const res = await getLlmLogsAppSummary({ from: range.from, to: range.to });
    if (seq !== appSeq.current) return;
    if (res.success && res.data) setAppRows(res.data.items ?? []);
    setAppLoading(false);
  }, [range]);

  const loadSeries = useCallback(async () => {
    const seq = ++seriesSeq.current;
    const res = await getLlmLogsTimeseries(baseParams);
    if (seq !== seriesSeq.current) return;
    if (res.success && res.data) setSeries(res.data.items ?? []);
  }, [baseParams]);

  // 切 tab / 改筛选 / 改范围 → 重载对应数据 + 柱状图
  useEffect(() => { setPage(1); }, [baseParams]);
  useEffect(() => { loadSeries(); }, [loadSeries]);
  useEffect(() => {
    if (subtab === 'generations' || subtab === 'upstream') loadList(page);
  }, [subtab, page, loadList]);
  useEffect(() => {
    if (subtab === 'sessions') loadSessions(sessPage);
  }, [subtab, sessPage, loadSessions]);
  useEffect(() => {
    if (subtab === 'apps') loadApps();
  }, [subtab, loadApps]);

  const refresh = () => {
    loadSeries();
    if (subtab === 'sessions') loadSessions(sessPage);
    else if (subtab === 'apps') loadApps();
    else loadList(page);
  };

  // ── 柱状图 option ──
  const chartOption = useMemo(() => {
    const dates = series.map((s) => s.date.slice(5)); // MM-DD
    const counts = series.map((s) => s.count);
    const axis = 'rgba(148,163,184,0.85)';
    const grid = 'rgba(148,163,184,0.18)';
    return {
      grid: { left: 38, right: 10, top: 14, bottom: 22 },
      tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
      xAxis: { type: 'category' as const, data: dates, axisLabel: { color: axis, fontSize: 10 }, axisLine: { lineStyle: { color: grid } }, axisTick: { show: false } },
      yAxis: { type: 'value' as const, axisLabel: { color: axis, fontSize: 10 }, splitLine: { lineStyle: { color: grid } } },
      series: [{ type: 'bar' as const, data: counts, itemStyle: { color: 'rgba(96,165,250,0.85)', borderRadius: [3, 3, 0, 0] as [number, number, number, number] }, barMaxWidth: 22 }],
    };
  }, [series]);

  const totalReq = useMemo(() => series.reduce((a, s) => a + s.count, 0), [series]);

  // ── 单元格渲染 ──
  const renderGenerationCell = (col: ColumnDef, it: LlmRequestLogListItem) => {
    switch (col.key) {
      case 'date': {
        const lc = deriveLifecycle(it);
        return (
          <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <span title={`生命周期：${lc.label}`} className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${lc.pulse ? 'animate-pulse' : ''}`} style={{ background: lc.color }} />
            {fmtShortTime(it.startedAt)}
          </span>
        );
      }
      case 'model': {
        const proto = getProtocolMeta(it.protocol);
        return <span className="inline-flex items-center gap-1 min-w-0"><span className="truncate text-[11px] font-medium" style={{ color: 'var(--text-primary)' }} title={it.model}>{it.model || DASH}</span>{proto ? <Chip label={proto.label} color={proto.color} bg={proto.bg} /> : null}</span>;
      }
      case 'provider': return <span className="truncate text-[11px]" style={{ color: 'var(--text-secondary)' }} title={it.platformName || it.provider}>{it.platformName || it.provider || DASH}</span>;
      case 'app': return <span className="truncate text-[11px] font-mono" style={{ color: 'var(--text-muted)' }} title={it.appCallerCode || ''}>{it.appCallerCodeDisplayName || it.appCallerCode || DASH}</span>;
      case 'input': return <span className="tabular-nums text-[11px]" style={{ color: 'var(--text-secondary)' }}>{fmtCompact(it.inputTokens)}</span>;
      case 'output': return <span className="tabular-nums text-[11px]" style={{ color: 'var(--text-secondary)' }}>{fmtCompact(it.outputTokens)}</span>;
      case 'cost': return <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{DASH}</span>;
      case 'usage': return <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{it.requestType || DASH}</span>;
      case 'speed': { const t = computeTokPerSec(it.outputTokens, it.durationMs); return <span className="tabular-nums text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t == null ? DASH : `${t}`}</span>; }
      case 'finish': return <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{it.finishReason || DASH}</span>;
      case 'user': return <span className="truncate text-[11px]" style={{ color: 'var(--text-secondary)' }} title={userLabel(it)}>{userLabel(it)}</span>;
      case 'stream': return <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{it.isStreaming == null ? DASH : (it.isStreaming ? '流式' : '非流')}</span>;
      default: return null;
    }
  };

  const renderUpstreamCell = (col: ColumnDef, it: LlmRequestLogListItem) => {
    switch (col.key) {
      case 'date': return <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{fmtShortTime(it.startedAt)}</span>;
      case 'model': return <span className="truncate text-[11px] font-medium" style={{ color: 'var(--text-primary)' }} title={it.model}>{it.model || DASH}</span>;
      case 'provider': return <span className="truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>{it.platformName || it.provider || DASH}</span>;
      case 'genId': return <span className="truncate text-[11px] font-mono" style={{ color: 'var(--text-muted)' }} title={it.requestId}>{it.requestId || DASH}</span>;
      case 'status': { const s = statusBadgeStyle(it.status, it.statusCode); return <Chip label={s.label} color={s.color} bg={s.bg} />; }
      case 'attempts': return <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{DASH}</span>;
      case 'fallback': return it.isFallback ? <Chip label="已降级" color="#fbbf24" bg="rgba(251,191,36,0.16)" title={it.expectedModel ? `期望 ${it.expectedModel}` : undefined} /> : <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>否</span>;
      case 'latency': return <span className="tabular-nums text-[11px]" style={{ color: 'var(--text-secondary)' }}>{fmtMs(it.durationMs)}</span>;
      default: return null;
    }
  };

  const renderSessionCell = (col: ColumnDef, it: LlmLogsSessionItem) => {
    switch (col.key) {
      case 'date': return <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{fmtDate(it.start)}{it.end && it.end !== it.start ? ` ~ ${fmtShortTime(it.end)}` : ''}</span>;
      case 'sessionId': return <span className="truncate text-[11px] font-mono" style={{ color: 'var(--text-secondary)' }} title={it.sessionId || ''}>{it.sessionId || DASH}</span>;
      case 'app': return <span className="truncate text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>{it.appCallerCode || DASH}</span>;
      case 'primaryModel': return <span className="truncate text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>{it.primaryModel || DASH}</span>;
      case 'primaryProvider': return <span className="truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>{it.primaryProvider || DASH}</span>;
      case 'supporting': return it.supportingModels.length ? <span className="flex flex-wrap gap-1">{it.supportingModels.slice(0, 3).map((m) => <Chip key={m} label={m} color="var(--text-secondary)" bg="rgba(148,163,184,0.14)" />)}{it.supportingModels.length > 3 ? <Chip label={`+${it.supportingModels.length - 3}`} color="var(--text-muted)" bg="rgba(148,163,184,0.1)" /> : null}</span> : <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{DASH}</span>;
      case 'requests': return <span className="tabular-nums text-[11px]" style={{ color: 'var(--text-secondary)' }}>{it.requestCount}</span>;
      default: return null;
    }
  };

  const renderAppCell = (col: ColumnDef, it: LlmLogsAppSummaryItem) => {
    switch (col.key) {
      case 'app': return <span className="truncate text-[11px] font-mono font-medium" style={{ color: 'var(--text-primary)' }} title={it.appPrefix}>{it.appPrefix || DASH}</span>;
      case 'type': return <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{it.requestType || DASH}</span>;
      case 'requests': return <span className="tabular-nums text-[11px]" style={{ color: 'var(--text-secondary)' }}>{fmtCompact(it.requestCount)}</span>;
      case 'successRate': { const s = successRateStyle(it.successRate); return <span className="inline-flex justify-end"><Chip label={fmtRate(it.successRate)} color={s.color} bg={s.bg} title={`成功 ${it.successCount} / 共 ${it.requestCount}`} /></span>; }
      case 'failCount': return <span className="tabular-nums text-[11px]" style={{ color: it.failCount > 0 ? '#f87171' : 'var(--text-muted)' }}>{it.failCount}</span>;
      case 'median': return <span className="tabular-nums text-[11px]" style={{ color: 'var(--text-secondary)' }}>{fmtMs(it.medianDurationMs)}</span>;
      default: return null;
    }
  };

  // ── 表格渲染器 ──
  // 桌面窄屏不挤压：外层横向滚动 + 内层 min-width，列保持可读；body 仍纵向滚动。
  // 手机端（核心列 ≤3）：minWidth 0 让 fr 列撑满视口，不强制横向滚动（mobile-first-density.md）。
  function Table<T>({ columns, items, rowKey, onRow, render, empty }: {
    columns: ColumnDef[]; items: T[]; rowKey: (t: T, idx: number) => string; onRow?: (t: T) => void;
    render: (col: ColumnDef, t: T) => ReactNode; empty: ReactNode;
  }) {
    const gridCols = columns.map((c) => c.width).join(' ');
    return (
      <div className="flex-1 min-h-0 overflow-x-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="h-full flex flex-col" style={{ minWidth: isMobile ? 0 : Math.max(880, columns.length * 90) }}>
          <div className="grid gap-2 px-3 py-2 shrink-0" style={{ gridTemplateColumns: gridCols, borderBottom: '1px solid var(--border-subtle)' }}>
            {columns.map((c) => (
              <div key={c.key} title={c.tip} className={`text-[10px] font-semibold uppercase tracking-wide ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`} style={{ color: 'var(--text-muted)' }}>
                {c.label}{c.tip ? <span style={{ opacity: 0.6 }}> ⓘ</span> : null}
              </div>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
            {items.length === 0 ? empty : items.map((t, idx) => (
              <div
                key={rowKey(t, idx)}
                onClick={onRow ? () => onRow(t) : undefined}
                className={`grid gap-2 px-3 py-2 items-center ${onRow ? 'cursor-pointer hover:bg-[rgba(255,255,255,0.07)]' : ''}`}
                style={{ gridTemplateColumns: gridCols, borderBottom: '1px solid var(--border-subtle)' }}
              >
                {columns.map((c) => (
                  <div key={c.key} className={`min-w-0 ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`}>
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
      <div className="shrink-0 flex items-center justify-between px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
        <span>共 {tot} 条 · 第 {p}/{pages} 页</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={busy || p <= 1} onClick={() => setP(p - 1)}><ChevronLeft size={14} /></Button>
          <Button variant="ghost" size="sm" disabled={busy || p >= pages} onClick={() => setP(p + 1)}><ChevronRight size={14} /></Button>
        </div>
      </div>
    );
  };

  const selectStyle: CSSProperties = { background: 'var(--bg-input, rgba(255,255,255,0.04))', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', borderRadius: 8, height: 30, padding: '0 8px', fontSize: 12 };

  return (
    <div className="h-full min-h-0 flex flex-col gap-3">
      {/* 顶部：标题 + 时间范围 + 刷新。手机端合并成单条横向滚动控制条（mobile-first-density.md：进内容前 ≤1 条控制条）*/}
      {isMobile ? (
        <div className="shrink-0 flex items-center gap-2 overflow-x-auto pb-1" style={{ overscrollBehavior: 'contain' }}>
          <div className="inline-flex rounded-lg overflow-hidden shrink-0" style={{ border: '1px solid var(--border-subtle)' }}>
            {TIME_RANGE_PRESETS.map((p) => (
              <button key={p.key} onClick={() => setPresetKey(p.key)} className="px-2.5 h-[30px] text-[11px] font-medium whitespace-nowrap" style={{ background: presetKey === p.key ? 'var(--bg-elevated, rgba(255,255,255,0.08))' : 'transparent', color: presetKey === p.key ? 'var(--text-primary)' : 'var(--text-muted)' }}>{p.label}</button>
            ))}
          </div>
          <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)} style={{ ...selectStyle, maxWidth: 140 }} className="shrink-0">
            <option value="">全部模型</option>
            {meta.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={selectStyle} className="shrink-0">
            <option value="">全部状态</option>
            {meta.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading || sessLoading} className="shrink-0">
            {loading || sessLoading ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 flex-wrap shrink-0">
          <div>
            <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Logs</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>查看大模型请求日志与历史 · 窗口内 {totalReq} 次请求</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)} style={selectStyle}>
              <option value="">全部模型</option>
              {meta.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={selectStyle}>
              <option value="">全部状态</option>
              {meta.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="inline-flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
              {TIME_RANGE_PRESETS.map((p) => (
                <button key={p.key} onClick={() => setPresetKey(p.key)} className="px-2.5 h-[30px] text-[11px] font-medium" style={{ background: presetKey === p.key ? 'var(--bg-elevated, rgba(255,255,255,0.08))' : 'transparent', color: presetKey === p.key ? 'var(--text-primary)' : 'var(--text-muted)' }}>{p.label}</button>
              ))}
            </div>
            <Button variant="secondary" size="sm" onClick={refresh} disabled={loading || sessLoading}>
              {loading || sessLoading ? <MapSpinner size={14} /> : <RefreshCw size={14} />}刷新
            </Button>
          </div>
        </div>
      )}

      {/* 柱状图：手机端隐藏（用户反馈统计图在手机端无必要，只看核心功能）*/}
      {!isMobile && (
        <GlassCard className="p-2 shrink-0">
          <EChart option={chartOption as EChartsOption} height={140} />
        </GlassCard>
      )}

      {/* 4 子 tab */}
      <TabBar items={LOGS_SUBTABS} activeKey={subtab} onChange={(k) => setSubtab(k as LogsSubTab)} />

      {/* 内容 */}
      <GlassCard className="flex-1 min-h-0 flex flex-col p-0 overflow-hidden">
        {subtab === 'generations' && (
          <>
            {loading && rows.length === 0 ? <MapSectionLoader text="正在加载…" /> : (
              <Table
                columns={isMobile ? GENERATIONS_COLUMNS_MOBILE : GENERATIONS_COLUMNS} items={rows} rowKey={(it) => it.id} onRow={(it) => setSelectedId(it.id)}
                render={renderGenerationCell}
                empty={<div className="py-16 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>该时间范围内暂无请求</div>}
              />
            )}
            <Pager p={page} setP={setPage} tot={total} busy={loading} />
          </>
        )}
        {subtab === 'upstream' && (
          <>
            {loading && rows.length === 0 ? <MapSectionLoader text="正在加载…" /> : (
              <Table
                columns={isMobile ? UPSTREAM_COLUMNS_MOBILE : UPSTREAM_COLUMNS} items={rows} rowKey={(it) => it.id} onRow={(it) => setSelectedId(it.id)}
                render={renderUpstreamCell}
                empty={<div className="py-16 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>该时间范围内暂无请求</div>}
              />
            )}
            <Pager p={page} setP={setPage} tot={total} busy={loading} />
          </>
        )}
        {subtab === 'sessions' && (
          <>
            {sessLoading && sessions.length === 0 ? <MapSectionLoader text="正在聚合会话…" /> : (
              <Table
                columns={isMobile ? SESSIONS_COLUMNS_MOBILE : SESSIONS_COLUMNS} items={sessions} rowKey={(it, idx) => it.sessionId || String(idx)}
                render={renderSessionCell as (col: ColumnDef, t: LlmLogsSessionItem) => ReactNode}
                empty={<div className="py-16 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>该时间范围内暂无带会话 ID 的请求</div>}
              />
            )}
            <Pager p={sessPage} setP={setSessPage} tot={sessTotal} busy={sessLoading} />
          </>
        )}
        {subtab === 'apps' && (
          <>
            {appLoading && appRows.length === 0 ? <MapSectionLoader text="正在聚合应用…" /> : (
              <Table
                columns={isMobile ? APP_SUMMARY_COLUMNS_MOBILE : APP_SUMMARY_COLUMNS} items={appRows} rowKey={(it, idx) => `${it.appPrefix}:${it.requestType}:${idx}`}
                render={renderAppCell as (col: ColumnDef, t: LlmLogsAppSummaryItem) => ReactNode}
                empty={<div className="py-16 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>该时间范围内暂无应用请求</div>}
              />
            )}
            <div className="shrink-0 flex items-center px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
              <span>按应用前缀 + 类型聚合 · 共 {appRows.length} 组</span>
            </div>
          </>
        )}
        {subtab === 'jobs' && (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center px-6 py-16">
            <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Jobs（批处理任务）</div>
            <div className="text-[12px] max-w-md" style={{ color: 'var(--text-muted)' }}>
              本系统当前没有 OpenRouter 意义上的批处理（Batch）任务概念，此处不展示占位假数据。待产品定义批任务后接入。
            </div>
          </div>
        )}
      </GlassCard>

      {selectedId ? <GenerationDetailsDrawer logId={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
