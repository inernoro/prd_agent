/**
 * 移动端首页（<768px）—— App Store「Today」版式的页面级复刻。
 *
 * 设计纪律（appStoreTokens 是唯一来源，杜绝随手值）：
 *  - 纯黑画布 + 白字 + 灰阶层级，颜色只出现在图标底色与操作文字（iOS 系统色）
 *  - 字号只走 AS_TYPE 的 9 档；间距只走 AS_SPACE 刻度；圆角/尺寸走 AS_SIZE
 *  - 结构：日期眉 + 大标题 → Featured 大卡（继续上次）→ 七日数据 → 快捷入口分组列表
 *          → 米多早报推广行（副页面入口）→ 推荐智能体货架 → 我的动态 → 页脚
 *  - 全部区块接真实数据（getMobileStats / listRecentWork / getMobileFeed / changelog 未读）
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Bug,
  ChevronRight,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Newspaper,
  type LucideIcon,
} from 'lucide-react';
import { accentFor, iconFor } from '@/lib/agentAccent';
import { useAuthStore } from '@/stores/authStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { buildDefaultCoverUrl } from '@/lib/homepageAssetSlots';
import { AS_COLOR, AS_FONT_FAMILY, AS_SIZE, AS_SPACE, AS_TYPE } from '@/lib/appStoreTokens';
import {
  formatCompactNumber,
  formatRelativeTime,
  greetingFor,
  normalizeFeedTitle,
  recentAgentMetaFor,
  useMobileHomeData,
} from '@/pages/mobile-home/shared';

/** 快捷入口（iOS 系统色实底图标块 + 标题/副题 + chevron），「全部」去百宝箱 */
const HOME_LIST_ENTRIES: Array<{
  key: string;
  title: string;
  subtitle: string;
  route: string;
  Icon: LucideIcon;
  tint: string;
}> = [
  { key: 'document-store', title: '知识库', subtitle: '文档沉淀与资料管理', route: '/document-store', Icon: BookOpen, tint: AS_COLOR.orange },
  { key: 'report-agent', title: '周报', subtitle: '生成、整理与审阅周报', route: '/report-agent', Icon: FileText, tint: AS_COLOR.blue },
  { key: 'visual-agent', title: '生图', subtitle: '文生图、图生图与配图', route: '/visual-agent', Icon: ImageIcon, tint: AS_COLOR.purple },
  { key: 'defect-agent', title: '缺陷', subtitle: '提交、跟踪与复盘问题', route: '/defect-agent', Icon: Bug, tint: AS_COLOR.red },
  { key: 'my-assets', title: '我的资产', subtitle: '图片、文档与附件', route: '/my-assets', Icon: FolderOpen, tint: AS_COLOR.teal },
  { key: 'changelog', title: '更新中心', subtitle: '版本动态与发布记录', route: '/changelog', Icon: Newspaper, tint: AS_COLOR.green },
];

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export default function MobileHomePage() {
  const navigate = useNavigate();
  const data = useMobileHomeData();
  const displayName = useAuthStore((s) => s.user?.displayName ?? '');
  const now = useMemo(() => new Date(), []);

  const headline = data.recentWork[0] ?? null;

  return (
    <div
      className="h-full min-h-0 overflow-auto"
      style={{
        margin: '0 calc(var(--mobile-padding, 16px) * -1)',
        background: AS_COLOR.bg,
        color: AS_COLOR.label,
        fontFamily: AS_FONT_FAMILY,
        overscrollBehavior: 'contain',
      }}
    >
      <main style={{ padding: `10px ${AS_SPACE.gutter}px 112px`, maxWidth: 720, margin: '0 auto' }}>
        {/* ── 日期眉 + 大标题（App Store Today 头） ── */}
        <header>
          <div style={{ ...AS_TYPE.eyebrow, color: AS_COLOR.labelSecondary }}>
            {now.getMonth() + 1}月{now.getDate()}日 星期{WEEKDAYS[now.getDay()]}
          </div>
          <div className="flex items-end justify-between" style={{ marginTop: 2 }}>
            <h1 style={{ ...AS_TYPE.heroTitle, margin: 0 }}>今日</h1>
            {displayName && (
              <span style={{ ...AS_TYPE.heroSubtitle, color: AS_COLOR.labelSecondary, paddingBottom: 4 }}>
                {greetingFor(now)}，{displayName}
              </span>
            )}
          </div>
        </header>

        {/* ── Featured 大卡：继续上次 ── */}
        <section style={{ marginTop: AS_SPACE.titleGap }}>
          <FeaturedCard
            headline={headline}
            onOpen={(route) => navigate(route)}
          />
        </section>

        {/* ── 七日数据（安静的分组卡，不抢戏） ── */}
        <section style={{ marginTop: 14 }}>
          <div
            className="grid grid-cols-4"
            style={{
              borderRadius: AS_SPACE.shelfCardRadius,
              background: AS_COLOR.surface,
              border: `1px solid ${AS_COLOR.hairline}`,
            }}
          >
            {[
              { label: '会话', value: data.stats?.sessions ?? 0 },
              { label: '消息', value: data.stats?.messages ?? 0 },
              { label: '生图', value: data.stats?.imageGenerations ?? 0 },
              { label: 'Token', value: data.stats?.totalTokens ?? 0 },
            ].map((stat, idx) => (
              <div
                key={stat.label}
                style={{
                  padding: '12px 4px 10px',
                  textAlign: 'center',
                  borderLeft: idx > 0 ? `1px solid ${AS_COLOR.hairline}` : undefined,
                }}
              >
                <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>
                  {data.loading ? '—' : formatCompactNumber(stat.value)}
                </div>
                <div style={{ ...AS_TYPE.caption, marginTop: 3, color: AS_COLOR.labelTertiary }}>{stat.label}</div>
              </div>
            ))}
          </div>
          <div style={{ ...AS_TYPE.caption, marginTop: 6, paddingLeft: 2, color: AS_COLOR.labelTertiary }}>
            近 7 日 · 我的使用记录
          </div>
        </section>

        {/* ── 快捷入口：iOS 分组列表 ── */}
        <SectionHeader title="快捷入口" actionLabel="全部" onAction={() => navigate('/ai-toolbox')} />
        <div
          style={{
            borderRadius: AS_SPACE.shelfCardRadius,
            background: AS_COLOR.surface,
            border: `1px solid ${AS_COLOR.hairline}`,
            overflow: 'hidden',
          }}
        >
          {HOME_LIST_ENTRIES.map((entry, idx) => {
            const Icon = entry.Icon;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => navigate(entry.route)}
                className="w-full flex items-center text-left transition-colors active:bg-white/10"
                style={{ gap: 12, padding: `${AS_SPACE.listItemPaddingY - 3}px 14px`, color: AS_COLOR.label, position: 'relative' }}
              >
                <span
                  className="shrink-0 flex items-center justify-center"
                  style={{ width: 40, height: 40, borderRadius: 10, background: entry.tint }}
                >
                  <Icon size={22} strokeWidth={2} style={{ color: '#fff' }} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center" style={{ gap: 7 }}>
                    <span style={{ ...AS_TYPE.itemTitle }}>{entry.title}</span>
                    {entry.key === 'changelog' && data.changelogUnread > 0 && (
                      <span
                        style={{
                          minWidth: 18,
                          padding: '0 5px',
                          borderRadius: AS_SPACE.pillRadius,
                          background: AS_COLOR.red,
                          color: '#fff',
                          fontSize: 11,
                          fontWeight: 600,
                          lineHeight: '17px',
                          textAlign: 'center',
                        }}
                      >
                        {data.changelogUnread > 99 ? '99+' : data.changelogUnread}
                      </span>
                    )}
                  </span>
                  <span className="block truncate" style={{ ...AS_TYPE.itemSubtitle, marginTop: 1, color: AS_COLOR.labelSecondary }}>
                    {entry.subtitle}
                  </span>
                </span>
                <ChevronRight size={17} className="shrink-0" style={{ color: AS_COLOR.labelTertiary }} />
                {idx < HOME_LIST_ENTRIES.length - 1 && (
                  <span
                    aria-hidden
                    style={{ position: 'absolute', left: 66, right: 0, bottom: 0, height: 1, background: AS_COLOR.separator }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* ── 米多早报：副页面推广行 ── */}
        <section style={{ marginTop: 14 }}>
          <button
            type="button"
            onClick={() => navigate('/daily-post')}
            className="w-full flex items-center text-left transition-colors active:bg-white/10"
            style={{
              gap: 12,
              padding: '13px 14px',
              borderRadius: AS_SPACE.shelfCardRadius,
              background: AS_COLOR.surface,
              border: `1px solid ${AS_COLOR.hairline}`,
              color: AS_COLOR.label,
            }}
          >
            <span
              className="shrink-0 flex items-center justify-center"
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: '#c05b3c',
                color: '#fffdf8',
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: '0.03em',
              }}
            >
              MAP
            </span>
            <span className="min-w-0 flex-1">
              <span style={{ ...AS_TYPE.itemTitle }}>米多早报</span>
              <span className="block truncate" style={{ ...AS_TYPE.itemSubtitle, marginTop: 1, color: AS_COLOR.labelSecondary }}>
                今日工作、数据与档案的报纸版
              </span>
            </span>
            <span
              className="shrink-0 flex items-center justify-center"
              style={{
                height: AS_SIZE.pillHeight,
                padding: '0 14px',
                borderRadius: AS_SPACE.pillRadius,
                background: AS_COLOR.pillBg,
                color: AS_COLOR.blue,
                ...AS_TYPE.pill,
              }}
            >
              阅读
            </span>
          </button>
        </section>

        {/* ── 推荐智能体：横滑货架（App Store 水平卡） ── */}
        <RecommendedShelf onNavigate={(to) => navigate(to)} />

        {/* ── 我的动态 ── */}
        <SectionHeader title="我的动态" actionLabel="全部" onAction={() => navigate('/my-assets')} />
        {data.feed.length === 0 ? (
          <div
            style={{
              borderRadius: AS_SPACE.shelfCardRadius,
              background: AS_COLOR.surface,
              border: `1px solid ${AS_COLOR.hairline}`,
              padding: '16px 14px',
            }}
          >
            <div style={{ ...AS_TYPE.itemTitle }}>还没有动态</div>
            <div style={{ ...AS_TYPE.itemSubtitle, marginTop: 3, color: AS_COLOR.labelSecondary }}>
              使用知识库、周报、生图或缺陷后会出现在这里
            </div>
          </div>
        ) : (
          <div
            style={{
              borderRadius: AS_SPACE.shelfCardRadius,
              background: AS_COLOR.surface,
              border: `1px solid ${AS_COLOR.hairline}`,
              overflow: 'hidden',
            }}
          >
            {data.feed.slice(0, 5).map((item, idx, arr) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.navigateTo)}
                className="w-full flex items-center text-left transition-colors active:bg-white/10"
                style={{ gap: 10, padding: '11px 14px', color: AS_COLOR.label, position: 'relative' }}
              >
                <span className="min-w-0 flex-1 truncate" style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em' }}>
                  {normalizeFeedTitle(item)}
                </span>
                <span className="shrink-0" style={{ ...AS_TYPE.itemSubtitle, color: AS_COLOR.labelTertiary }}>
                  {formatRelativeTime(item.updatedAt)}
                </span>
                {idx < arr.length - 1 && (
                  <span aria-hidden style={{ position: 'absolute', left: 14, right: 0, bottom: 0, height: 1, background: AS_COLOR.separator }} />
                )}
              </button>
            ))}
          </div>
        )}

        {/* ── 页脚 ── */}
        <footer style={{ marginTop: AS_SPACE.sectionGap, textAlign: 'center' }}>
          <div style={{ ...AS_TYPE.caption, color: AS_COLOR.labelTertiary }}>
            MAP · 每个成员，都有一支 AI 团队
          </div>
        </footer>
      </main>
    </div>
  );
}

