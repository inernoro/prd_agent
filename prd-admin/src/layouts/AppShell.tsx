import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Cpu, LogOut, PanelLeftClose, PanelLeftOpen, Users2, ScrollText, FlaskConical, MessagesSquare, Database, FileText, Wand2, Image, PenLine } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/stores/authStore';
import { useLayoutStore } from '@/stores/layoutStore';
import RecursiveGridBackdrop from '@/components/background/RecursiveGridBackdrop';
import { backdropMotionController, useBackdropMotionSnapshot } from '@/lib/backdropMotionController';
import { SystemDialogHost } from '@/components/ui/SystemDialogHost';
import { AvatarEditDialog } from '@/components/ui/AvatarEditDialog';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import { updateUserAvatar } from '@/services';

type NavItem = { key: string; label: string; icon: React.ReactNode };

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);
  const collapsed = useLayoutStore((s) => s.navCollapsed);
  const toggleNavCollapsed = useLayoutStore((s) => s.toggleNavCollapsed);
  const fullBleedMain = useLayoutStore((s) => s.fullBleedMain);
  const { count: backdropCount, pendingStopId } = useBackdropMotionSnapshot();
  const backdropRunning = backdropCount > 0;
  const backdropStopping = !backdropRunning && !!pendingStopId;
  const [avatarOpen, setAvatarOpen] = useState(false);

  // 兜底：部分 WebView/快捷键拦截环境下 Cmd/Ctrl+A 在输入控件中可能无法触发默认“全选”
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!(e.key === 'a' || e.key === 'A')) return;

      const active = document.activeElement;
      if (!active) return;

      // 仅在“可编辑内容”范围内兜底，避免影响页面级“全选”
      if (active instanceof HTMLTextAreaElement) {
        if (active.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        active.select();
        return;
      }

      if (active instanceof HTMLInputElement) {
        if (active.disabled) return;
        const type = String(active.getAttribute('type') ?? 'text').toLowerCase();
        // 这些类型不具备文本选择语义
        if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color'].includes(type)) return;
        e.preventDefault();
        e.stopPropagation();
        active.select();
        return;
      }

      if (active instanceof HTMLElement && active.isContentEditable) {
        e.preventDefault();
        e.stopPropagation();
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(active);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    };

    // capture：优先于页面/画布层快捷键，避免误伤输入区
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const items: NavItem[] = useMemo(
    () => [
      { key: '/', label: '仪表盘', icon: <LayoutDashboard size={18} /> },
      { key: '/users', label: '用户管理', icon: <Users size={18} /> },
      { key: '/groups', label: '群组管理', icon: <Users2 size={18} /> },
      { key: '/model-manage', label: '模型管理', icon: <Cpu size={18} /> },
      { key: '/prompts', label: '提示词管理', icon: <FileText size={18} /> },
      { key: '/ai-chat', label: 'AI 对话', icon: <MessagesSquare size={18} /> },
      { key: '/visual-agent', label: '视觉创作 Agent', icon: <Wand2 size={18} /> },
      { key: '/literary-agent', label: '文学创作 Agent', icon: <PenLine size={18} /> },
      { key: '/assets', label: '资源管理', icon: <Image size={18} /> },
      { key: '/llm-logs', label: '请求日志', icon: <ScrollText size={18} /> },
      { key: '/data', label: '数据管理', icon: <Database size={18} /> },
      { key: '/lab', label: '实验室', icon: <FlaskConical size={18} /> },
    ],
    []
  );

  const activeKey = location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;
  const asideWidth = collapsed ? 72 : 220;
  const asideGap = 18;
  // 专注模式（fullBleedMain）下隐藏侧栏，主区最大化
  const focusHideAside = fullBleedMain;
  const mainPadLeft = focusHideAside ? asideGap : asideWidth + asideGap * 2;

  return (
    <div className="h-full w-full relative overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      <SystemDialogHost />
      {/* 全局背景：覆盖侧边栏 + 主区（像背景色一样） */}
      <RecursiveGridBackdrop
        className="absolute inset-0"
        // 与 thirdparty/ref/递归网络.html 一致：rot += 0.02deg @60fps => 1.2deg/s
        speedDegPerSec={1.2}
        shouldRun={backdropRunning}
        stopRequestId={pendingStopId}
        stopBrakeMs={2000}
        onFullyStopped={(id) => {
          if (!id) return;
          backdropMotionController.markStopped(id);
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
          className={cn(
            'absolute flex flex-col p-2.5 transition-[width] duration-220 ease-out',
            collapsed ? 'gap-2' : 'gap-2.5'
          )}
          style={{
            left: asideGap,
            top: asideGap,
            bottom: asideGap,
            width: focusHideAside ? 0 : asideWidth,
            zIndex: 20,
            borderRadius: 18,
            opacity: focusHideAside ? 0 : 0.8,
            // 让线条能透出来，但内容依旧清晰
            background:
              'linear-gradient(180deg, rgba(10,10,12,0.78) 0%, rgba(10,10,12,0.72) 100%)',
            border: '1px solid color-mix(in srgb, var(--border-subtle) 78%, rgba(255,255,255,0.10))',
            boxShadow: '0 26px 120px rgba(0,0,0,0.60)',
            backdropFilter: 'blur(12px)',
            pointerEvents: focusHideAside ? 'none' : 'auto',
          }}
        >
          <div
            className={cn(
              'flex items-center transition-[padding,border-radius,width,height] duration-220 ease-out',
              // 收拢态：强制正圆（避免 flex stretch 导致椭圆）
              collapsed
                ? 'justify-center rounded-full w-[50px] h-[50px] p-1.5 self-center shrink-0'
                : 'justify-between rounded-[14px] px-3 py-3'
            )}
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
              onClick={() => toggleNavCollapsed()}
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
                    // 收拢态：按钮点击区为正方形圆角矩形（避免扁长）
                    collapsed && 'justify-center px-0 py-0 w-[50px] h-[50px] self-center shrink-0'
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

          <div
            className={cn(
              'transition-[padding,border-radius,width,height] duration-220 ease-out',
              // 收拢态：强制正圆（避免 flex stretch 导致椭圆）
              collapsed
                ? 'rounded-full w-[50px] h-[50px] p-1.5 self-center shrink-0 flex items-center justify-center'
                : 'rounded-[14px] p-3'
            )}
               style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            {!collapsed && (
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => setAvatarOpen(true)}
                  className="h-10 w-10 rounded-[12px] overflow-hidden shrink-0"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-subtle)' }}
                  title="修改头像"
                >
                  {(() => {
                    const url = resolveAvatarUrl({
                      username: user?.username,
                      userType: user?.userType,
                      botKind: user?.botKind,
                      avatarFileName: user?.avatarFileName ?? null,
                      avatarUrl: user?.avatarUrl,
                    });
                    const fallback = resolveNoHeadAvatarUrl();
                    return (
                      <img
                        src={url}
                        alt="avatar"
                        className="h-full w-full object-cover"
                        onError={(e) => {
                          const el = e.currentTarget;
                          if (el.getAttribute('data-fallback-applied') === '1') return;
                          if (!fallback) return;
                          el.setAttribute('data-fallback-applied', '1');
                          el.src = fallback;
                        }}
                      />
                    );
                  })()}
                </button>
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{user?.displayName || 'Admin'}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{user?.role === 'ADMIN' ? '系统管理员' : user?.role || ''}</div>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => logout()}
              className={cn(
                'inline-flex items-center justify-center rounded-[12px] transition-colors hover:bg-white/5',
                collapsed ? 'w-9 h-9 p-0' : 'mt-3 w-full gap-2 px-3 py-2'
              )}
              style={{ color: 'var(--text-secondary)' }}
            >
              <LogOut size={18} className="shrink-0" />
              {!collapsed && <span className="text-sm">退出</span>}
            </button>
          </div>

          <AvatarEditDialog
            open={avatarOpen}
            onOpenChange={setAvatarOpen}
            title="修改我的头像"
            description={user ? `${user.displayName} · ${user.userId}` : undefined}
            userId={user?.userId ?? null}
            username={user?.username}
            userType={user?.userType ?? null}
            avatarFileName={user?.avatarFileName ?? null}
            onSave={async (avatarFileName) => {
              if (!user?.userId) return;
              const res = await updateUserAvatar(user.userId, avatarFileName);
              if (!res.success) throw new Error(res.error?.message || '保存失败');
              patchUser({ avatarFileName: avatarFileName ?? null });
            }}
          />
        </aside>

        <main
          className="relative h-full w-full overflow-auto flex flex-col transition-[padding-left] duration-220 ease-out"
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
          <div
            className={cn(
              'relative w-full flex-1 min-h-0 flex flex-col',
              fullBleedMain ? 'px-3 py-3' : 'mx-auto max-w-[1440px] px-5 py-5'
            )}
          >
            <div className="flex-1 min-h-0">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
