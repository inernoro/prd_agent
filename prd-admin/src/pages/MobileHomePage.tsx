import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as LucideIcons from 'lucide-react';
import {
  MessageSquare,
  Image,
  Bug,
  Bell,
  ChevronRight,
  Zap,
  MessagesSquare,
  Sparkles,
  Download,
  Paperclip,
  Bot,
  Monitor,
  Dot,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import type { ToolboxItem } from '@/services/real/aiToolbox';
import { getAdminNotifications, getMobileFeed, getMobileStats } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';
import { resolveAvatarUrl } from '@/lib/avatar';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveMobileCompat, type MobileCompatLevel } from '@/lib/mobileCompatibility';

/* ── Feed 项类型图标 ── */
const FEED_ICON: Record<string, { icon: LucideIcon; color: string }> = {
  'prd-session':       { icon: MessageSquare, color: '#818CF8' },
  'visual-workspace':  { icon: Image,         color: '#FB923C' },
  'defect':            { icon: Bug,           color: '#F87171' },
};

/* ── 统计卡片 ── */
interface StatCard {
  key: string;
  label: string;
  icon: LucideIcon;
  color: string;
  getValue: (s: MobileStats) => number;
  format?: (v: number) => string;
}

const STAT_CARDS: StatCard[] = [
  { key: 'sessions', label: '会话', icon: MessagesSquare, color: '#818CF8', getValue: (s) => s.sessions },
  { key: 'messages', label: '消息', icon: MessageSquare,  color: '#34D399', getValue: (s) => s.messages },
  { key: 'images',   label: '生图', icon: Sparkles,       color: '#FB923C', getValue: (s) => s.imageGenerations },
  { key: 'tokens',   label: 'Token', icon: Zap,            color: '#60A5FA', getValue: (s) => s.totalTokens, format: (v) => v >= 10000 ? `${(v / 1000).toFixed(1)}k` : String(v) },
];

/* ── 卡片主题色（按图标名）—— 与桌面 AgentLauncher 对齐 ── */
const ACCENT: Record<string, { from: string; to: string }> = {
  FileText:  { from: '#3B82F6', to: '#60A5FA' },
  Palette:   { from: '#A855F7', to: '#C084FC' },
  PenTool:   { from: '#10B981', to: '#34D399' },
  Bug:       { from: '#F97316', to: '#FB923C' },
  Video:     { from: '#F43F5E', to: '#FB7185' },
  Swords:    { from: '#F59E0B', to: '#FBBF24' },
  Code2:     { from: '#10B981', to: '#6EE7B7' },
  Languages: { from: '#06B6D4', to: '#67E8F9' },
  FileSearch:{ from: '#EAB308', to: '#FDE68A' },
  BarChart3: { from: '#8B5CF6', to: '#C4B5FD' },
  Bot:       { from: '#6366F1', to: '#A5B4FC' },
  FileBarChart: { from: '#6366F1', to: '#818CF8' },
  Workflow:  { from: '#14B8A6', to: '#5EEAD4' },
  Zap:       { from: '#F59E0B', to: '#FCD34D' },
  Globe:     { from: '#0EA5E9', to: '#38BDF8' },
  ClipboardCheck: { from: '#6366F1', to: '#A5B4FC' },
  ScanSearch: { from: '#8B5CF6', to: '#C4B5FD' },
  Wand2:     { from: '#8B5CF6', to: '#C4B5FD' },
  AudioLines: { from: '#EC4899', to: '#F9A8D4' },
};

function getAccent(iconName: string) {
  return ACCENT[iconName] ?? { from: '#6366F1', to: '#A5B4FC' };
}

function getIcon(iconName: string): LucideIcon {
  const icons = LucideIcons as unknown as Record<string, LucideIcon>;
  return icons[iconName] ?? Bot;
}

/**
 * 移动端首页 — 问候 + 苹果 App Store 风智能体/工具横滑区 + 统计 + Feed + 通知。
 *
 * 横滑区块布局：
 *  - 每张卡片 132×140，overflow-x-auto + snap-x + snap-mandatory
 *  - 超出当前视口左右滑动查看更多（参考 iOS App Store "今日" tab）
 *  - 右上角兼容性徽章：pc-only 显示灰色"PC"、limited 显示黄色圆点
 */
