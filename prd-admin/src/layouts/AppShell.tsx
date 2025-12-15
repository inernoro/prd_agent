import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Cpu, BarChart3, LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/stores/authStore';

type NavItem = { key: string; label: string; icon: React.ReactNode };

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const [collapsed, setCollapsed] = useState(false);

  const items: NavItem[] = useMemo(
    () => [
      { key: '/', label: '仪表盘', icon: <LayoutDashboard size={18} /> },
      { key: '/users', label: '用户管理', icon: <Users size={18} /> },
      { key: '/model-manage', label: '模型管理', icon: <Cpu size={18} /> },
      { key: '/stats', label: '统计', icon: <BarChart3 size={18} /> },
    ],
    []
  );

  const activeKey = location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;

  return (
    <div className="h-full w-full" style={{ background: 'var(--bg-base)' }}>
      <div className="h-full w-full grid" style={{ gridTemplateColumns: collapsed ? '72px 1fr' : '220px 1fr' }}>
        <aside
          className={cn('h-full flex flex-col p-2.5', collapsed ? 'gap-2' : 'gap-2.5')}
          style={{
            background: 'color-mix(in srgb, var(--bg-elevated) 85%, black)',
            borderRight: '1px solid var(--border-subtle)',
          }}
        >
          <div className={cn('flex items-center justify-between rounded-[14px] px-3 py-3', collapsed && 'justify-center')}
               style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            {!collapsed && (
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="h-9 w-9 rounded-[10px] flex items-center justify-center text-[11px] font-extrabold"
                  style={{ background: 'linear-gradient(135deg, var(--accent-gold) 0%, var(--accent-gold-2) 100%)', color: '#1a1206' }}
                >
                  PRD
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>PRD Admin</div>
                  <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>Web Console</div>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className={cn(
                'h-9 w-9 inline-flex items-center justify-center rounded-[12px] transition-colors',
                'hover:bg-white/5'
              )}
              style={{ color: 'var(--text-secondary)' }}
              aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
            >
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
          </div>

          <nav className={cn('flex-1 flex flex-col', collapsed ? 'gap-1' : 'gap-1')}
               style={{ paddingTop: 2 }}>
            {items.map((it) => {
              const active = it.key === activeKey;
              return (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => navigate(it.key)}
                  className={cn(
                    'relative flex items-center gap-3 rounded-[12px] px-3 py-2.5 transition-colors',
                    'hover:bg-white/4',
                    collapsed && 'justify-center px-0'
                  )}
                  style={{
                    background: active ? 'color-mix(in srgb, var(--accent-gold) 10%, transparent)' : 'transparent',
                    border: active ? '1px solid color-mix(in srgb, var(--accent-gold) 35%, var(--border-subtle))' : '1px solid transparent',
                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  <span className={cn('inline-flex items-center justify-center', active && 'drop-shadow')}>
                    {it.icon}
                  </span>
                  {!collapsed && <span className="text-sm font-medium">{it.label}</span>}
                  {active && (
                    <span
                      className="absolute left-0 top-1/2 -translate-y-1/2"
                      style={{ width: 3, height: 18, background: 'var(--accent-gold)', borderRadius: '0 999px 999px 0' }}
                    />
                  )}
                </button>
              );
            })}
          </nav>

          <div className={cn('rounded-[14px] p-3', collapsed && 'p-2')}
               style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{user?.displayName || 'Admin'}</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>系统管理员</div>
              </div>
            )}
            <button
              type="button"
              onClick={() => logout()}
              className={cn(
                'mt-3 w-full inline-flex items-center justify-center gap-2 rounded-[12px] px-3 py-2',
                'transition-colors hover:bg-white/5'
              )}
              style={{ color: 'var(--text-secondary)' }}
            >
              <LogOut size={16} />
              {!collapsed && <span className="text-sm">退出</span>}
            </button>
          </div>
        </aside>

        <main
          className="relative h-full w-full overflow-auto"
          style={{ background: 'var(--bg-base)' }}
        >
          {/* 主内容区背景：满屏暗角 + 轻微渐变（不随 max-width 截断） */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(900px 520px at 50% 18%, rgba(214, 178, 106, 0.08) 0%, transparent 60%), radial-gradient(820px 520px at 22% 55%, rgba(124, 252, 0, 0.035) 0%, transparent 65%), radial-gradient(1200px 700px at 60% 70%, rgba(255, 255, 255, 0.025) 0%, transparent 70%)',
            }}
          />
          <div className="relative mx-auto w-full max-w-[1440px] px-5 py-5">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
