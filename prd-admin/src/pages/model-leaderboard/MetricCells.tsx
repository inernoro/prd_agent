import type { ModelMetric } from '@/services/real/modelLeaderboard';

/**
 * 榜单里那些「一眼看强弱」的小部件。抽出来是因为一行要用六次，
 * 而且误差须的画法是本页最容易被改坏的细节。
 */

/** 误差须的画布尺寸，与设计稿一致（Main.dc.html 里的 104×18）。 */
const BAR_W = 104;
const BAR_H = 18;

/**
 * 误差须：中轴 + 实心条 + 两端的须。
 *
 * 为什么不是一根纯色进度条：榜单给的每个分数都带 95% 置信区间，两个模型的区间重叠时，
 * 它们的名次差别本来就不作数。画成实心条是在假装精确——须画出来，读者才知道这个 +13.85%
 * 实际可能是 11.93 到 15.77 之间的任何一个数。
 *
 * 坐标全部按 `scale`（值 → px）换算，零点在中轴：正值向右、负值向左。
 */
export function ErrorBar({
  metric,
  scale,
  lead = false,
}: {
  metric: ModelMetric;
  /** 把「一个百分点」换算成多少像素；由整列的最大绝对值决定，全列共用一把尺 */
  scale: number;
  /** 榜首那行：条更粗、须更亮 */
  lead?: boolean;
}) {
  const zero = BAR_W / 2;
  const mid = BAR_H / 2;
  const len = metric.value * scale;
  const x = len >= 0 ? zero : zero + len;
  const w = Math.max(2, Math.abs(len));

  // 须的两端 = 值 ± 误差，夹在画布内，免得大误差把须画到框外
  const clamp = (v: number) => Math.max(1, Math.min(BAR_W - 1, zero + v * scale));
  const lo = metric.margin != null ? clamp(metric.value - metric.margin) : null;
  const hi = metric.margin != null ? clamp(metric.value + metric.margin) : null;

  const barFill = lead ? 'var(--accent-gold)' : 'color-mix(in srgb, var(--accent-gold) 72%, transparent)';
  const whisker = lead ? 'var(--text-secondary)' : 'var(--text-muted)';
  const barH = lead ? 5 : 4;

  return (
    <svg width={BAR_W} height={BAR_H} viewBox={`0 0 ${BAR_W} ${BAR_H}`} aria-hidden="true" className="shrink-0">
      {/* 基线与零点 */}
      <line x1={0} y1={mid} x2={BAR_W} y2={mid} stroke="var(--border-subtle)" strokeWidth={1} />
      <line x1={zero} y1={3} x2={zero} y2={BAR_H - 3} stroke="var(--border-default)" strokeWidth={1} />
      {/* 分数条 */}
      <rect x={x} y={mid - barH / 2} width={w} height={barH} rx={barH / 2} fill={barFill} />
      {/* 置信区间的须：两根竖线 + 一根横梁 */}
      {lo != null && hi != null && (
        <>
          <line x1={lo} y1={mid - 4.5} x2={lo} y2={mid + 4.5} stroke={whisker} strokeWidth={lead ? 1.4 : 1.3} />
          <line x1={hi} y1={mid - 4.5} x2={hi} y2={mid + 4.5} stroke={whisker} strokeWidth={lead ? 1.4 : 1.3} />
          <line x1={lo} y1={mid} x2={hi} y2={mid} stroke={whisker} strokeWidth={lead ? 1.2 : 1.1} />
        </>
      )}
    </svg>
  );
}

/**
 * 热力单元格：同一列里底色深浅即强弱，扫一眼就看出谁在哪项强。
 *
 * 负值不参与暖色热力——它走一层很淡的语义红，和「弱」区分开：一个是「不如别人」，
 * 一个是「本来就掉了」，混成同一种灰会让人读错。
 */
export function HeatCell({
  metric,
  max,
}: {
  metric: ModelMetric | null;
  /** 整列的最大绝对值，用来把当前值归一成 0-1 的热度 */
  max: number;
}) {
  if (!metric) return <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>—</span>;

  const negative = metric.value < 0;
  const heat = max > 0 ? Math.min(1, Math.abs(metric.value) / max) : 0;
  // 0.30 是设计稿里榜首那格的上限；再深会把数字压得读不清
  const alpha = (0.04 + heat * 0.26).toFixed(3);

  return (
    <div
      className="text-right rounded-[7px]"
      style={{
        padding: '6px 10px',
        marginLeft: 6,
        background: negative
          ? `color-mix(in srgb, var(--semantic-danger-text) ${(heat * 14 + 4).toFixed(1)}%, transparent)`
          : `color-mix(in srgb, var(--accent-gold) ${(Number(alpha) * 100).toFixed(1)}%, transparent)`,
      }}
    >
      <div
        className="font-mono text-[13px] font-semibold tabular-nums"
        style={{ color: negative ? 'var(--semantic-danger-text)' : 'var(--text-primary)' }}
      >
        {formatSigned(metric.value)}
      </div>
      <div className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
        {metric.margin != null ? `±${metric.margin.toFixed(2)}` : ''}
      </div>
    </div>
  );
}

