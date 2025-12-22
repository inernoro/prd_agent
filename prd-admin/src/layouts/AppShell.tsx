import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Cpu, LogOut, PanelLeftClose, PanelLeftOpen, Users2, ScrollText, FlaskConical } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/stores/authStore';
import RecursiveGridBackdrop from '@/components/background/RecursiveGridBackdrop';
import { BACKDROP_BUSY_END_EVENT, BACKDROP_BUSY_START_EVENT, emitBackdropBusyEnd, emitBackdropBusyStart, emitBackdropBusyStopped } from '@/lib/backdropBusy';

type NavItem = { key: string; label: string; icon: React.ReactNode };

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const [collapsed, setCollapsed] = useState(false);
  const [backdropBusyCount, setBackdropBusyCount] = useState(0);
  const [pendingStopId, setPendingStopId] = useState<string | null>(null);
  const postLoginTimerRef = useRef<number | null>(null);
  const backdropRunning = backdropBusyCount > 0;
  const backdropStopping = !backdropRunning && !!pendingStopId;

  useEffect(() => {
    // 登录后承接背景：动 2 秒，然后静止（像登录页与主页连起来）
    try {
      const flag = sessionStorage.getItem('prd-postlogin-fx');
      if (flag) {
        sessionStorage.removeItem('prd-postlogin-fx');
        emitBackdropBusyStart();
        if (postLoginTimerRef.current) window.clearTimeout(postLoginTimerRef.current);
        postLoginTimerRef.current = window.setTimeout(() => {
          emitBackdropBusyEnd();
          postLoginTimerRef.current = null;
        }, 2000);
      }
    } catch {
      // ignore
    }
    return () => {
      if (postLoginTimerRef.current) window.clearTimeout(postLoginTimerRef.current);
      postLoginTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onStart = () => {
      setPendingStopId(null);
      setBackdropBusyCount((c) => c + 1);
    };
    const onEnd = (e: Event) => {
      const ce = e as CustomEvent;
      const id = (ce.detail?.id as string | undefined) ?? '';
      setBackdropBusyCount((c) => {
        const next = Math.max(0, c - 1);
        if (c > 0 && next === 0 && id) setPendingStopId(id);
        return next;
      });
    };
    window.addEventListener(BACKDROP_BUSY_START_EVENT, onStart);
    window.addEventListener(BACKDROP_BUSY_END_EVENT, onEnd);
    return () => {
      window.removeEventListener(BACKDROP_BUSY_START_EVENT, onStart);
      window.removeEventListener(BACKDROP_BUSY_END_EVENT, onEnd);
    };
  }, []);

  const items: NavItem[] = useMemo(
    () => [
      { key: '/', label: '仪表盘', icon: <LayoutDashboard size={18} /> },
      { key: '/users', label: '用户管理', icon: <Users size={18} /> },
      { key: '/groups', label: '群组管理', icon: <Users2 size={18} /> },
      { key: '/model-manage', label: '模型管理', icon: <Cpu size={18} /> },
      { key: '/llm-logs', label: '请求日志', icon: <ScrollText size={18} /> },
      { key: '/lab', label: '实验室', icon: <FlaskConical size={18} /> },
    ],
    []
  );

  const activeKey = location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;
  const asideWidth = collapsed ? 72 : 220;
  const asideGap = 18;
  const mainPadLeft = asideWidth + asideGap * 2;

  return (
    <div className="h-full w-full relative overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      {/* 全局背景：覆盖侧边栏 + 主区（像背景色一样） */}
      <RecursiveGridBackdrop
        className="absolute inset-0"
        shouldRun={backdropRunning}
        stopRequestId={pendingStopId}
        stopBrakeMs={2000}
        onFullyStopped={(id) => {
          if (!id) return;
          // 仅处理“当前这一次 stop”对应的回调；若 stop 期间又 start，会清空 pendingStopId，从而忽略旧回调
          if (id !== pendingStopId) return;
          emitBackdropBusyStopped(id);
          setPendingStopId(null);
        }}
        persistKey="prd-recgrid-rot"
        persistMode="readwrite"
        // 刹车前更实，刹车瞬间变淡并缓慢“刹停”
        strokeRunning={backdropRunning || backdropStopping ? 'rgba(231, 206, 151, 1)' : 'rgba(231, 206, 151, 0.30)'}
        strokeBraking={'rgba(231, 206, 151, 0.30)'}
        // 刹车阶段按 2s 渐隐，更符合“缓慢结束”的体感
        brakeStrokeFadeMs={2000}
        brakeDecelerationRate={0.965}
        brakeMinSpeedDegPerSec={0.015}
      />
      {/* 运行态高亮：解析/任务运行时让背景整体更“亮”一点 */}
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: backdropRunning ? 1 : backdropStopping ? 0.35 : 0,
          background:
            'radial-gradient(900px 520px at 50% 18%, rgba(214, 178, 106, 0.18) 0%, transparent 60%), radial-gradient(820px 520px at 22% 55%, rgba(124, 252, 0, 0.055) 0%, transparent 65%), radial-gradient(1200px 700px at 60% 70%, rgba(255, 255, 255, 0.045) 0%, transparent 70%)',
        }}
      />

      <div className="relative z-10 h-full w-full">
        {/* 悬浮侧边栏：不贴左边，像“挂着” */}
        <aside
          className={cn('absolute flex flex-col p-2.5', collapsed ? 'gap-2' : 'gap-2.5')}
          style={{
            left: asideGap,
            top: asideGap,
            bottom: asideGap,
            width: asideWidth,
            zIndex: 20,
            borderRadius: 18,
            opacity: 0.8,
            // 让线条能透出来，但内容依旧清晰
            background:
              'linear-gradient(180deg, rgba(10,10,12,0.78) 0%, rgba(10,10,12,0.72) 100%)',
            border: '1px solid color-mix(in srgb, var(--border-subtle) 78%, rgba(255,255,255,0.10))',
            boxShadow: '0 26px 120px rgba(0,0,0,0.60)',
            backdropFilter: 'blur(12px)',
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
          className="relative h-full w-full overflow-auto flex flex-col"
          // 让递归线条背景可见；前景可读性由 Card 等“实底组件”承担
          style={{ background: 'transparent', paddingLeft: mainPadLeft, zIndex: 10 }}
        >
          {/* 主内容区背景：满屏暗角 + 轻微渐变（不随 max-width 截断） */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(900px 520px at 50% 18%, rgba(214, 178, 106, 0.08) 0%, transparent 60%), radial-gradient(820px 520px at 22% 55%, rgba(124, 252, 0, 0.035) 0%, transparent 65%), radial-gradient(1200px 700px at 60% 70%, rgba(255, 255, 255, 0.025) 0%, transparent 70%)',
            }}
          />
          <div className="relative mx-auto w-full max-w-[1440px] px-5 py-5 flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
