import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  Bug,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react';
import { accentFor, iconFor } from '@/lib/agentAccent';
import { useAuthStore } from '@/stores/authStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { getMobileFeed } from '@/services';
import type { FeedItem } from '@/services/contracts/mobile';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { buildDefaultCoverUrl } from '@/lib/homepageAssetSlots';
import { AS_COLOR, AS_FONT_FAMILY } from '@/lib/appStoreTokens';

const AMBER = '#FF9F0A';
const SURFACE = 'rgba(255,255,255,0.105)';
const HAIRLINE = 'rgba(255,255,255,0.17)';
const TEXT_SECONDARY = 'rgba(245,245,247,0.74)';
const TEXT_TERTIARY = 'rgba(245,245,247,0.52)';

interface HomeTool {
  key: string;
  title: string;
  subtitle: string;
  route: string;
  Icon: LucideIcon;
  accent: string;
}

const PRIMARY_TOOLS: HomeTool[] = [
  {
    key: 'document-store',
    title: '知识库',
    subtitle: '文档沉淀与资料管理',
    route: '/document-store',
    Icon: BookOpen,
    accent: '#FFB340',
  },
  {
    key: 'report-agent',
    title: '周报',
    subtitle: '生成、整理与审阅周报',
    route: '/report-agent',
    Icon: FileText,
    accent: '#7DD3FC',
  },
  {
    key: 'visual-agent',
    title: '生图',
    subtitle: '文生图、图生图与配图',
    route: '/visual-agent',
    Icon: ImageIcon,
    accent: '#A78BFA',
  },
  {
    key: 'defect-agent',
    title: '缺陷',
    subtitle: '提交、跟踪与复盘问题',
    route: '/defect-agent',
    Icon: Bug,
    accent: '#FB7185',
  },
];

const HERO_CARDS = [
  {
    key: 'today-workbench',
    title: '今日工作台',
    subtitle: '知识沉淀 · 周报生成',
    route: '/document-store',
  },
  {
    key: 'visual-workbench',
    title: '生图与资产',
    subtitle: '配图生成 · 素材归档',
    route: '/visual-agent',
  },
  {
    key: 'defect-workbench',
    title: '缺陷闭环',
    subtitle: '问题记录 · 复盘追踪',
    route: '/defect-agent',
  },
];

const FEED_ICON: Record<string, { icon: LucideIcon; color: string; bg: string }> = {
  'prd-session': { icon: MessageSquare, color: '#7DD3FC', bg: 'rgba(125,211,252,0.13)' },
  'visual-workspace': { icon: ImageIcon, color: '#A78BFA', bg: 'rgba(167,139,250,0.13)' },
  defect: { icon: Bug, color: '#FB7185', bg: 'rgba(251,113,133,0.13)' },
};

export default function MobileHomePage() {
  const navigate = useNavigate();
  const cdnBase = useAuthStore((s) => s.cdnBaseUrl ?? '');
  const [feed, setFeed] = useState<FeedItem[]>([]);

  useEffect(() => {
    (async () => {
      const feedRes = await getMobileFeed({ limit: 6 });
      if (feedRes.success) {
        setFeed(feedRes.data.items ?? []);
      }
    })();
  }, []);

  const recommendedAgents = useMemo(
    () => BUILTIN_TOOLS
      .filter((t) => t.kind === 'agent')
      .filter((t) => resolveMobileCompat(t.routePath ?? '')?.level !== 'pc-only')
      .filter((t) => !PRIMARY_TOOLS.some((tool) => tool.route === t.routePath))
      .slice(0, 5),
    [],
  );

  return (
    <div
      className="h-full min-h-0 overflow-auto"
      style={{
        margin: '0 calc(var(--mobile-padding, 16px) * -1)',
        background:
          'radial-gradient(circle at 72% 8%, rgba(255,159,10,0.22), transparent 32%), radial-gradient(circle at 10% 48%, rgba(52,132,170,0.18), transparent 34%), linear-gradient(180deg, #1c1d24 0%, #12161b 46%, #0c0e12 100%)',
        color: AS_COLOR.label,
        fontFamily: AS_FONT_FAMILY,
      }}
    >
      <main style={{ padding: '4px 20px 112px' }}>
        <h1
          style={{
            margin: 0,
            fontSize: 34,
            lineHeight: 1.08,
            fontWeight: 800,
            letterSpacing: 0,
          }}
        >
          今日
        </h1>

        <HeroCarousel onNavigate={navigate} />

        <QuickStartStrip items={PRIMARY_TOOLS.slice(0, 3)} onNavigate={navigate} />

        <SectionTitle title="常用入口" />
        <ToolGrid tools={PRIMARY_TOOLS} onNavigate={navigate} />

        <SectionTitle title="我的动态" actionLabel="全部" onAction={() => navigate('/assets')} dense />
        <MyActivityList feed={feed.slice(0, 4)} onNavigate={navigate} />

        {recommendedAgents.length > 0 && (
          <>
            <SectionTitle title="推荐智能体" actionLabel="全部" onAction={() => navigate('/ai-toolbox')} />
            <RecommendedAgentRow
              cdnBase={cdnBase}
              items={recommendedAgents}
              onNavigate={(path) => navigate(path)}
            />
          </>
        )}
      </main>
    </div>
  );
}

