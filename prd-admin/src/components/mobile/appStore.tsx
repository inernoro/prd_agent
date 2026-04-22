import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { AS_COLOR, AS_TYPE, AS_SPACE, AS_SIZE, AS_FONT_FAMILY } from '@/lib/appStoreTokens';

/**
 * App Store Today tab（暗色）页面级复刻的基础组件集。
 *
 * 使用纪律：
 *  - 每种排版只允许用 `AS_TYPE` 里的某一档，不允许自己写 fontSize
 *  - 所有间距对齐 `AS_SPACE`，不自己造
 *  - 暗色下永远用 `AS_COLOR.bg`（纯黑），不要 --bg-base 的灰黑
 *  - 所有卡片圆角只能是 `featuredRadius (22)` / `shelfCardRadius (18)` / `iconRadius (12)` 三档
 */

/* ─────────────────────── Hero：页面主标题 ─────────────────────── */

interface HeroProps {
  /** 上眉日期/分组标签：`星期二 · 4 月 22 日` */
  eyebrow?: string;
  /** 大标题：`下午好，蒋云峰` */
  title: string;
  /** 副标：`看看今天能帮你做什么` */
  subtitle?: string;
  /** 右上头像区 */
  trailing?: ReactNode;
}

export function AppStoreHero({ eyebrow, title, subtitle, trailing }: HeroProps) {
  return (
    <div
      className="flex items-start justify-between gap-4"
      style={{
        fontFamily: AS_FONT_FAMILY,
        padding: `${AS_SPACE.sectionGap}px ${AS_SPACE.gutter}px 0 ${AS_SPACE.gutter}px`,
      }}
    >
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <div
            style={{
              ...AS_TYPE.eyebrow,
              color: AS_COLOR.labelSecondary,
              marginBottom: 6,
            }}
          >
            {eyebrow}
          </div>
        )}
        <h1
          style={{
            ...AS_TYPE.heroTitle,
            color: AS_COLOR.label,
            margin: 0,
            wordBreak: 'break-word',
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <div
            style={{
              ...AS_TYPE.heroSubtitle,
              color: AS_COLOR.labelSecondary,
              marginTop: 6,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}

/* ─────────────────────── SectionHeader：区块标题 + See All ─────────────────────── */

interface SectionHeaderProps {
  title: string;
  /** 右侧可点的"全部"/"See All"行动点 */
  onShowAll?: () => void;
  /** 标题下方的说明文字（可选） */
  caption?: string;
}

export function AppStoreSectionHeader({ title, onShowAll, caption }: SectionHeaderProps) {
  return (
    <div style={{ padding: `0 ${AS_SPACE.gutter}px`, marginBottom: AS_SPACE.titleGap, fontFamily: AS_FONT_FAMILY }}>
      <div className="flex items-end justify-between gap-3">
        <h2 style={{ ...AS_TYPE.sectionTitle, color: AS_COLOR.label, margin: 0 }}>{title}</h2>
        {onShowAll && (
          <button
            type="button"
            onClick={onShowAll}
            className="inline-flex items-center gap-0.5 active:opacity-60 transition-opacity"
            style={{ ...AS_TYPE.sectionAction, color: AS_COLOR.blue }}
          >
            全部
            <ChevronRight size={18} strokeWidth={2.2} />
          </button>
        )}
      </div>
      {caption && (
        <div style={{ ...AS_TYPE.itemSubtitle, color: AS_COLOR.labelSecondary, marginTop: 4 }}>
          {caption}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Pill Button：Get/Open 药丸按钮 ─────────────────────── */

interface PillButtonProps {
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  /** 附加说明（如 "In-App Purchases"） */
  caption?: string;
  /** 反色（在深色图片上使用，用半透明白底 + 黑字） */
  variant?: 'default' | 'onImage';
}

export function AppStorePill({ label, onClick, caption, variant = 'default' }: PillButtonProps) {
  const bg = variant === 'onImage' ? 'rgba(255, 255, 255, 0.20)' : AS_COLOR.pillBg;
  const fg = variant === 'onImage' ? AS_COLOR.label : AS_COLOR.blue;
  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0" style={{ fontFamily: AS_FONT_FAMILY }}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center justify-center transition-opacity active:opacity-60"
        style={{
          height: AS_SIZE.pillHeight,
          minWidth: 78,
          padding: '0 18px',
          borderRadius: AS_SPACE.pillRadius,
          background: bg,
          color: fg,
          backdropFilter: variant === 'onImage' ? 'blur(20px) saturate(180%)' : undefined,
          WebkitBackdropFilter: variant === 'onImage' ? 'blur(20px) saturate(180%)' : undefined,
          ...AS_TYPE.pill,
          border: 'none',
        }}
      >
        {label}
      </button>
      {caption && (
        <div style={{ ...AS_TYPE.caption, color: AS_COLOR.labelTertiary }}>{caption}</div>
      )}
    </div>
  );
}

/* ─────────────────────── AppIcon：圆角 52×52 图标格 ─────────────────────── */

interface AppIconProps {
  Icon: LucideIcon;
  /** 渐变主题色（from / to），用于图标底色 */
  accent: { from: string; to: string };
  size?: number;
  /** 叠在图片上时的特殊模式（白磨砂底） */
  onImage?: boolean;
}

export function AppStoreAppIcon({ Icon, accent, size = AS_SIZE.appIconSize, onImage = false }: AppIconProps) {
  const background = onImage
    ? 'rgba(255, 255, 255, 0.95)'
    : `linear-gradient(135deg, ${accent.from}, ${accent.to})`;
  const iconColor = onImage ? accent.from : '#FFFFFF';
  return (
    <div
      className="shrink-0 flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: AS_SPACE.iconRadius,
        background,
        boxShadow: onImage
          ? '0 1px 3px rgba(0, 0, 0, 0.12)'
          : `0 2px 8px ${accent.from}40`,
      }}
    >
      <Icon size={Math.round(size * 0.55)} strokeWidth={2} style={{ color: iconColor }} />
    </div>
  );
}

/* ─────────────────────── Featured：Today 大卡 ─────────────────────── */

interface FeaturedProps {
  /** 上眉小标签：NOW AVAILABLE / MEET THE AGENT 等 */
  eyebrow: string;
  /** 上眉颜色（iOS System Color） */
  eyebrowColor?: string;
  /** 主标 */
  title: string;
  /** 副标（一两行） */
  subtitle?: string;
  /** 背景图 URL；不提供则用 accent 渐变兜底 */
  imageUrl?: string | null;
  /** 渐变 fallback + mesh 的主题色 */
  accent: { from: string; to: string };
  /** 底部玻璃条的 app 信息 */
  footer: {
    Icon: LucideIcon;
    name: string;
    tagline: string;
  };
  onClick: () => void;
  /** 底部按钮文字，默认"打开" */
  pillLabel?: string;
  /** 底部按钮下方说明 */
  pillCaption?: string;
}

export function AppStoreFeatured({
  eyebrow,
  eyebrowColor,
  title,
  subtitle,
  imageUrl,
  accent,
  footer,
  onClick,
  pillLabel = '打开',
  pillCaption,
}: FeaturedProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative overflow-hidden block w-full text-left transition-transform active:scale-[0.985]"
      style={{
        margin: `0 ${AS_SPACE.gutter}px`,
        width: `calc(100% - ${AS_SPACE.gutter * 2}px)`,
        aspectRatio: AS_SIZE.featuredAspect,
        borderRadius: AS_SPACE.featuredRadius,
        background: imageUrl ? '#000' : buildMeshGradient(accent),
        fontFamily: AS_FONT_FAMILY,
        border: `1px solid ${AS_COLOR.hairline}`,
      }}
    >
      {/* 背景图层 */}
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover"
          onError={(e) => {
            (e.currentTarget.style.display = 'none');
          }}
        />
      )}

      {/* 底部渐变蒙版，保证文字可读（苹果的标配） */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0"
        style={{
          top: '40%',
          background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.85) 100%)',
        }}
      />

      {/* 顶部 eyebrow + 标题 + 副标 */}
      <div
        className="absolute left-0 right-0 top-0 flex flex-col"
        style={{ padding: 20, gap: 6 }}
      >
        <div
          style={{
            ...AS_TYPE.eyebrow,
            color: eyebrowColor ?? AS_COLOR.blue,
            textShadow: '0 1px 2px rgba(0,0,0,0.4)',
          }}
        >
          {eyebrow}
        </div>
        <div
          style={{
            ...AS_TYPE.featuredTitle,
            color: AS_COLOR.label,
            textShadow: '0 2px 8px rgba(0,0,0,0.4)',
            maxWidth: '90%',
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              ...AS_TYPE.featuredSubtitle,
              color: 'rgba(255,255,255,0.85)',
              textShadow: '0 1px 4px rgba(0,0,0,0.4)',
              maxWidth: '90%',
            }}
          >
            {subtitle}
          </div>
        )}
      </div>

      {/* 底部玻璃条：icon + 名字 + 一句话 + Pill */}
      <div
        className="absolute left-0 right-0 bottom-0 flex items-center gap-3"
        style={{ padding: 14 }}
      >
        <AppStoreAppIcon Icon={footer.Icon} accent={accent} size={48} onImage />
        <div className="min-w-0 flex-1">
          <div
            className="truncate"
            style={{ ...AS_TYPE.itemTitle, color: AS_COLOR.label }}
          >
            {footer.name}
          </div>
          <div
            className="truncate"
            style={{ ...AS_TYPE.itemSubtitle, color: 'rgba(255,255,255,0.75)' }}
          >
            {footer.tagline}
          </div>
        </div>
        <AppStorePill label={pillLabel} caption={pillCaption} variant="onImage" />
      </div>
    </button>
  );
}

