import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, BookOpen, Boxes, Bug, Building2, ChevronDown, CircleDollarSign, Cpu, FileClock, Layers3,
  Check, ExternalLink, GitCompare, KeyRound, LayoutDashboard, LogOut, Menu, Moon, Search, Server, Settings, SlidersHorizontal,
  ShieldCheck, Shuffle, Sun, Tags, UserRound, X,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { OPEN_BUG_REPORT_EVENT } from '@/components/BugReportDialog';
import { shortcutHint } from '@/components/BugReportCore';
import { getAvailableTenants, setSession, switchTenant } from '@/lib/api';
import type { AvailableTenant } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { canAccessPage, canUseCapability, type ConsolePage } from '@/lib/access';
import { useThemePreference } from '@/lib/theme';
import { canOpenTutorials, resolveMapHomeHref, resolveTutorialHref, usePlatformMapHome } from '@/lib/mapNavigation';

type NavItem = { to: string; label: string; icon: ReactNode; page: ConsolePage; end?: boolean };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  { label: '工作区', items: [
    { to: '/', label: '概览', icon: <LayoutDashboard size={16} />, page: 'home', end: true },
    { to: '/logs', label: '请求记录', icon: <Activity size={16} />, page: 'logs' },
    { to: '/app-callers', label: 'appCaller', icon: <Tags size={16} />, page: 'appCallers' },
  ] },
  { label: '路由', items: [
    { to: '/logical-models', label: '逻辑模型', icon: <Layers3 size={16} />, page: 'routeConfig' },
    { to: '/pools', label: '模型池', icon: <Boxes size={16} />, page: 'routeConfig' },
    { to: '/platforms', label: 'Provider', icon: <Server size={16} />, page: 'routeConfig' },
    { to: '/models', label: '模型', icon: <Cpu size={16} />, page: 'routeConfig' },
    { to: '/exchanges', label: 'Exchange', icon: <Shuffle size={16} />, page: 'routeConfig' },
  ] },
  { label: '开发者', items: [
    { to: '/quickstart', label: 'Quickstart', icon: <BookOpen size={16} />, page: 'quickstart' },
    { to: '/service-keys', label: '接入密钥', icon: <KeyRound size={16} />, page: 'serviceKeys' },
    { to: '/learn', label: '学习中心', icon: <BookOpen size={16} />, page: 'learn' },
  ] },
  { label: '组织', items: [
    { to: '/organization', label: '团队与成员', icon: <Building2 size={16} />, page: 'organization' },
  ] },
  { label: '治理', items: [
    { to: '/usage', label: '预算与用量', icon: <CircleDollarSign size={16} />, page: 'usage' },
    { to: '/audits', label: '审计', icon: <FileClock size={16} />, page: 'audits' },
    { to: '/shadow', label: '影子对比', icon: <GitCompare size={16} />, page: 'shadow' },
    { to: '/governance', label: '系统运维', icon: <ShieldCheck size={16} />, page: 'governance' },
  ] },
  { label: '设置', items: [
    // 服务网关设置排在控制台设置之前：它管的是「网关自己怎么调模型」，
    // 比个人偏好更常被找（401 类问题的唯一自救入口就在这一页）。
    { to: '/gateway-settings', label: '服务网关设置', icon: <SlidersHorizontal size={16} />, page: 'gatewaySettings' },
    { to: '/settings', label: '控制台设置', icon: <Settings size={16} />, page: 'settings' },
  ] },
];

