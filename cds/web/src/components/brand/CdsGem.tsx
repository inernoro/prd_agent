import type { CSSProperties, ReactNode, SVGProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * CdsGem — CDS 品牌标「宝石六芒」(状态系统设定 v2 定稿)。
 *
 * 本体 = 原版切面:十二切面(6 核心三角 + 6 星尖)亮度轮转直拼,
 * 无缝线、无高光点;每个切面以自身色封边 0.5,任何缩放不出黑缝。
 * 一颗几何、多种矿色、各司一态:紫晶是品牌,其余矿色映射运行状态
 * (琥珀构建 / 银河部署 / 翡翠在线 / 月长石排队 / 石榴石失败 /
 * 石墨停止 / 海蓝宝冻结)。动效签名定义在 index.css 的 .cds-gem--* 块。
 */

export type GemMineral =
  | 'ember'
  | 'amethyst'
  | 'amber'
  | 'galaxy'
  | 'emerald'
  | 'moonstone'
  | 'garnet'
  | 'graphite'
  | 'aqua';

export type GemMode =
  | 'static'
  | 'brand'
  | 'build'
  | 'deploy'
  | 'live'
  | 'pending'
  | 'fail'
  | 'stop'
  | 'frozen'
  | 'loader';

/** 矿色色阶(暗 → 亮,6 阶)。ember 为品牌色:与系统 --primary(hue 24 橙)同调,
    瓷贴片暖色语言原生适配;amethyst 保留为备选。 */
export const GEM_SHADES: Record<GemMineral, readonly [string, string, string, string, string, string]> = {
  ember: ['#7c2d12', '#9a3412', '#c2410c', '#ea580c', '#f97316', '#fb923c'],
  amethyst: ['#2e1065', '#4c1d95', '#6d28d9', '#7c3aed', '#8b5cf6', '#a78bfa'],
  amber: ['#713f12', '#92400e', '#b45309', '#d97706', '#f59e0b', '#fbbf24'],
  galaxy: ['#1e1b4b', '#312e81', '#3730a3', '#1d4ed8', '#0284c7', '#22d3ee'],
  emerald: ['#064e3b', '#065f46', '#047857', '#059669', '#10b981', '#34d399'],
  moonstone: ['#334155', '#475569', '#64748b', '#94a3b8', '#cbd5e1', '#e2e8f0'],
  garnet: ['#7f1d1d', '#991b1b', '#b91c1c', '#dc2626', '#ef4444', '#f87171'],
  graphite: ['#27272a', '#3f3f46', '#52525b', '#71717a', '#a1a1aa', '#d4d4d8'],
  aqua: ['#164e63', '#155e75', '#0e7490', '#0891b2', '#06b6d4', '#22d3ee'],
};

/** 状态 → 默认矿色(状态系统设定 v2)。 */
export const GEM_MODE_MINERAL: Record<GemMode, GemMineral> = {
  static: 'ember',
  brand: 'ember',
  loader: 'ember',
  build: 'amber',
  deploy: 'galaxy',
  live: 'emerald',
  pending: 'moonstone',
  fail: 'garnet',
  stop: 'graphite',
  frozen: 'aqua',
};

/** 分支/服务状态字符串 → 宝石状态(与 lib/statusStyle.ts 的语义对齐)。 */
export function gemModeForStatus(status: string): GemMode {
  if (status === 'running') return 'live';
  if (status === 'building') return 'build';
  if (status === 'starting' || status === 'restarting' || status === 'deploying') return 'deploy';
  if (status === 'error') return 'fail';
  if (status === 'stopping') return 'pending';
  if (status === 'stopped') return 'stop';
  if (status === 'frozen' || status === 'hibernated') return 'frozen';
  return 'pending';
}

/* ---- 几何(模块级预计算,所有实例共享) ---- */

interface GemFacet {
  points: string;
  shadeIdx: number;
  i: number;
}

const GEM_FACETS: readonly GemFacet[] = (() => {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const pt = (R: number, deg: number): [number, number] => [
    32 + R * Math.cos(rad(deg)),
    32 + R * Math.sin(rad(deg)),
  ];
  const fmt = (pts: Array<[number, number]>): string =>
    pts.map((p) => p.map((n) => +n.toFixed(2)).join(',')).join(' ');
  const R = 23.5;
  const r = R / Math.sqrt(3);
  const hex = [0, 1, 2, 3, 4, 5].map((k) => pt(r, -60 + k * 60));
  const facets: GemFacet[] = [];
  for (let k = 0; k < 6; k++) {
    facets.push({
      points: fmt([[32, 32], hex[k], hex[(k + 1) % 6]]),
      shadeIdx: k % 6,
      i: 2 * k,
    });
  }
  for (let k = 0; k < 6; k++) {
    facets.push({
      points: fmt([pt(R, -90 + k * 60), hex[(k + 5) % 6], hex[k]]),
      shadeIdx: (k + 3) % 6,
      i: 2 * k + 1,
    });
  }
  return facets;
})();

export interface CdsGemProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'mode'> {
  /** 状态(决定动效签名 + 默认矿色)。默认 static:静止无动效。 */
  mode?: GemMode;
  /** 覆盖矿色(默认由 mode 决定)。 */
  mineral?: GemMineral;
  /** 一次性逐面组装入场(登录卡 / 冷启动场景)。 */
  entrance?: boolean;
  className?: string;
  title?: string;
}

export function CdsGem({
  mode = 'static',
  mineral,
  entrance = false,
  className,
  title = 'CDS',
  ...props
}: CdsGemProps): JSX.Element {
  const shades = GEM_SHADES[mineral ?? GEM_MODE_MINERAL[mode]];
  return (
    <svg
      className={cn('cds-gem', mode !== 'static' ? `cds-gem--${mode}` : null, entrance ? 'cds-gem--entrance' : null, className)}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      {...props}
    >
      {GEM_FACETS.map((facet) => {
        const shade = shades[facet.shadeIdx];
        return (
          <polygon
            key={facet.i}
            className="cds-gem-facet"
            points={facet.points}
            fill={shade}
            stroke={shade}
            strokeWidth={0.5}
            strokeLinejoin="round"
            style={{ '--gi': facet.i, '--gd': `${(facet.i * 0.055).toFixed(2)}s`, '--gg': `${(facet.i * 0.31).toFixed(2)}s` } as CSSProperties}
          />
        );
      })}
    </svg>
  );
}

/* ---- 加载器:宝石逐面组装 → 保持 → 溶解 → 循环 ---- */

const gemLoaderSizes = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
  xl: 'h-12 w-12',
} as const;

export type CdsGemLoaderSize = keyof typeof gemLoaderSizes;

export function CdsGemLoader({
  className,
  gemClassName,
  label,
  size = 'sm',
  mineral = 'amethyst',
  inline = true,
}: {
  className?: string;
  gemClassName?: string;
  label?: ReactNode;
  size?: CdsGemLoaderSize;
  /** 上下文矿色:品牌场景紫晶,构建上下文琥珀,部署上下文银河…… */
  mineral?: GemMineral;
  inline?: boolean;
}): JSX.Element {
  return (
    <span
      className={cn(
        'cds-logo-loader',
        inline ? 'inline-flex' : 'flex',
        label ? 'items-center gap-2' : 'items-center justify-center',
        className,
      )}
      role={label ? 'status' : 'img'}
      aria-live={label ? 'polite' : undefined}
      aria-label={label ? undefined : 'CDS 正在加载'}
    >
      <span className="cds-logo-loader-mark" aria-hidden="true">
        <CdsGem mode="loader" mineral={mineral} className={cn(gemLoaderSizes[size], gemClassName)} />
      </span>
      {label ? <span>{label}</span> : null}
    </span>
  );
}
