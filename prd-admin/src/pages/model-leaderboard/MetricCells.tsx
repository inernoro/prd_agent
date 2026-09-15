import type { ModelMetric } from '@/services/real/modelLeaderboard';

/**
 * 榜单里那些「一眼看强弱」的小部件。抽出来是因为一行要用六次，
 * 而且误差须的画法是本页最容易被改坏的细节。
 */

/** 条的高度。宽度不再写死——由所在列给多少就占多少，见下。 */
const BAR_H = 18;

/**
 * 误差须：中轴 + 实心条 + 两端的须。
 *
 * 为什么不是一根纯色进度条：榜单给的每个分数都带 95% 置信区间，两个模型的区间重叠时，
 * 它们的名次差别本来就不作数。画成实心条是在假装精确——须画出来，读者才知道这个 +13.85%
 * 实际可能是 11.93 到 15.77 之间的任何一个数。
 *
 * ## 为什么用百分比定位而不是固定宽度的 SVG
 *
 * 固定 104px 的画布在宽屏下会把富余宽度留给别的列（最后落在模型名那一列，变成一大片
 * 空白）。改成撑满所在列之后，宽屏上条更长、须分得更开——多出来的像素直接变成了
 * 可读性，而不是空白（content-fills-canvas.md）。
 *
 * 坐标以中轴为零点：正值向右、负值向左，`scale` 是「一个百分点换算成画布宽度的百分之几」。
 */
export function ErrorBar({
  metric,
  scale,
  lead = false,
}: {
  metric: ModelMetric;
  /** 值 → 画布百分比；由整列的最大绝对值决定，全列共用一把尺 */
  scale: number;
  /** 榜首那行：条更粗、须更亮 */
  lead?: boolean;
}) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const len = metric.value * scale;
  const x = clamp(len >= 0 ? 50 : 50 + len);
  const w = Math.min(100 - x, Math.abs(len));

  const lo = metric.margin != null ? clamp(50 + (metric.value - metric.margin) * scale) : null;
  const hi = metric.margin != null ? clamp(50 + (metric.value + metric.margin) * scale) : null;

  const barFill = lead
    ? 'var(--accent-gold)'
    : 'color-mix(in srgb, var(--accent-gold) 72%, transparent)';
  const whisker = lead ? 'var(--text-secondary)' : 'var(--text-muted)';

  return (
    <Track>
      {/* 零点中轴：压在轨道上，负值往左、正值往右都从这里起算 */}
      <span
        style={{
          position: 'absolute', left: '50%', top: 2, bottom: 2, width: 1,
          background: 'var(--border-default)',
        }}
      />
      <Bar left={x} width={w} fill={barFill} />
      <Whiskers lo={lo} hi={hi} color={whisker} lead={lead} />
    </Track>
  );
}

/** 轨道的高度。条填在里面，须画在它上面（比它高，压得住）。 */
const TRACK_H = 6;

/**
 * 条与须共用的画布：撑满所在列，高度固定。
 *
 * ## 为什么有一条满宽的轨道，而不是一根细基线
 *
 * 第一版画的是一根 1px 基线，条只有起点固定、右端跟着数值跑。三五行的设计稿上看不出问题，
 * 78 行真实数据一铺开，右边缘就成了一条锯齿线——用户 2026-09-15 的原话是「列表里面忽长忽短，
 * 我不认同这好看」，说得对。
 *
 * 轨道把右边缘钉死：扫下来是一排等长的槽，条在槽里填充。长短差异照样读得出来（那是数据），
 * 但视觉上不再是一堆参差的线头。这是进度条的通用做法，不是我发明的。
 */
function Track({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="relative block flex-1"
      style={{ height: BAR_H, minWidth: 90 }}
    >
      {/* 轨道：满宽，右边缘永远齐平 */}
      <span
        style={{
          position: 'absolute', left: 0, right: 0, top: '50%',
          transform: 'translateY(-50%)',
          height: TRACK_H, borderRadius: TRACK_H / 2,
          background: 'var(--nested-block-bg)',
        }}
      />
      {children}
    </span>
  );
}

/** 填在轨道里的那一段。与轨道同高，看起来就是轨道被填满了多少。 */
function Bar({ left, width, fill }: { left: number; width: number; fill: string }) {
  return (
    <span
      style={{
        position: 'absolute', left: `${left}%`, top: '50%', transform: 'translateY(-50%)',
        width: `${Math.max(width, 0)}%`, minWidth: 3,
        height: TRACK_H, borderRadius: TRACK_H / 2, background: fill,
      }}
    />
  );
}

/** 置信区间的须：两根竖线 + 一根横梁。区间抓不到时整组不画，不拿 0 冒充。 */
function Whiskers({
  lo, hi, color, lead,
}: { lo: number | null; hi: number | null; color: string; lead: boolean }) {
  if (lo == null || hi == null) return null;
  const t = lead ? 1.4 : 1.2;
  return (
    <>
      <span
        style={{
          position: 'absolute', left: `${lo}%`, right: `${100 - hi}%`, top: '50%',
          height: 1, background: color,
        }}
      />
      {[lo, hi].map((x, i) => (
        <span
          key={i}
          style={{
            position: 'absolute', left: `${x}%`, top: '50%',
            transform: 'translate(-50%, -50%)', width: t, height: 9, background: color,
          }}
        />
      ))}
    </>
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
 * agent 榜更要紧——所以这一列吃掉整行的富余宽度，让须分得开、看得清。
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
  // 全列只有一行、或者所有分数一样时 span 为 0：画满，不做除零
  const pct = (v: number) =>
    span <= 0 ? 100 : Math.max(0, Math.min(100, ((v - min) / span) * 100));

  const end = pct(value);
  const lo = marginDown != null ? pct(value - marginDown) : null;
  const hi = marginUp != null ? pct(value + marginUp) : null;

  const barFill = lead
    ? 'var(--accent-gold)'
    : 'color-mix(in srgb, var(--accent-gold) 72%, transparent)';
  const whisker = lead ? 'var(--text-secondary)' : 'var(--text-muted)';

  return (
    <Track>
      <Bar left={0} width={end} fill={barFill} />
      <Whiskers lo={lo} hi={hi} color={whisker} lead={lead} />
    </Track>
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
