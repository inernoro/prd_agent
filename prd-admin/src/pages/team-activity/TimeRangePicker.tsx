/**
 * 团队动态页头时间选择控件（方案1 + 方案2 结合，用户 2026-06-20 拍板）。
 * - 主体（方案2，用户最爱）：预设胶囊 全部/今天/本周/本月，每个 hover/focus 弹出锚定 popover
 *   （createPortal，非全屏），显示该范围真实「信号数 N / 痛点数 M + mini sparkline」微预览。
 * - 结合（方案1）：胶囊末尾「自定义范围」打开活动密度刷选条（锚定 popover），背景画近 ~90 天
 *   每天活动量/痛点密度柱，两个把手拖动刷选 [from,to]，拖动结束（onRelease）才提交，不在拖动中狂请求。
 * 数据：复用 GET /api/team-activity/experience-trend 取近 90 天每天 buckets（信号=total，痛点=errors+slow）。
 *   预设微预览数字 = 在该预设窗口内对 buckets 求和；密度柱/sparkline 同源。前端聚合，不新增后端端点。
 * 浮层遵守 frontend-modal.md（createPortal + inline 尺寸 + minHeight:0 + overscrollBehavior contain + ESC/点外关闭）。
 * 手机端遵守 mobile-first-density.md（控件紧凑、popover/刷选条触摸可用、不溢出、非全屏）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarRange, X } from 'lucide-react';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { getTeamActivityExperienceTrend } from '@/services';
import type { ExperienceTrendBucket } from '@/services/contracts/teamActivity';

const TEAL = '#2dd4bf';
const TEAL_SOFT = '#5eead4';
const ROSE = '#f8717a';
const DENSITY_DAYS = 90;

export type RangeKey = 'all' | 'today' | 'week' | 'month';

/** 时间选择：预设之一，或自定义起止区间（ISO 串） */
export type TeamRange = { kind: 'preset'; preset: RangeKey } | { kind: 'custom'; from: string; to: string };

const PRESET_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
];

/** 预设窗口起点（与原 rangeFrom 一致：今天/本周一/本月一号；全部=undefined） */
export function presetFrom(key: RangeKey): string | undefined {
  if (key === 'all') return undefined;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === 'week') {
    const day = (start.getDay() + 6) % 7; // 周一为一周起点
    start.setDate(start.getDate() - day);
  } else if (key === 'month') {
    start.setDate(1);
  }
  return start.toISOString();
}

/** 把 TeamRange 解析成发给后端的 from/to（preset 的 to 为 undefined=至今） */
export function resolveRange(range: TeamRange): { from?: string; to?: string } {
  if (range.kind === 'custom') return { from: range.from, to: range.to };
  // 「全部」名副其实：覆盖密度窗口（近 DENSITY_DAYS 天），与悬浮预览（汇 90 天）一致。
  // 不传 from 时后端 insights/热力图默认只聚合近 30 天，会与预览数字不符。
  if (range.preset === 'all') {
    const start = new Date(startOfDay(new Date()).getTime() - (DENSITY_DAYS - 1) * 86_400_000);
    return { from: start.toISOString(), to: undefined };
  }
  return { from: presetFrom(range.preset), to: undefined };
}

