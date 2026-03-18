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
  Workflow,
  Swords,
  Menu,
  Download,
  Globe,
  Smartphone,
  FolderOpen,
  Server,
  Store,
  Wrench,
  UserCircle,
  HardDrive,
  Home,
  BarChart3,
  type LucideIcon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { glassPanel, glassSidebar, glassFloatingButton, glassMobileHeader } from '@/lib/glassStyles';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/stores/themeStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useNavOrderStore } from '@/stores/navOrderStore';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SystemDialogHost } from '@/components/ui/SystemDialogHost';
import { AvatarEditDialog } from '@/components/ui/AvatarEditDialog';
import { Dialog } from '@/components/ui/Dialog';
import { MobileDrawer } from '@/components/ui/MobileDrawer';
import { MobileTabBar } from '@/components/ui/MobileTabBar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { getAdminNotifications, handleAdminNotification, handleAllAdminNotifications, updateMyAvatar, uploadMyAvatar } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import { GlobalDefectSubmitDialog, DefectSubmitButton } from '@/components/ui/GlobalDefectSubmitDialog';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';

type NavItem = { key: string; appKey: string; label: string; icon: React.ReactNode; description?: string; group?: string | null };

/** 侧边栏分组定义 */
const NAV_GROUPS: { key: string; label: string }[] = [
  { key: 'tools', label: '效率工具' },
  { key: 'personal', label: '个人空间' },
  { key: 'admin', label: '系统管理' },
];

/** 根据 mimeType 推断扩展名，确保下载文件名带后缀 */
function ensureDownloadName(name: string | undefined | null, mimeType?: string | null): string {
  let n = name || 'output';
  if (/\.\w{1,5}$/.test(n)) return n;
  if (!mimeType) return n + '.txt';
  if (mimeType.includes('markdown')) return n + '.md';
  if (mimeType.includes('json')) return n + '.json';
  if (mimeType.includes('csv')) return n + '.csv';
  if (mimeType.includes('html')) return n + '.html';
  if (mimeType.includes('xml')) return n + '.xml';
  if (mimeType.includes('javascript')) return n + '.js';
  return n + '.txt';
}

