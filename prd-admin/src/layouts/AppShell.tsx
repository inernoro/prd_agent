import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Cpu, LogOut, PanelLeftClose, PanelLeftOpen, Users2, ScrollText, FlaskConical, MessagesSquare, Database, FileText, Wand2, Image, PenLine, Plug, UserCog } from 'lucide-react';
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

type NavItem = { key: string; label: string; icon: React.ReactNode; description?: string; perm?: string };

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
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
      { key: '/', label: '仪表盘', icon: <LayoutDashboard size={18} />, description: 'LLM 可观测性与数据概览' },
      { key: '/users', label: '用户管理', icon: <Users size={18} />, description: '账号、角色与权限管理', perm: 'admin.users.read' },
      { key: '/groups', label: '群组管理', icon: <Users2 size={18} />, description: '协作群组与成员管理', perm: 'admin.groups.read' },
      { key: '/model-manage', label: '模型管理', icon: <Cpu size={18} />, description: '平台、模型与配置管理', perm: 'admin.models.read' },
      { key: '/prompts', label: '提示词管理', icon: <FileText size={18} />, description: 'PRD 问答提示词配置', perm: 'admin.settings.write' },
      { key: '/ai-chat', label: 'PRD Agent', icon: <MessagesSquare size={18} />, description: 'PRD 智能解读与问答', perm: 'admin.agent.use' },
      { key: '/visual-agent', label: '视觉创作 Agent', icon: <Wand2 size={18} />, description: '高级视觉创作工作区', perm: 'admin.agent.use' },
      { key: '/literary-agent', label: '文学创作 Agent', icon: <PenLine size={18} />, description: '文章配图智能生成', perm: 'admin.agent.use' },
      { key: '/assets', label: '资源管理', icon: <Image size={18} />, description: 'Desktop 资源与品牌配置', perm: 'admin.assets.read' },
      { key: '/llm-logs', label: '请求日志', icon: <ScrollText size={18} />, description: 'LLM 请求与系统日志', perm: 'admin.logs.read' },
      { key: '/data', label: '数据管理', icon: <Database size={18} />, description: '数据概览、清理与迁移', perm: 'admin.data.read' },
      { key: '/open-platform', label: '开放平台', icon: <Plug size={18} />, description: 'API 应用与调用日志', perm: 'admin.openPlatform.manage' },
      { key: '/authz', label: '权限管理', icon: <UserCog size={18} />, description: '系统角色与用户权限', perm: 'admin.authz.manage' },
      { key: '/lab', label: '实验室', icon: <FlaskConical size={18} />, description: '模型测试与实验功能', perm: 'admin.models.read' },
    ],
    []
  );

  const visibleItems = useMemo(() => {
    const perms = Array.isArray(permissions) ? permissions : [];
    return items.filter((it) => !it.perm || perms.includes(it.perm));
  }, [items, permissions]);

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
            opacity: focusHideAside ? 0 : 1,
            // 与主内容区 Card 保持一致的配色方案
            backgroundColor: 'var(--bg-elevated)',
            backgroundImage: 'linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 96%, white) 0%, color-mix(in srgb, var(--bg-elevated) 92%, black) 100%)',
            border: '1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent)',
            boxShadow: '0 26px 120px rgba(0,0,0,0.60), 0 0 0 1px rgba(255, 255, 255, 0.02) inset',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            pointerEvents: focusHideAside ? 'none' : 'auto',
          }}
        >
          <div
            className={cn(
              'relative overflow-hidden transition-all duration-300 ease-out shrink-0',
              collapsed
                ? 'rounded-[16px] w-[50px] self-center'
                : 'rounded-[16px] p-3'
            )}
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 98%, white) 0%, color-mix(in srgb, var(--bg-elevated) 94%, black) 100%)',
              border: '1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.03) inset',
            }}
          >
            {collapsed ? (
              <div className="flex flex-col items-center gap-2 py-2">
                <div
                  className="h-9 w-9 rounded-[10px] flex items-center justify-center text-[10px] font-black tracking-tighter shrink-0"
                  style={{ 
                    background: 'var(--gold-gradient)',
                    color: '#1a1206',
                    boxShadow: '0 2px 8px rgba(214, 178, 106, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.1) inset'
                  }}
                >
                  PRD
                </div>
                <button
                  type="button"
                  onClick={() => toggleNavCollapsed()}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-[9px] transition-all duration-200 hover:bg-white/8"
                  style={{ 
                    color: 'var(--text-secondary)',
                    border: '1px solid rgba(255, 255, 255, 0.06)'
                  }}
                  aria-label="展开侧边栏"
                  title="展开侧边栏"
                >
                  <PanelLeftOpen size={16} />
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className="h-8 w-8 rounded-[9px] flex items-center justify-center text-[10px] font-black tracking-tighter shrink-0"
                      style={{ 
                        background: 'var(--gold-gradient)',
                        color: '#1a1206',
                        boxShadow: '0 2px 8px rgba(214, 178, 106, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.1) inset'
                      }}
                    >
                      PRD
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-bold truncate tracking-tight" style={{ color: 'var(--text-primary)' }}>PRD Admin</div>
                      <div className="text-[10px] truncate tracking-wide" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>Web Console</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleNavCollapsed()}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-[9px] transition-all duration-200 hover:bg-white/8 shrink-0"
                    style={{ 
                      color: 'var(--text-secondary)',
                      border: '1px solid rgba(255, 255, 255, 0.06)'
                    }}
                    aria-label="折叠侧边栏"
                  >
                    <PanelLeftClose size={16} />
                  </button>
                </div>
                <div 
                  className="h-px w-full"
                  style={{
                    background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.08) 20%, rgba(255, 255, 255, 0.08) 80%, transparent 100%)'
                  }}
                />
              </>
            )}
          </div>

          <nav className={cn('flex-1 min-h-0 flex flex-col overflow-y-auto overflow-x-hidden', collapsed ? 'gap-0.5' : 'gap-0.5')}
               style={{ paddingTop: 2, paddingRight: 2 }}>
            {visibleItems.map((it) => {
              const active = it.key === activeKey;
              return (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => navigate(it.key)}
                  className={cn(
                    'relative flex items-center gap-3 rounded-[12px] transition-colors',
                    'hover:bg-white/4',
                    // 收拢态：按钮点击区为正方形圆角矩形（避免扁长）
                    collapsed ? 'justify-center px-0 py-0 w-[50px] h-[50px] self-center shrink-0' : 'px-3 py-2'
                  )}
                  style={{
                    background: active ? 'color-mix(in srgb, var(--accent-gold) 10%, transparent)' : 'transparent',
                    border: active ? '1px solid color-mix(in srgb, var(--accent-gold) 35%, var(--border-subtle))' : '1px solid transparent',
                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                  title={collapsed && it.description ? `${it.label} - ${it.description}` : undefined}
                >
                  <span className={cn('inline-flex items-center justify-center shrink-0', active && 'drop-shadow')}>
                    {it.icon}
                  </span>
                  {!collapsed && (
                    <div className="min-w-0 flex-1 text-left">
                      <div className="text-sm font-medium truncate">{it.label}</div>
                      {it.description && (
                        <div className="text-[10px] truncate mt-0.5 leading-tight" style={{ color: 'var(--text-muted)', opacity: active ? 0.9 : 0.7 }}>
                          {it.description}
                        </div>
                      )}
                    </div>
                  )}
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
              'relative overflow-hidden transition-all duration-300 ease-out shrink-0',
              collapsed
                ? 'rounded-full w-[50px] h-[50px] self-center'
                : 'rounded-[16px] p-3'
            )}
            style={{
              background: collapsed
                ? 'linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 98%, white) 0%, color-mix(in srgb, var(--bg-elevated) 94%, black) 100%)'
                : 'linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 98%, white) 0%, color-mix(in srgb, var(--bg-elevated) 94%, black) 100%)',
              border: '1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.03) inset',
            }}
          >
            {collapsed ? (
              <button
                type="button"
                onClick={() => setAvatarOpen(true)}
                className="h-full w-full rounded-full overflow-hidden"
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
            ) : (
              <>
                <div className="flex items-center gap-2.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => setAvatarOpen(true)}
                    className="h-9 w-9 rounded-[10px] overflow-hidden shrink-0 transition-all duration-200 hover:scale-105"
                    style={{ 
                      background: 'rgba(255,255,255,0.04)', 
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)'
                    }}
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
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold truncate tracking-tight" style={{ color: 'var(--text-primary)' }}>
                      {user?.displayName || 'Admin'}
                    </div>
                    <div className="text-[10px] truncate tracking-wide mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
                      {user?.role === 'ADMIN' ? '系统管理员' : user?.role || ''}
                    </div>
                  </div>
                </div>
                <div 
                  className="h-px w-full my-2.5"
                  style={{
                    background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.08) 20%, rgba(255, 255, 255, 0.08) 80%, transparent 100%)'
                  }}
                />
                <button
                  type="button"
                  onClick={() => logout()}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-[10px] transition-all duration-200 hover:bg-white/6 group"
                  style={{ 
                    color: 'var(--text-secondary)',
                    border: '1px solid rgba(255, 255, 255, 0.06)'
                  }}
                >
                  <LogOut size={16} className="shrink-0 transition-transform duration-200 group-hover:-translate-x-0.5" />
                  <span className="text-[12px] font-medium">退出登录</span>
                </button>
              </>
            )}
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
              // 同时更新 avatarFileName 和 avatarUrl，确保左下角头像立即更新
              patchUser({ 
                avatarFileName: avatarFileName ?? null,
                avatarUrl: res.data?.avatarUrl ?? null
              });
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
              fullBleedMain ? 'px-3 py-3' : 'mx-auto max-w-[1680px] px-5 py-5'
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