function HeroCarousel({ onNavigate }: { onNavigate: (to: string) => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let frame = 0;
    const updateActiveIndex = () => {
      const firstCard = scroller.firstElementChild;
      if (!(firstCard instanceof HTMLElement)) return;
      const cardWidth = firstCard.getBoundingClientRect().width;
      const gap = 12;
      const nextIndex = Math.round(scroller.scrollLeft / (cardWidth + gap));
      setActiveIndex(Math.max(0, Math.min(HERO_CARDS.length - 1, nextIndex)));
    };
    const handleScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateActiveIndex);
    };

    updateActiveIndex();
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', handleScroll);
    };
  }, []);

  return (
    <section style={{ marginTop: 18 }}>
      <div
        ref={scrollerRef}
        className="flex overflow-x-auto snap-x snap-mandatory"
        style={{
          gap: 12,
          paddingBottom: 2,
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
          overscrollBehaviorX: 'contain',
        }}
        aria-label="今日首页推荐"
      >
        {HERO_CARDS.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => onNavigate(card.route)}
            className="relative shrink-0 snap-start overflow-hidden text-left transition-transform active:scale-[0.985]"
            style={{
              width: 'calc(100vw - 76px)',
              minWidth: 304,
              maxWidth: 720,
              aspectRatio: '1.68 / 1',
              borderRadius: 18,
              border: `1px solid ${HAIRLINE}`,
              background:
                'linear-gradient(135deg, rgba(42,43,51,0.98), rgba(18,20,25,0.98))',
              boxShadow: '0 22px 70px rgba(0,0,0,0.36)',
              color: '#fff',
            }}
          >
            <AmberWorkbenchArt />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(90deg, rgba(0,0,0,0.68) 0%, rgba(0,0,0,0.24) 44%, rgba(0,0,0,0.20) 100%)',
              }}
            />
            <div
              className="absolute left-0 top-0 h-full flex flex-col justify-end"
              style={{ padding: 20, width: '54%' }}
            >
              <div
                style={{
                  fontSize: 25,
                  lineHeight: 1.12,
                  fontWeight: 800,
                  letterSpacing: 0,
                  color: '#FFD08A',
                  textShadow: '0 2px 18px rgba(0,0,0,0.55)',
                  whiteSpace: 'nowrap',
                }}
              >
                {card.title}
              </div>
              <div
                style={{
                  width: 28,
                  height: 3,
                  borderRadius: 999,
                  background: '#FFD08A',
                  margin: '12px 0 10px',
                }}
              />
              <div
                style={{
                  fontSize: 15,
                  lineHeight: 1.35,
                  color: 'rgba(255,255,255,0.84)',
                  fontWeight: 600,
                  letterSpacing: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                {card.subtitle}
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="flex items-center" style={{ gap: 7, marginTop: 9, paddingLeft: 48 }}>
        {HERO_CARDS.map((card, index) => (
          <span key={card.key} style={dotStyle(index === activeIndex)} />
        ))}
      </div>
    </section>
  );
}

