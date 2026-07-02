// 网关控制台共享外壳：顶部 header（标题 + 导航「日志/模型池/平台/影子」+ 当前用户 + 登出）+ Outlet。
// SSOT 头部只此一处，4 个子页复用。
import { Activity, LogOut, Boxes, Server, GitCompare, ScrollText, LayoutDashboard } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui';

const NAV: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/', label: '概览', icon: <LayoutDashboard size={14} /> },
  { to: '/logs', label: '日志', icon: <ScrollText size={14} /> },
  { to: '/pools', label: '模型池', icon: <Boxes size={14} /> },
  { to: '/platforms', label: '平台', icon: <Server size={14} /> },
  { to: '/shadow', label: '影子比对', icon: <GitCompare size={14} /> },
];

export function ConsoleLayout() {
  const { user, logout } = useAuth();
  const who = user?.displayName || user?.username || '已登录';

  return (
    <div style={{ height: '100vh', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-page)' }}>
      <header
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '0 20px',
          height: 56,
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 30,
                height: 30,
                borderRadius: 8,
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
              }}
            >
              <Activity size={18} />
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>LLM 网关控制台</span>
          </div>
          <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                style={({ isActive }) => ({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 500,
                  textDecoration: 'none',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                })}
              >
                {n.icon}
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{who}</span>
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut size={14} />
            登出
          </Button>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 20 }}>
        <Outlet />
      </main>
    </div>
  );
}
