import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Cpu, LogOut, PanelLeftClose, PanelLeftOpen, Users2, ScrollText, FlaskConical } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/stores/authStore';
import RecursiveGridBackdrop from '@/components/background/RecursiveGridBackdrop';
import { BACKDROP_BUSY_END_EVENT, BACKDROP_BUSY_START_EVENT, BACKDROP_POST_BUSY_HOLD_MS } from '@/lib/backdropBusy';

type NavItem = { key: string; label: string; icon: React.ReactNode };

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const [collapsed, setCollapsed] = useState(false);
  const [postLoginRunForMs, setPostLoginRunForMs] = useState(0);
  const postLoginFx = postLoginRunForMs > 0;
  const [backdropBusyCount, setBackdropBusyCount] = useState(0);
  const backdropBusy = backdropBusyCount > 0;
  const [postBusyHold, setPostBusyHold] = useState(false);
  const postBusyHoldTimerRef = useRef<number | null>(null);
  const prevBusyCountRef = useRef(backdropBusyCount);

  useEffect(() => {
    // 登录后承接背景：动 2 秒，然后静止（像登录页与主页连起来）
    try {
      const flag = sessionStorage.getItem('prd-postlogin-fx');
      if (flag) {
        sessionStorage.removeItem('prd-postlogin-fx');
        setPostLoginRunForMs(2000);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const onStart = () => setBackdropBusyCount((c) => c + 1);
    const onEnd = () => setBackdropBusyCount((c) => Math.max(0, c - 1));
    window.addEventListener(BACKDROP_BUSY_START_EVENT, onStart);
    window.addEventListener(BACKDROP_BUSY_END_EVENT, onEnd);
    return () => {
      window.removeEventListener(BACKDROP_BUSY_START_EVENT, onStart);
      window.removeEventListener(BACKDROP_BUSY_END_EVENT, onEnd);
    };
  }, []);

  useEffect(() => {
    // busy -> idle 的瞬间：先强制背景停住一小段时间（让弹窗/内容按顺序出场）
    const prev = prevBusyCountRef.current;
    prevBusyCountRef.current = backdropBusyCount;

    // busy 再次开始：立即取消 hold（避免“停顿覆盖运行态”）
    if (backdropBusyCount > 0) {
      setPostBusyHold(false);
      if (postBusyHoldTimerRef.current) {
        window.clearTimeout(postBusyHoldTimerRef.current);
        postBusyHoldTimerRef.current = null;
      }
      return;
    }

    // 只有从 >0 归零，才进入 hold；初始就是 0 时不触发
    if (prev <= 0 || backdropBusyCount !== 0) return;

    setPostBusyHold(true);
    if (postBusyHoldTimerRef.current) window.clearTimeout(postBusyHoldTimerRef.current);
    postBusyHoldTimerRef.current = window.setTimeout(() => {
      setPostBusyHold(false);
      postBusyHoldTimerRef.current = null;
    }, BACKDROP_POST_BUSY_HOLD_MS);
  }, [backdropBusyCount]);

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
  const effectiveRunForMs: number | undefined = backdropBusy ? undefined : postBusyHold ? 0 : postLoginRunForMs;

  return (
    <div className="h-full w-full relative overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      {/* 全局背景：覆盖侧边栏 + 主区（像背景色一样） */}
      <RecursiveGridBackdrop
        className="absolute inset-0"
        runForMs={effectiveRunForMs}
        persistKey="prd-recgrid-rot"
        persistMode="readwrite"
        // 刹车前更实，刹车瞬间变淡并缓慢“刹停”
        strokeRunning={backdropBusy ? 'rgba(231, 206, 151, 1)' : postLoginFx ? 'rgba(231, 206, 151, 1)' : 'rgba(231, 206, 151, 0.30)'}
        strokeBraking={backdropBusy ? 'rgba(231, 206, 151, 0.55)' : 'rgba(231, 206, 151, 0.30)'}
        brakeStrokeFadeMs={backdropBusy ? 260 : postLoginFx ? 260 : 0}
        brakeDecelerationRate={backdropBusy ? 0.97 : 0.965}
        brakeMinSpeedDegPerSec={backdropBusy ? 0.012 : 0.015}
      />
      {/* 运行态高亮：解析/任务运行时让背景整体更“亮”一点 */}
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: backdropBusy ? 1 : 0,
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
