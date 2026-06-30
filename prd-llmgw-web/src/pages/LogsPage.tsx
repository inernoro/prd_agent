// 观测主页：顶部独立 app 头部（标题 + 当前用户 + 登出）+ LogsView 主体。
import { Activity, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { LogsView } from '@/components/LogsView';
import { Button } from '@/components/ui';

export function LogsPage() {
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
          padding: '0 20px',
          height: 56,
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>LLM 网关观测台</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{who}</span>
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut size={14} />
            登出
          </Button>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, padding: 20 }}>
        <LogsView />
      </main>
    </div>
  );
}
