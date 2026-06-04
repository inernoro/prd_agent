import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, Users, Clock, X, UserCircle2, Download, FileText } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import { listStoreViewEvents, getStoreAnalytics, listAllStoresViewEvents, getAllStoresAnalytics } from '@/services';
import type {
  DocumentStoreViewEvent,
  DocumentStoreAnalytics,
} from '@/services/contracts/documentStore';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { EChart } from '@/components/charts/EChart';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';

// 图表配色走「主题中性」：mid-gray 在白天/黑夜两套主题都看得清，避免 ECharts canvas
// 不随主题切换重绘导致的对比度问题（呼应 cds-theme-tokens 规则）。
const AXIS_LABEL = 'rgba(130,130,140,0.85)';
const SPLIT_LINE = 'rgba(130,130,140,0.16)';
const SERIES_BLUE = '#60a5fa';
const SERIES_INDIGO = '#818cf8';

// ── 时间 / 时长格式化 ──

function formatRelative(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso).getTime();
  const diff = Date.now() - date;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

// 聚合统计「总停留 / 平均停留」用：始终给出一个数值文案。
function formatDurationMs(ms?: number): string {
  if (!ms || ms < 1000) return '< 1 秒';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时 ${min % 60} 分`;
}

// 单条访问「停留」用：埋点只累计「前台可见」时长，离开/切 tab/关页时经 sendBeacon 补写。
// durationMs 为 0/缺失 = leave 信标未送达（硬关浏览器等），与「真的看了不到 1 秒」语义不同，
// 显示为「—」避免误导，而不是谎报「< 1 秒」。
function formatDwell(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  return formatDurationMs(ms);
}

function formatRate(r?: number): string {
  if (r == null || Number.isNaN(r)) return '—';
  return `${Math.round(r * 100)}%`;
}

// 本地时区 UTC 偏移（形如 "+08:00"），交给后端按用户本地时区划分日界/小时桶。
function localTzOffset(): string {
  const off = -new Date().getTimezoneOffset(); // 东区为正，中国 = +480
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 导出当前已加载的访问明细（最近 50 条流水），加 BOM 让 Excel 正确识别 UTF-8 中文。
function exportCsv(events: DocumentStoreViewEvent[], storeName: string) {
  const header = ['访客', '类型', '文档', '进入时间', '停留(秒)', '访问次数'];
  const rows = events.map(e => [
    e.viewerName,
    e.viewerUserId ? '登录' : '匿名',
    e.entryTitle ?? '',
    new Date(e.enteredAt).toLocaleString('zh-CN'),
    e.durationMs && e.durationMs > 0 ? Math.round(e.durationMs / 1000) : '',
    (e.revisitCount ?? 0) + 1,
  ]);
  const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `访客记录_${storeName}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const RANGE_OPTIONS: { label: string; days: number }[] = [
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
  { label: '近 90 天', days: 90 },
];

// ── Drawer ──

// scope='store'：单个知识库；scope='account'：我名下所有知识库聚合（列表页「统计」入口）。
export type ViewersDrawerProps = { onClose: () => void } & (
  | { scope?: 'store'; storeId: string; storeName: string }
  | { scope: 'account'; storeId?: undefined; storeName?: undefined }
);

export function ViewersDrawer(props: ViewersDrawerProps) {
  const { onClose } = props;
  const isAccount = props.scope === 'account';
  const storeId = isAccount ? null : props.storeId;
  const headerSub = isAccount ? '全部知识库 · 我的空间' : (props.storeName ?? '');
  const exportName = isAccount ? '全部知识库' : (props.storeName ?? '知识库');

  const [eventsLoading, setEventsLoading] = useState(true);
  const [events, setEvents] = useState<DocumentStoreViewEvent[]>([]);
  const [analytics, setAnalytics] = useState<DocumentStoreAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [days, setDays] = useState(30);
  const tz = useMemo(() => localTzOffset(), []);

  // 流水列表加载一次（始终展示最近活动，不随时间档变化）
  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    const res = isAccount ? await listAllStoresViewEvents(50) : await listStoreViewEvents(storeId!, 50);
    if (res.success) {
      setEvents(res.data.events);
    } else {
      toast.error('加载访客列表失败', res.error?.message);
    }
    setEventsLoading(false);
  }, [isAccount, storeId]);

  // 聚合报表随时间档重新拉取
  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    const res = isAccount ? await getAllStoresAnalytics(days, tz) : await getStoreAnalytics(storeId!, days, tz);
    if (res.success) {
      setAnalytics(res.data);
    } else {
      toast.error('加载访客报表失败', res.error?.message);
    }
    setAnalyticsLoading(false);
  }, [isAccount, storeId, days, tz]);

  useEffect(() => { loadEvents(); }, [loadEvents]);
  useEffect(() => { loadAnalytics(); }, [loadAnalytics]);

  // ESC 关闭（遵循 frontend-modal 规则）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trendOption = useMemo<EChartsOption | null>(() => {
    if (!analytics) return null;
    return {
      grid: { left: 34, right: 12, top: 12, bottom: 22 },
      tooltip: { trigger: 'axis', confine: true },
      xAxis: {
        type: 'category',
        data: analytics.trend.map(t => t.date),
        axisLabel: { color: AXIS_LABEL, fontSize: 9, formatter: (v: string) => v.slice(5), hideOverlap: true },
        axisLine: { lineStyle: { color: SPLIT_LINE } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value', minInterval: 1,
        axisLabel: { color: AXIS_LABEL, fontSize: 9 },
        splitLine: { lineStyle: { color: SPLIT_LINE } },
      },
      series: [{
        name: '访问量', type: 'line', smooth: true, symbol: 'none',
        data: analytics.trend.map(t => t.views),
        lineStyle: { color: SERIES_BLUE, width: 2 },
        areaStyle: { color: 'rgba(96,165,250,0.16)' },
      }],
    };
  }, [analytics]);

  const hourlyOption = useMemo<EChartsOption | null>(() => {
    if (!analytics) return null;
    return {
      grid: { left: 28, right: 12, top: 12, bottom: 20 },
      tooltip: { trigger: 'axis', confine: true },
      xAxis: {
        type: 'category',
        data: analytics.hourly.map(h => String(h.hour)),
        axisLabel: { color: AXIS_LABEL, fontSize: 9, interval: 2, formatter: (v: string) => `${v}时` },
        axisLine: { lineStyle: { color: SPLIT_LINE } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value', minInterval: 1,
        axisLabel: { color: AXIS_LABEL, fontSize: 9 },
        splitLine: { lineStyle: { color: SPLIT_LINE } },
      },
      series: [{
        name: '访问量', type: 'bar',
        data: analytics.hourly.map(h => h.views),
        itemStyle: { color: SERIES_INDIGO, borderRadius: [2, 2, 0, 0] },
      }],
    };
  }, [analytics]);

  const kpi = analytics?.kpi;

  const drawer = (
    <div className="surface-backdrop fixed inset-0 z-[10000] flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* 面板底色用不透明 token var(--bg-elevated)：surface-popover 的 --panel-solid
          在暗色仅 92% 不透明，叠加 backdrop blur 会透出底层页面头部（分享/上传按钮），
          与 SiteViewersDrawer 保持一致的不透明处理。 */}
      <div className="surface-popover flex h-full w-[560px] max-w-[94vw] flex-col border-l border-token-subtle"
        style={{ background: 'var(--bg-elevated)' }}>

        {/* 头部 */}
        <div className="surface-panel-header flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
              <Users size={15} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">
                {isAccount ? '访客统计 · 全部知识库' : '访客记录'}
              </p>
              <p className="truncate text-[10px] text-token-muted">
                {headerSub}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {/* 时间档 + 导出 */}
          <div className="mx-5 mt-4 flex items-center justify-between gap-2">
            <div className="inline-flex rounded-[8px] p-0.5" style={{ background: 'var(--bg-input)' }}>
              {RANGE_OPTIONS.map(opt => (
                <button key={opt.days}
                  onClick={() => setDays(opt.days)}
                  className="cursor-pointer rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={days === opt.days
                    ? { background: 'var(--accent-primary, #818cf8)', color: '#fff' }
                    : { color: 'var(--text-muted)' }}>
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => exportCsv(events, exportName)}
              disabled={events.length === 0}
              title="导出当前已加载的最近 50 条访问明细为 CSV"
              className="inline-flex items-center gap-1 rounded-[8px] px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
              <Download size={12} /> 导出
            </button>
          </div>

          {analyticsLoading && !analytics ? (
            <div className="flex items-center justify-center py-16">
              <MapSectionLoader text="加载访客报表…" />
            </div>
          ) : (
            <>
              {/* KPI：首行三大指标 + 次行三衍生指标 */}
              <div className="surface-inset mx-5 mt-3 rounded-[12px] p-4" style={{ position: 'relative' }}>
                {analyticsLoading && (
                  <div className="absolute right-3 top-3"><MapSpinner size={12} /></div>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <StatTile icon={<Eye size={14} style={{ color: 'rgba(96,165,250,0.9)' }} />}
                    label="总访问量" value={kpi?.totalViews ?? 0} />
                  <StatTile icon={<Users size={14} style={{ color: 'rgba(168,85,247,0.9)' }} />}
                    label="独立访客" value={kpi?.uniqueVisitors ?? 0} />
                  <StatTile icon={<Clock size={14} style={{ color: 'rgba(74,222,128,0.9)' }} />}
                    label="总停留" value={formatDurationMs(kpi?.totalDurationMs)} />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3 border-t border-token-subtle pt-3">
                  <StatTile small label="平均停留" value={kpi ? formatDurationMs(kpi.avgDurationMs) : '—'} />
                  <StatTile small label="回访率" value={formatRate(kpi?.returningRate)} />
                  <StatTile small label="跳出率" value={formatRate(kpi?.bounceRate)} />
                </div>
              </div>

              {/* 访问趋势 */}
              <ChartCard title="访问趋势">
                {trendOption && <EChart option={trendOption} height={132} />}
              </ChartCard>

              {/* 时段分布 */}
              <ChartCard title="访问时段分布（本地时区）">
                {hourlyOption && <EChart option={hourlyOption} height={120} />}
              </ChartCard>

              {/* 停留分布 */}
              <ChartCard title="停留时长分布">
                <DwellBars buckets={analytics?.dwellBuckets} />
              </ChartCard>

              {/* 文档排行 */}
              <ChartCard title="文档访问排行">
                <TopEntries items={analytics?.topEntries ?? []} />
              </ChartCard>
            </>
          )}

          {/* 最近访问流水 */}
          <div className="mx-5 mt-5 mb-5">
            <p className="mb-3 text-[11px] font-semibold text-token-muted">
              最近 {events.length} 次访问
            </p>
            {eventsLoading ? (
              <div className="py-6"><MapSectionLoader text="加载访客明细…" /></div>
            ) : events.length === 0 ? (
              <div className="surface-inset rounded-[10px] border border-dashed border-token-subtle py-10 text-center">
                <Eye size={22} className="mx-auto mb-2 text-token-muted opacity-30" />
                <p className="text-[11px] text-token-muted">还没有访客记录</p>
                <p className="mt-1 text-[10px] text-token-muted-faint">
                  把知识库设为公开后，访客浏览会在这里显示
                </p>
              </div>
            ) : (
              <ol className="space-y-1">
                {events.map(ev => <ViewEventRow key={ev.id} ev={ev} />)}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(drawer, document.body);
}

function StatTile({ icon, label, value, small }: { icon?: React.ReactNode; label: string; value: number | string; small?: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[10px] text-token-muted">{label}</span>
      </div>
      <p className={`font-bold text-token-primary ${small ? 'text-[13px]' : 'text-[16px]'}`}>{value}</p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-5 mt-3">
      <p className="mb-1.5 text-[11px] font-semibold text-token-muted">{title}</p>
      <div className="surface-inset rounded-[12px] p-2.5">
        {children}
      </div>
    </div>
  );
}

function DwellBars({ buckets }: { buckets?: DocumentStoreAnalytics['dwellBuckets'] }) {
  const rows: { label: string; value: number; color: string }[] = [
    { label: '< 5 秒', value: buckets?.lt5s ?? 0, color: 'rgba(248,113,113,0.75)' },
    { label: '5-30 秒', value: buckets?.s5_30 ?? 0, color: 'rgba(251,191,36,0.8)' },
    { label: '30 秒-2 分', value: buckets?.s30_2m ?? 0, color: 'rgba(96,165,250,0.8)' },
    { label: '> 2 分', value: buckets?.gt2m ?? 0, color: 'rgba(74,222,128,0.8)' },
  ];
  const measured = buckets?.measured ?? 0;
  if (measured === 0) {
    return <p className="py-3 text-center text-[11px] text-token-muted">暂无可测得的停留数据</p>;
  }
  return (
    <div className="space-y-1.5 py-0.5">
      {rows.map(r => {
        const pct = measured > 0 ? Math.round((r.value / measured) * 100) : 0;
        return (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-[60px] flex-shrink-0 text-[10px] text-token-muted">{r.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--bg-input)' }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: r.color }} />
            </div>
            <span className="w-[64px] flex-shrink-0 text-right text-[10px] tabular-nums text-token-secondary">
              {r.value} · {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TopEntries({ items }: { items: DocumentStoreAnalytics['topEntries'] }) {
  if (items.length === 0) {
    return <p className="py-3 text-center text-[11px] text-token-muted">暂无文档访问数据</p>;
  }
  const max = Math.max(...items.map(i => i.views), 1);
  return (
    <ol className="space-y-1 py-0.5">
      {items.map((it, idx) => (
        <li key={it.entryId ?? idx} className="flex items-center gap-2 rounded-[6px] px-1.5 py-1">
          <span className="w-4 flex-shrink-0 text-center text-[10px] font-bold tabular-nums text-token-muted">{idx + 1}</span>
          <FileText size={12} className="flex-shrink-0 text-token-muted" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] text-token-primary">{it.title ?? '（已删除文档）'}</p>
            <div className="mt-0.5 h-1 overflow-hidden rounded-full" style={{ background: 'var(--bg-input)' }}>
              <div className="h-full rounded-full" style={{ width: `${Math.round((it.views / max) * 100)}%`, background: SERIES_INDIGO }} />
            </div>
          </div>
          <span className="flex-shrink-0 text-right text-[10px] tabular-nums text-token-secondary">
            {it.views} 次 · {formatDwell(it.totalDurationMs)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ViewEventRow({ ev }: { ev: DocumentStoreViewEvent }) {
  const revisits = ev.revisitCount ?? 0;
  return (
    <li className="surface-row flex items-center gap-2.5 rounded-[8px] px-2.5 py-2">
      {ev.viewerUserId ? (
        // 登录访客：渲染真实头像（resolveAvatarUrl 自动兜底 nohead.png）
        <UserAvatar
          src={resolveAvatarUrl({ avatarFileName: ev.viewerAvatar })}
          alt={ev.viewerName}
          className="w-7 h-7 flex-shrink-0 rounded-full object-cover"
        />
      ) : (
        // 匿名访客：无头像，沿用占位图标
        <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
          style={{
            background: 'rgba(148,163,184,0.1)',
            border: '1px solid rgba(148,163,184,0.2)',
          }}>
          <UserCircle2 size={15} style={{ color: 'rgba(148,163,184,0.9)' }} />
        </div>
      )}
      {/* 中段取自然高度（姓名 + 文档名两行），紧凑不留白 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold text-token-primary">
            {ev.viewerName}
          </span>
          {!ev.viewerUserId && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
              style={{ background: 'rgba(148,163,184,0.1)', color: 'rgba(148,163,184,0.9)' }}>
              匿名
            </span>
          )}
        </div>
        {ev.entryTitle && (
          <p className="truncate text-[11px] text-token-secondary">
            {ev.entryTitle}
          </p>
        )}
      </div>
      {/* 时间 + 停留靠右，填满原本空荡的右侧 */}
      <div className="flex flex-shrink-0 flex-col items-end gap-0.5 text-[10px] text-token-muted">
        <span>{formatRelative(ev.enteredAt)}</span>
        <span>
          停留 {formatDwell(ev.durationMs)}
          {revisits > 0 && ` · ${revisits + 1} 次`}
        </span>
      </div>
    </li>
  );
}
