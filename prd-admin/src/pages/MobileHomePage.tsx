import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as LucideIcons from 'lucide-react';
import {
  MessageSquare,
  Image as ImageIcon,
  Bug,
  Bell,
  ChevronRight,
  Bot,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import type { ToolboxItem } from '@/services/real/aiToolbox';
import { getAdminNotifications, getMobileFeed, getMobileStats } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';
import { resolveAvatarUrl } from '@/lib/avatar';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { buildDefaultCoverUrl } from '@/lib/homepageAssetSlots';
import {
  AppStoreHero,
  AppStoreFeatured,
  AppStoreSection,
  AppStoreShelf,
  AppStoreRankedList,
} from '@/components/mobile/appStore';
import { AS_COLOR, AS_SPACE, AS_FONT_FAMILY, AS_TYPE } from '@/lib/appStoreTokens';

/* ─────────── Agent 主题色（iOS System Colors 级，不刺眼） ─────────── */

const AGENT_ACCENT: Record<string, { from: string; to: string }> = {
  'prd-agent':       { from: '#0A84FF', to: '#64D2FF' },  // iOS Blue → Teal
  'visual-agent':    { from: '#BF5AF2', to: '#FF375F' },  // iOS Purple → Pink
  'literary-agent':  { from: '#30D158', to: '#64D2FF' },  // iOS Green → Teal
  'defect-agent':    { from: '#FF9F0A', to: '#FF453A' },  // iOS Orange → Red
  'video-agent':     { from: '#FF375F', to: '#BF5AF2' },  // iOS Pink → Purple
  'report-agent':    { from: '#5E5CE6', to: '#0A84FF' },  // iOS Indigo → Blue
  'review-agent':    { from: '#FFD60A', to: '#FF9F0A' },  // iOS Yellow → Orange
  'pr-review':       { from: '#5E5CE6', to: '#64D2FF' },  // iOS Indigo → Teal
  'shortcuts-agent': { from: '#FFD60A', to: '#FF9F0A' },  // iOS Yellow → Orange
  'transcript-agent':{ from: '#FF375F', to: '#BF5AF2' },  // Pink → Purple
  'workflow-agent':  { from: '#30D158', to: '#64D2FF' },  // Green → Teal
  'arena':           { from: '#FF9F0A', to: '#FFD60A' },  // Orange → Yellow
};

const DEFAULT_ACCENT = { from: '#0A84FF', to: '#5E5CE6' };

function accentFor(agentKey?: string): { from: string; to: string } {
  if (!agentKey) return DEFAULT_ACCENT;
  return AGENT_ACCENT[agentKey] ?? DEFAULT_ACCENT;
}

function iconFor(iconName: string): LucideIcon {
  const icons = LucideIcons as unknown as Record<string, LucideIcon>;
  return icons[iconName] ?? Bot;
}

/* ─────────── Feed 类型映射 ─────────── */

const FEED_ICON: Record<string, { icon: LucideIcon; accent: { from: string; to: string } }> = {
  'prd-session':      { icon: MessageSquare, accent: { from: '#0A84FF', to: '#64D2FF' } },
  'visual-workspace': { icon: ImageIcon,     accent: { from: '#BF5AF2', to: '#FF375F' } },
  'defect':           { icon: Bug,           accent: { from: '#FF9F0A', to: '#FF453A' } },
};

/* ─────────── 页面 ─────────── */

export default function MobileHomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const cdnBase = useAuthStore((s) => s.cdnBaseUrl ?? '');
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [stats, setStats] = useState<MobileStats | null>(null);

  useEffect(() => {
    (async () => {
      const [feedRes, statsRes, notifRes] = await Promise.allSettled([
        getMobileFeed({ limit: 10 }),
        getMobileStats({ days: 7 }),
        getAdminNotifications(),
      ]);
      if (feedRes.status === 'fulfilled' && feedRes.value.success) {
        setFeed(feedRes.value.data.items ?? []);
      }
      if (statsRes.status === 'fulfilled' && statsRes.value.success) {
        setStats(statsRes.value.data);
      }
      if (notifRes.status === 'fulfilled' && notifRes.value.success) {
        setNotifications(notifRes.value.data.items?.filter((n) => n.status === 'open') ?? []);
      }
    })();
  }, []);

  /* ── 今日问候 + 日期 ── */
  // 在组件挂载时锁定时间，避免 useMemo 依赖不稳定（页面开着几小时后再切问候语不是关键需求）
  const now = useMemo(() => new Date(), []);
  const greeting = useMemo(() => {
    const h = now.getHours();
    if (h < 6) return '夜深了';
    if (h < 12) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }, [now]);

  const dateEyebrow = useMemo(() => {
    const weekday = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][now.getDay()];
    return `${weekday} · ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  }, [now]);

  const displayName = user?.displayName || user?.username || '';
  const avatarUrl = user ? resolveAvatarUrl(user) : null;

  /* ── 数据分类 ── */
  const agents = useMemo(() => BUILTIN_TOOLS.filter((t) => t.kind === 'agent'), []);
  const tools = useMemo(() => BUILTIN_TOOLS.filter((t) => t.kind === 'tool'), []);

  /* ── 今日精选（基于日期 rotate） ── */
  const featured = useMemo(() => {
    if (agents.length === 0) return null;
    const dayOfYear = Math.floor(
      (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000,
    );
    return agents[dayOfYear % agents.length];
  }, [agents, now]);

  const featuredImage = useMemo(() => {
    if (!featured?.agentKey) return null;
    return buildDefaultCoverUrl(cdnBase, featured.agentKey);
  }, [featured, cdnBase]);

  const handleItemClick = (item: ToolboxItem) => {
    navigate(item.routePath ?? `/ai-toolbox?item=${item.id}`);
  };

  const compatTagFor = (item: ToolboxItem) => {
    if (!item.routePath) return undefined;
    const c = resolveMobileCompat(item.routePath);
    if (c?.level === 'pc-only') {
      return { label: 'PC', color: '#FCA5A5', bg: 'rgba(255, 69, 58, 0.22)' };
    }
    if (c?.level === 'limited') {
      return { label: '部分', color: '#FFD60A', bg: 'rgba(255, 214, 10, 0.18)' };
    }
    return undefined;
  };

  return (
    <div
      className="h-full min-h-0 overflow-auto"
      style={{
        background: AS_COLOR.bg,
        fontFamily: AS_FONT_FAMILY,
      }}
    >
      <div style={{ paddingBottom: 120 }}>
        {/* ── Hero ── */}
        <AppStoreHero
          eyebrow={dateEyebrow}
          title={`${greeting}${displayName ? '，' + displayName : ''}`}
          subtitle="看看今天能帮你做什么"
          trailing={
            <AvatarBadge
              avatarUrl={avatarUrl}
              fallback={displayName[0]}
              notifCount={notifications.length}
              onClick={() => navigate('/profile')}
            />
          }
        />

        {/* ── Featured 大卡（今日推荐 Agent） ── */}
        {featured && (
          <section style={{ marginTop: AS_SPACE.sectionGap }}>
            <AppStoreFeatured
              eyebrow="今日推荐"
              eyebrowColor="#FFD60A"
              title={featured.name}
              subtitle={featured.description}
              imageUrl={featuredImage}
              accent={accentFor(featured.agentKey)}
              footer={{
                Icon: iconFor(featured.icon),
                name: featured.name,
                tagline: (featured.tags ?? []).slice(0, 3).join(' · '),
              }}
              onClick={() => handleItemClick(featured)}
              pillLabel="打开"
            />
          </section>
        )}

        {/* ── 智能体（横滑） ── */}
        {agents.length > 0 && (
          <AppStoreSection
            title="智能体"
            caption="AI 全生命周期 · 有专属存储与界面"
            onShowAll={() => navigate('/ai-toolbox')}
          >
            <AppStoreShelf
              items={agents.map((a) => ({
                key: a.id,
                Icon: iconFor(a.icon),
                accent: accentFor(a.agentKey),
                title: a.name,
                subtitle: a.description,
                tag: compatTagFor(a),
                onClick: () => handleItemClick(a),
              }))}
            />
          </AppStoreSection>
        )}

        {/* ── 工具（Top 榜单） ── */}
        {tools.length > 0 && (
          <AppStoreSection
            title="工具"
            caption="专项能力 · 即开即用"
            onShowAll={() => navigate('/ai-toolbox')}
          >
            <AppStoreRankedList
              numbered
              items={tools.map((t) => ({
                key: t.id,
                Icon: iconFor(t.icon),
                accent: accentFor(t.agentKey),
                title: t.name,
                subtitle: t.description,
                pillLabel: '打开',
                pillCaption: compatTagFor(t)?.label === 'PC' ? '建议 PC 使用' : undefined,
                onClick: () => handleItemClick(t),
              }))}
            />
          </AppStoreSection>
        )}

        {/* ── 近 7 日统计（极简 chip 排） ── */}
        {stats && <StatsRow stats={stats} />}

        {/* ── 通知（榜单风） ── */}
        {notifications.length > 0 && (
          <AppStoreSection
            title="通知"
            caption={`${notifications.length} 条待处理`}
            onShowAll={() => navigate('/notifications')}
          >
            <NotificationsList notifications={notifications.slice(0, 4)} />
          </AppStoreSection>
        )}

        {/* ── 最近活动 ── */}
        {feed.length > 0 && (
          <AppStoreSection
            title="最近活动"
          >
            <FeedList feed={feed.slice(0, 6)} onNavigate={(to) => navigate(to)} />
          </AppStoreSection>
        )}
      </div>
    </div>
  );
}

/* ─────────────── 顶部头像 + 通知红点 ─────────────── */

function AvatarBadge({ avatarUrl, fallback, notifCount, onClick }: {
  avatarUrl: string | null;
  fallback: string;
  notifCount: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative transition-opacity active:opacity-60"
      style={{ border: 'none', background: 'transparent', padding: 0 }}
      aria-label="个人中心"
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 999,
          overflow: 'hidden',
          background: AS_COLOR.surface,
          border: `1px solid ${AS_COLOR.hairline}`,
        }}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ ...AS_TYPE.itemTitle, color: AS_COLOR.label }}
          >
            {fallback || '?'}
          </div>
        )}
      </div>
      {notifCount > 0 && (
        <span
          className="absolute"
          style={{
            top: -2,
            right: -2,
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 999,
            background: AS_COLOR.red,
            color: AS_COLOR.label,
            fontSize: 10,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `2px solid ${AS_COLOR.bg}`,
            lineHeight: 1,
          }}
        >
          {notifCount > 99 ? '99+' : notifCount}
        </span>
      )}
    </button>
  );
}

/* ─────────────── 近 7 日统计（极简横排） ─────────────── */

function StatsRow({ stats }: { stats: MobileStats }) {
  const items = [
    { label: '会话', value: stats.sessions },
    { label: '消息', value: stats.messages },
    { label: '生图', value: stats.imageGenerations },
    {
      label: 'Token',
      value: stats.totalTokens >= 10000
        ? `${(stats.totalTokens / 1000).toFixed(1)}k`
        : String(stats.totalTokens),
    },
  ];

  return (
    <AppStoreSection title="近 7 日">
      <div
        className="grid grid-cols-4"
        style={{
          margin: `0 ${AS_SPACE.gutter}px`,
          borderRadius: AS_SPACE.shelfCardRadius,
          background: AS_COLOR.surface,
          border: `1px solid ${AS_COLOR.hairline}`,
          overflow: 'hidden',
        }}
      >
        {items.map((it, i) => (
          <div
            key={it.label}
            className="flex flex-col items-center justify-center"
            style={{
              padding: '16px 4px',
              borderRight: i < items.length - 1 ? `0.5px solid ${AS_COLOR.hairline}` : undefined,
            }}
          >
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: AS_COLOR.label,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
              }}
            >
              {it.value}
            </div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: AS_COLOR.labelSecondary,
                marginTop: 4,
                letterSpacing: '0.02em',
              }}
            >
              {it.label}
            </div>
          </div>
        ))}
      </div>
    </AppStoreSection>
  );
}

/* ─────────────── 通知列表 ─────────────── */

function NotificationsList({ notifications }: { notifications: AdminNotificationItem[] }) {
  return (
    <div style={{ padding: `0 ${AS_SPACE.gutter}px` }}>
      {notifications.map((n, idx) => (
        <div
          key={n.id}
          className="flex items-start gap-3 relative"
          style={{ padding: '14px 0' }}
        >
          <div
            className="shrink-0 flex items-center justify-center"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'rgba(255, 159, 10, 0.16)',
            }}
          >
            <Bell size={16} strokeWidth={2} style={{ color: AS_COLOR.orange }} />
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="truncate"
              style={{ ...AS_TYPE.itemTitle, color: AS_COLOR.label, fontSize: 15 }}
            >
              {n.title}
            </div>
            {n.message && (
              <div
                className="line-clamp-2"
                style={{
                  ...AS_TYPE.itemSubtitle,
                  color: AS_COLOR.labelSecondary,
                  marginTop: 2,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {n.message}
              </div>
            )}
          </div>
          {idx < notifications.length - 1 && (
            <div
              className="absolute bottom-0"
              style={{
                left: 48,
                right: 0,
                height: 0.5,
                background: AS_COLOR.separator,
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────────── Feed 列表 ─────────────── */

function FeedList({ feed, onNavigate }: { feed: FeedItem[]; onNavigate: (to: string) => void }) {
  return (
    <div style={{ padding: `0 ${AS_SPACE.gutter}px` }}>
      {feed.map((item, idx) => {
        const meta = FEED_ICON[item.type] ?? { icon: MessageSquare, accent: DEFAULT_ACCENT };
        const Icon = meta.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.navigateTo)}
            className="w-full flex items-center gap-3 text-left transition-opacity active:opacity-60 relative"
            style={{ padding: '12px 0' }}
          >
            <div
              className="shrink-0 flex items-center justify-center"
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: `linear-gradient(135deg, ${meta.accent.from}, ${meta.accent.to})`,
              }}
            >
              <Icon size={18} strokeWidth={2.2} style={{ color: '#FFFFFF' }} />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="truncate"
                style={{ ...AS_TYPE.itemTitle, color: AS_COLOR.label, fontSize: 15 }}
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
            <ChevronRight size={18} style={{ color: AS_COLOR.labelTertiary }} className="shrink-0" />
            {idx < feed.length - 1 && (
              <div
                className="absolute bottom-0"
                style={{
                  left: 52,
                  right: 0,
                  height: 0.5,
                  background: AS_COLOR.separator,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