function AmberWorkbenchArt() {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 76% 42%, rgba(255,159,10,0.62), transparent 22%), radial-gradient(circle at 28% 16%, rgba(255,214,120,0.24), transparent 34%), linear-gradient(135deg, #151820 0%, #251809 54%, #0d1118 100%)',
        }}
      />
      <div
        className="absolute"
        style={{
          left: 0,
          right: 0,
          bottom: 0,
          height: '44%',
          background:
            'linear-gradient(rgba(255,159,10,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(255,159,10,0.10) 1px, transparent 1px)',
          backgroundSize: '34px 24px',
          opacity: 0.58,
          transform: 'perspective(420px) rotateX(58deg) translateY(18px) scale(1.28)',
          transformOrigin: '50% 100%',
        }}
      />
      <div
        className="absolute"
        style={{
          right: 10,
          top: 30,
          width: '50%',
          height: '66%',
          borderRadius: 18,
          border: '1px solid rgba(255,198,104,0.62)',
          background:
            'linear-gradient(135deg, rgba(255,178,66,0.28), rgba(255,159,10,0.06) 48%, rgba(255,255,255,0.06))',
          boxShadow:
            '0 0 38px rgba(255,159,10,0.32), inset 0 0 30px rgba(255,197,108,0.20)',
          transform: 'perspective(440px) rotateY(-15deg) rotateX(7deg)',
        }}
      >
        <span
          className="absolute"
          style={{
            left: 16,
            top: 14,
            right: 20,
            height: 24,
            borderRadius: 8,
            border: '1px solid rgba(255,211,132,0.38)',
            color: 'rgba(255,225,155,0.78)',
            fontSize: 8,
            lineHeight: '23px',
            textAlign: 'center',
            fontWeight: 800,
            letterSpacing: 0,
          }}
        >
          AI WORKBENCH
        </span>
        <span
          className="absolute"
          style={{
            left: 20,
            right: 18,
            bottom: 18,
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(255,218,146,0.58), transparent)',
          }}
        />
      </div>
      <div
        className="absolute"
        style={{
          right: 48,
          top: 70,
          width: 74,
          height: 74,
          borderRadius: '50%',
          border: '2px solid rgba(255,220,150,0.78)',
          boxShadow: '0 0 24px rgba(255,159,10,0.50), inset 0 0 18px rgba(255,159,10,0.20)',
        }}
      />
      <div
        className="absolute"
        style={{
          right: 65,
          top: 87,
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: '1px solid rgba(255,255,255,0.66)',
          boxShadow: 'inset 0 0 10px rgba(255,255,255,0.16)',
        }}
      />
      {Array.from({ length: 12 }).map((_, i) => {
        const angle = i * 30;
        return (
          <span
            key={`tooth-${i}`}
            className="absolute"
            style={{
              right: 81,
              top: 82,
              width: 4,
              height: 54,
              borderRadius: 999,
              background: 'rgba(255,198,104,0.58)',
              boxShadow: '0 0 8px rgba(255,159,10,0.38)',
              transform: `rotate(${angle}deg) translateY(-27px)`,
              transformOrigin: '2px 45px',
            }}
          />
        );
      })}
      <div
        className="absolute"
        style={{
          right: 74,
          top: 101,
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#FFD08A',
          boxShadow: '0 0 18px rgba(255,159,10,0.85)',
        }}
      />
      {Array.from({ length: 11 }).map((_, i) => (
        <span
          key={`trace-${i}`}
          className="absolute"
          style={{
            right: 12 + i * 34,
            bottom: 18 + (i % 3) * 42,
            width: 46,
            height: 2,
            borderRadius: 999,
            background: i % 2 === 0 ? 'rgba(255,204,120,0.42)' : 'rgba(255,159,10,0.28)',
            boxShadow: '0 0 12px rgba(255,159,10,0.34)',
          }}
        />
      ))}
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={`node-${i}`}
          className="absolute"
          style={{
            right: 38 + i * 42,
            top: 40 + (i % 2) * 78,
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'rgba(255,225,155,0.74)',
            boxShadow: '0 0 12px rgba(255,159,10,0.76)',
          }}
        />
      ))}
    </div>
  );
}