export function ConsoleLayout() {
  const { user, tenant, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [tenants, setTenants] = useState<AvailableTenant[]>([]);
  const [switching, setSwitching] = useState(false);
  const { resolved: theme, setPreference: setTheme } = useThemePreference();
  const who = user?.displayName || user?.username || '已登录';
  const navGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canAccessPage(tenant, item.page)),
  })).filter((group) => group.items.length > 0);
  const canSearchRequests = canUseCapability(tenant?.role, 'logsRead');
  // 判定与拼接都收在 lib/mapNavigation —— 页面里的 TutorialLink 走同一份实现，
  // 不再各拼各的（否则改一处漏一处）。
  // 订阅平台下发的 MAP 主入口：healthz 通常在首屏之后才回来，不订阅就一直用兜底算出的 href。
  usePlatformMapHome();
  const canOpenMapTutorials = canOpenTutorials(user, tenant);
  const mapTutorialHref = resolveTutorialHref(location.pathname);
  const bugShortcutHint = shortcutHint(typeof navigator === 'undefined' ? undefined : navigator.userAgent);

  useEffect(() => {
    getAvailableTenants().then((res) => {
      if (res.success) setTenants(res.data ?? []);
    });
  }, []);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const query = search.trim();
    if (!query) return;
    navigate(`/logs?requestId=${encodeURIComponent(query)}`);
    setMobileOpen(false);
    setMobileSearchOpen(false);
  }

  async function changeTenant(tenantId: string) {
    if (!tenantId || tenantId === tenant?.id || switching) return;
    setSwitching(true);
    const res = await switchTenant(tenantId);
    if (res.success) {
      setSession(res.data);
      window.location.reload();
      return;
    }
    setSwitching(false);
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }

  function renderTenantSwitcher(className: string) {
    return (
      <details className={`lg-tenant-switcher ${className}`}>
        <summary aria-label="切换组织" aria-busy={switching}>
          <Building2 size={14} />
          <span><small>组织</small><strong>{tenant?.name ?? tenants.find((item) => item.current)?.name ?? '当前组织'}</strong></span>
          <ChevronDown size={13} />
        </summary>
        <div className="lg-tenant-popover">
          <header><strong>组织</strong><span>隔离成员、密钥、路由、预算与日志</span></header>
          <div role="menu" aria-label="可用组织">
            {(tenants.length > 0 ? tenants : [{
              id: tenant?.id ?? '',
              name: tenant?.name ?? '当前组织',
              slug: '',
              role: tenant?.role ?? 'member',
              current: true,
            }]).map((item) => {
              const selected = item.id === tenant?.id || item.current;
              return (
                <button key={item.id || item.name} type="button" role="menuitemradio" aria-checked={selected} disabled={switching} onClick={() => void changeTenant(item.id)}>
                  <span><strong>{item.name}</strong><small>{item.role}</small></span>
                  {selected ? <Check size={15} /> : null}
                </button>
              );
            })}
          </div>
          <NavLink to="/organization" onClick={() => setMobileOpen(false)}><Building2 size={14} /><span>管理团队与成员</span></NavLink>
        </div>
      </details>
    );
  }

  return (
    <div className="lg-console-shell">
      <header className="lg-console-header">
        <div className="lg-console-brand">
          <button className="lg-mobile-menu-button" type="button" aria-label="打开导航" onClick={() => setMobileOpen(true)}><Menu size={18} /></button>
          <span className="lg-brand-mark"><Activity size={17} /></span>
          <span>LLM Gateway</span>
        </div>

        {renderTenantSwitcher('lg-desktop-tenant-switcher')}

        {canSearchRequests ? <form className="lg-global-search" role="search" onSubmit={submitSearch}>
          <Search size={15} />
          <input aria-label="按 requestId 搜索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="按 requestId 定位请求" />
          <kbd>Enter</kbd>
          <button type="submit" aria-label="搜索请求"><Search size={14} /></button>
        </form> : <div className="lg-global-search" aria-label="当前角色不提供请求搜索"><Search size={15} /><span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-caption)' }}>当前角色仅查看用量</span></div>}

        <div className="lg-header-actions">
          {canSearchRequests ? (
            <button
              className="lg-mobile-search-button"
              type="button"
              aria-label={mobileSearchOpen ? '关闭请求搜索' : '搜索请求'}
              aria-expanded={mobileSearchOpen}
              onClick={() => setMobileSearchOpen((open) => !open)}
            >
              {mobileSearchOpen ? <X size={18} /> : <Search size={18} />}
            </button>
          ) : null}
          {canOpenMapTutorials ? <a className="lg-header-link" href={mapTutorialHref}><BookOpen size={15} /><span>相关教程</span><ExternalLink size={12} /></a> : null}
          <NavLink className="lg-header-link" to="/learn"><BookOpen size={15} /><span>文档</span></NavLink>
          <details className="lg-user-menu">
            <summary aria-label="打开用户菜单"><span>{who.slice(0, 1).toUpperCase()}</span><strong>{who}</strong><ChevronDown size={13} /></summary>
            <div className="lg-user-popover">
              <div><strong>{who}</strong><small>{tenant?.name ?? '当前租户'} · {tenant?.role ?? 'member'}</small></div>
              {canOpenMapTutorials ? (
                <a href={mapTutorialHref}>
                  <BookOpen size={15} />相关教程<ExternalLink className="lg-user-menu-end-icon" size={14} />
                </a>
              ) : null}
              {user?.identityProvider === 'map' ? (
                <button type="button" onClick={() => window.location.assign(resolveMapHomeHref())}>
                  <Activity size={15} />返回 MAP<ExternalLink className="lg-user-menu-end-icon" size={14} />
                </button>
              ) : null}
              {/* 断头修复：此前菜单里没有任何入口能设置网关口令，一键登录进来的人
                  既不知道自己的登录名，也无处改密。这一项对所有角色常驻。 */}
              <NavLink to="/account"><UserRound size={15} />账号与安全</NavLink>
              <button type="button" onClick={toggleTheme}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}{theme === 'dark' ? '切换浅色' : '切换深色'}</button>
              <button type="button" onClick={logout}><LogOut size={15} />退出登录</button>
            </div>
          </details>
        </div>
        {canSearchRequests && mobileSearchOpen ? (
          <form className="lg-mobile-search-panel" role="search" onSubmit={submitSearch}>
            <Search size={17} />
            <input
              aria-label="按 requestId 搜索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="输入 requestId"
              autoFocus
            />
            <button type="submit">查找</button>
          </form>
        ) : null}
      </header>

      <div className="lg-console-body">
        {mobileOpen ? <button className="lg-sidebar-backdrop" type="button" aria-label="关闭导航" onClick={() => setMobileOpen(false)} /> : null}
        <aside className={`lg-console-sidebar${mobileOpen ? ' is-open' : ''}`} aria-label="主导航">
          <div className="lg-sidebar-mobile-heading"><span>导航</span><button type="button" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><X size={18} /></button></div>
          {renderTenantSwitcher('lg-mobile-tenant-switcher')}
          <nav>
            {navGroups.map((group) => (
              <div className="lg-nav-group" key={group.label}>
                <div className="lg-nav-group-label">{group.label}</div>
                {group.items.map((item) => (
                  <NavLink key={`${group.label}:${item.to}:${item.label}`} to={item.to} end={item.end} onClick={() => setMobileOpen(false)} className={({ isActive }) => isActive ? 'is-active' : undefined}>
                    {item.icon}<span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          {/* 提交缺陷是全局动作，位置在导航壳里而不是浮在内容之上。
              此前它是右下角 position:fixed 的 FAB，会盖住页面底部那一行按钮，
              于是 .lg-console-content 被迫给它常留 72px 净空——「浮层」反而
              在每一页占掉一条横带。移进这里之后那条净空已删除。 */}
          <div className="lg-sidebar-footer">
            <button
              type="button"
              aria-label={`提交缺陷，快捷键 ${bugShortcutHint}`}
              onClick={() => {
                setMobileOpen(false);
                window.dispatchEvent(new Event(OPEN_BUG_REPORT_EVENT));
              }}
            >
              <Bug size={16} /><span>提交缺陷</span><kbd>{bugShortcutHint}</kbd>
            </button>
          </div>
        </aside>
        <main className="lg-console-content"><Outlet /></main>
      </div>
    </div>
  );
}
