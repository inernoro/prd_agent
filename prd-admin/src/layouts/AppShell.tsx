import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Cpu,
  LogOut,
  PanelLeftClose,
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
import * as LucideIcons from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { glassPanel, glassSidebar, glassFloatingButton, glassMobileHeader } from '@/lib/glassStyles';
import { useAuthStore } from '@/stores/authStore';
import { useAgentSwitcherStore } from '@/stores/agentSwitcherStore';
import { useThemeStore } from '@/stores/themeStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useNavOrderStore, NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import { getLauncherCatalog } from '@/lib/launcherCatalog';
import { getShortLabel } from '@/lib/shortLabel';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SystemDialogHost } from '@/components/ui/SystemDialogHost';
import { InlinePageLoader } from '@/components/ui/VideoLoader';
import { AvatarEditDialog } from '@/components/ui/AvatarEditDialog';
import { Dialog } from '@/components/ui/Dialog';
import { MobileDrawer } from '@/components/ui/MobileDrawer';
import { MobileTabBar } from '@/components/ui/MobileTabBar';
import { MobileSafeBoundary } from '@/components/MobileSafeBoundary';
import { MobileCompatGate } from '@/components/MobileCompatGate';
import { resolveAvatarUrl } from '@/lib/avatar';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { getAdminNotifications, handleAdminNotification, handleAllAdminNotifications, updateMyAvatar, uploadMyAvatar } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import { GlobalDefectSubmitDialog, DefectSubmitButton } from '@/components/ui/GlobalDefectSubmitDialog';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';
import { ChangelogBell } from '@/components/changelog/ChangelogBell';
import { useChangelogStore, selectUnreadCount } from '@/stores/changelogStore';
import { SpotlightOverlay } from '@/components/daily-tips/SpotlightOverlay';
import { TipsDrawer, FLOATING_DOCK_COLLAPSED_KEY, FLOATING_DOCK_EVENT } from '@/components/daily-tips/TipsDrawer';
import { CommandPalette } from '@/components/command-palette/CommandPalette';

type NavItem = { key: string; appKey: string; label: string; shortLabel: string; icon: React.ReactNode; description?: string; group?: string | null };

/** 侧边栏分组定义 */
const NAV_GROUPS: { key: string; label: string }[] = [
  { key: 'tools', label: '效率工具' },
  { key: 'personal', label: '个人空间' },
  { key: 'admin', label: '系统管理' },
];

/** 从侧边栏隐藏的 appKey（页面仍可直接访问） */
const HIDDEN_NAV_KEYS = new Set<string>([]);

