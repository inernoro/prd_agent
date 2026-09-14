/**
 * 藏书阁手机档（390 终稿）的版式原语。
 *
 * 这一层存在的唯一理由：**让档位只有一处出处**。
 * 终稿的纪律是「同屏最多三档圆角、七档字号、一条 20px 基准线」，而纪律一旦
 * 以字面量的形式散进三四个页面组件，第二屏必然与第一屏漂移——这正是改版前
 * 「歪歪扭扭」的成因：每个块各有各的边距、圆角和间距，没有共同的刻度。
 *
 * 所以数值一律来自 `lib/appStoreTokens`（AS_TYPE / AS_SPACE / AS_SIZE），
 * 颜色一律走 CSS 变量（双皮肤棘轮会拦硬编码）。这里不新造任何一档。
 *
 * 与桌面档的关系：互不干扰。桌面保持原来的粗野骨架（3px 墨边 + 硬投影 +
 * 整卡五色底），手机档把它减到只剩三样记号——主标题 800 字重、卷序汉字大字、
 * 五色只出现在 44px 卷序块上。分层改为只靠 --bg-card 与 --bg-base 的明度差。
 */
import type { CSSProperties, ReactNode } from 'react';
import { AS_TYPE, AS_SPACE, AS_SIZE } from '@/lib/appStoreTokens';

/** 一条 20px 基准线：页眉、标题、正文、卡片左边缘全部对齐到它。 */
export const GUTTER = AS_SPACE.gutter;

/**
 * 每一屏的底部留白：必须让最后一行内容滚得过底部 TabBar，否则最末条目
 * 永远压在导航下面——这在 fullPage 截图里看不出来，只有真机滑到底才发现。
 *
 * 值走仓库既有的 `--mobile-tab-height`（MobileTabBar 自己也读它）加安全区，
 * 不写死 48：TabBar 高度改一次，写死的那些页面会静默各自出错。
 */
export const BOTTOM_GAP = 'calc(var(--mobile-tab-height, 60px) + env(safe-area-inset-bottom, 0px) + 24px)';

export const asStyle = (t: { fontSize: number; fontWeight: number; letterSpacing?: string; lineHeight?: number }): CSSProperties => ({
  fontSize: t.fontSize,
  fontWeight: t.fontWeight,
  letterSpacing: t.letterSpacing,
  lineHeight: t.lineHeight,
});

