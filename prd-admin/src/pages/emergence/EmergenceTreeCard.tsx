import { useMemo } from 'react';
import { Sparkle, Flame } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { getTreeVisual, hsla } from './emergenceFingerprint';

interface TreeSummary {
  id: string;
  title: string;
  description?: string;
  nodeCount: number;
  updatedAt: string;
}

interface Props {
  tree: TreeSummary;
  onOpen: (id: string) => void;
}

/**
 * 涌现树卡片 —— 每棵树都有独特"视觉指纹"：
 * - 左上角渐变光晕（色相从标题哈希派生）
 * - 中央花蕾/发光核 + 轨道粒子（粒子数量随节点数增长）
 * - 右上角热度火苗（最近更新越接近 24h 越亮）
 *
 * 与右侧原本单调的文字信息协同：形 + 数 + 色 三通道表达树的气质。
 */
export function EmergenceTreeCard({ tree, onOpen }: Props) {
  const v = useMemo(
    () => getTreeVisual(tree.title, tree.nodeCount, tree.updatedAt),
    [tree.title, tree.nodeCount, tree.updatedAt],
  );

  const days = Math.floor((Date.now() - new Date(tree.updatedAt).getTime()) / 86_400_000);
  const freshness =
    days <= 0 ? '今天' : days === 1 ? '昨天' : days < 7 ? `${days} 天前` : new Date(tree.updatedAt).toLocaleDateString();

  const showFlame = v.warmth > 0.55;

  return (
    <GlassCard
      animated
      interactive
      padding="none"
      className="group relative flex flex-col h-full overflow-hidden"
      onClick={() => onOpen(tree.id)}
    >
      {/* 背景指纹光晕（绝对定位，不影响内容） */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(120% 80% at 15% 0%, ${hsla(v.hue, 85, 60, 0.22)} 0%, transparent 55%),
                       radial-gradient(100% 70% at 100% 100%, ${hsla(v.hueSecondary, 75, 55, 0.14)} 0%, transparent 60%)`,
          mixBlendMode: 'screen',
        }}
      />
      {/* 上半部分：视觉指纹（花蕾 + 轨道） */}
      <div
        className="relative h-[128px] flex items-center justify-center"
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          background: `linear-gradient(180deg, ${hsla(v.hue, 70, 18, 0.35)} 0%, rgba(0,0,0,0) 100%)`,
        }}
      >
        <BloomVisual visual={v} nodeCount={tree.nodeCount} />

        {/* 右上角热度指示 */}
        {showFlame && (
          <div
            className="absolute top-3 right-3 flex items-center gap-1 px-2 py-0.5 rounded-full"
            style={{
              background: `rgba(234,88,12,${0.12 + v.warmth * 0.14})`,
              border: `1px solid rgba(234,88,12,${0.25 + v.warmth * 0.2})`,
              backdropFilter: 'blur(10px)',
            }}
          >
            <Flame size={10} style={{ color: `rgba(251,146,60,${0.6 + v.warmth * 0.35})` }} />
            <span className="text-[9px] font-semibold tracking-wide" style={{ color: `rgba(251,146,60,${0.7 + v.warmth * 0.25})` }}>
              HOT
            </span>
          </div>
        )}

        {/* 左上角节点数徽章（胶囊） */}
        <div
          className="absolute top-3 left-3 flex items-center gap-1 px-2 py-0.5 rounded-full"
          style={{
            background: hsla(v.hue, 55, 25, 0.55),
            border: `1px solid ${hsla(v.hue, 65, 55, 0.3)}`,
            backdropFilter: 'blur(12px)',
          }}
        >
          <Sparkle size={9} style={{ color: hsla(v.hue, 75, 70, 0.9) }} />
          <span className="text-[10px] font-semibold tabular-nums" style={{ color: hsla(v.hue, 30, 92, 0.95) }}>
            {tree.nodeCount}
          </span>
        </div>
      </div>

      {/* 下半部分：信息 */}
      <div className="relative p-4 flex-1 flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold leading-snug line-clamp-2" style={{ color: 'var(--text-primary)' }}>
          {tree.title}
        </h3>
        {tree.description && (
          <p className="text-[11px] leading-[1.5] line-clamp-2" style={{ color: 'var(--text-muted)' }}>
            {tree.description}
          </p>
        )}

        {/* 进度条（节点数映射至 0-20 区间，越粗代表越茂盛） */}
        <div className="mt-auto pt-3 flex items-center gap-2">
          <div
            className="flex-1 h-1 rounded-full overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.05)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(100, (tree.nodeCount / 20) * 100)}%`,
                background: `linear-gradient(90deg, ${hsla(v.hue, 80, 60, 0.85)}, ${hsla(v.hueSecondary, 75, 65, 0.85)})`,
                boxShadow: `0 0 12px ${hsla(v.hue, 80, 60, 0.4)}`,
              }}
            />
          </div>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {freshness}
          </span>
        </div>
      </div>

      {/* Hover 时底部显露的进入提示条 */}
      <div
        className="relative overflow-hidden transition-all duration-300 group-hover:max-h-[40px] max-h-0"
        aria-hidden
      >
        <div
          className="px-4 py-2 flex items-center justify-center gap-1 text-[11px] font-semibold"
          style={{
            background: `linear-gradient(90deg, ${hsla(v.hue, 80, 40, 0.2)}, ${hsla(v.hueSecondary, 75, 45, 0.2)})`,
            color: hsla(v.hue, 80, 85, 0.95),
            borderTop: `1px solid ${hsla(v.hue, 70, 55, 0.2)}`,
          }}
        >
          <Sparkle size={11} /> 进入探索 →
        </div>
      </div>
    </GlassCard>
  );
}