/** 根据 mimeType 推断扩展名，确保下载文件名带后缀 */
function ensureDownloadName(name: string | undefined | null, mimeType?: string | null): string {
  const n = name || 'output';
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
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  const collapsed = useLayoutStore((s) => s.navCollapsed);
  const fullBleedMain = useLayoutStore((s) => s.fullBleedMain);
  const mobileDrawerOpen = useLayoutStore((s) => s.mobileDrawerOpen);
  const setMobileDrawerOpen = useLayoutStore((s) => s.setMobileDrawerOpen);
  const { isMobile } = useBreakpoint();
  const { navOrder, navHidden, loaded: navOrderLoaded, loadFromServer: loadNavOrder } = useNavOrderStore();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [notificationDialogOpen, setNotificationDialogOpen] = useState(false);
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  // 更新中心：未读数（用于桌面 dropdown 中的徽章）+ 拉取本周更新
  const changelogUnread = useChangelogStore(selectUnreadCount);
  const loadChangelogCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);
  useEffect(() => {
    void loadChangelogCurrentWeek();
  }, [loadChangelogCurrentWeek]);
  // 本会话已关闭的 toast id 黑名单：持久化到 sessionStorage，避免 polling/刷新后重复弹出
  const [dismissedToastIds, setDismissedToastIds] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem('dismissedToastIds');
      return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const [toastCollapsed, setToastCollapsed] = useState(false);
  const [toastHovering, setToastHovering] = useState(false);

  // ── 悬浮组整体折叠(联动 TipsDrawer 的「收起书 + 铃铛」把手) ──
  // TipsDrawer 通过 sessionStorage(FLOATING_DOCK_COLLAPSED_KEY) + FLOATING_DOCK_EVENT
  // 自定义事件广播状态;AppShell 订阅后把通知铃铛移到右边缘(只露半个,鼠标 hover 时滑回)。
  // 常量从 TipsDrawer 导入,避免两边字符串字面量漂移。
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(FLOATING_DOCK_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [dockEdgeHover, setDockEdgeHover] = useState(false);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ collapsed: boolean }>).detail;
      setDockCollapsed(!!detail?.collapsed);
    };
    window.addEventListener(FLOATING_DOCK_EVENT, onChange);
    return () => window.removeEventListener(FLOATING_DOCK_EVENT, onChange);
  }, []);
  useEffect(() => {
    if (!dockCollapsed) {
      setDockEdgeHover(false);
      return;
    }
    const onMove = (e: MouseEvent) => {
      const inZone =
        window.innerWidth - e.clientX < 140 &&
        window.innerHeight - e.clientY < 200;
      setDockEdgeHover(inZone);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [dockCollapsed]);


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

  // 加载 Agent Switcher 偏好（置顶 / 最近 / 常用）—— 换分支 / 浏览器也能恢复
  const loadAgentSwitcher = useAgentSwitcherStore((s) => s.loadFromServer);
  const agentSwitcherLoaded = useAgentSwitcherStore((s) => s.serverLoaded);
  useEffect(() => {
    if (!agentSwitcherLoaded && user?.userId) {
      void loadAgentSwitcher();
    }
  }, [agentSwitcherLoaded, user?.userId, loadAgentSwitcher]);

  // 从后端菜单目录生成导航项，按 group 分组
  // 只有带 group 字段的菜单项才在侧边栏显示
  const allCatalogItems: NavItem[] = useMemo(() => {
    if (!menuCatalogLoaded || !Array.isArray(menuCatalog) || menuCatalog.length === 0) {
      return [];
    }

    // 只显示有 group 的菜单项（无 group 的放在头像面板），并排除 HIDDEN_NAV_KEYS
    return menuCatalog
      .filter((m) => !!m.group && !HIDDEN_NAV_KEYS.has(m.appKey))
      .map((m) => {
        const IconComp = iconMap[m.icon] ?? LayoutDashboard;
        return {
          key: m.path,
          appKey: m.appKey,
          label: m.label,
          shortLabel: getShortLabel(m.appKey, m.label),
          icon: <IconComp size={18} />,
          description: m.description ?? undefined,
          group: m.group,
        };
      });
  }, [menuCatalog, menuCatalogLoaded]);

  // 过滤掉用户隐藏的项（隐藏 = 不在导航展示，但保留页面访问权）
  const visibleItems: NavItem[] = useMemo(() => {
    const hiddenSet = new Set(navHidden);
    return allCatalogItems.filter((it) => !hiddenSet.has(it.appKey));
  }, [allCatalogItems, navHidden]);

  // 首页独立项（不归属任何分组，始终可见，不参与用户自定义）
  const homeItem = useMemo(
    () => allCatalogItems.find((it) => it.group === 'home'),
    [allCatalogItems]
  );

  /**
   * 分组化的导航段（每段一块视觉区域，段之间渲染 1px 横杆）
   * - 有用户自定义 navOrder → 以其中的 "---" 分隔符切段，item 按数组顺序排列
   *   未在 navOrder 中出现的新 appKey 自动追加到末段（保证新功能上线不会"消失"）
   * - 无自定义 → 回退到后端 `group` 字段（effort/personal/admin）默认分段
   */
  const groupedNav = useMemo(() => {
    const NON_HOME = visibleItems.filter((it) => it.group !== 'home');

    // 用户自定义模式：按 navOrder 展开 + "---" 切段，不再显示分组标签（纯视觉横杆）
    if (navOrder.length > 0) {
      const byAppKey = new Map(NON_HOME.map((it) => [it.appKey, it]));
      // 从 launcher catalog 回退解析：支持用户从候选池拖进来的 toolbox/agent/utility 项
      // 这些 token 形如 "agent:xxx" / "toolbox:xxx" / "utility:xxx"
      const launcherById = new Map(
        getLauncherCatalog({ permissions, isRoot }).map((li) => [li.id, li])
      );
      // launcher 分支也要受 navHidden 约束，避免 "既在 navOrder 又在 navHidden" 的 launcher 条目穿透
      const hiddenSet = new Set(navHidden);
      const appeared = new Set<string>();
      const segments: { key: string; label?: string; items: NavItem[] }[] = [];
      let current: NavItem[] = [];
      let segIdx = 0;

      for (const token of navOrder) {
        if (token === NAV_DIVIDER_KEY) {
          if (current.length > 0) {
            segments.push({ key: `custom-${segIdx++}`, items: current });
            current = [];
          }
          continue;
        }
        if (appeared.has(token)) continue;
        if (hiddenSet.has(token)) continue;
        const item = byAppKey.get(token);
        if (item) {
          current.push(item);
          appeared.add(token);
          continue;
        }
        // Fallback：来自 launcher 目录的条目（agent:/toolbox:/utility: 前缀）
        // launcher 的 icon 名是前端自定义枚举，静态 iconMap 覆盖不全（如 Library/Sparkle/Video/Palette/PenTool/FileBarChart）
        // 走动态 lucide-react 命名空间查找，与 SettingsPage 的 getIcon 保持一致
        const li = launcherById.get(token);
        if (li) {
          const IconComp =
            iconMap[li.icon] ??
            ((LucideIcons as unknown as Record<string, LucideIcon | undefined>)[li.icon]) ??
            Cpu;
          current.push({
            key: li.route,
            appKey: li.id,
            label: li.name,
            shortLabel: getShortLabel(li.agentKey ?? li.id, li.name),
            icon: <IconComp size={18} />,
            description: li.description,
            group: null,
          });
          appeared.add(token);
        }
      }
      // 追加未出现过的 menuCatalog item（新功能上线兜底）
      for (const it of NON_HOME) {
        if (!appeared.has(it.appKey)) {
          current.push(it);
          appeared.add(it.appKey);
        }
      }
      if (current.length > 0) {
        segments.push({ key: `custom-${segIdx++}`, items: current });
      }
      return segments.filter((s) => s.items.length > 0);
    }

    // 默认模式：按后端 `group` 字段分段，保留分组标签
    return NAV_GROUPS
      .map((g) => ({
        key: g.key,
        label: g.label,
        items: NON_HOME.filter((it) => it.group === g.key),
      }))
      .filter((g) => g.items.length > 0);
  }, [visibleItems, navOrder, navHidden, permissions, isRoot]);
  
  // 首页为 Agent Launcher 沉浸页，不自动跳转，让用户自主选择 Agent
  const isHomePage = location.pathname === '/';

  const activeKey = location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;
  const isLabPage = location.pathname.startsWith('/lab');

  // 读取主题配置中的侧边栏玻璃效果设置
  const sidebarGlass = useThemeStore((s) => s.config.sidebarGlass);
  // 根据配置决定是否使用玻璃效果：always 始终启用，auto 仅实验室页面，never 禁用
  const useSidebarGlass = sidebarGlass === 'always' || (sidebarGlass === 'auto' && isLabPage);

  const asideWidth = collapsed ? 68 : 176;
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
      try {
        sessionStorage.setItem('dismissedToastIds', JSON.stringify(Array.from(next)));
      } catch {
        // sessionStorage 不可用时静默降级（保持内存态黑名单）
      }
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
    <div
      className="w-full relative overflow-hidden"
      style={{
        background: 'var(--bg-base)',
        // 移动端：用 dvh 跟随视口（修 iOS Safari 地址栏收缩导致的高度抖动 / 黑带）
        // 桌面端：保持 h:100% 依赖 #root，避免破坏现有侧栏/浮层布局
        minHeight: '100dvh',
        height: '100%',
      }}
    >
      <SystemDialogHost />
      <GlobalDefectSubmitDialog />
      <TipsDrawer />
      <CommandPalette />
      {/* 移动端顶栏已有 Bell 按钮，隐藏右下浮球避免和 MobileTabBar "+" 重叠 */}
      {!isMobile && toastNotification && (
        toastCollapsed ? (
          // 收缩状态：浮动按钮;如果悬浮组整体折叠了,这个按钮会跟着贴到屏幕右边缘
          <button
            type="button"
            className="fixed bottom-5 z-[120] h-12 w-12 rounded-full flex items-center justify-center transition-all duration-200 hover:scale-105"
            style={{
              ...glassFloatingButton,
              right: dockCollapsed ? (dockEdgeHover ? 12 : -20) : 20,
              opacity: dockCollapsed && !dockEdgeHover ? 0.6 : 1,
              background: 'var(--panel-solid, rgba(18, 18, 22, 0.92))',
              border: `1px solid ${getNotificationTone(toastNotification.level).border}`,
              transition: 'right 240ms cubic-bezier(.2,.8,.2,1), opacity 240ms ease-out, transform 180ms ease-out',
            }}
            onClick={() => {
              if (dockCollapsed) {
                // 用户点到贴边的铃铛 → 把整组召回(TipsDrawer 订阅该事件后会把
                // hiddenByUser 置 false,对应的 useEffect 会清理 sessionStorage)
                window.dispatchEvent(new CustomEvent(FLOATING_DOCK_EVENT, {
                  detail: { collapsed: false },
                }));
              }
              setToastCollapsed(false);
            }}
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
                  className="px-3 py-1.5 text-[12px] rounded-full transition-all hover:bg-white/15 active:scale-[0.97]"
                  style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-primary)' }}
                  onClick={() => handleNotification(toastNotification.id, toastNotification.actionUrl)}
                >
                  {toastNotification.actionLabel || '去处理'}
                </button>
              )}
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-full transition-all hover:brightness-110 active:scale-[0.97]"
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
      {/* 首页 (isHomePage) 做 Apple Today 式透明顶栏：
       *   - 左: menu 按钮
       *   - 中: 空
       *   - 右: 头像按钮（带通知红点）—— 点击 → /profile
       *   文字标题职责交给页面内 Hero */}
      {isMobile && (
        <header
          className="fixed top-0 left-0 right-0 z-100 flex items-center gap-3 px-4"
          style={{
            ...(isHomePage ? { background: 'transparent' } : glassMobileHeader),
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
          {!isHomePage && (
            <div className="flex-1 min-w-0 text-center">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {visibleItems.find((it) => it.key === activeKey)?.label || 'PRD Agent'}
              </span>
            </div>
          )}
          {isHomePage && <div className="flex-1" />}
          {!isHomePage && <ChangelogBell size={18} compact />}
          {!isHomePage && (
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
          )}
          {/* 首页右上角头像按钮 —— Apple Today 范式 */}
          {isHomePage && (
            <button
              type="button"
              onClick={() => navigate('/profile')}
              className="relative h-9 w-9 inline-flex items-center justify-center rounded-full overflow-hidden transition-opacity active:opacity-60"
              style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)', padding: 0 }}
              aria-label="个人中心"
            >
              {user?.avatarUrl || user?.avatarFileName ? (
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
              ) : (
                <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {(user?.displayName || user?.username || '?')[0]}
                </span>
              )}
              {notificationCount > 0 && (
                <span
                  className="absolute"
                  style={{
                    top: -2,
                    right: -2,
                    minWidth: 16,
                    height: 16,
                    padding: '0 4px',
                    borderRadius: 999,
                    background: '#FF453A',
                    color: '#fff',
                    fontSize: 9,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '2px solid #000',
                    lineHeight: 1,
                  }}
                >
                  {notificationCount > 9 ? '9+' : notificationCount}
                </span>
              )}
            </button>
          )}
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
                {group.label && (
                  <div
                    className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase select-none"
                    style={{ color: 'var(--text-muted, rgba(255,255,255,0.32))' }}
                  >
                    {group.label}
                  </div>
                )}
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
              onClick={() => {
                useAgentSwitcherStore.getState().resetServerSync();
                logout();
                setMobileDrawerOpen(false);
                navigate('/login', { replace: true });
              }}
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
          {/* ── 顶部 Logo 区域 ── */}
          <div
            className={cn(
              'shrink-0 flex items-center',
              collapsed ? 'justify-center py-2' : 'px-3 py-2'
            )}
          >
            <img
              src="/favicon.png"
              alt="Logo"
              className={cn('transition-all duration-200', collapsed ? 'w-7 h-7' : 'w-8 h-8')}
              draggable={false}
            />
          </div>

          {/* ── 首页按钮 ── */}
          {homeItem && (
            <div className="flex justify-center px-1">
              <button
                type="button"
                onClick={() => navigate(homeItem.key)}
                className={cn(
                  'group/nav relative flex flex-col items-center justify-center gap-0 w-full',
                  'transition-all duration-200 ease-out rounded-[14px]',
                  activeKey !== '/' && 'nav-item-hover'
                )}
                style={{
                  color: activeKey === '/' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  width: 56,
                  padding: '6px 0 4px',
                  background: activeKey === '/' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                  border: activeKey === '/' ? '1px solid rgba(255, 255, 255, 0.10)' : '1px solid transparent',
                }}
                title={homeItem.label}
              >
                <span
                  className={cn(
                    'inline-flex items-center justify-center shrink-0 transition-all duration-200 group-hover/nav:scale-105',
                  )}
                  style={{
                    width: 28,
                    height: 28,
                    color: activeKey === '/' ? '#818cf8' : undefined,
                  }}
                >
                  {homeItem.icon}
                </span>
                <span className="text-[10px] leading-tight mt-0.5" style={{ color: activeKey === '/' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  首页
                </span>
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
                'h-full flex flex-col overflow-y-auto overflow-x-hidden nav-scroll-hidden',
                collapsed ? 'items-center' : ''
              )}
              style={{ paddingTop: 4, paddingRight: collapsed ? 0 : 2, paddingBottom: 8 }}
            >
              {groupedNav.map((group, gi) => (
                <div key={group.key}>
                  {/* 分组分隔线（非首组）— 组间距比组内间距更大 */}
                  {gi > 0 && (
                    <div
                      className={cn('mx-auto', collapsed ? 'my-4' : 'my-5 mx-3')}
                      style={{
                        height: 1,
                        background: collapsed
                          ? 'rgba(255, 255, 255, 0.06)'
                          : 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.08) 80%, transparent 100%)',
                        width: collapsed ? 24 : undefined,
                      }}
                    />
                  )}

                  {/* 分组标题（仅展开时显示；自定义导航模式下 group.label 为空，不渲染） */}
                  {!collapsed && group.label && (
                    <div
                      className="px-2.5 pt-1 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase select-none"
                      style={{ color: 'var(--text-muted, rgba(255,255,255,0.32))' }}
                    >
                      {group.label}
                    </div>
                  )}

                  {/* 分组内的导航项 */}
                  <div className="flex flex-col gap-0.5 items-center px-1">
                    {group.items.map((it) => {
                      const active = it.key === activeKey;
                      return (
                        <button
                          key={it.key}
                          type="button"
                          onClick={() => navigate(it.key)}
                          className={cn(
                            'group/nav relative flex flex-col items-center justify-center gap-0 w-full',
                            'transition-all duration-200 ease-out rounded-[14px]',
                            !active && 'nav-item-hover'
                          )}
                          style={{
                            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                            width: 56,
                            padding: '6px 0 4px',
                            background: active ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                            border: active ? '1px solid rgba(255, 255, 255, 0.10)' : '1px solid transparent',
                          }}
                          title={it.description ? `${it.label} - ${it.description}` : it.label}
                        >
                          {/* 图标容器 */}
                          <span
                            className={cn(
                              'inline-flex items-center justify-center shrink-0 transition-all duration-200 group-hover/nav:scale-105',
                            )}
                            style={{
                              width: 28,
                              height: 28,
                              color: active ? '#818cf8' : undefined,
                            }}
                          >
                            {it.icon}
                          </span>
                          <span className="text-[10px] leading-tight text-center mt-0.5" style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                            {it.shortLabel}
                          </span>
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

          {/* ── 底部用户区域 ── */}
          <div
            className={cn(
              'shrink-0',
              collapsed ? 'flex flex-col items-center gap-1 py-1' : 'px-1 py-1'
            )}
          >
            {/* 分隔线 */}
            <div
              className={cn('mx-auto mb-2', collapsed ? '' : 'mx-3')}
              style={{
                height: 1,
                background: collapsed
                  ? 'rgba(255, 255, 255, 0.06)'
                  : 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.08) 80%, transparent 100%)',
                width: collapsed ? 24 : undefined,
              }}
            />
            <div
              className={cn(
                'group relative shrink-0 rounded-[10px]',
                collapsed ? 'w-[38px] flex justify-center' : 'px-2 py-1.5'
              )}
              style={{ background: 'transparent' }}
            >
              {/* 悬停背景效果 */}
              <div
                className="absolute inset-0 rounded-[10px] opacity-0 group-hover:opacity-100 transition-opacity duration-200"
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
                        className="h-7 w-7 rounded-full overflow-hidden shrink-0 ring-1 ring-white/10 hover:ring-indigo-400/30 transition-colors duration-200"
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
                        </div>
                      )}
                    </div>
                  </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[220px] rounded-[16px] p-2 z-50"
                style={glassPanel}
                sideOffset={8}
                side="top"
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

                {/* 我的空间：顶部入口。账户管理已合并到 /settings?tab=account，不再出现在此菜单 */}
                <DropdownMenu.Item
                  className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer outline-none transition-colors hover:bg-white/6"
                  style={{ color: 'var(--text-secondary)' }}
                  onSelect={() => navigate('/settings?tab=user-space')}
                >
                  <Sparkles size={16} className="shrink-0" />
                  <span className="text-[13px]">我的空间</span>
                  <span
                    className="ml-auto text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    常用 / 最近 / 置顶
                  </span>
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
                  onSelect={() => navigate('/changelog')}
                >
                  <Sparkles size={16} className="shrink-0" />
                  <span className="text-[13px]">更新中心</span>
                  {changelogUnread > 0 && (
                    <span
                      className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold"
                      style={{ background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.32), rgba(249, 115, 22, 0.32))', color: '#fbbf24' }}
                    >
                      {changelogUnread > 9 ? '9+' : changelogUnread}
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

                {/* 注意：工具类菜单项（网页托管/知识库/涌现/提示词/实验室/自动化/快捷指令/PR 审查/请求日志 等）
                    已从用户菜单移除。它们的入口现在是：
                    - 首页「实用工具」区（AgentLauncherPage staticUtilities）
                    - 百宝箱 BUILTIN_TOOLS
                    - Cmd/Ctrl + K 命令面板（Agent / 工具 / 实用工具 统一搜索）
                    原则：用户菜单只保留「账户 + 系统 + 我的空间 + 退出」四类，不承载工具导航。 */}

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
                  onSelect={() => {
                    useAgentSwitcherStore.getState().resetServerSync();
                    logout();
                    navigate('/login', { replace: true });
                  }}
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
          </div>

          {/* 底部间距 */}
          <div className="shrink-0 h-1" />

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
                    className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] transition-all hover:bg-white/15 active:scale-[0.97]"
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
                        {/* 窄屏竖排（移动端 / 窄浏览器），宽屏水平分栏；按钮列 shrink-0 + 按钮文字 whitespace-nowrap，防止被挤成竖排单字 */}
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                          <div className="min-w-0 flex-1">
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
                          <div className="shrink-0 flex flex-row sm:flex-col items-stretch sm:items-end gap-2">
                            {item.actionUrl && (
                              <button
                                type="button"
                                className="rounded-full px-3 py-1.5 text-[12px] whitespace-nowrap transition-all hover:bg-white/20 active:scale-[0.97]"
                                style={{ background: 'rgba(255, 255, 255, 0.15)', color: 'var(--text-primary)' }}
                                onClick={() => handleNotification(item.id, item.actionUrl)}
                              >
                                {item.actionLabel || '去处理'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="rounded-full px-3 py-1.5 text-[12px] whitespace-nowrap transition-all hover:brightness-110 active:scale-[0.97]"
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
            <div className="flex-1 min-h-0 relative">
              {/* 移动端兼容门槛：根据路由显示 banner / 模态，非阻断式 */}
              {isMobile && <MobileCompatGate pathname={location.pathname} />}
              {/* ErrorBoundary：渲染异常时显示友好错误 + 重试，避免整棵树卸载成纯黑 */}
              <MobileSafeBoundary resetKey={location.pathname}>
                <Suspense fallback={<InlinePageLoader />}>
                  <Outlet />
                </Suspense>
              </MobileSafeBoundary>
              {/* 每日小贴士跳转后的 DOM 脉冲光圈 —— 单例,不用 key 绑 pathname。
                  路由切换时 SpotlightOverlay 自己在 readAndStart() 里重置 state;
                  保持单实例才能让 Play 按钮(写 sessionStorage → navigate)的
                  payload 在 mount 周期里稳定地被消费(历史 key={pathname}
                  导致路由切换时 overlay unmount 丢 state,Play 按钮失效)。 */}
              <SpotlightOverlay />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