function QuickStartStrip({
  items,
  onNavigate,
}: {
  items: HomeTool[];
  onNavigate: (to: string) => void;
}) {
  return (
    <div
      className="grid grid-cols-3 overflow-hidden"
      style={{
        marginTop: 14,
        borderRadius: 16,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.135), rgba(255,255,255,0.075))',
        border: `1px solid ${HAIRLINE}`,
        boxShadow: '0 18px 58px rgba(0,0,0,0.32)',
      }}
    >
      {items.map((item, index) => {
        const Icon = item.Icon;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onNavigate(item.route)}
            className="min-h-[62px] flex items-center gap-2 text-left transition-colors active:bg-white/10"
            style={{
              padding: '10px 10px',
              color: '#fff',
              borderRight: index < items.length - 1 ? `1px solid ${HAIRLINE}` : undefined,
            }}
          >
            <Icon size={22} strokeWidth={2.1} style={{ color: AMBER }} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.1, letterSpacing: 0 }}>
                {item.title}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: TEXT_TERTIARY, letterSpacing: 0 }}>
                打开
              </div>
            </div>
            <ChevronRight size={15} style={{ color: TEXT_TERTIARY }} className="shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

function SectionTitle({
  title,
  actionLabel,
  onAction,
  dense = false,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  dense?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ marginTop: dense ? 22 : 24, marginBottom: dense ? 10 : 12 }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: 23,
          lineHeight: 1.15,
          fontWeight: 800,
          letterSpacing: 0,
          color: '#fff',
        }}
      >
        {title}
      </h2>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="min-h-[44px] inline-flex items-center gap-1 transition-opacity active:opacity-60"
          style={{
            color: TEXT_SECONDARY,
            fontSize: 15,
            fontWeight: 500,
            letterSpacing: 0,
          }}
        >
          {actionLabel}
          <ChevronRight size={17} />
        </button>
      )}
    </div>
  );
}