/** 花蕾 + 轨道粒子视觉：SVG 实现，确保矢量清晰 */
function BloomVisual({ visual: v, nodeCount }: { visual: ReturnType<typeof getTreeVisual>; nodeCount: number }) {
  // 多圈轨道，从内到外色相微偏，粒子沿轨道均匀分布
  const rings = Math.min(3, Math.max(1, Math.ceil(v.orbits / 3)));
  const particlesPerRing = Math.ceil(v.orbits / rings);
  const coreGlow = hsla(v.hue, 85, 65, 0.9);
  const coreOuter = hsla(v.hue, 70, 45, 0.3);

  return (
    <svg width="160" height="120" viewBox="-80 -60 160 120" style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id={`core-${v.hue}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={hsla(v.hue, 100, 85, 0.95)} />
          <stop offset="60%" stopColor={hsla(v.hue, 85, 60, 0.6)} />
          <stop offset="100%" stopColor={hsla(v.hue, 85, 60, 0)} />
        </radialGradient>
      </defs>

      {/* 核心光晕 */}
      <circle cx={0} cy={0} r={32} fill={`url(#core-${v.hue})`} />
      <circle cx={0} cy={0} r={7} fill={coreGlow}>
        <animate attributeName="r" values="6;8.5;6" dur="2.4s" repeatCount="indefinite" />
      </circle>
      <circle cx={0} cy={0} r={14} fill="none" stroke={coreOuter} strokeWidth={1} strokeDasharray="2 3" />

      {/* 轨道 + 粒子 */}
      {Array.from({ length: rings }).map((_, ringIdx) => {
        const r = 22 + ringIdx * 14;
        const ringHue = (v.hue + ringIdx * 18) % 360;
        const dur = 14 + ringIdx * 6;
        // 反向旋转奇数圈，制造"对流"感
        const dir = ringIdx % 2 === 0 ? 1 : -1;
        const particleCount = Math.max(2, particlesPerRing - ringIdx);

        return (
          <g key={ringIdx}>
            {/* 轨道线 */}
            <circle
              cx={0}
              cy={0}
              r={r}
              fill="none"
              stroke={hsla(ringHue, 60, 55, 0.14)}
              strokeWidth={0.6}
              strokeDasharray="1 3"
            />
            {/* 整个粒子组围绕中心旋转 */}
            <g>
              <animateTransform
                attributeName="transform"
                type="rotate"
                from={`${v.rotation + ringIdx * 45} 0 0`}
                to={`${v.rotation + ringIdx * 45 + 360 * dir} 0 0`}
                dur={`${dur}s`}
                repeatCount="indefinite"
              />
              {Array.from({ length: particleCount }).map((_, p) => {
                const angle = (p / particleCount) * Math.PI * 2;
                const px = Math.cos(angle) * r;
                const py = Math.sin(angle) * r;
                // 节点数量影响粒子亮度：节点越多越亮
                const density = Math.min(1, nodeCount / 15);
                const alpha = 0.55 + density * 0.35;
                return (
                  <circle
                    key={p}
                    cx={px}
                    cy={py}
                    r={2 + (ringIdx === 0 ? 0.6 : 0)}
                    fill={hsla(ringHue, 85, 70, alpha)}
                    style={{ filter: `drop-shadow(0 0 3px ${hsla(ringHue, 90, 65, 0.5)})` }}
                  />
                );
              })}
            </g>
          </g>
        );
      })}
    </svg>
  );
}
