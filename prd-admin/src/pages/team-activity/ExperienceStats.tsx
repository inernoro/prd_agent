/**
 * 体验痛点指数 + 痛点声道占比（VOC 右侧面板，可折叠）。
 * 全部从痛点榜 insights items 现算，不额外请求后端：
 * - 痛点指数：按声道权重 × 影响人数 × log(频次) 的饱和曲线映射到 0-100（越低越健康，启发式）
 * - 声道占比：把洞察按类型归并为 报错/等待/停留/流失/横跳 五声道，按加权占比排条
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { GlassCard } from '@/components/design';
import type { BehaviorInsight } from '@/services/contracts/teamActivity';

const RED = '#f8717a';
const AMBER = '#fbbf24';
const VIOLET = '#a78bfa';
const GREEN = '#34d399';

// 声道权重（与后端 insights 严重度口径同向）
const KIND_W: Record<string, number> = {
  'api-error': 3,
  'quick-exit': 2.5,
  'slow-endpoint': 2,
  'route-oscillation': 2,
  'long-dwell': 1.5,
};

const CHANNELS: Record<string, { label: string; color: string }> = {
  'api-error': { label: '报错', color: RED },
  'quick-exit': { label: '秒退流失', color: RED },
  'slow-endpoint': { label: '等待过久', color: AMBER },
  'long-dwell': { label: '停留过久', color: AMBER },
  'route-oscillation': { label: '反复横跳', color: VIOLET },
};

function computePainIndex(items: BehaviorInsight[]): number {
  const open = items.filter((i) => i.status !== 'resolved' && i.status !== 'ignored');
  if (open.length === 0) return 0;
  const raw = open.reduce(
    (s, i) => s + (KIND_W[i.kind] ?? 2) * Math.max(1, i.userCount) * Math.log10(Math.max(10, i.eventCount + 10)),
    0
  );
  // 饱和曲线：少量痛点 ~40-60，大量痛点逼近 100
  return Math.min(100, Math.round((raw / (raw + 32)) * 100));
}

function computeChannels(items: BehaviorInsight[]) {
  const open = items.filter((i) => i.status !== 'resolved' && i.status !== 'ignored');
  const agg = new Map<string, number>();
  open.forEach((i) => {
    const w = (KIND_W[i.kind] ?? 2) * Math.max(1, i.userCount);
    agg.set(i.kind, (agg.get(i.kind) ?? 0) + w);
  });
  const total = [...agg.values()].reduce((a, b) => a + b, 0) || 1;
  return [...agg.entries()]
    .map(([kind, w]) => ({
      kind,
      label: CHANNELS[kind]?.label ?? kind,
      color: CHANNELS[kind]?.color ?? AMBER,
      pct: Math.round((w / total) * 100),
    }))
    .sort((a, b) => b.pct - a.pct);
}

/** 半圆仪表盘 + 数字 count-up */
function Gauge({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 1100);
      setShown(Math.round((1 - Math.pow(1 - p, 3)) * value));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value]);

  const R = 84;
  const cx = 104;
  const cy = 110;
  const len = Math.PI * R;
  const color = value < 40 ? GREEN : value < 70 ? '#fb923c' : RED;
  return (
    <svg viewBox="0 0 208 132" style={{ width: '100%', maxWidth: 220, height: 'auto', display: 'block', margin: '0 auto' }}>
      <defs>
        <linearGradient id="voc-gauge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={GREEN} />
          <stop offset="0.5" stopColor={AMBER} />
          <stop offset="1" stopColor={RED} />
        </linearGradient>
      </defs>
      <path d={`M${cx - R} ${cy} A${R} ${R} 0 0 1 ${cx + R} ${cy}`} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={13} strokeLinecap="round" />
      <path
        d={`M${cx - R} ${cy} A${R} ${R} 0 0 1 ${cx + R} ${cy}`}
        fill="none"
        stroke="url(#voc-gauge)"
        strokeWidth={13}
        strokeLinecap="round"
        style={{ strokeDasharray: len, strokeDashoffset: len * (1 - value / 100), transition: 'stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)' }}
      />
      <text x={cx} y={cy - 8} textAnchor="middle" style={{ fill: color, fontSize: 38, fontWeight: 800, transition: 'fill .8s' }}>
        {shown}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" style={{ fill: 'rgba(236,236,239,0.4)', fontSize: 10.5 }}>
        满分 100 · 越低越健康
      </text>
    </svg>
  );
}

export function ExperienceStats({ items, onCollapse }: { items: BehaviorInsight[]; onCollapse: () => void }) {
  const index = computePainIndex(items);
  const channels = computeChannels(items);
  const open = items.filter((i) => i.status !== 'resolved' && i.status !== 'ignored').length;

  return (
    <GlassCard className="flex flex-col" style={{ padding: 0 }}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-[13px] font-semibold text-white/85">体验痛点指数</span>
        <button
          type="button"
          onClick={onCollapse}
          title="折叠"
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="px-4 pb-2">
        <Gauge value={index} />
        <div className="text-center text-[11.5px] text-white/45 -mt-1">
          {index === 0 ? '当前窗口暂无未处理痛点' : `${open} 处待解决 · 修复后指数回落`}
        </div>
      </div>
      {channels.length > 0 ? (
        <div className="px-4 pb-4 pt-1 border-t border-white/[0.05] mt-1">
          <div className="text-[12px] text-white/55 font-medium mb-2.5 mt-2">痛点声道占比</div>
          <div className="flex flex-col gap-2.5">
            {channels.map((c) => (
              <div key={c.kind}>
                <div className="flex items-center justify-between text-[11.5px] mb-1">
                  <span className="text-white/70">{c.label}</span>
                  <span className="text-white/35 tabular-nums">{c.pct}%</span>
                </div>
                <div className="h-[7px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <div style={{ width: `${c.pct}%`, height: '100%', borderRadius: 4, background: c.color, transition: 'width .9s cubic-bezier(.2,.8,.2,1)' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </GlassCard>
  );
}
