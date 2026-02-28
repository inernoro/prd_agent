import { useNavigate } from 'react-router-dom';
import {
  Palette,
  Bell,
  ScrollText,
  Settings,
  LogOut,
  ChevronRight,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { resolveAvatarUrl } from '@/lib/avatar';

/* ── 菜单项 ── */
interface MenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  color: string;
  path?: string;
  action?: () => void;
}

/**
 * 移动端「我的」个人中心页。
 */
export default function MobileProfilePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const isRoot = useAuthStore((s) => s.isRoot);

  const avatarUrl = user ? resolveAvatarUrl(user) : null;

  const roleLabel = (() => {
    if (isRoot) return '超级管理员';
    switch (user?.role) {
      case 'ADMIN': return '管理员';
      case 'PM': return '产品经理';
      case 'DEV': return '开发者';
      case 'QA': return '测试';
      default: return user?.role ?? '用户';
    }
  })();

  const menuItems: MenuItem[] = [
    { key: 'theme',    label: '主题设置',   icon: Palette,    color: '#818CF8', path: '/settings' },
    { key: 'notify',   label: '系统通知',   icon: Bell,       color: '#FB923C', path: '/settings' },
    { key: 'logs',     label: '请求日志',   icon: ScrollText, color: '#34D399', path: '/logs' },
    { key: 'settings', label: '通用设置',   icon: Settings,   color: '#60A5FA', path: '/settings' },
  ];

  if (isRoot) {
    menuItems.push({ key: 'authz', label: '权限管理', icon: Shield, color: '#F472B6', path: '/settings' });
  }

  const handleLogout = () => {
    logout();
    navigate('/home', { replace: true });
  };

  return (
    <div className="h-full min-h-0 overflow-auto" style={{ background: 'var(--bg-base)' }}>
      <div className="px-5 pt-8 pb-28">

        {/* ── 用户卡片 ── */}
        <div
          className="surface-inset flex items-center gap-4 p-5 rounded-2xl mb-6"
        >
          {avatarUrl ? (
            <img src={avatarUrl} className="w-14 h-14 rounded-full object-cover" alt="" />
          ) : (
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-semibold"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
            >
              {(user?.displayName || user?.username || '?')[0]}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-lg font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {user?.displayName || user?.username}
            </div>
            <div
              className="inline-block mt-1 px-2 py-0.5 rounded-md text-[11px] font-medium"
              style={{ background: 'rgba(129,140,248,0.15)', color: '#818CF8' }}
            >
              {roleLabel}
            </div>
          </div>
        </div>

        {/* ── 菜单列表 ── */}
        <div
          className="surface-inset rounded-2xl overflow-hidden mb-6"
        >
          {menuItems.map((item, i) => {
            const MenuIcon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => item.path ? navigate(item.path) : item.action?.()}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-all active:bg-white/[0.03]"
                style={{
                  borderBottom: i < menuItems.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                }}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `${item.color}20` }}
                >
                  <MenuIcon size={16} style={{ color: item.color }} />
                </div>
                <span className="flex-1 text-sm" style={{ color: 'var(--text-primary)' }}>
                  {item.label}
                </span>
                <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
              </button>
            );
          })}
        </div>

        {/* ── 退出登录 ── */}
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl transition-all active:scale-[0.98]"
          style={{
            background: 'rgba(248,113,113,0.08)',
            border: '1px solid rgba(248,113,113,0.15)',
            color: '#F87171',
          }}
        >
          <LogOut size={16} />
          <span className="text-sm font-medium">退出登录</span>
        </button>
      </div>
    </div>
  );
}