export default function MobileHomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
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

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 12) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }, []);

  const avatarUrl = user ? resolveAvatarUrl(user) : null;

  const agents = useMemo(
    () => BUILTIN_TOOLS.filter((t) => t.kind === 'agent'),
    [],
  );
  const tools = useMemo(
    () => BUILTIN_TOOLS.filter((t) => t.kind === 'tool'),
    [],
  );

  return (
    <div className="h-full min-h-0 overflow-auto" style={{ background: 'var(--bg-base)' }}>
      <div className="px-5 pt-6 pb-28">

        {/* ── 问候区 ── */}
        <div className="flex items-center gap-3 mb-6">
          {avatarUrl ? (
            <UserAvatar src={avatarUrl} className="w-11 h-11 rounded-full object-cover" />
          ) : (
            <div
              className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
            >
              {(user?.displayName || user?.username || '?')[0]}
            </div>
          )}
          <div className="flex flex-col items-start">
            <div
              className="text-lg font-semibold px-2.5 py-0.5 rounded-lg bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
              style={{ color: 'var(--text-primary)', textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}
            >
              {greeting}，{user?.displayName || user?.username}
            </div>
            <div
              className="text-xs mt-1.5 px-2 py-0.5 rounded-md bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
              style={{ color: 'var(--text-muted)' }}
            >
              看看今天能帮你做什么
            </div>
          </div>
        </div>

        {/* ── 智能体横滑 ── */}
        <Shelf
          title="智能体"
          subtitle={`${agents.length} 个`}
          items={agents}
          onItemClick={(item) => navigate(item.routePath ?? `/ai-toolbox?item=${item.id}`)}
          onMoreClick={() => navigate('/ai-toolbox')}
        />

        {/* ── 工具横滑 ── */}
        <Shelf
          title="工具"
          subtitle={`${tools.length} 个`}
          items={tools}
          onItemClick={(item) => navigate(item.routePath ?? `/ai-toolbox?item=${item.id}`)}
          onMoreClick={() => navigate('/ai-toolbox')}
        />

        {/* ── 统计卡片 (近 7 日) ── */}
        {stats && (
          <div className="mb-5">
            <div
              className="text-xs font-medium mb-3 px-2.5 py-1 rounded-md inline-block bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
              style={{ color: 'var(--text-primary)' }}
            >
              近 7 日统计
            </div>
            <div className="grid grid-cols-4 gap-2">
              {STAT_CARDS.map((card) => {
                const CardIcon = card.icon;
                const val = card.getValue(stats);
                const display = card.format ? card.format(val) : String(val);
                return (
                  <div
                    key={card.key}
                    className="surface-inset flex flex-col items-center gap-1.5 py-3 rounded-xl"
                  >
                    <CardIcon size={16} className="mb-0.5" style={{ color: card.color }} />
                    <div
                      className="text-base font-bold px-2 py-0.5 rounded-md bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
                      style={{ color: 'var(--text-primary)', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}
                    >
                      {display}
                    </div>
                    <div
                      className="text-[10px] px-1.5 py-0.5 rounded bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {card.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 通知摘要 ── */}
        {notifications.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-3">
              <div
                className="text-xs font-medium px-2.5 py-1 rounded-md inline-block bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
                style={{ color: 'var(--text-primary)' }}
              >
                通知
              </div>
              <div
                className="text-[11px] px-2 py-0.5 rounded-md bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
                style={{ color: 'var(--text-muted)' }}
              >
                {notifications.length} 条未读
              </div>
            </div>
            <div className="space-y-2">
              {notifications.slice(0, 3).map((n) => (
                <div
                  key={n.id}
                  className="surface-inset flex items-start gap-3 p-3 rounded-xl"
                >
                  <Bell size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-sm font-medium truncate px-1.5 py-0.5 rounded bg-black/20 w-fit max-w-full backdrop-blur-md shadow-sm border border-white/5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {n.title}
                    </div>
                    {n.message && (
                      <div
                        className="text-xs mt-1 line-clamp-2 px-1.5 py-0.5 rounded bg-black/20 w-fit backdrop-blur-md shadow-sm border border-white/5"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {n.message}
                      </div>
                    )}
                    {n.attachments && n.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {n.attachments.map((att, idx) => (
                          <a
                            key={idx}
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] transition-colors"
                            style={{
                              background: 'var(--surface-elevated)',
                              color: 'var(--text-secondary)',
                              border: '1px solid var(--border-default)',
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Paperclip size={10} />
                            <span className="truncate max-w-[120px]">{att.name}</span>
                            <Download size={10} className="shrink-0 opacity-60" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Feed 流 (最近活动) ── */}
        {feed.length > 0 && (
          <div>
            <div
              className="text-xs font-medium mb-3 px-2.5 py-1 rounded-md inline-block bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
              style={{ color: 'var(--text-primary)' }}
            >
              最近活动
            </div>
            <div className="space-y-2">
              {feed.map((item) => {
                const meta = FEED_ICON[item.type] ?? { icon: MessageSquare, color: '#818CF8' };
                const FeedIcon = meta.icon;
                return (
                  <button
                    key={item.id}
                    onClick={() => navigate(item.navigateTo)}
                    className="surface-inset w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all active:scale-[0.98]"
                  >
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: `${meta.color}20` }}
                    >
                      <FeedIcon size={18} style={{ color: meta.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-sm font-medium truncate px-1.5 py-0.5 rounded bg-black/20 w-fit max-w-full backdrop-blur-md shadow-sm border border-white/5"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {item.title}
                      </div>
                      <div
                        className="text-[11px] truncate mt-1 px-1.5 py-0.5 rounded bg-black/20 w-fit max-w-full backdrop-blur-md shadow-sm border border-white/5"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {item.subtitle}
                      </div>
                    </div>
                    <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============ 横滑卡片区块（App Store 风）============ */

interface ShelfProps {
  title: string;
  subtitle?: string;
  items: ToolboxItem[];
  onItemClick: (item: ToolboxItem) => void;
  onMoreClick?: () => void;
}

function Shelf({ title, subtitle, items, onItemClick, onMoreClick }: ShelfProps) {
  if (items.length === 0) return null;
  return (
    <div className="mb-5 -mx-5">
      {/* 标题行 —— 不滑动，保留左右内边距 */}
      <div className="px-5 mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="text-xs font-semibold px-2.5 py-1 rounded-md bg-black/20 backdrop-blur-md shadow-sm border border-white/5"
            style={{ color: 'var(--text-primary)' }}
          >
            {title}
          </div>
          {subtitle && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {subtitle}
            </span>
          )}
        </div>
        {onMoreClick && (
          <button
            type="button"
            onClick={onMoreClick}
            className="inline-flex items-center gap-0.5 text-[11px] px-2 py-0.5 rounded transition-colors active:scale-95"
            style={{ color: 'var(--text-muted)' }}
          >
            全部
            <ChevronRight size={12} />
          </button>
        )}
      </div>

      {/* 横滑容器 */}
      <div
        className="flex gap-3 overflow-x-auto snap-x snap-mandatory px-5 pb-1"
        style={{
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
          overscrollBehaviorX: 'contain',
        }}
      >
        {items.map((item) => (
          <ShelfCard key={item.id} item={item} onClick={() => onItemClick(item)} />
        ))}
      </div>
    </div>
  );
}

function ShelfCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const Icon = getIcon(item.icon);
  const accent = getAccent(item.icon);
  // 兼容性徽章：根据 routePath 查注册表
  const compat = item.routePath ? resolveMobileCompat(item.routePath) : null;
  const level: MobileCompatLevel | null = compat?.level ?? null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="relative shrink-0 snap-start rounded-2xl p-3 flex flex-col items-start text-left transition-all active:scale-95"
      style={{
        width: 140,
        minHeight: 148,
        background: 'rgba(255, 255, 255, 0.04)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
      }}
    >
      {/* 右上角兼容性徽章 */}
      {level === 'pc-only' && (
        <span
          className="absolute top-2 right-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold"
          style={{
            background: 'rgba(248, 113, 113, 0.18)',
            color: '#fca5a5',
          }}
          aria-label="建议在 PC 上使用"
        >
          <Monitor size={9} /> PC
        </span>
      )}
      {level === 'limited' && (
        <span
          className="absolute top-2 right-2 inline-flex items-center justify-center"
          style={{ color: '#fbbf24' }}
          aria-label="移动端体验受限"
        >
          <Dot size={18} />
        </span>
      )}

      {/* WIP 施工中角标 */}
      {item.wip && (
        <span
          className="absolute top-2 left-2 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold"
          style={{ background: 'rgba(251, 146, 60, 0.18)', color: '#fdba74' }}
        >
          施工中
        </span>
      )}

      {/* 图标 */}
      <div
        className="w-11 h-11 rounded-2xl flex items-center justify-center mb-2 mt-1"
        style={{
          background: `linear-gradient(135deg, ${accent.from}33, ${accent.to}22)`,
          border: `1px solid ${accent.from}44`,
        }}
      >
        <Icon size={22} style={{ color: accent.from }} />
      </div>

      {/* 名称 + 描述 */}
      <div
        className="text-[13px] font-semibold leading-tight line-clamp-1 w-full"
        style={{ color: 'var(--text-primary)' }}
      >
        {item.name}
      </div>
      <div
        className="text-[11px] leading-snug mt-1 line-clamp-2 w-full"
        style={{ color: 'var(--text-muted)' }}
      >
        {item.description}
      </div>
    </button>
  );
}
