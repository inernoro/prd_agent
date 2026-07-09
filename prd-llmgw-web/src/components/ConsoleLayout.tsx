// 网关控制台共享外壳：顶部 header（标题 + 导航「日志/模型池/平台/影子」+ 当前用户 + 登出）+ Outlet。
// SSOT 头部只此一处，4 个子页复用。
import { Activity, LogOut, Boxes, Server, GitCompare, ScrollText, LayoutDashboard, Search } from 'lucide-react';
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
    <div className="lg-console-shell" style={{ height: '100vh', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 18,
          padding: '0 18px',
          height: 54,
          borderBottom: '1px solid var(--border-subtle)',
          background: 'rgba(8, 9, 11, 0.86)',
          backdropFilter: 'blur(18px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 7,
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <Activity size={17} />
            </span>
            <span style={{ fontSize: 14, fontWeight: 650, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>LLM Gateway</span>
          </div>
          <div
            className="lg-global-search"
            style={{
              flex: '0 1 360px',
              height: 32,
              minWidth: 180,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 10px',
              color: 'var(--text-muted)',
              background: 'var(--bg-input)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <Search size={14} />
            <span style={{ fontSize: 12, flex: 1 }}>Search requests, models, providers</span>
            <span
              style={{
                flexShrink: 0,
                padding: '1px 5px',
                fontSize: 10,
                lineHeight: '16px',
                borderRadius: 4,
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)',
              }}
            >
              Ctrl K
            </span>
          </div>
          <nav className="lg-console-nav" style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                style={({ isActive }) => ({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 9px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 500,
                  textDecoration: 'none',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
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

      <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '16px 18px' }}>
        <Outlet />
      </main>
    </div>
  );
}