/* ─────────────────────── Shelf：横滑横幅卡片列表 ─────────────────────── */

interface ShelfItem {
  key: string;
  Icon: LucideIcon;
  accent: { from: string; to: string };
  title: string;
  subtitle: string;
  /** 右上角角标（如 "PC" / "WIP"） */
  tag?: { label: string; color: string; bg: string };
  pillLabel?: string;
  onClick: () => void;
}

interface ShelfProps {
  items: ShelfItem[];
}

export function AppStoreShelf({ items }: ShelfProps) {
  if (items.length === 0) return null;
  return (
    <div
      className="flex overflow-x-auto snap-x snap-mandatory"
      style={{
        gap: AS_SIZE.shelfGap,
        paddingLeft: AS_SPACE.gutter,
        paddingRight: AS_SPACE.gutter,
        paddingBottom: 2,
        scrollbarWidth: 'none',
        WebkitOverflowScrolling: 'touch',
        overscrollBehaviorX: 'contain',
        fontFamily: AS_FONT_FAMILY,
      }}
    >
      {items.map((item) => (
        <ShelfCard key={item.key} item={item} />
      ))}
    </div>
  );
}

function ShelfCard({ item }: { item: ShelfItem }) {
  return (
    <button
      type="button"
      onClick={item.onClick}
      className="relative snap-start shrink-0 flex items-center gap-3 text-left transition-transform active:scale-[0.98]"
      style={{
        width: AS_SIZE.shelfCardWidth,
        height: AS_SIZE.shelfCardHeight,
        padding: '0 14px 0 14px',
        borderRadius: AS_SPACE.shelfCardRadius,
        background: AS_COLOR.surface,
        border: `1px solid ${AS_COLOR.hairline}`,
      }}
    >
      <AppStoreAppIcon Icon={item.Icon} accent={item.accent} size={56} />
      <div className="min-w-0 flex-1">
        <div
          className="truncate"
          style={{ ...AS_TYPE.itemTitle, color: AS_COLOR.label }}
        >
          {item.title}
        </div>
        <div
          className="line-clamp-2"
          style={{
            ...AS_TYPE.itemSubtitle,
            color: AS_COLOR.labelSecondary,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {item.subtitle}
        </div>
      </div>
      {item.pillLabel && (
        <AppStorePill label={item.pillLabel} onClick={(e) => { e.stopPropagation(); item.onClick(); }} />
      )}
      {item.tag && (
        <span
          className="absolute top-2 right-2 inline-flex items-center"
          style={{
            padding: '2px 7px',
            borderRadius: 6,
            background: item.tag.bg,
            color: item.tag.color,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          {item.tag.label}
        </span>
      )}
    </button>
  );
}

/* ─────────────────────── RankedList：Top 榜单式列表 ─────────────────────── */

interface RankedItem {
  key: string;
  Icon: LucideIcon;
  accent: { from: string; to: string };
  title: string;
  subtitle: string;
  /** 右侧按钮文字，默认"打开" */
  pillLabel?: string;
  /** Pill 下方附加说明，如 "PC 推荐使用" */
  pillCaption?: string;
  onClick: () => void;
}

interface RankedListProps {
  items: RankedItem[];
  /** 是否显示左侧数字编号（App Store Top 榜风格） */
  numbered?: boolean;
}

export function AppStoreRankedList({ items, numbered = true }: RankedListProps) {
  if (items.length === 0) return null;
  return (
    <div
      style={{
        padding: `0 ${AS_SPACE.gutter}px`,
        fontFamily: AS_FONT_FAMILY,
      }}
    >
      <div>
        {items.map((item, idx) => (
          <RankedRow
            key={item.key}
            item={item}
            rank={numbered ? idx + 1 : null}
            isLast={idx === items.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function RankedRow({ item, rank, isLast }: { item: RankedItem; rank: number | null; isLast: boolean }) {
  return (
    <button
      type="button"
      onClick={item.onClick}
      className="w-full text-left flex items-center gap-3 transition-opacity active:opacity-60"
      style={{
        padding: `${AS_SPACE.listItemPaddingY}px 0`,
        position: 'relative',
      }}
    >
      {rank !== null && (
        <div
          className="shrink-0 text-center"
          style={{
            width: 22,
            ...AS_TYPE.itemTitle,
            color: AS_COLOR.labelSecondary,
            fontWeight: 400,
          }}
        >
          {rank}
        </div>
      )}
      <AppStoreAppIcon Icon={item.Icon} accent={item.accent} size={AS_SIZE.appIconSize} />
      <div className="min-w-0 flex-1">
        <div
          className="truncate"
          style={{ ...AS_TYPE.itemTitle, color: AS_COLOR.label }}
        >
          {item.title}
        </div>
        <div
          className="truncate"
          style={{ ...AS_TYPE.itemSubtitle, color: AS_COLOR.labelSecondary, marginTop: 2 }}
        >
          {item.subtitle}
        </div>
      </div>
      <AppStorePill
        label={item.pillLabel ?? '打开'}
        caption={item.pillCaption}
        onClick={(e) => { e.stopPropagation(); item.onClick(); }}
      />
      {/* iOS 分隔线 —— 从 icon 右侧开始 */}
      {!isLast && (
        <div
          className="absolute left-0 right-0 bottom-0"
          style={{
            height: 0.5,
            background: AS_COLOR.separator,
            marginLeft: rank !== null ? AS_SPACE.listDividerInset + 22 + 12 : AS_SPACE.listDividerInset,
          }}
          aria-hidden
        />
      )}
    </button>
  );
}

/* ─────────────────────── 程序化 mesh 渐变（无封面图时的兜底） ─────────────────────── */

function buildMeshGradient(accent: { from: string; to: string }): string {
  // 叠三层径向渐变，模拟苹果 Today 那种有质感的背景
  return [
    `radial-gradient(120% 90% at 10% 0%, ${accent.from}cc, transparent 60%)`,
    `radial-gradient(100% 80% at 90% 20%, ${accent.to}aa, transparent 55%)`,
    `radial-gradient(110% 100% at 50% 100%, ${accent.from}66, transparent 60%)`,
    `linear-gradient(180deg, #1c1c1e, #000000)`,
  ].join(', ');
}

/* ─────────────────────── Section：统一包一层 Section 做区块间距 ─────────────────────── */

interface SectionProps {
  title?: string;
  caption?: string;
  onShowAll?: () => void;
  children: ReactNode;
  style?: CSSProperties;
}

export function AppStoreSection({ title, caption, onShowAll, children, style }: SectionProps) {
  return (
    <section style={{ marginTop: AS_SPACE.sectionGap, ...style }}>
      {title && <AppStoreSectionHeader title={title} caption={caption} onShowAll={onShowAll} />}
      {children}
    </section>
  );
}