/** 眉标：11px / 800 / .08em。颜色默认弱化，需要身份色时传 color。 */
export function Eyebrow({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <div style={{ ...asStyle(AS_TYPE.eyebrow), color: color ?? 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

/**
 * 区块头：眉标 + 20px 标题，两行间距 4。
 * 区块之间的 36px 间距由调用方给（sectionGap），因为首个区块不需要它。
 */
export function SectionHead({ eyebrow, title }: { eyebrow: ReactNode; title: ReactNode }) {
  return (
    <div>
      <Eyebrow>{eyebrow}</Eyebrow>
      <div style={{ marginTop: 4, ...asStyle(AS_TYPE.groupTitle) }}>{title}</div>
    </div>
  );
}

/**
 * 分组卡容器（iOS grouped list）：18px 圆角、--bg-card 实底、不描边不投影。
 *
 * `marginTop: -1` 配合每个 Row 的 `borderTop` 是 iOS 的老做法：行之间有
 * hairline，首行那条被容器的 overflow:hidden 裁掉，于是不必给首行写特例。
 */
export function GroupCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        borderRadius: AS_SPACE.shelfCardRadius,
        background: 'var(--shelf-surface)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <div style={{ marginTop: -1 }}>{children}</div>
    </div>
  );
}

/** 分组卡里的一行：14/16 padding + 顶部 hairline。 */
export function GroupRow({
  children,
  onClick,
  style,
  align = 'center',
}: {
  children: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
  align?: CSSProperties['alignItems'];
}) {
  const base: CSSProperties = {
    display: 'flex',
    alignItems: align,
    gap: 12,
    width: '100%',
    textAlign: 'left',
    padding: `${AS_SPACE.listItemPaddingY}px ${AS_SPACE.listItemPaddingX}px`,
    borderTop: '1px solid var(--border-faint)',
    background: 'transparent',
    color: 'inherit',
    ...style,
  };
  if (!onClick) return <div style={base}>{children}</div>;
  return (
    <button type="button" onClick={onClick} style={{ ...base, border: 0, borderTop: base.borderTop }}>
      {children}
    </button>
  );
}

/** 行尾的雪佛龙。20px、弱化色、line-height 1 —— 与 17/13 两行文字的视觉中线对齐。 */
export function Chevron() {
  return <span style={{ fontSize: 20, color: 'var(--text-muted)', lineHeight: 1 }}>›</span>;
}

/**
 * 主卡（featured）：22px 圆角、18/20 padding。
 * 同屏只允许出现一到两块，它是「这一屏在说什么」的载体。
 */
export function FeaturedCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        borderRadius: AS_SPACE.featuredRadius,
        background: 'var(--shelf-surface)',
        padding: `${AS_SPACE.featuredPaddingY}px ${AS_SPACE.featuredPaddingX}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** 序号方块：卷序汉字、推荐书的 1/2。五色只在这里出现。 */
export function NumberBox({
  children,
  fg,
  box,
  size,
  fontSize,
}: {
  children: ReactNode;
  fg: string;
  box: string;
  size: number;
  fontSize: number;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: AS_SPACE.iconRadius,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize,
        fontWeight: 800,
        background: box,
        color: fg,
      }}
    >
      {children}
    </div>
  );
}

/** pill 按钮：30 高、999 圆角、15/600。实心用于主动作，--bg-card 用于次动作。 */
export function Pill({
  children,
  onClick,
  tone = 'solid',
  accent,
  block,
  disabled,
  height = AS_SIZE.pillHeight,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'solid' | 'soft';
  accent?: string;
  block?: boolean;
  disabled?: boolean;
  /** 行内附着的 pill 用 30（AS_SIZE.pillHeight），整屏底部的主动作用 44。 */
  height?: number;
}) {
  const solid = tone === 'solid';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height,
        flex: block ? 1 : 'none',
        padding: `0 ${AS_SPACE.listItemPaddingX}px`,
        borderRadius: AS_SPACE.pillRadius,
        border: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...asStyle(AS_TYPE.pill),
        background: solid ? (accent ?? 'var(--accent-fg-emerald)') : 'var(--shelf-surface)',
        color: solid ? 'var(--bg-base)' : 'var(--text-primary)',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

/**
 * 顶部导航：44 高，左返回（17px 身份色 + 24px 雪佛龙），右附信息。
 * `margin: 0 -4px` 是为了让返回箭头的光学左边缘落在 20px 基准线上——
 * 雪佛龙左侧天生带一点字形留白，不补这 4px 看起来就往右缩了一格。
 */
export function NavBar({
  backLabel,
  onBack,
  title,
  trailing,
  accent,
}: {
  backLabel: string;
  onBack: () => void;
  title?: ReactNode;
  trailing?: ReactNode;
  accent?: string;
}) {
  return (
    <div
      style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        margin: '0 -4px',
      }}
    >
      <button
        type="button"
        onClick={onBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          border: 0,
          background: 'transparent',
          padding: '0 4px',
          fontSize: 17,
          color: accent ?? 'var(--accent-fg-emerald)',
        }}
      >
        <span style={{ fontSize: 24, lineHeight: 1 }}>‹</span> {backLabel}
      </button>
      {title ? <span style={{ ...asStyle(AS_TYPE.itemTitle) }}>{title}</span> : null}
      {trailing ?? <span style={{ width: 60 }} />}
    </div>
  );
}
