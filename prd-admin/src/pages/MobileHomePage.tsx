import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  Image,
  PenLine,
  Bug,
  Bell,
  ChevronRight,
  Zap,
  MessagesSquare,
  Sparkles,
  Download,
  Paperclip,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { getAdminNotifications, getMobileFeed, getMobileStats } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';
import { resolveAvatarUrl } from '@/lib/avatar';

/* ── 快捷 Agent 入口 ── */
interface QuickAgent {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;
  color: string;
  bg: string;
}

const QUICK_AGENTS: QuickAgent[] = [
  { key: 'prd',      label: 'PRD',    icon: MessageSquare, path: '/prd-agent',      color: '#818CF8', bg: 'rgba(129,140,248,0.15)' },
  { key: 'visual',   label: '视觉',   icon: Image,         path: '/visual-agent',   color: '#FB923C', bg: 'rgba(251,146,60,0.15)' },
  { key: 'literary', label: '文学',   icon: PenLine,       path: '/literary-agent', color: '#34D399', bg: 'rgba(52,211,153,0.15)' },
  { key: 'defect',   label: '缺陷',   icon: Bug,           path: '/defect-agent',   color: '#F87171', bg: 'rgba(248,113,113,0.15)' },
];

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

/**
 * 移动端首页 — 快捷入口 + 统计 + Feed + 通知。
 */
export default function MobileHomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [stats, setStats] = useState<MobileStats | null>(null);

  useEffect(() => {
    // 并行拉取 feed + stats + notifications
    (async () => {
      const [feedRes, statsRes, notifRes] = await Promise.all([
        getMobileFeed({ limit: 10 }),
        getMobileStats({ days: 7 }),
        getAdminNotifications(),
      ]);
      if (feedRes.success) setFeed(feedRes.data.items ?? []);
      if (statsRes.success) setStats(statsRes.data);
      if (notifRes.success) setNotifications(notifRes.data.items?.filter((n) => n.status === 'open') ?? []);
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

  return (
    <div className="h-full min-h-0 overflow-auto" style={{ background: 'var(--bg-base)' }}>
      <div className="px-5 pt-6 pb-28">

        {/* ── 问候区 ── */}
        <div className="flex items-center gap-3 mb-6">
          {avatarUrl ? (
            <img src={avatarUrl} className="w-11 h-11 rounded-full object-cover" alt="" />
          ) : (
            <div
              className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
            >
              {(user?.displayName || user?.username || '?')[0]}
            </div>
          )}
          <div>
            <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {greeting}，{user?.displayName || user?.username}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              看看今天能帮你做什么
            </div>
          </div>
        </div>

        {/* ── 快捷 Agent 入口 ── */}
        <div className="mb-5">
          <div className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>
            快捷入口
          </div>
          <div className="grid grid-cols-4 gap-3">
            {QUICK_AGENTS.map((agent) => {
              const AgentIcon = agent.icon;
              return (
                <button
                  key={agent.key}
                  onClick={() => navigate(agent.path)}
                  className="surface-inset flex flex-col items-center gap-2 py-3 rounded-2xl transition-all active:scale-95"
                >
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ background: agent.bg }}
                  >
                    <AgentIcon size={20} style={{ color: agent.color }} />
                  </div>
                  <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {agent.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── 统计卡片 (近 7 日) ── */}
        {stats && (
          <div className="mb-5">
            <div className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>
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
                    <CardIcon size={16} style={{ color: card.color }} />
                    <div className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                      {display}
                    </div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
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
              <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                通知
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
                    <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {n.title}
                    </div>
                    {n.message && (
                      <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
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
            <div className="text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>
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
                      <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {item.title}
                      </div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
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