/* ───────────── Featured 大卡（继续上次 / 空态引导） ───────────── */

function FeaturedCard({
  headline,
  onOpen,
}: {
  headline: { route: string; agentKey: string; title: string; lastActiveAt: string } | null;
  onOpen: (route: string) => void;
}) {
  const meta = headline ? recentAgentMetaFor(headline.agentKey) : null;
  const accent = meta?.accent ?? AS_COLOR.orange;
  const route = headline?.route ?? '/document-store';
  const Icon = meta?.Icon ?? BookOpen;

  return (
    <button
      type="button"
      onClick={() => onOpen(route)}
      className="relative w-full overflow-hidden text-left transition-transform active:scale-[0.99]"
      style={{
        borderRadius: AS_SPACE.featuredRadius,
        aspectRatio: AS_SIZE.featuredAspect,
        border: `1px solid ${AS_COLOR.hairline}`,
        color: AS_COLOR.label,
        background: '#1c1c1e',
      }}
    >
      {/* 克制的双色渐层画面：深灰基底 + 单一 accent 低饱和罩光（非 AI 霓虹） */}
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `linear-gradient(165deg, ${accent}30 0%, rgba(28,28,30,0) 46%), linear-gradient(200deg, #2c2c2e 0%, #131315 60%, #0a0a0b 100%)`,
        }}
      />
      <span
        aria-hidden
        className="absolute"
        style={{
          right: -46,
          top: -46,
          width: 190,
          height: 190,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${accent}26, transparent 68%)`,
        }}
      />
      <span className="absolute inset-0 flex flex-col" style={{ padding: 18 }}>
        <span style={{ ...AS_TYPE.eyebrow, color: 'rgba(235,235,245,0.6)' }}>
          {headline ? '继续上次' : '从这里开始'}
        </span>
        <span
          style={{
            ...AS_TYPE.featuredTitle,
            marginTop: 6,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {headline ? headline.title || '未命名工作' : '把今天的工作放进 MAP'}
        </span>
        <span style={{ ...AS_TYPE.featuredSubtitle, marginTop: 6, color: 'rgba(235,235,245,0.6)' }}>
          {headline
            ? `${meta?.label ?? '智能体'} · ${formatRelativeTime(headline.lastActiveAt)}`
            : '知识沉淀、周报、生图与缺陷，一处开始'}
        </span>

        {/* 底部条：icon + 说明 + 行动 pill（App Store featured 卡的落款结构） */}
        <span className="mt-auto flex items-center" style={{ gap: 10, paddingTop: 12, borderTop: `1px solid ${AS_COLOR.hairline}` }}>
          <span
            className="shrink-0 flex items-center justify-center"
            style={{ width: 34, height: 34, borderRadius: 9, background: 'rgba(255,255,255,0.14)' }}
          >
            <Icon size={19} strokeWidth={2} style={{ color: '#fff' }} />
          </span>
          <span className="min-w-0 flex-1" style={{ ...AS_TYPE.itemSubtitle, color: 'rgba(235,235,245,0.6)' }}>
            {headline ? '回到你离开时的工作现场' : '进入知识库，创建第一篇文档'}
          </span>
          <span
            className="shrink-0 flex items-center justify-center"
            style={{
              height: AS_SIZE.pillHeight,
              padding: '0 16px',
              borderRadius: AS_SPACE.pillRadius,
              background: 'rgba(255,255,255,0.18)',
              color: '#fff',
              ...AS_TYPE.pill,
            }}
          >
            {headline ? '继续' : '开始'}
          </span>
        </span>
      </span>
    </button>
  );
}

/* ───────────── 区块标题（26px + 右侧 See All） ───────────── */

function SectionHeader({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      className="flex items-baseline justify-between"
      style={{ marginTop: AS_SPACE.sectionGap - 8, marginBottom: AS_SPACE.titleGap - 4 }}
    >
      <h2 style={{ ...AS_TYPE.sectionTitle, margin: 0 }}>{title}</h2>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="transition-opacity active:opacity-60"
          style={{ ...AS_TYPE.sectionAction, color: AS_COLOR.blue }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/* ───────────── 推荐智能体：水平货架卡（icon 52 + 文案 + 打开 pill） ───────────── */

function RecommendedShelf({ onNavigate }: { onNavigate: (to: string) => void }) {
  const cdnBase = useAuthStore((s) => s.cdnBaseUrl ?? '');
  const items = useMemo(
    () =>
      BUILTIN_TOOLS.filter((t) => t.kind === 'agent')
        .filter((t) => resolveMobileCompat(t.routePath ?? '')?.level !== 'pc-only')
        .filter((t) => !HOME_LIST_ENTRIES.some((entry) => entry.route === t.routePath))
        .slice(0, 6),
    [],
  );
  if (items.length === 0) return null;

  return (
    <>
      <SectionHeader title="推荐智能体" actionLabel="全部" onAction={() => onNavigate('/ai-toolbox')} />
      <div
        className="flex overflow-x-auto"
        style={{
          gap: AS_SIZE.shelfGap,
          margin: `0 -${AS_SPACE.gutter}px`,
          padding: `0 ${AS_SPACE.gutter}px 4px`,
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
          overscrollBehaviorX: 'contain',
        }}
      >
        {items.map((item) => {
          const Icon = iconFor(item.icon);
          const accent = accentFor(item.agentKey);
          const coverUrl = cdnBase ? buildDefaultCoverUrl(cdnBase, item.agentKey) : null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.routePath ?? `/ai-toolbox?item=${item.id}`)}
              className="shrink-0 flex items-center text-left transition-transform active:scale-[0.985]"
              style={{
                width: AS_SIZE.shelfCardWidth,
                height: AS_SIZE.shelfCardHeight,
                gap: 12,
                padding: '0 14px',
                borderRadius: AS_SPACE.shelfCardRadius,
                background: AS_COLOR.surface,
                border: `1px solid ${AS_COLOR.hairline}`,
                color: AS_COLOR.label,
              }}
            >
              <span
                className="shrink-0 flex items-center justify-center overflow-hidden"
                style={{
                  width: AS_SIZE.appIconSize,
                  height: AS_SIZE.appIconSize,
                  borderRadius: AS_SPACE.iconRadius,
                  background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
                }}
              >
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt=""
                    aria-hidden
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ) : (
                  <Icon size={26} style={{ color: '#fff' }} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate" style={{ ...AS_TYPE.itemTitle }}>{item.name}</span>
                <span className="block truncate" style={{ ...AS_TYPE.itemSubtitle, marginTop: 2, color: AS_COLOR.labelSecondary }}>
                  {item.description}
                </span>
              </span>
              <span
                className="shrink-0 flex items-center justify-center"
                style={{
                  height: AS_SIZE.pillHeight,
                  padding: '0 14px',
                  borderRadius: AS_SPACE.pillRadius,
                  background: AS_COLOR.pillBg,
                  color: AS_COLOR.blue,
                  ...AS_TYPE.pill,
                }}
              >
                打开
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
