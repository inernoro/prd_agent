import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Cpu,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Users2,
  ScrollText,
  FlaskConical,
  MessagesSquare,
  Database,
  FileText,
  Wand2,
  Image,
  PenLine,
  Plug,
  UserCog,
  User,
  Settings,
  Bell,
  CheckCircle2,
  X,
  Bug,
  Zap,
  Crown,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/stores/themeStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useNavOrderStore } from '@/stores/navOrderStore';
import RecursiveGridBackdrop from '@/components/background/RecursiveGridBackdrop';
import { backdropMotionController, useBackdropMotionSnapshot } from '@/lib/backdropMotionController';
import { SystemDialogHost } from '@/components/ui/SystemDialogHost';
import { AvatarEditDialog } from '@/components/ui/AvatarEditDialog';
import { Dialog } from '@/components/ui/Dialog';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import { getAdminNotifications, handleAdminNotification, handleAllAdminNotifications, updateUserAvatar } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import { GlobalDefectSubmitDialog, DefectSubmitButton } from '@/components/ui/GlobalDefectSubmitDialog';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';

type NavItem = { key: string; label: string; icon: React.ReactNode; description?: string };

// 图标映射：后端下发的图标名称 → Lucide 图标组件
const iconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  Users,
  Users2,
  Cpu,
  FileText,
  MessagesSquare,
  Wand2,
  PenLine,
  Image,
  ScrollText,
  Database,
  Plug,
  UserCog,
  FlaskConical,
  Zap,
  Bug,
  Crown,
  Sparkles,
};

const notificationTone = {
  info: { border: 'rgba(59, 130, 246, 0.4)', bg: 'rgba(59, 130, 246, 0.08)', text: '#93c5fd' },
  warning: { border: 'rgba(251, 146, 60, 0.45)', bg: 'rgba(251, 146, 60, 0.1)', text: '#fdba74' },
  error: { border: 'rgba(248, 113, 113, 0.45)', bg: 'rgba(248, 113, 113, 0.08)', text: '#fca5a5' },
  success: { border: 'rgba(34, 197, 94, 0.45)', bg: 'rgba(34, 197, 94, 0.08)', text: '#86efac' },
};