/** 不参与热力的素净指标格（命令恢复 / 工具幻觉这两列）。 */
export function PlainCell({ metric }: { metric: ModelMetric | null }) {
  if (!metric) return <div className="text-right pl-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>—</div>;
  return (
    <div className="text-right pl-2">
      <div className="font-mono text-[12.5px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {formatSigned(metric.value)}
      </div>
      <div className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
        {metric.margin != null ? `±${metric.margin.toFixed(2)}` : ''}
      </div>
    </div>
  );
}

/**
 * 带符号的百分比。
 *
 * 负号用真正的减号 U+2212 而不是连字符：连字符在等宽字体里又短又贴着数字，
 * 一列数字扫下来容易把 −0.91 看成 0.91。
 */
export function formatSigned(v: number): string {
  const s = Math.abs(v).toFixed(2);
  return v < 0 ? `−${s}%` : `+${s}%`;
}

/** 厂商缩写标记。没有品牌图时用两个字母，比一个灰方块认得出来。 */
export function orgMark(organization: string | null): string {
  const cleaned = (organization ?? '').trim();
  if (!cleaned) return '--';
  const words = cleaned.split(/[\s.·]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

/** 授权字样是否算开源。榜单里除了 Proprietary 都按开源处理（MIT / Apache / 各家自有 license）。 */
export function isOpenSource(license: string | null): boolean {
  return !/proprietary/i.test(license ?? 'Proprietary');
}

/** 分数条的画布尺寸。比 agent 榜的误差须宽一些——分数榜这一列本来就该是主角。 */
const SCORE_BAR_W = 148;
const SCORE_BAR_H = 18;

/**
 * 对战分条：整列共用一把尺，左端是全列最低分、右端是全列最高分。
 *
 * ## 为什么不从 0 起画
 *
 * Elo 分数是相对分，全榜挤在 1200-1520 之间。从 0 起画的话每根条都是九成满，
 * 榜首和垫底看起来一模一样——那根条就只是装饰。按全列的实际跨度归一，
 * 条长才真的对应「差多少」。
 *
 * ## 须仍然是重点
 *
 * 图像视频这些榜的样本少，误差经常到 ±26，而相邻两名只差 4 分。不把区间画出来，
 * 读者会以为第一名真的赢了第二名。区间重叠时名次差别不作数，这句话对分数榜比对
 * agent 榜更要紧。
 */
export function ScoreBar({
  value,
  marginUp,
  marginDown,
  min,
  max,
  lead = false,
}: {
  value: number;
  marginUp: number | null;
  marginDown: number | null;
  /** 全列最小值（已含误差下界），下同 */
  min: number;
  max: number;
  lead?: boolean;
}) {
  const span = max - min;
  const mid = SCORE_BAR_H / 2;
  // 全列只有一行、或者所有分数一样时 span 为 0：画满，不做除零
  const x = (v: number) =>
    span <= 0 ? SCORE_BAR_W : Math.max(0, Math.min(SCORE_BAR_W, ((v - min) / span) * SCORE_BAR_W));

  const end = x(value);
  const lo = marginDown != null ? x(value - marginDown) : null;
  const hi = marginUp != null ? x(value + marginUp) : null;

  const barFill = lead
    ? 'var(--accent-gold)'
    : 'color-mix(in srgb, var(--accent-gold) 72%, transparent)';
  const whisker = lead ? 'var(--text-secondary)' : 'var(--text-muted)';
  const barH = lead ? 5 : 4;

  return (
    <svg
      width={SCORE_BAR_W}
      height={SCORE_BAR_H}
      viewBox={`0 0 ${SCORE_BAR_W} ${SCORE_BAR_H}`}
      aria-hidden="true"
      className="shrink-0"
    >
      <line x1={0} y1={mid} x2={SCORE_BAR_W} y2={mid} stroke="var(--border-subtle)" strokeWidth={1} />
      <rect x={0} y={mid - barH / 2} width={Math.max(2, end)} height={barH} rx={barH / 2} fill={barFill} />
      {lo != null && hi != null && (
        <>
          <line x1={lo} y1={mid - 4.5} x2={lo} y2={mid + 4.5} stroke={whisker} strokeWidth={lead ? 1.4 : 1.3} />
          <line x1={hi} y1={mid - 4.5} x2={hi} y2={mid + 4.5} stroke={whisker} strokeWidth={lead ? 1.4 : 1.3} />
          <line x1={lo} y1={mid} x2={hi} y2={mid} stroke={whisker} strokeWidth={lead ? 1.2 : 1.1} />
        </>
      )}
    </svg>
  );
}

/**
 * 置信区间的文字写法。两边相等就写「±13」，不等才写「+20/−5」。
 *
 * 一律写成非对称形式会让 402 行里每一行都多出一半没信息量的字符；
 * 一律压成对称又会在真遇到非对称时说谎。所以看数据说话。
 */
export function formatScoreMargin(up: number | null, down: number | null): string {
  if (up == null && down == null) return '';
  if (up != null && down != null && Math.abs(up - down) < 0.005) return `±${up.toFixed(0)}`;
  const u = up != null ? `+${up.toFixed(0)}` : '';
  const d = down != null ? `−${down.toFixed(0)}` : '';
  return [u, d].filter(Boolean).join('/');
}

/** 大数字的千分位写法，票数与会话数共用。 */
export function formatCount(v: number | null | undefined): string {
  return v == null ? '—' : v.toLocaleString('en-US');
}
