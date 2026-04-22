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
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { buildDefaultCoverUrl, buildDefaultVideoUrl } from '@/lib/homepageAssetSlots';
import {
  AppStoreHero,
  AppStoreFeaturedCarousel,
  AppStoreSection,
  AppStoreShelf,
  AppStoreRankedList,
  type FeaturedItem,
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

/** 每个 Agent 的上眉 eyebrow 标签（苹果 NOW AVAILABLE / MEET THE DEVELOPER 风，极简） */
const AGENT_EYEBROW: Record<string, { label: string; color: string }> = {
  'prd-agent':       { label: '产品神器',     color: '#0A84FF' },
  'visual-agent':    { label: '创作之眼',     color: '#BF5AF2' },
  'literary-agent':  { label: '写作新搭档',   color: '#30D158' },
  'defect-agent':    { label: '缺陷追踪',     color: '#FF9F0A' },
  'video-agent':     { label: '文字生视频',   color: '#FF375F' },
  'report-agent':    { label: '周报自动化',   color: '#5E5CE6' },
  'review-agent':    { label: '产品评审员',   color: '#FFD60A' },
  'pr-review':       { label: 'PR 智能审查',  color: '#64D2FF' },
  'shortcuts-agent': { label: '快捷指令',     color: '#FFD60A' },
  'transcript-agent':{ label: '音视频转录',   color: '#FF375F' },
};

export default function MobileHomePage() {
  const navigate = useNavigate();
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

  /* ── 数据分类 ── */
  const agents = useMemo(() => BUILTIN_TOOLS.filter((t) => t.kind === 'agent'), []);
  const tools = useMemo(() => BUILTIN_TOOLS.filter((t) => t.kind === 'tool'), []);

  /* ── 推荐 Carousel 项（有视频资产优先，无资产不上榜） ── */
  const featuredItems: FeaturedItem[] = useMemo(() => {
    // 只取有视频或图片资产的 agent，才能撑起海报级大卡
    const withMedia = agents.filter((a) => {
      if (!a.agentKey) return false;
      return Boolean(buildDefaultVideoUrl(cdnBase, a.agentKey) || buildDefaultCoverUrl(cdnBase, a.agentKey));
    });
    // 按日期 rotate 起始位置，让每天首卡不同
    const now = new Date();
    const dayOfYear = Math.floor(
      (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000,
    );
    const offset = withMedia.length > 0 ? dayOfYear % withMedia.length : 0;
    const rotated = [...withMedia.slice(offset), ...withMedia.slice(0, offset)];

    return rotated.slice(0, 5).map((a) => {
      const eyebrowMeta = AGENT_EYEBROW[a.agentKey ?? ''] ?? { label: '今日推荐', color: '#0A84FF' };
      const coverUrl = buildDefaultCoverUrl(cdnBase, a.agentKey);
      return {
        key: a.id,
        eyebrow: eyebrowMeta.label,
        eyebrowColor: eyebrowMeta.color,
        title: a.name,
        subtitle: undefined, // 刻意不放副标 —— 苹果 Today 大卡主标下一行极少，大多只有 1 句足够
        videoUrl: buildDefaultVideoUrl(cdnBase, a.agentKey),
        imageUrl: coverUrl,
        accent: accentFor(a.agentKey),
        footer: {
          Icon: iconFor(a.icon),
          iconImageUrl: coverUrl, // 底部小 icon 用同一张封面图，iOS app icon 质感
          name: a.name,
          tagline: a.description,
        },
        onClick: () => navigate(a.routePath ?? `/ai-toolbox?item=${a.id}`),
        pillLabel: '打开',
      };
    });
  }, [agents, cdnBase, navigate]);

  const handleItemClick = (item: ToolboxItem) => {
    navigate(item.routePath ?? `/ai-toolbox?item=${item.id}`);
  };

  const compatTagFor = (item: ToolboxItem) => {
    if (!item.routePath) return undefined;
    const c = resolveMobileCompat(item.routePath);
    if (c?.level === 'pc-only') {
      return { label: 'PC', color: '#FCA5A5', bg: 'rgba(255, 69, 58, 0.22)' };
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
        {/* ── Hero：一个词，和苹果 Today 对齐 ── */}
        <AppStoreHero title="今日" />

        {/* ── Featured 海报级轮播 ── */}
        {featuredItems.length > 0 && (
          <section style={{ marginTop: 20 }}>
            <AppStoreFeaturedCarousel items={featuredItems} />
          </section>
        )}

        {/* ── 智能体横滑（封面图作为 iOS app icon） ── */}
        {agents.length > 0 && (
          <AppStoreSection title="智能体" onShowAll={() => navigate('/ai-toolbox')}>
            <AppStoreShelf
              items={agents.map((a) => ({
                key: a.id,
                Icon: iconFor(a.icon),
                iconImageUrl: buildDefaultCoverUrl(cdnBase, a.agentKey),
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
          <AppStoreSection title="工具" onShowAll={() => navigate('/ai-toolbox')}>
            <AppStoreRankedList
              numbered
              items={tools.map((t) => ({
                key: t.id,
                Icon: iconFor(t.icon),
                accent: accentFor(t.agentKey),
                title: t.name,
                subtitle: t.description,
                pillLabel: '打开',
                onClick: () => handleItemClick(t),
              }))}
            />
          </AppStoreSection>
        )}

        {/* ── 近 7 日统计（极简 chip 排） ── */}
        {stats && <StatsRow stats={stats} />}

        {/* ── 通知（榜单风） ── */}
        {notifications.length > 0 && (
          <AppStoreSection title="通知" onShowAll={() => navigate('/notifications')}>
            <NotificationsList notifications={notifications.slice(0, 4)} />
          </AppStoreSection>
        )}

        {/* ── 最近活动 ── */}
        {feed.length > 0 && (
          <AppStoreSection title="最近活动">
            <FeedList feed={feed.slice(0, 6)} onNavigate={(to) => navigate(to)} />
          </AppStoreSection>
        )}
      </div>
    </div>
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
                className="truncate"
                style={{
                  ...AS_TYPE.itemSubtitle,
                  color: AS_COLOR.labelSecondary,
                  marginTop: 2,
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