function getNotificationTone(level?: string) {
  const key = (level ?? '').toLowerCase() as keyof typeof notificationTone;
  return notificationTone[key] ?? notificationTone.info;
}

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);
  const menuCatalog = useAuthStore((s) => s.menuCatalog);
  const menuCatalogLoaded = useAuthStore((s) => s.menuCatalogLoaded);
  const collapsed = useLayoutStore((s) => s.navCollapsed);
  const toggleNavCollapsed = useLayoutStore((s) => s.toggleNavCollapsed);
  const fullBleedMain = useLayoutStore((s) => s.fullBleedMain);
  const { navOrder, loaded: navOrderLoaded, loadFromServer: loadNavOrder } = useNavOrderStore();
  const { count: backdropCount, pendingStopId } = useBackdropMotionSnapshot();
  const backdropRunning = backdropCount > 0;
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [notificationDialogOpen, setNotificationDialogOpen] = useState(false);
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [dismissedToastIds, setDismissedToastIds] = useState<Set<string>>(new Set());
  const [toastCollapsed, setToastCollapsed] = useState(false);
  const [toastHovering, setToastHovering] = useState(false);

  // 导航滚动状态：用于显示渐变阴影指示器
  const navRef = useRef<HTMLElement>(null);
  const [navScrollState, setNavScrollState] = useState<{ atTop: boolean; atBottom: boolean; canScroll: boolean }>({
    atTop: true,
    atBottom: true,
    canScroll: false,
  });

  const updateNavScrollState = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const { scrollTop, scrollHeight, clientHeight } = nav;
    const canScroll = scrollHeight > clientHeight + 2; // 2px 容差
    const atTop = scrollTop <= 2;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 2;
    setNavScrollState({ atTop, atBottom, canScroll });
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    // 初始化检测
    updateNavScrollState();
    // 监听滚动
    nav.addEventListener('scroll', updateNavScrollState, { passive: true });
    // 监听窗口大小变化（可能影响可滚动性）
    window.addEventListener('resize', updateNavScrollState);
    return () => {
      nav.removeEventListener('scroll', updateNavScrollState);
      window.removeEventListener('resize', updateNavScrollState);
    };
  }, [updateNavScrollState]);

  // 兜底：部分 WebView/快捷键拦截环境下 Cmd/Ctrl+A 在输入控件中可能无法触发默认"全选"
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

  // 加载用户导航顺序偏好
  useEffect(() => {
    if (!navOrderLoaded && user?.userId) {
      void loadNavOrder();
    }
  }, [navOrderLoaded, user?.userId, loadNavOrder]);

  // 从后端菜单目录生成导航项，并应用用户自定义排序
  // 注意：后端已根据用户权限过滤，返回的菜单列表即用户可见的菜单
  const visibleItems: NavItem[] = useMemo(() => {
    if (!menuCatalogLoaded || !Array.isArray(menuCatalog) || menuCatalog.length === 0) {
      return [];
    }

    // 构建导航项列表
    const items = menuCatalog.map((m) => {
      const IconComp = iconMap[m.icon] ?? LayoutDashboard;
      return {
        key: m.path,
        appKey: m.appKey, // 用于排序匹配
        label: m.label,
        icon: <IconComp size={18} />,
        description: m.description ?? undefined,
      };
    });

    // 如果有用户自定义顺序，则按该顺序排列
    if (navOrder.length > 0) {
      const orderMap = new Map(navOrder.map((k, i) => [k, i]));
      items.sort((a, b) => {
        const aOrder = orderMap.get(a.appKey) ?? 9999;
        const bOrder = orderMap.get(b.appKey) ?? 9999;
        return aOrder - bOrder;
      });
    }

    return items;
  }, [menuCatalog, menuCatalogLoaded, navOrder]);
  
  // 若用户在首页（仪表盘）但菜单中不含仪表盘，自动跳转到第一个可用页面
  useEffect(() => {
    if (location.pathname !== '/' || !menuCatalogLoaded || visibleItems.length === 0) return;
    const hasDashboard = visibleItems.some((item) => item.key === '/');
    if (!hasDashboard) {
      navigate(visibleItems[0].key, { replace: true });
    }
  }, [location.pathname, menuCatalogLoaded, visibleItems, navigate]);

  const activeKey = location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;
  const isLabPage = location.pathname.startsWith('/lab');

  // 读取主题配置中的侧边栏玻璃效果设置
  const sidebarGlass = useThemeStore((s) => s.config.sidebarGlass);
  // 根据配置决定是否使用玻璃效果：always 始终启用，auto 仅实验室页面，never 禁用
  const useSidebarGlass = sidebarGlass === 'always' || (sidebarGlass === 'auto' && isLabPage);

  const asideWidth = collapsed ? 72 : 220;
  const asideGap = 18;
  // 专注模式（fullBleedMain）下隐藏侧栏，主区最大化
  const focusHideAside = fullBleedMain;
  const mainPadLeft = focusHideAside ? asideGap : asideWidth + asideGap * 2;

  // 过滤活跃通知：仅显示状态为 open 的通知
  const activeNotifications = useMemo(
    () => notifications.filter((n) => n.status === 'open'),
    [notifications]
  );
  const notificationCount = activeNotifications.length;
  const toastNotification = useMemo(
    () => activeNotifications.find((n) => !dismissedToastIds.has(n.id)),
    [activeNotifications, dismissedToastIds]
  );

  const loadNotifications = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setNotificationsLoading(true);
    try {
      const res = await getAdminNotifications();
      if (res.success) {
        setNotifications(res.data.items ?? []);
      }
    } finally {
      if (!opts?.silent) setNotificationsLoading(false);
    }
  }, []);

  const handleNotification = useCallback(async (id: string, actionUrl?: string | null) => {
    const res = await handleAdminNotification(id);
    if (res.success && actionUrl) {
      navigate(actionUrl);
    }
    await loadNotifications({ silent: true });
  }, [loadNotifications, navigate]);

  const handleAllNotifications = useCallback(async () => {
    const res = await handleAllAdminNotifications();
    if (res.success) {
      await loadNotifications({ silent: true });
    }
  }, [loadNotifications]);

  const dismissToast = useCallback((id: string) => {
    setDismissedToastIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // 自动消失逻辑：悬浮或收缩时暂停计时
  useEffect(() => {
    if (!toastNotification) return;
    // 悬浮或收缩状态下不自动消失
    if (toastHovering || toastCollapsed) return;
    const timer = window.setTimeout(() => {
      dismissToast(toastNotification.id);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [toastNotification, dismissToast, toastHovering, toastCollapsed]);

  // 当通知消失时，重置收缩状态
  useEffect(() => {
    if (!toastNotification) {
      setToastCollapsed(false);
      setToastHovering(false);
    }
  }, [toastNotification]);

  useEffect(() => {
    if (!user?.userId) return;
    void loadNotifications();
    const timer = window.setInterval(() => {
      void loadNotifications({ silent: true });
    }, 60000);
    return () => window.clearInterval(timer);
  }, [loadNotifications, user?.userId]);

  return (
    <div className="h-full w-full relative overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      <SystemDialogHost />
      <GlobalDefectSubmitDialog />
      {toastNotification && (
        toastCollapsed ? (
          // 收缩状态：浮动按钮
          <button
            type="button"
            className="fixed bottom-5 right-5 z-[120] h-12 w-12 rounded-full flex items-center justify-center transition-all duration-200 hover:scale-105"
            style={{
              background: 'var(--panel-solid, rgba(18, 18, 22, 0.92))',
              border: `1px solid ${getNotificationTone(toastNotification.level).border}`,
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              backdropFilter: 'blur(18px)',
            }}
            onClick={() => setToastCollapsed(false)}
            onMouseEnter={() => setToastHovering(true)}
            onMouseLeave={() => setToastHovering(false)}
            aria-label="展开通知"
          >
            <Bell size={18} style={{ color: getNotificationTone(toastNotification.level).text }} />
            {/* 未读数徽章 */}
            <span
              className="absolute -top-1 -right-1 h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold"
              style={{ background: 'var(--accent-gold)', color: '#1a1a1a' }}
            >
              {activeNotifications.length > 9 ? '9+' : activeNotifications.length}
            </span>
          </button>
        ) : (
          // 展开状态：完整通知卡片
          <div
            className="fixed bottom-5 right-5 z-[120] w-[360px] rounded-[18px] p-4 shadow-xl"
            style={{
              background: 'var(--panel-solid, rgba(18, 18, 22, 0.92))',
              border: `1px solid ${getNotificationTone(toastNotification.level).border}`,
              boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
              backdropFilter: 'blur(18px)',
            }}
            onMouseEnter={() => setToastHovering(true)}
            onMouseLeave={() => setToastHovering(false)}
          >
            <div className="flex items-start gap-3">
              <div
                className="mt-1 h-2.5 w-2.5 rounded-full"
                style={{ background: getNotificationTone(toastNotification.level).text }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {toastNotification.title}
                </div>
                {toastNotification.message && (
                  <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {toastNotification.message}
                  </div>
                )}
              </div>
              {/* 收缩按钮 */}
              <button
                type="button"
                className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-white/10"
                onClick={() => setToastCollapsed(true)}
                aria-label="收缩通知"
                title="收缩为浮动按钮"
              >
                <PanelLeftClose size={14} style={{ transform: 'rotate(90deg)' }} />
              </button>
              {/* 关闭按钮 */}
              <button
                type="button"
                className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-white/10"
                onClick={() => dismissToast(toastNotification.id)}
                aria-label="稍后提醒"
              >
                <X size={14} />
              </button>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              {toastNotification.actionUrl && (
                <button
                  type="button"
                  className="px-3 py-1.5 text-[12px] rounded-full"
                  style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-primary)' }}
                  onClick={() => handleNotification(toastNotification.id, toastNotification.actionUrl)}
                >
                  {toastNotification.actionLabel || '去处理'}
                </button>
              )}
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-full"
                style={{ background: 'var(--accent-gold)', color: '#1a1a1a' }}
                onClick={() => handleNotification(toastNotification.id)}
              >
                标记已处理
              </button>
            </div>
          </div>
        )
      )}
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
        // 统一使用较淡的线条颜色，避免状态切换时的突变闪烁
        // 刹车时内部会按 brakeStrokeFadeMs 渐变到 strokeBraking
        strokeRunning={'rgba(231, 206, 151, 0.65)'}
        strokeBraking={'rgba(231, 206, 151, 0.25)'}
        // 刹车阶段按 2s 渐隐，更符合"缓慢结束"的体感
        brakeStrokeFadeMs={2000}
        brakeDecelerationRate={0.965}
        brakeMinSpeedDegPerSec={0.015}
      />
      {/* 隔离层：阻断 backdrop-filter 对 Canvas 动画的实时采样，避免模糊重算导致卡顿 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'rgba(5, 5, 7, 0.15)',
          willChange: 'transform',
          transform: 'translateZ(0)',
        }}
      />
      {/* 运行态高亮：解析/任务运行时让背景整体更"亮"一点 */}
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-[2000ms] ease-out"
        style={{
          opacity: backdropRunning ? 0.8 : 0,
          background:
            'radial-gradient(900px 520px at 50% 18%, rgba(214, 178, 106, 0.12) 0%, transparent 60%), radial-gradient(820px 520px at 22% 55%, rgba(124, 252, 0, 0.04) 0%, transparent 65%), radial-gradient(1200px 700px at 60% 70%, rgba(255, 255, 255, 0.03) 0%, transparent 70%)',
        }}
      />

      <div className="relative z-10 h-full w-full">
        {/* 悬浮侧边栏：不贴左边，像“挂着” */}
        <aside
          className={cn(
            'absolute flex flex-col p-2.5 transition-[width] duration-220 ease-out',
            collapsed ? 'gap-2 items-center' : 'gap-2.5'
          )}
          style={{
            left: asideGap,
            top: asideGap,
            bottom: asideGap,
            width: focusHideAside ? 0 : asideWidth,
            zIndex: 12,
            borderRadius: 18,
            opacity: focusHideAside ? 0 : 1,
            // 根据主题配置决定是否使用液态玻璃效果
            // 强制创建持久的 GPU 合成层，避免状态变化时频繁创建/销毁合成层导致闪烁
            transform: 'translateZ(0)',
            willChange: 'transform',
            ...(useSidebarGlass ? {
              background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.06)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.02)) 100%)',
              border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.12))',
              backdropFilter: 'blur(40px) saturate(200%) brightness(1.1)',
              WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.1)',
              boxShadow: '0 12px 48px -8px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.15) inset, 0 2px 0 0 rgba(255, 255, 255, 0.2) inset, 0 -1px 0 0 rgba(0, 0, 0, 0.15) inset',
            } : {
              backgroundColor: 'var(--bg-elevated, #121216)',
              backgroundImage: 'linear-gradient(135deg, rgba(20,20,24,1) 0%, rgba(14,14,17,1) 100%)',
              border: '1px solid var(--border-faint, rgba(255, 255, 255, 0.05))',
              boxShadow: '0 26px 120px rgba(0,0,0,0.60), 0 0 0 1px rgba(255, 255, 255, 0.02) inset',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
            }),
            pointerEvents: focusHideAside ? 'none' : 'auto',
          }}
        >
          {/* 用户头像区域 */}
          <div
            className={cn(
              'group relative shrink-0 rounded-[14px]',
              collapsed ? 'w-[50px] py-2 flex justify-center' : 'px-3 py-2.5'
            )}
            style={{ background: 'transparent' }}
          >
            {/* 悬停背景效果 */}
            <div 
              className="absolute inset-0 rounded-[14px] opacity-0 group-hover:opacity-100 transition-opacity duration-200"
              style={{ background: 'rgba(255, 255, 255, 0.03)' }}
            />
            
            <div className={cn('relative flex items-center', collapsed ? 'justify-center' : 'gap-3')}>
              {/* 头像+用户名（触发下拉菜单） */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <div
                    className={cn('flex items-center cursor-pointer', collapsed ? '' : 'gap-3 flex-1 min-w-0')}
                    title="用户菜单"
                  >
                    {/* 头像 */}
                    <div
                      className="h-9 w-9 rounded-full overflow-hidden shrink-0 ring-1 ring-white/10 hover:ring-[var(--accent-gold)]/30 transition-colors duration-200"
                      style={{ boxShadow: '0 0 0 1px rgba(214, 178, 106, 0.1), 0 2px 12px rgba(0, 0, 0, 0.2)' }}
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
                    </div>
                    
                    {/* 用户信息（仅展开时显示） */}
                    {!collapsed && (
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                          {user?.displayName || 'Admin'}
                        </div>
                        <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
                          {user?.role === 'ADMIN' ? '系统管理员' : user?.role || ''}
                        </div>
                      </div>
                    )}
                  </div>
                </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[220px] rounded-[16px] p-2 z-50"
                style={{
                  background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
                  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
                  boxShadow: '0 18px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
                  backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
                  WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
                }}
                sideOffset={8}
                side="bottom"
                align="start"
              >
                {/* 用户信息区 */}
                <div className="px-2 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="h-10 w-10 rounded-full overflow-hidden shrink-0"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255, 255, 255, 0.08)' }}
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
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                        {user?.displayName || 'Admin'}
                      </div>
                      <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {user?.role === 'ADMIN' ? '系统管理员' : user?.role || ''}
                      </div>
                    </div>
                  </div>
                </div>

                <DropdownMenu.Separator
                  className="h-px mx-2 my-1"
                  style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.08) 20%, rgba(255, 255, 255, 0.08) 80%, transparent 100%)' }}
                />

                <DropdownMenu.Item
                  className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer outline-none transition-colors hover:bg-white/6"
                  style={{ color: 'var(--text-secondary)' }}
                  onSelect={() => setAvatarOpen(true)}
                >
                  <User size={16} className="shrink-0" />
                  <span className="text-[13px]">账户管理</span>
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer outline-none transition-colors hover:bg-white/6"
                  style={{ color: 'var(--text-secondary)' }}
                  onSelect={() => setAvatarOpen(true)}
                >
                  <Settings size={16} className="shrink-0" />
                  <span className="text-[13px]">修改头像</span>
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer outline-none transition-colors hover:bg-white/6"
                  style={{ color: 'var(--text-secondary)' }}
                  onSelect={() => {
                    setNotificationDialogOpen(true);
                    void loadNotifications({ silent: true });
                  }}
                >
                  <Bell size={16} className="shrink-0" />
                  <span className="text-[13px]">系统通知</span>
                  {notificationCount > 0 && (
                    <span
                      className="ml-auto rounded-full px-2 py-0.5 text-[10px]"
                      style={{ background: 'rgba(214, 178, 106, 0.18)', color: 'var(--accent-gold)' }}
                    >
                      {notificationCount}
                    </span>
                  )}
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer outline-none transition-colors hover:bg-white/6"
                  style={{ color: 'var(--text-secondary)' }}
                  onSelect={() => useGlobalDefectStore.getState().openDialog()}
                >
                  <Bug size={16} className="shrink-0" />
                  <span className="text-[13px]">提交缺陷</span>
                  <span
                    className="ml-auto text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+B
                  </span>
                </DropdownMenu.Item>

                <DropdownMenu.Separator
                  className="h-px mx-2 my-1"
                  style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.08) 20%, rgba(255, 255, 255, 0.08) 80%, transparent 100%)' }}
                />

                <DropdownMenu.Item
                  className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer outline-none transition-colors hover:bg-white/6"
                  style={{ color: 'var(--text-secondary)' }}
                  onSelect={() => logout()}
                >
                  <LogOut size={16} className="shrink-0" />
                  <span className="text-[13px]">退出登录</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          
          {/* 提交缺陷按钮 + 折叠按钮（仅展开时显示，在 DropdownMenu 外部） */}
          {!collapsed && (
            <>
              <DefectSubmitButton collapsed={collapsed} />
              <button
                type="button"
                onClick={toggleNavCollapsed}
                className="h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors duration-200 hover:bg-white/10 opacity-40 hover:opacity-100 shrink-0"
                style={{ color: 'var(--text-muted)' }}
                aria-label="折叠侧边栏"
              >
                <PanelLeftClose size={14} />
              </button>
            </>
          )}
            </div>
          </div>
          
          {/* 展开按钮（仅收缩时显示） */}
          {collapsed && (
            <button
              type="button"
              onClick={toggleNavCollapsed}
              className="h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors duration-200 hover:bg-white/10 opacity-60 hover:opacity-100"
              style={{ color: 'var(--text-muted)' }}
              aria-label="展开侧边栏"
              title="展开侧边栏"
            >
              <PanelLeftOpen size={14} />
            </button>
          )}

          {/* 导航区域容器：包含滚动指示器 */}
          <div className="relative flex-1 min-h-0">
            {/* 顶部渐变阴影：提示可向上滚动 */}
            <div
              className="pointer-events-none absolute top-0 left-0 right-0 z-10 transition-opacity duration-200"
              style={{
                height: 32,
                background: 'linear-gradient(to bottom, var(--bg-elevated, #121216) 0%, transparent 100%)',
                opacity: navScrollState.canScroll && !navScrollState.atTop ? 0.95 : 0,
              }}
            />
            
            <nav 
              ref={navRef}
              className={cn(
                'h-full flex flex-col overflow-y-auto overflow-x-hidden nav-scroll-hidden',
                collapsed ? 'gap-0.5 items-center' : 'gap-0.5'
              )}
              style={{ paddingTop: 2, paddingRight: collapsed ? 0 : 2, paddingBottom: 8 }}
            >
              {visibleItems.map((it) => {
                const active = it.key === activeKey;
                return (
                  <button
                    key={it.key}
                    type="button"
                    onClick={() => navigate(it.key)}
                    className={cn(
                      'group/nav relative flex items-center gap-3 rounded-[12px]',
                      'transition-all duration-200 ease-out',
                      collapsed ? 'justify-center w-[50px] h-[50px] shrink-0' : 'px-3 py-2',
                      // 使用 CSS 类处理 hover，避免 JS 残影问题
                      !active && 'nav-item-hover'
                    )}
                    style={{
                      background: active ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                      border: active ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid transparent',
                      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                    title={collapsed && it.description ? `${it.label} - ${it.description}` : undefined}
                  >
                    <span
                      className="inline-flex items-center justify-center shrink-0 transition-all duration-200 group-hover/nav:scale-110"
                      style={{ color: active ? 'var(--accent-gold)' : undefined }}
                    >
                      {it.icon}
                    </span>
                    {!collapsed && (
                      <div className="min-w-0 flex-1 text-left">
                        <div className="text-sm font-medium truncate transition-colors duration-200 group-hover/nav:text-[var(--text-primary)]">{it.label}</div>
                        {it.description && (
                          <div className="text-[10px] truncate mt-0.5 leading-tight" style={{ color: 'var(--text-muted)', opacity: active ? 0.8 : 0.6 }}>
                            {it.description}
                          </div>
                        )}
                      </div>
                    )}
                    {active && !collapsed && (
                      <span
                        className="absolute left-0 top-1/2 -translate-y-1/2"
                        style={{ width: 2, height: 16, background: 'var(--accent-gold)', borderRadius: '0 999px 999px 0' }}
                      />
                    )}
                  </button>
                );
              })}
            </nav>
            
            {/* 底部渐变阴影：提示可向下滚动 */}
            <div
              className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 transition-opacity duration-200"
              style={{
                height: 40,
                background: 'linear-gradient(to top, var(--bg-elevated, #121216) 0%, transparent 100%)',
                opacity: navScrollState.canScroll && !navScrollState.atBottom ? 0.95 : 0,
              }}
            />
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

          <Dialog
            open={notificationDialogOpen}
            onOpenChange={setNotificationDialogOpen}
            title="系统通知"
            description="系统级通知与待处理事项"
            maxWidth={620}
            content={
              <div className="flex h-full flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {notificationsLoading ? '加载中...' : `未处理 ${notificationCount} 条`}
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px]"
                    style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-primary)' }}
                    onClick={() => handleAllNotifications()}
                    disabled={notificationCount === 0}
                  >
                    <CheckCircle2 size={14} />
                    一键处理
                  </button>
                </div>

                <div className="flex-1 overflow-auto pr-2 space-y-3">
                  {notificationCount === 0 && !notificationsLoading && (
                    <div className="rounded-[14px] border border-dashed border-white/10 px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                      暂无待处理通知
                    </div>
                  )}
                  {activeNotifications.map((item) => {
                    const tone = getNotificationTone(item.level);
                    return (
                      <div
                        key={item.id}
                        className="rounded-[16px] border px-4 py-3"
                        style={{ borderColor: tone.border, background: tone.bg }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                              {item.title}
                            </div>
                            {item.message && (
                              <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                                {item.message}
                              </div>
                            )}
                            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {new Date(item.createdAt).toLocaleString()}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            {item.actionUrl && (
                              <button
                                type="button"
                                className="rounded-full px-3 py-1.5 text-[12px]"
                                style={{ background: 'rgba(255, 255, 255, 0.15)', color: 'var(--text-primary)' }}
                                onClick={() => handleNotification(item.id, item.actionUrl)}
                              >
                                {item.actionLabel || '去处理'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="rounded-full px-3 py-1.5 text-[12px]"
                              style={{ background: 'var(--accent-gold)', color: '#1a1a1a' }}
                              onClick={() => handleNotification(item.id)}
                            >
                              标记已处理
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            }
          />
        </aside>

        <main
          className="relative h-full w-full overflow-auto flex flex-col transition-[padding-left] duration-220 ease-out"
          // 让递归线条背景可见；前景可读性由 Card 等“实底组件”承担
          style={{ background: 'transparent', paddingLeft: mainPadLeft }}
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
              fullBleedMain ? 'px-3 py-3' : 'px-5 py-5'
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
