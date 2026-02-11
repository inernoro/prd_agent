import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  Image,
  PenLine,
  Bug,
  Bell,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useToolboxStore } from '@/stores/toolboxStore';
import { getAdminNotifications } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
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

/**
 * 移动端首页 — 最近使用 + 快捷入口 + 通知摘要。
 */
export default function MobileHomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { items: toolboxItems, loadItems } = useToolboxStore();
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);

  useEffect(() => { loadItems(); }, [loadItems]);

  useEffect(() => {
    (async () => {
      const res = await getAdminNotifications();
      if (res.success) setNotifications(res.data.items?.filter((n) => n.status === 'open') ?? []);
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
        <div className="mb-6">
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
                  className="flex flex-col items-center gap-2 py-3 rounded-2xl transition-all active:scale-95"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
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

        {/* ── 通知摘要 ── */}
        {notifications.length > 0 && (
          <div className="mb-6">
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
                  className="flex items-start gap-3 p-3 rounded-xl"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
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
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 最近工具 (从 toolbox 取) ── */}
        {toolboxItems.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                全部工具
              </div>
              <button
                onClick={() => navigate('/ai-toolbox')}
                className="flex items-center text-[11px] active:opacity-70"
                style={{ color: 'var(--text-muted)' }}
              >
                查看全部 <ChevronRight size={14} />
              </button>
            </div>
            <div className="space-y-2">
              {toolboxItems.slice(0, 5).map((item) => (
                <button
                  key={item.id}
                  onClick={() => navigate(item.routePath || '/ai-toolbox')}
                  className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all active:scale-[0.98]"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-sm"
                    style={{ background: 'rgba(255,255,255,0.06)' }}
                  >
                    {item.icon ? '🔧' : '🤖'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {item.name}
                    </div>
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                      {item.description}
                    </div>
                  </div>
                  <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
