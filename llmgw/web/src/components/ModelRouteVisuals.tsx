// 白名单列表的三个视觉零件：上游标记、用量趋势线、线路条。
//
// 这一页原先是「一个模型一张卡，卡里再套一张只有一行的表」，加每行六个纯文字按钮。
// 用户的原话是「全是字，全都是按钮」。改法不是换配色，是把三类信息从文字换成图形：
//   - 上游是谁 -> 品牌色标记，不用读字
//   - 这条线路在不在扛流量 -> 带光晕的实心点 / 灰点，不用读「健康 / 不可用」
//   - 近 30 天用量 -> 面积曲线，不用读一串数字
//
// 品牌色是有限枚举而不是自由文本映射：认不出的上游一律落到中性灰，不猜。
import { useId, type CSSProperties } from 'react';

/** 上游品牌色。认不出来就用中性灰，不按名字猜颜色。 */
const UPSTREAM_BRANDS: ReadonlyArray<{ match: RegExp; color: string; short: string }> = [
  { match: /openrouter/i, color: '#6467f2', short: 'OR' },
  { match: /openai|chatgpt|gpt/i, color: '#10a37f', short: 'AI' },
  { match: /anthropic|claude/i, color: '#d97757', short: 'AN' },
  { match: /gemini|google|vertex/i, color: '#1a73e8', short: 'GE' },
  { match: /fal\.?ai/i, color: '#ff4f00', short: 'FA' },
  { match: /azure/i, color: '#0078d4', short: 'AZ' },
  { match: /deepseek/i, color: '#4d6bfe', short: 'DS' },
];

/**
 * 认不出的上游走中性色 + 名字首字。
 *
 * 不能写死成「--」那种占位符：自建上游、内网网关、教程里的假上游都会落到这一档，
 * 而一屏里五行都顶着两根横杠，比没有标记还难看。取首字至少还能把几行区分开。
 */
function neutralBrand(hints: Array<string | null | undefined>) {
  const name = hints.find((x) => x && x.trim().length > 0)?.trim() ?? '';
  const ascii = name.match(/[A-Za-z0-9]/g)?.slice(0, 2).join('').toUpperCase();
  return { color: 'var(--text-muted)', short: ascii || name.slice(0, 1) || '·' };
}

export function resolveUpstreamBrand(...hints: Array<string | null | undefined>) {
  const text = hints.filter(Boolean).join(' ');
  return UPSTREAM_BRANDS.find((x) => x.match.test(text)) ?? neutralBrand(hints);
}

/** 模型左侧那个带品牌色的方块。尺寸固定，行高才不会被它撑歪。 */
export function UpstreamMark({ hints, size = 26 }: { hints: Array<string | null | undefined>; size?: number }) {
  const brand = resolveUpstreamBrand(...hints);
  return (
    <span
      aria-hidden
      style={{
        width: size, height: size, borderRadius: size >= 30 ? 8 : 7,
        background: brand.color, color: '#fff',
        fontSize: 'var(--fs-micro)', fontWeight: 700, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}
    >
      {brand.short}
    </span>
  );
}

export type RouteHealth = 'live' | 'standby' | 'down' | 'disabled';

const HEALTH_DOT: Record<RouteHealth, CSSProperties> = {
  // 正在扛流量的那条带一圈光晕，扫一眼就知道现在谁在干活
  live: { background: 'var(--ok)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent)' },
  standby: { background: 'var(--text-muted)' },
  down: { background: 'var(--warn)' },
  disabled: { background: 'var(--border-strong)' },
};

export function RouteDot({ health }: { health: RouteHealth }) {
  return <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, flexShrink: 0, ...HEALTH_DOT[health] }} />;
}

/**
 * 近 N 天调用量的面积曲线。
 *
 * 全零时只画一条底线而不是一条假的平滑曲线——「这个模型没人用」和「用量平稳」
 * 是两件完全不同的事，画成一样会误导。
 */
export function UsageSparkline({
  values, width = 74, height = 26, title,
}: { values: readonly number[]; width?: number; height?: number; title?: string }) {
  // 渐变 id 必须每个实例唯一：同一页十来条曲线共用一个 id 时，浏览器一律取文档里第一个，
  // 后面所有曲线都会去填第一条的渐变。useId 保证每个实例拿到自己的那一份。
  const gradientId = `spark${useId().replace(/:/g, '')}`;
  if (values.length < 2) {
    return <svg width={width} height={height} role="img" aria-label={title ?? '暂无用量'} />;
  }
  const peak = Math.max(...values);
  const step = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * step;
    // 顶部留 3px、底部留 2px，峰值和谷底才不会贴着边被切掉
    const y = peak <= 0 ? height - 2 : height - 2 - (value / peak) * (height - 5);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = `M${points.join(' L')}`;
  const flat = peak <= 0;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" role="img" aria-label={title ?? '近期用量'} style={{ display: 'block', flexShrink: 0 }}>
      {flat ? null : (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.18" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${gradientId})`} />
        </>
      )}
      <path
        d={line}
        stroke={flat ? 'var(--border-strong)' : 'var(--accent)'}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