function ToolGrid({
  tools,
  onNavigate,
}: {
  tools: HomeTool[];
  onNavigate: (to: string) => void;
}) {
  return (
    <div className="grid grid-cols-4" style={{ gap: 9 }}>
      {tools.map((tool) => {
        const Icon = tool.Icon;
        return (
          <button
            key={tool.key}
            type="button"
            onClick={() => onNavigate(tool.route)}
            className="min-h-[78px] flex flex-col items-center justify-center transition-transform active:scale-[0.97]"
            style={{
              borderRadius: 15,
              background: 'linear-gradient(180deg, rgba(255,255,255,0.135), rgba(255,255,255,0.075))',
              border: `1px solid ${HAIRLINE}`,
              color: '#fff',
              padding: '9px 6px',
            }}
          >
            <Icon size={25} strokeWidth={1.9} style={{ color: 'rgba(255,255,255,0.86)' }} />
            <span
              aria-hidden
              style={{
                width: 18,
                height: 2,
                borderRadius: 999,
                background: tool.accent,
                margin: '7px 0 6px',
                boxShadow: `0 0 10px ${tool.accent}66`,
              }}
            />
            <span style={{ fontSize: 13, lineHeight: 1.15, color: 'rgba(255,255,255,0.82)', letterSpacing: 0 }}>
              {tool.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MyActivityList({
  feed,
  onNavigate,
}: {
  feed: FeedItem[];
  onNavigate: (to: string) => void;
}) {
  if (feed.length === 0) {
    return (
      <div
        className="flex items-center gap-3"
        style={{
          minHeight: 76,
          borderRadius: 16,
          background: SURFACE,
          border: `1px solid ${HAIRLINE}`,
          padding: '0 14px',
        }}
      >
        <div
          className="shrink-0 flex items-center justify-center"
          style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,159,10,0.12)' }}
        >
          <Activity size={19} style={{ color: AMBER }} />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: 0 }}>
            还没有我的动态
          </div>
          <div style={{ marginTop: 3, fontSize: 13, color: TEXT_SECONDARY, letterSpacing: 0 }}>
            使用知识库、周报、生图或缺陷后会出现在这里
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        borderRadius: 18,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.105), rgba(255,255,255,0.055))',
        border: `1px solid ${HAIRLINE}`,
        overflow: 'hidden',
      }}
    >
      {feed.map((item, idx) => {
        const meta = FEED_ICON[item.type] ?? { icon: MessageSquare, color: AMBER, bg: 'rgba(255,159,10,0.13)' };
        const Icon = meta.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.navigateTo)}
            className="w-full min-h-[62px] flex items-center text-left transition-colors active:bg-white/10"
            style={{
              display: 'flex',
              gap: 10,
              padding: '10px 13px',
              color: '#fff',
              borderBottom: idx < feed.length - 1 ? `1px solid ${AS_COLOR.separator}` : undefined,
            }}
          >
            <div
              className="shrink-0 flex items-center justify-center"
              style={{ width: 38, height: 38, borderRadius: 11, background: meta.bg }}
            >
              <Icon size={18} strokeWidth={2.1} style={{ color: meta.color }} />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="truncate"
                style={{ fontSize: 14, lineHeight: 1.2, fontWeight: 700, color: '#fff', letterSpacing: 0 }}
              >
                {normalizeFeedTitle(item)}
              </div>
              <div
                className="truncate"
                style={{ marginTop: 3, fontSize: 12, lineHeight: 1.2, color: TEXT_SECONDARY, letterSpacing: 0 }}
              >
                我 · {formatRelativeTime(item.updatedAt)}
              </div>
            </div>
            <ChevronRight size={17} style={{ color: TEXT_TERTIARY }} className="shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

function RecommendedAgentRow({
  cdnBase,
  items,
  onNavigate,
}: {
  cdnBase: string;
  items: typeof BUILTIN_TOOLS;
  onNavigate: (to: string) => void;
}) {
  return (
    <div
      className="flex overflow-x-auto"
      style={{
        gap: 12,
        margin: '0 -20px',
        padding: '0 20px 4px',
        scrollbarWidth: 'none',
        WebkitOverflowScrolling: 'touch',
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
            className="shrink-0 text-left transition-transform active:scale-[0.98]"
            style={{
              width: 148,
              minHeight: 112,
              borderRadius: 16,
              background: SURFACE,
              border: `1px solid ${HAIRLINE}`,
              padding: 12,
              color: '#fff',
            }}
          >
            <div
              className="flex items-center justify-center overflow-hidden"
              style={{
                width: 42,
                height: 42,
                borderRadius: 12,
                background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
              }}
            >
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt=""
                  aria-hidden
                  className="h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ) : (
                <Icon size={21} style={{ color: '#fff' }} />
              )}
            </div>
            <div
              className="truncate"
              style={{ marginTop: 10, fontSize: 15, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0 }}
            >
              {item.name}
            </div>
            <div
              className="line-clamp-2"
              style={{
                marginTop: 4,
                fontSize: 12,
                lineHeight: 1.35,
                color: TEXT_SECONDARY,
                letterSpacing: 0,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {item.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function normalizeFeedTitle(item: FeedItem): string {
  if (item.type === 'visual-workspace') return `生成了一张配图：${item.title}`;
  if (item.type === 'defect') return `更新了缺陷：${item.title}`;
  return `更新了知识内容：${item.title}`;
}

function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '刚刚';
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  if (diff < 48 * 60 * 60_000) return '昨天';
  return `${Math.floor(diff / (24 * 60 * 60_000))} 天前`;
}

function dotStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-block',
    width: active ? 30 : 8,
    height: 5,
    borderRadius: 999,
    background: active ? '#fff' : 'rgba(235,235,245,0.28)',
  };
}