/** 轻量 Markdown → HTML（仅用于通知摘要：标题、粗体、列表） */
function renderNotificationMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<strong style="font-size:11px">$1</strong>')
    .replace(/^## (.+)$/gm, '<strong style="font-size:12px">$1</strong>')
    .replace(/^# (.+)$/gm, '<strong style="font-size:13px">$1</strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '• $1')
    .replace(/\|[^\n]+\|/g, (m) => m.replace(/\|/g, ' ').trim())
    .replace(/^[\s|:-]+$/gm, '')
    .replace(/\n\n+/g, '<br/>')
    .replace(/\n/g, '<br/>');
}

/** 判断文本是否包含 Markdown 特征 */
function looksLikeMarkdown(text: string): boolean {
  return /^#{1,3}\s/m.test(text) || /\*\*.+\*\*/.test(text) || /^\|.+\|$/m.test(text);
}

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
  Workflow,
  Swords,
  Globe,
  Smartphone,
  FolderOpen,
  Server,
  Store,
  Settings,
  Wrench,
  UserCircle,
  HardDrive,
  Home,
  BarChart3,
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
  const mobileDrawerOpen = useLayoutStore((s) => s.mobileDrawerOpen);
  const setMobileDrawerOpen = useLayoutStore((s) => s.setMobileDrawerOpen);
  const { isMobile } = useBreakpoint();
  const { navOrder, loaded: navOrderLoaded, loadFromServer: loadNavOrder } = useNavOrderStore();
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


  // 加载用户导航顺序偏好
  useEffect(() => {
    if (!navOrderLoaded && user?.userId) {
      void loadNavOrder();
    }
  }, [navOrderLoaded, user?.userId, loadNavOrder]);

  // 从后端菜单目录生成导航项，按 group 分组
  // 只有带 group 字段的菜单项才在侧边栏显示
  const visibleItems: NavItem[] = useMemo(() => {
    if (!menuCatalogLoaded || !Array.isArray(menuCatalog) || menuCatalog.length === 0) {
      return [];
    }

    // 只显示有 group 的菜单项（无 group 的放在头像面板）
    const items = menuCatalog
      .filter((m) => !!m.group)
      .map((m) => {
        const IconComp = iconMap[m.icon] ?? LayoutDashboard;
        return {
          key: m.path,
          appKey: m.appKey,
          label: m.label,
          icon: <IconComp size={18} />,
          description: m.description ?? undefined,
          group: m.group,
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

  // 头像面板菜单项（无 group 的项）
  const avatarPanelItems: NavItem[] = useMemo(() => {
    if (!menuCatalogLoaded || !Array.isArray(menuCatalog)) return [];
    return menuCatalog
      .filter((m) => !m.group)
      .map((m) => {
        const IconComp = iconMap[m.icon] ?? LayoutDashboard;
        return {
          key: m.path,
          appKey: m.appKey,
          label: m.label,
          icon: <IconComp size={16} />,
          description: m.description ?? undefined,
          group: null,
        };
      });
  }, [menuCatalog, menuCatalogLoaded]);

  // 首页独立项（不归属任何分组）
  const homeItem = useMemo(() => visibleItems.find((it) => it.group === 'home'), [visibleItems]);

  // 按 group 分组的导航项（排除 home）
  const groupedNav = useMemo(() => {
    return NAV_GROUPS
      .map((g) => ({
        ...g,
        items: visibleItems.filter((it) => it.group === g.key),
      }))
      .filter((g) => g.items.length > 0);
  }, [visibleItems]);
  
  // 首页为 Agent Launcher 沉浸页，不自动跳转，让用户自主选择 Agent
  const isHomePage = location.pathname === '/';

  const activeKey = location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;
  const isLabPage = location.pathname.startsWith('/lab');

  // 读取主题配置中的侧边栏玻璃效果设置
  const sidebarGlass = useThemeStore((s) => s.config.sidebarGlass);
  // 根据配置决定是否使用玻璃效果：always 始终启用，auto 仅实验室页面，never 禁用
  const useSidebarGlass = sidebarGlass === 'always' || (sidebarGlass === 'auto' && isLabPage);

  const asideWidth = collapsed ? 52 : 176;
  const asideGap = 12;
  // 专注模式（fullBleedMain）、移动端下隐藏侧栏，主区最大化
  const focusHideAside = fullBleedMain || isMobile;
  const mainPadLeft = focusHideAside ? (isMobile ? 0 : asideGap) : asideWidth + asideGap * 2;

  // 移动端底部 Tab 栏: 5 固定 Tab（首页/浏览/+/资产/我的），不再依赖后端菜单

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
              ...glassFloatingButton,
              background: 'var(--panel-solid, rgba(18, 18, 22, 0.92))',
              border: `1px solid ${getNotificationTone(toastNotification.level).border}`,
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
              ...glassFloatingButton,
              background: 'var(--panel-solid, rgba(18, 18, 22, 0.92))',
              border: `1px solid ${getNotificationTone(toastNotification.level).border}`,
              boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
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
                  looksLikeMarkdown(toastNotification.message) ? (
                    <div
                      className="mt-1 text-[12px] leading-relaxed"
                      style={{ color: 'var(--text-muted)' }}
                      dangerouslySetInnerHTML={{ __html: renderNotificationMarkdown(toastNotification.message) }}
                    />
                  ) : (
                    <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      {toastNotification.message}
                    </div>
                  )
                )}
                {toastNotification.attachments && toastNotification.attachments.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {toastNotification.attachments.map((att, i) => (
                      <a
                        key={i}
                        href={att.url}
                        download={ensureDownloadName(att.name, att.mimeType)}
                        onClick={async (e) => {
                          e.preventDefault();
                          try {
                            const resp = await fetch(att.url);
                            const blob = await resp.blob();
                            const blobUrl = URL.createObjectURL(blob);
                            const link = document.createElement('a');
                            link.href = blobUrl;
                            link.download = ensureDownloadName(att.name, att.mimeType);
                            link.click();
                            URL.revokeObjectURL(blobUrl);
                          } catch {
                            window.open(att.url, '_blank');
                          }
                        }}
                        className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-[6px] transition-colors hover:bg-white/10 cursor-pointer no-underline"
                        style={{ color: 'var(--accent-gold)' }}
                      >
                        <Download size={12} />
                        <span>{ensureDownloadName(att.name, att.mimeType)}</span>
                        {att.sizeBytes > 0 && (
                          <span style={{ color: 'var(--text-muted)' }}>
                            ({(att.sizeBytes / 1024).toFixed(1)} KB)
                          </span>
                        )}
                      </a>
                    ))}
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
      {/* ── 移动端: 顶部导航栏 ── */}
      {isMobile && (
        <header
          className="fixed top-0 left-0 right-0 z-100 flex items-center gap-3 px-4"
          style={{
            ...glassMobileHeader,
            height: 'calc(var(--mobile-header-height, 48px) + env(safe-area-inset-top, 0px))',
            paddingTop: 'env(safe-area-inset-top, 0px)',
          }}
        >
          <button
            type="button"
            onClick={() => setMobileDrawerOpen(true)}
            className="h-9 w-9 inline-flex items-center justify-center rounded-xl"
            style={{ color: 'var(--text-primary)' }}
            aria-label="打开导航菜单"
          >
            <Menu size={20} />
          </button>
          <div className="flex-1 min-w-0 text-center">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {visibleItems.find((it) => it.key === activeKey)?.label || 'PRD Agent'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setNotificationDialogOpen(true);
              void loadNotifications({ silent: true });
            }}
            className="relative h-9 w-9 inline-flex items-center justify-center rounded-xl"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="通知"
          >
            <Bell size={18} />
            {notificationCount > 0 && (
              <span
                className="absolute top-1 right-1 h-4 w-4 rounded-full flex items-center justify-center text-[9px] font-bold"
                style={{ background: 'var(--accent-gold)', color: '#1a1a1a' }}
              >
                {notificationCount > 9 ? '9+' : notificationCount}
              </span>
            )}
          </button>
        </header>
      )}

      {/* ── 移动端: 侧滑抽屉导航 ── */}
      {isMobile && (
        <MobileDrawer open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen}>
          {/* 用户信息 */}
          <div className="px-4 py-3 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full overflow-hidden shrink-0 ring-1 ring-white/10">
              <UserAvatar
                src={resolveAvatarUrl({
                  username: user?.username,
                  userType: user?.userType,
                  botKind: user?.botKind,
                  avatarFileName: user?.avatarFileName ?? null,
                  avatarUrl: user?.avatarUrl,
                })}
                alt="avatar"
                className="h-full w-full object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {user?.displayName || 'Admin'}
              </div>
              <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                {user?.role === 'ADMIN' ? '系统管理员' : user?.role || ''}
              </div>
            </div>
          </div>

          {/* 导航列表 — 按分组显示 */}
          <nav className="flex flex-col gap-0.5 px-2 mt-2">
            {groupedNav.map((group, gi) => (
              <div key={group.key}>
                {gi > 0 && (
                  <div className="h-px mx-3 my-3.5" style={{ background: 'rgba(255,255,255,0.06)' }} />
                )}
                <div
                  className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase select-none"
                  style={{ color: 'var(--text-muted, rgba(255,255,255,0.32))' }}
                >
                  {group.label}
                </div>
                {group.items.map((it) => {
                  const active = it.key === activeKey;
                  return (
                    <button
                      key={it.key}
                      type="button"
                      onClick={() => { navigate(it.key); setMobileDrawerOpen(false); }}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors',
                        'min-h-[var(--mobile-min-touch,44px)]',
                      )}
                      style={{
                        background: active ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                      }}
                    >
                      <span style={{ color: active ? '#818cf8' : undefined }}>{it.icon}</span>
                      <span className="text-sm">{it.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* 底部操作 */}
          <div className="mt-auto px-4 py-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => { setAvatarOpen(true); setMobileDrawerOpen(false); }}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl min-h-[44px]"
              style={{ color: 'var(--text-secondary)' }}
            >
              <Settings size={18} />
              <span className="text-sm">修改头像</span>
            </button>
            <button
              type="button"
              onClick={() => { logout(); setMobileDrawerOpen(false); }}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl min-h-[44px]"
              style={{ color: 'var(--text-secondary)' }}
            >
              <LogOut size={18} />
              <span className="text-sm">退出登录</span>
            </button>
          </div>
        </MobileDrawer>
      )}

      {/* ── 移动端: 底部 Tab 栏 (5 固定 Tab: 首页/浏览/+/资产/我的) ── */}
      {isMobile && <MobileTabBar />}

      {/* 主体容器（背景动画已临时移除以消除渲染卡顿） */}
      <div className="relative h-full w-full">
        {/* 悬浮侧边栏：不贴左边，像"挂着" (移动端隐藏) */}
        <aside
          className={cn(
            'absolute flex flex-col p-2 transition-[width] duration-220 ease-out',
            collapsed ? 'gap-1.5 items-center' : 'gap-1.5'
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
            ...(useSidebarGlass ? glassSidebar : {
              backgroundColor: 'var(--bg-elevated, #1e1e24)',
              backgroundImage: 'linear-gradient(180deg, rgba(30,30,36,1) 0%, rgba(20,20,24,1) 100%)',
              border: '1px solid rgba(99,102,241,0.08)',
              boxShadow: '0 26px 120px rgba(0,0,0,0.60), 0 0 0 1px rgba(99,102,241,0.04) inset',
            }),
            pointerEvents: focusHideAside ? 'none' : 'auto',
          }}
        >
          {/* 用户头像区域 */}
          <div
            className={cn(
              'group relative shrink-0 rounded-[14px]',
              collapsed ? 'w-[38px] py-1.5 flex justify-center' : 'px-2.5 py-2'
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
                      className="h-8 w-8 rounded-full overflow-hidden shrink-0 ring-1 ring-white/10 hover:ring-indigo-400/30 transition-colors duration-200"
                      style={{ boxShadow: '0 0 0 1px rgba(99, 102, 241, 0.1), 0 2px 12px rgba(0, 0, 0, 0.2)' }}
                    >
                      <UserAvatar
                        src={resolveAvatarUrl({
                          username: user?.username,
                          userType: user?.userType,
                          botKind: user?.botKind,
                          avatarFileName: user?.avatarFileName ?? null,
                          avatarUrl: user?.avatarUrl,
                        })}
                        alt="avatar"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    
                    {/* 用户信息（仅展开时显示） */}
                    {!collapsed && (
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-semibold truncate" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                          {user?.displayName || 'Admin'}
                        </div>
                        <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
                          {user?.role === 'ADMIN' ? '系统管理员' : user?.role || ''}
                        </div>
                      </div>
                    )}
                  </div>
                </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[220px] rounded-[16px] p-2 z-50"
                style={glassPanel}
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
                      <UserAvatar
                        src={resolveAvatarUrl({
                          username: user?.username,
                          userType: user?.userType,
                          botKind: user?.botKind,
                          avatarFileName: user?.avatarFileName ?? null,
                          avatarUrl: user?.avatarUrl,
                        })}
                        alt="avatar"
                        className="h-full w-full object-cover"
                      />
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
                      style={{ background: 'rgba(99, 102, 241, 0.18)', color: 'var(--accent-gold)' }}
                    >
                      {notificationCount}
                    </span>
                  )}
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer outline-none transition-colors hover:bg-white/6"
                  style={{ color: 'var(--text-secondary)' }}
                  onSelect={() => navigate('/data-transfers')}
                >
                  <Database size={16} className="shrink-0" />
                  <span className="text-[13px]">数据分享</span>
                </DropdownMenu.Item>

                {/* 动态：从后端菜单目录中加载头像面板项 */}
                {avatarPanelItems.map((it) => (
                  <DropdownMenu.Item
                    key={it.key}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer outline-none transition-colors hover:bg-white/6"
                    style={{ color: 'var(--text-secondary)' }}
                    onSelect={() => navigate(it.key)}
                  >
                    <span className="shrink-0">{it.icon}</span>
                    <span className="text-[13px]">{it.label}</span>
                  </DropdownMenu.Item>
                ))}

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
          
          {/* 提交缺陷按钮（仅展开时显示，在 DropdownMenu 外部） */}
          {!collapsed && (
            <DefectSubmitButton collapsed={collapsed} />
          )}
            </div>
          </div>

          {/* ── 首页按钮（独立，不在分组内） ── */}
          {homeItem && (
            <div className={cn(collapsed ? 'flex justify-center' : 'px-1')}>
              <button
                type="button"
                onClick={() => navigate(homeItem.key)}
                className={cn(
                  'group/nav relative flex items-center gap-2.5 rounded-[10px] w-full',
                  'transition-all duration-200 ease-out',
                  collapsed ? 'justify-center w-[38px] h-[38px] shrink-0' : 'px-2.5 py-1.5',
                  activeKey === '/' ? '' : 'nav-item-hover'
                )}
                style={{
                  background: activeKey === '/' ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                  border: activeKey === '/' ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid transparent',
                  color: activeKey === '/' ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
                title={collapsed ? homeItem.label : undefined}
              >
                <span
                  className="inline-flex items-center justify-center shrink-0 transition-all duration-200 group-hover/nav:scale-110"
                  style={{ color: activeKey === '/' ? '#818cf8' : undefined }}
                >
                  {homeItem.icon}
                </span>
                {!collapsed && (
                  <div className="text-[13px] font-medium truncate transition-colors duration-200 group-hover/nav:text-[var(--text-primary)]">
                    {homeItem.label}
                  </div>
                )}
              </button>
            </div>
          )}

          {/* 导航区域容器：包含滚动指示器 */}
          <div className="relative flex-1 min-h-0">
            {/* 顶部渐变阴影：提示可向上滚动 */}
            <div
              className="pointer-events-none absolute top-0 left-0 right-0 z-10 transition-opacity duration-200"
              style={{
                height: 32,
                background: 'linear-gradient(to bottom, var(--bg-elevated, #1e1e24) 0%, transparent 100%)',
                opacity: navScrollState.canScroll && !navScrollState.atTop ? 0.95 : 0,
              }}
            />
            
            <nav
              ref={navRef}
              className={cn(
                'h-full flex flex-col justify-between overflow-y-auto overflow-x-hidden nav-scroll-hidden',
                collapsed ? 'items-center' : ''
              )}
              style={{ paddingTop: 2, paddingRight: collapsed ? 0 : 2, paddingBottom: 8 }}
            >
              {groupedNav.map((group, gi) => (
                <div key={group.key}>
                  {/* 分组分隔线（非首组） */}
                  {gi > 0 && (
                    <div
                      className={cn('mx-auto', collapsed ? 'my-3' : 'my-4 mx-3')}
                      style={{
                        height: 1,
                        background: collapsed
                          ? 'rgba(255, 255, 255, 0.06)'
                          : 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.08) 80%, transparent 100%)',
                        width: collapsed ? 24 : undefined,
                      }}
                    />
                  )}

                  {/* 分组标题（仅展开时显示） */}
                  {!collapsed && (
                    <div
                      className="px-2.5 pt-1 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase select-none"
                      style={{ color: 'var(--text-muted, rgba(255,255,255,0.32))' }}
                    >
                      {group.label}
                    </div>
                  )}

                  {/* 分组内的导航项 */}
                  <div className={cn('flex flex-col', collapsed ? 'gap-px items-center' : 'gap-px')}>
                    {group.items.map((it) => {
                      const active = it.key === activeKey;
                      return (
                        <button
                          key={it.key}
                          type="button"
                          onClick={() => navigate(it.key)}
                          className={cn(
                            'group/nav relative flex items-center gap-2.5 rounded-[10px]',
                            'transition-all duration-200 ease-out',
                            collapsed ? 'justify-center w-[38px] h-[38px] shrink-0' : 'px-2.5 py-1.5',
                            !active && 'nav-item-hover'
                          )}
                          style={{
                            background: active ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                            border: active ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid transparent',
                            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                          }}
                          title={collapsed ? (it.description ? `${it.label} - ${it.description}` : it.label) : undefined}
                        >
                          <span
                            className="inline-flex items-center justify-center shrink-0 transition-all duration-200 group-hover/nav:scale-110"
                            style={{ color: active ? '#818cf8' : undefined }}
                          >
                            {it.icon}
                          </span>
                          {!collapsed && (
                            <div className="min-w-0 flex-1 text-left">
                              <div className="text-[13px] font-medium truncate transition-colors duration-200 group-hover/nav:text-[var(--text-primary)]">{it.label}</div>
                            </div>
                          )}
                          {active && !collapsed && (
                            <span
                              className="absolute left-0 top-1/2 -translate-y-1/2"
                              style={{ width: 2, height: 14, background: '#818cf8', borderRadius: '0 999px 999px 0' }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
            
            {/* 底部渐变阴影：提示可向下滚动 */}
            <div
              className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 transition-opacity duration-200"
              style={{
                height: 40,
                background: 'linear-gradient(to top, var(--bg-elevated, #1e1e24) 0%, transparent 100%)',
                opacity: navScrollState.canScroll && !navScrollState.atBottom ? 0.95 : 0,
              }}
            />
          </div>

          {/* ── 折叠/展开按钮（底部固定） ── */}
          <div className={cn('shrink-0 pt-1 pb-0.5', collapsed ? 'flex justify-center' : 'px-2')}>
            <button
              type="button"
              onClick={toggleNavCollapsed}
              className={cn(
                'inline-flex items-center gap-2 rounded-[10px] transition-colors duration-200 hover:bg-white/[0.06]',
                collapsed ? 'h-9 w-9 justify-center' : 'h-8 px-3 w-full'
              )}
              style={{ color: 'var(--text-muted)' }}
              aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
              title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
            >
              {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
              {!collapsed && (
                <span className="text-[12px] opacity-60">收起</span>
              )}
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
            onUpload={async (file) => uploadMyAvatar({ file })}
            onSave={async (avatarFileName) => {
              if (!user?.userId) return;
              const res = await updateMyAvatar(avatarFileName);
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
                              looksLikeMarkdown(item.message) ? (
                                <div
                                  className="mt-1 text-[12px] leading-relaxed"
                                  style={{ color: 'var(--text-muted)' }}
                                  dangerouslySetInnerHTML={{ __html: renderNotificationMarkdown(item.message) }}
                                />
                              ) : (
                                <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                                  {item.message}
                                </div>
                              )
                            )}
                            {item.attachments && item.attachments.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {item.attachments.map((att, i) => (
                                  <a
                                    key={i}
                                    href={att.url}
                                    download={ensureDownloadName(att.name, att.mimeType)}
                                    onClick={async (e) => {
                                      e.preventDefault();
                                      try {
                                        const resp = await fetch(att.url);
                                        const blob = await resp.blob();
                                        const blobUrl = URL.createObjectURL(blob);
                                        const link = document.createElement('a');
                                        link.href = blobUrl;
                                        link.download = ensureDownloadName(att.name, att.mimeType);
                                        link.click();
                                        URL.revokeObjectURL(blobUrl);
                                      } catch {
                                        window.open(att.url, '_blank');
                                      }
                                    }}
                                    className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-[6px] transition-colors hover:bg-white/10 cursor-pointer no-underline"
                                    style={{
                                      background: 'rgba(255,255,255,0.06)',
                                      border: '1px solid rgba(255,255,255,0.1)',
                                      color: 'var(--accent-gold)',
                                    }}
                                  >
                                    <Download size={12} />
                                    <span>{ensureDownloadName(att.name, att.mimeType)}</span>
                                    {att.sizeBytes > 0 && (
                                      <span style={{ color: 'var(--text-muted)' }}>
                                        ({(att.sizeBytes / 1024).toFixed(1)} KB)
                                      </span>
                                    )}
                                  </a>
                                ))}
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
          style={{
            background: 'var(--bg-base)',
            paddingLeft: mainPadLeft,
            // 移动端留出顶部 header 和底部 tab 栏空间
            paddingTop: isMobile ? 'calc(var(--mobile-header-height, 48px) + env(safe-area-inset-top, 0px))' : undefined,
            paddingBottom: isMobile ? 'calc(var(--mobile-tab-height, 60px) + env(safe-area-inset-bottom, 0px))' : undefined,
          }}
        >
          <div
            className={cn(
              'relative w-full flex-1 min-h-0 flex flex-col',
              isMobile ? 'px-[var(--mobile-padding,16px)] py-3' : fullBleedMain ? 'p-0' : isHomePage ? 'px-3 py-3' : 'px-5 py-5'
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