/** 当前选中的预设 key（自定义时为 null，用于 compare 文案等仅预设场景） */
export function rangePreset(range: TeamRange): RangeKey | null {
  return range.kind === 'preset' ? range.preset : null;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function fmtMD(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 自定义范围的胶囊回显文案：自定义 X–Y（今天结尾时显示「今天」） */
function customLabel(fromIso: string, toIso: string): string {
  const f = new Date(fromIso);
  const t = new Date(toIso);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return '自定义';
  const todayKey = startOfDay(new Date()).getTime();
  const tEnd = startOfDay(t).getTime() >= todayKey ? '今天' : fmtMD(t);
  return `自定义 ${fmtMD(f)}–${tEnd}`;
}

/** 一天的密度点：信号（total）与痛点（errors+slow） */
type DensityDay = { dayStart: number; signal: number; pain: number };

/** 把 buckets 折叠成近 N 天每天密度序列（buckets 已是天桶；补齐缺失日为 0） */
function buildDensity(buckets: ExperienceTrendBucket[]): DensityDay[] {
  const byDay = new Map<number, DensityDay>();
  for (const b of buckets) {
    const d = new Date(b.bucketStart);
    if (Number.isNaN(d.getTime())) continue;
    const key = startOfDay(d).getTime();
    const cur = byDay.get(key) ?? { dayStart: key, signal: 0, pain: 0 };
    cur.signal += b.total;
    cur.pain += b.errors + b.slow;
    byDay.set(key, cur);
  }
  const today = startOfDay(new Date()).getTime();
  const out: DensityDay[] = [];
  for (let i = DENSITY_DAYS - 1; i >= 0; i--) {
    const key = today - i * 86_400_000;
    out.push(byDay.get(key) ?? { dayStart: key, signal: 0, pain: 0 });
  }
  return out;
}

/** 在 [fromMs, toMs] 闭区间内对密度求和，得到该窗口的信号/痛点合计 */
function sumWindow(days: DensityDay[], fromMs: number | undefined, toMs: number): { signal: number; pain: number } {
  let signal = 0;
  let pain = 0;
  for (const d of days) {
    if (fromMs !== undefined && d.dayStart < startOfDay(new Date(fromMs)).getTime()) continue;
    if (d.dayStart > startOfDay(new Date(toMs)).getTime()) continue;
    signal += d.signal;
    pain += d.pain;
  }
  return { signal, pain };
}

/** mini sparkline path（信号曲线 + 淡填充），W×H 视口 */
function sparkPath(seg: number[], W: number, H: number): { line: string; area: string } {
  if (seg.length === 0) return { line: '', area: '' };
  const max = Math.max(1, ...seg);
  const step = seg.length > 1 ? W / (seg.length - 1) : W;
  let line = '';
  seg.forEach((v, i) => {
    const x = (seg.length > 1 ? i * step : W / 2).toFixed(1);
    const y = (H - 2 - (v / max) * (H - 4)).toFixed(1);
    line += `${i === 0 ? 'M' : 'L'}${x} ${y} `;
  });
  const area = `${line}L${W} ${H} L0 ${H} Z`;
  return { line, area };
}

type AnchorRect = { left: number; top: number; bottom: number; width: number };

export function TimeRangePicker({ value, onChange }: { value: TeamRange; onChange: (next: TeamRange) => void }) {
  const isMobile = useIsMobile();
  const [days, setDays] = useState<DensityDay[]>([]);
  const fetchIdRef = useRef(0);

  // 近 90 天密度序列（复用 experience-trend 天桶），用于预设微预览数字 + sparkline + 刷选条背景柱
  useEffect(() => {
    const id = ++fetchIdRef.current;
    const from = new Date(Date.now() - DENSITY_DAYS * 86_400_000).toISOString();
    void getTeamActivityExperienceTrend({ from }).then((res) => {
      if (fetchIdRef.current !== id) return;
      if (res.success) setDays(buildDensity(res.data.buckets));
    });
  }, []);

  const todayMs = startOfDay(new Date()).getTime();

  // 预设窗口起点（ms）：与 presetFrom 一致——本周=本周一0点、本月=1号0点（不是滚动近7/30天），
  // 保证悬浮微预览数字/sparkline 与点击后实际加载的时间窗一致，避免「真实聚合」误导。
  const weekStartMs = useMemo(() => new Date(presetFrom('week')!).getTime(), []);
  const monthStartMs = useMemo(() => new Date(presetFrom('month')!).getTime(), []);
  // 各预设窗口的信号/痛点合计（前端聚合 90 天序列；today 单日、week 本周至今、month 本月至今、all 全 90 天）
  const presetSummary = useMemo(() => {
    const map: Record<RangeKey, { signal: number; pain: number }> = {
      all: sumWindow(days, undefined, todayMs),
      today: sumWindow(days, todayMs, todayMs),
      week: sumWindow(days, weekStartMs, todayMs),
      month: sumWindow(days, monthStartMs, todayMs),
    };
    return map;
  }, [days, todayMs, weekStartMs, monthStartMs]);

  const presetSeg = useCallback(
    (key: RangeKey): number[] => {
      if (days.length === 0) return [];
      if (key === 'today') return days.slice(-1).map((d) => d.signal);
      // 切片天数 = 实际窗口天数（本周一/本月一号 至今），与 presetSummary 同口径
      if (key === 'week') return days.slice(-(Math.floor((todayMs - weekStartMs) / 86_400_000) + 1)).map((d) => d.signal);
      if (key === 'month') return days.slice(-(Math.floor((todayMs - monthStartMs) / 86_400_000) + 1)).map((d) => d.signal);
      return days.map((d) => d.signal);
    },
    [days, todayMs, weekStartMs, monthStartMs]
  );

  const activePreset = rangePreset(value);
  const [hoverKey, setHoverKey] = useState<RangeKey | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<AnchorRect | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openHover = useCallback((key: RangeKey, el: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const r = el.getBoundingClientRect();
    hoverTimer.current = setTimeout(() => {
      setHoverKey(key);
      setHoverAnchor({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
    }, 160);
  }, []);
  const closeHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverKey(null);
  }, []);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  // 自定义刷选条浮层
  const [brushOpen, setBrushOpen] = useState(false);
  const [brushAnchor, setBrushAnchor] = useState<AnchorRect | null>(null);
  const customBtnRef = useRef<HTMLButtonElement | null>(null);

  const openBrush = useCallback(() => {
    closeHover();
    const el = customBtnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBrushAnchor({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
    setBrushOpen(true);
  }, [closeHover]);

  const customDisplay = value.kind === 'custom' ? customLabel(value.from, value.to) : null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {PRESET_OPTIONS.map((p) => {
        const active = activePreset === p.key;
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange({ kind: 'preset', preset: p.key })}
            onMouseEnter={(e) => !isMobile && openHover(p.key, e.currentTarget)}
            onMouseLeave={() => !isMobile && closeHover()}
            onFocus={(e) => openHover(p.key, e.currentTarget)}
            onBlur={closeHover}
            className={`px-2.5 h-[26px] rounded-md text-[12px] border transition-colors cursor-pointer ${
              active
                ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/35'
                : 'bg-white/[0.03] text-white/50 border-white/10 hover:text-white/75 hover:border-white/20'
            }`}
          >
            {p.label}
          </button>
        );
      })}

      <button
        ref={customBtnRef}
        type="button"
        onClick={openBrush}
        title="活动密度刷选条：拖动两个把手刷选任意窗口"
        className={`inline-flex items-center gap-1.5 px-2.5 h-[26px] rounded-md text-[12px] border transition-colors cursor-pointer ${
          customDisplay
            ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/35'
            : 'bg-white/[0.03] text-white/50 border-white/10 hover:text-white/75 hover:border-white/20'
        }`}
      >
        <CalendarRange size={13} />
        {customDisplay ?? '自定义范围'}
      </button>

      {/* 方案2 悬浮微预览 popover（createPortal 锚定，非全屏） */}
      {hoverKey && hoverAnchor
        ? createPortal(
            <MicroPreview
              anchor={hoverAnchor}
              label={PRESET_OPTIONS.find((p) => p.key === hoverKey)?.label ?? ''}
              summary={presetSummary[hoverKey]}
              seg={presetSeg(hoverKey)}
              loading={days.length === 0}
            />,
            document.body
          )
        : null}

      {/* 方案1 活动密度刷选条 popover（createPortal 锚定，拖动结束才提交） */}
      {brushOpen && brushAnchor
        ? createPortal(
            <BrushPopover
              anchor={brushAnchor}
              isMobile={isMobile}
              days={days}
              initial={value}
              onClose={() => setBrushOpen(false)}
              onApply={(from, to) => {
                onChange({ kind: 'custom', from, to });
                setBrushOpen(false);
              }}
            />,
            document.body
          )
        : null}
    </div>
  );
}

/** 锚定悬浮微预览：信号/痛点数字 + mini sparkline */
function MicroPreview({
  anchor,
  label,
  summary,
  seg,
  loading,
}: {
  anchor: AnchorRect;
  label: string;
  summary: { signal: number; pain: number };
  seg: number[];
  loading: boolean;
}) {
  const width = 188;
  // 默认锚定胶囊下方居中；越界时夹回视口
  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - 8);
  const top = anchor.bottom + 8;
  const { line, area } = sparkPath(seg, 160, 26);
  return (
    <div
      className="rounded-[11px] border px-3 py-3 pointer-events-none"
      style={{
        position: 'fixed',
        left,
        top,
        width,
        zIndex: 10040,
        background: '#1a1c20',
        borderColor: 'rgba(255,255,255,0.16)',
        boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
        animation: 'voc-micro-in .16s ease both',
      }}
    >
      <style>{`@keyframes voc-micro-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div className="text-[11px] text-white/40 mb-2">{label} · 真实聚合</div>
      <div className="flex gap-3.5 mb-2">
        <div>
          <div className="text-[17px] font-semibold tabular-nums" style={{ color: TEAL_SOFT }}>
            {loading ? '—' : summary.signal.toLocaleString()}
          </div>
          <div className="text-[10px] text-white/40">信号</div>
        </div>
        <div>
          <div className="text-[17px] font-semibold tabular-nums" style={{ color: ROSE }}>
            {loading ? '—' : summary.pain.toLocaleString()}
          </div>
          <div className="text-[10px] text-white/40">痛点</div>
        </div>
      </div>
      {seg.length > 0 ? (
        <svg viewBox="0 0 160 26" preserveAspectRatio="none" style={{ width: '100%', height: 26, display: 'block' }}>
          <path d={area} fill="rgba(45,212,191,0.10)" stroke="none" />
          <path d={line} fill="none" stroke={TEAL_SOFT} strokeWidth={1.6} strokeLinejoin="round" />
        </svg>
      ) : (
        <div className="h-[26px] flex items-center text-[10px] text-white/25">暂无密度数据</div>
      )}
    </div>
  );
}

const BRUSH_W = 1000;
const BRUSH_H = 64;

/** 活动密度刷选条浮层：背景密度柱 + 两把手拖动刷选，onRelease(拖动结束)才 apply */
function BrushPopover({
  anchor,
  isMobile,
  days,
  initial,
  onClose,
  onApply,
}: {
  anchor: AnchorRect;
  isMobile: boolean;
  days: DensityDay[];
  initial: TeamRange;
  onClose: () => void;
  onApply: (from: string, to: string) => void;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // 选区为天索引 [lo, hi]（含端点），0 = 最早一天，days.length-1 = 今天
  const n = days.length;
  const initialSel = useMemo<[number, number]>(() => {
    if (n === 0) return [0, 0];
    if (initial.kind === 'custom') {
      const fromKey = startOfDay(new Date(initial.from)).getTime();
      const toKey = startOfDay(new Date(initial.to)).getTime();
      let lo = days.findIndex((d) => d.dayStart >= fromKey);
      if (lo < 0) lo = 0;
      let hi = days.length - 1;
      for (let i = days.length - 1; i >= 0; i--) {
        if (days[i].dayStart <= toKey) { hi = i; break; }
      }
      return [Math.min(lo, hi), Math.max(lo, hi)];
    }
    // 预设映射到与 presetFrom/实际加载一致的刷选窗口（今天/本周一/本月一号/全部90天），
    // 不再用滚动近7/近30天，避免未拖动直接「应用范围」提交与当前预设不一致的窗口。
    if (initial.preset === 'today') return [n - 1, n - 1];
    if (initial.preset === 'all') return [0, n - 1];
    const startIso = presetFrom(initial.preset); // week / month 非空
    const startKey = startIso ? startOfDay(new Date(startIso)).getTime() : days[0].dayStart;
    let lo = days.findIndex((d) => d.dayStart >= startKey);
    if (lo < 0) lo = 0;
    return [lo, n - 1];
  }, [days, initial, n]);

  const [sel, setSel] = useState<[number, number]>(initialSel);
  const dragRef = useRef<null | { which: 'L' | 'R' | 'M'; startFrac: number; loStart: number; hiStart: number }>(null);
  // 用户是否已动过刷选条。popover 在密度数据(days)加载前打开时 initialSel 退化为 [0,0]，
  // 而 useState 只取一次初值——若不重算，days 到达后 Apply 会以「最早一天」为窗口（错误的历史窗）。
  // 只要用户尚未交互，就在 days 由空变满时把 sel 重置为意图中的初始窗口；用户已拖动则不再覆盖。
  const userInteractedRef = useRef(false);
  useEffect(() => {
    if (userInteractedRef.current) return;
    setSel(initialSel);
    // 依赖 n（days.length）：从 0 变为加载完成时触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  const [popPos, setPopPos] = useState<{ left: number; top: number; width: number }>({ left: 0, top: 0, width: 0 });

  const width = isMobile ? Math.min(window.innerWidth - 16, 360) : Math.min(window.innerWidth - 24, 560);

  useLayoutEffect(() => {
    // 锚定到按钮下方右对齐，越界夹回视口
    const left = Math.min(Math.max(8, anchor.left + anchor.width - width), window.innerWidth - width - 8);
    const top = anchor.bottom + 8;
    setPopPos({ left, top, width });
  }, [anchor, width]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const max = useMemo(() => Math.max(1, ...days.map((d) => d.signal)), [days]);

  const fracToIdx = useCallback((frac: number) => Math.round(frac * Math.max(0, n - 1)), [n]);
  const clientToFrac = useCallback((clientX: number) => {
    const el = overlayRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }, []);

  const startDrag = useCallback(
    (which: 'L' | 'R' | 'M', clientX: number) => {
      userInteractedRef.current = true; // 一旦动手，days 后续到达不再覆盖用户选区
      const frac = clientToFrac(clientX);
      dragRef.current = { which, startFrac: frac, loStart: sel[0], hiStart: sel[1] };
      document.body.style.cursor = 'ew-resize';
    },
    [clientToFrac, sel]
  );

  useEffect(() => {
    const onMove = (clientX: number) => {
      const d = dragRef.current;
      if (!d || n === 0) return;
      const frac = clientToFrac(clientX);
      const idx = fracToIdx(frac);
      setSel(([lo, hi]) => {
        if (d.which === 'L') return [Math.min(idx, hi), hi];
        if (d.which === 'R') return [lo, Math.max(idx, lo)];
        // 平移整窗：保持窗宽
        const span = d.hiStart - d.loStart;
        const startIdx = fracToIdx(d.startFrac);
        let nlo = d.loStart + (idx - startIdx);
        nlo = Math.min(Math.max(0, nlo), Math.max(0, n - 1 - span));
        return [nlo, nlo + span];
      });
    };
    const onMouseMove = (e: MouseEvent) => onMove(e.clientX);
    const onTouchMove = (e: TouchEvent) => {
      if (!dragRef.current) return;
      if (e.touches[0]) { e.preventDefault(); onMove(e.touches[0].clientX); }
    };
    const onUp = () => {
      if (dragRef.current) { dragRef.current = null; document.body.style.cursor = ''; }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    };
  }, [clientToFrac, fracToIdx, n]);

  const summary = useMemo(() => {
    if (n === 0) return { signal: 0, pain: 0 };
    let signal = 0;
    let pain = 0;
    for (let i = sel[0]; i <= sel[1]; i++) {
      signal += days[i].signal;
      pain += days[i].pain;
    }
    return { signal, pain };
  }, [days, sel, n]);

  const rangeLabel = useMemo(() => {
    if (n === 0) return '—';
    const f = new Date(days[sel[0]].dayStart);
    const tEnd = sel[1] >= n - 1 ? '今天' : fmtMD(new Date(days[sel[1]].dayStart));
    return `${fmtMD(f)} – ${tEnd}`;
  }, [days, sel, n]);

  const apply = useCallback(() => {
    if (n === 0) return;
    const from = new Date(days[sel[0]].dayStart).toISOString();
    // 结束日含当天：取所选末日的 23:59:59.999
    const endDay = new Date(days[sel[1]].dayStart);
    const to = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate(), 23, 59, 59, 999).toISOString();
    onApply(from, to);
  }, [days, sel, n, onApply]);

  const loFrac = n > 1 ? sel[0] / (n - 1) : 0;
  const hiFrac = n > 1 ? sel[1] / (n - 1) : 1;

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'fixed',
        left: popPos.left,
        top: popPos.top,
        width: popPos.width,
        zIndex: 10030,
        background: '#1a1c20',
        border: '1px solid rgba(255,255,255,0.16)',
        borderRadius: 13,
        boxShadow: '0 20px 50px rgba(0,0,0,0.55)',
        minHeight: 0,
        overscrollBehavior: 'contain',
        animation: 'voc-brush-in .2s ease both',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <style>{`@keyframes voc-brush-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      {/* 点外关闭遮罩（透明，捕获页面其它点击） */}
      {createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 10029 }} onClick={onClose} />,
        document.body
      )}
      <div className="relative" style={{ zIndex: 10031, padding: isMobile ? '12px 12px 10px' : '14px 16px 12px' }}>
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-[12px] font-semibold text-white/80">活动密度刷选条</span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-5 h-5 rounded text-white/40 hover:text-white/80 cursor-pointer"
            title="关闭"
          >
            <X size={13} />
          </button>
        </div>

        {/* 密度柱 + 选区窗口 + 两把手 */}
        <div style={{ position: 'relative', height: BRUSH_H }}>
          <svg viewBox={`0 0 ${BRUSH_W} ${BRUSH_H}`} preserveAspectRatio="none" style={{ width: '100%', height: BRUSH_H, display: 'block', overflow: 'visible' }}>
            {days.map((d, i) => {
              const bw = BRUSH_W / Math.max(1, n);
              const x = i * bw;
              const h = (d.signal / max) * (BRUSH_H - 6);
              const painH = (d.pain / max) * (BRUSH_H - 6);
              return (
                <g key={d.dayStart}>
                  <rect x={x + 0.6} y={BRUSH_H - h} width={Math.max(0.4, bw - 1.2)} height={h} rx={0.8} fill="rgba(45,212,191,0.28)" />
                  {painH > 0.5 ? (
                    <rect x={x + 0.6} y={BRUSH_H - painH} width={Math.max(0.4, bw - 1.2)} height={painH} rx={0.8} fill="rgba(248,113,122,0.55)" />
                  ) : null}
                </g>
              );
            })}
          </svg>
          {/* 交互层：拖动把手/平移窗口 */}
          <div
            style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
            onMouseDown={(e) => {
              const frac = clientToFrac(e.clientX);
              if (frac >= loFrac && frac <= hiFrac) startDrag('M', e.clientX);
              else if (frac < loFrac) { setSel([fracToIdx(frac), sel[1]]); startDrag('L', e.clientX); }
              else { setSel([sel[0], fracToIdx(frac)]); startDrag('R', e.clientX); }
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${loFrac * 100}%`,
                width: `${(hiFrac - loFrac) * 100}%`,
                background: 'rgba(45,212,191,0.12)',
                borderLeft: `2px solid ${TEAL}`,
                borderRight: `2px solid ${TEAL}`,
                boxShadow: 'inset 0 0 30px rgba(45,212,191,0.08)',
              }}
            >
              <BrushHandle side="left" onStart={(cx) => startDrag('L', cx)} />
              <BrushHandle side="right" onStart={(cx) => startDrag('R', cx)} />
            </div>
          </div>
        </div>
        <div className="flex justify-between mt-2 text-[10px] text-white/35">
          <span>{n > 0 ? fmtMD(new Date(days[0].dayStart)) : ''}</span>
          <span>{n > 1 ? fmtMD(new Date(days[Math.floor(n / 2)].dayStart)) : ''}</span>
          <span>今天</span>
        </div>

        {/* 回显 + 应用 */}
        <div className="flex items-center gap-2.5 flex-wrap mt-3 pt-3 border-t border-white/[0.08]">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/[0.04] text-[11px]">
            <span className="text-white/40">窗口</span>
            <span className="font-semibold tabular-nums" style={{ color: TEAL_SOFT }}>{rangeLabel}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/[0.04] text-[11px]">
            <span className="text-white/40">信号</span>
            <span className="font-semibold tabular-nums text-white/85">{summary.signal.toLocaleString()}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/[0.04] text-[11px]">
            <span className="text-white/40">痛点</span>
            <span className="font-semibold tabular-nums" style={{ color: ROSE }}>{summary.pain.toLocaleString()}</span>
          </span>
          <button
            type="button"
            onClick={apply}
            disabled={n === 0}
            className="ml-auto inline-flex items-center px-3 h-[28px] rounded-md text-[12px] font-semibold border border-cyan-500/35 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            应用范围
          </button>
        </div>
      </div>
    </div>
  );
}

/** 刷选把手：鼠标 + 触摸两路启动拖动 */
function BrushHandle({ side, onStart }: { side: 'left' | 'right'; onStart: (clientX: number) => void }) {
  return (
    <div
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); onStart(e.clientX); }}
      onTouchStart={(e) => { e.stopPropagation(); if (e.touches[0]) onStart(e.touches[0].clientX); }}
      style={{
        position: 'absolute',
        top: '50%',
        left: side === 'left' ? '0' : '100%',
        transform: 'translate(-50%,-50%)',
        width: 16,
        height: 32,
        borderRadius: 5,
        background: TEAL,
        cursor: 'ew-resize',
        boxShadow: '0 2px 8px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        touchAction: 'none',
      }}
    >
      <span style={{ width: 1.5, height: 12, background: 'rgba(13,14,16,0.6)', borderRadius: 1 }} />
      <span style={{ width: 1.5, height: 12, background: 'rgba(13,14,16,0.6)', borderRadius: 1 }} />
    </div>
  );
}
