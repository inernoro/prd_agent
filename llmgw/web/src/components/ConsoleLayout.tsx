import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, BookOpen, Boxes, Building2, ChevronDown, CircleDollarSign, Cpu, FileClock, Layers3,
  Check, ExternalLink, GitCompare, KeyRound, LayoutDashboard, LogOut, Menu, Moon, Search, Server, Settings,
  ShieldCheck, Shuffle, Sun, Tags, X,
} from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { getAvailableTenants, setSession, switchTenant } from '@/lib/api';
import type { AvailableTenant } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { canAccessPage, canUseCapability, type ConsolePage } from '@/lib/access';
import { useThemePreference } from '@/lib/theme';
import { resolveMapHomeHref } from '@/lib/mapNavigation';

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
    { to: '/settings', label: '控制台设置', icon: <Settings size={16} />, page: 'settings' },
  ] },
];

export function ConsoleLayout() {
  const { user, tenant, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
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

  return (
    <div className="lg-console-shell">
      <header className="lg-console-header">
        <div className="lg-console-brand">
          <button className="lg-mobile-menu-button" type="button" aria-label="打开导航" onClick={() => setMobileOpen(true)}><Menu size={18} /></button>
          <span className="lg-brand-mark"><Activity size={17} /></span>
          <span>LLM Gateway</span>
        </div>

        <details className="lg-tenant-switcher">
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
            <NavLink to="/organization"><Building2 size={14} /><span>管理团队与成员</span></NavLink>
          </div>
        </details>

        {canSearchRequests ? <form className="lg-global-search" role="search" onSubmit={submitSearch}>
          <Search size={15} />
          <input aria-label="按 requestId 搜索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="按 requestId 定位请求" />
          <kbd>Enter</kbd>
          <button type="submit" aria-label="搜索请求"><Search size={14} /></button>
        </form> : <div className="lg-global-search" aria-label="当前角色不提供请求搜索"><Search size={15} /><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>当前角色仅查看用量</span></div>}

        <div className="lg-header-actions">
          <NavLink className="lg-header-link" to="/learn"><BookOpen size={15} /><span>文档</span></NavLink>
          <details className="lg-user-menu">
            <summary aria-label="打开用户菜单"><span>{who.slice(0, 1).toUpperCase()}</span><strong>{who}</strong><ChevronDown size={13} /></summary>
            <div className="lg-user-popover">
              <div><strong>{who}</strong><small>{tenant?.name ?? '当前租户'} · {tenant?.role ?? 'member'}</small></div>
              {user?.identityProvider === 'map' ? (
                <button type="button" onClick={() => window.location.assign(resolveMapHomeHref())}>
                  <Activity size={15} />返回 MAP<ExternalLink className="lg-user-menu-end-icon" size={14} />
                </button>
              ) : null}
              <button type="button" onClick={toggleTheme}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}{theme === 'dark' ? '切换浅色' : '切换深色'}</button>
              <button type="button" onClick={logout}><LogOut size={15} />退出登录</button>
            </div>
          </details>
        </div>
      </header>

      <div className="lg-console-body">
        {mobileOpen ? <button className="lg-sidebar-backdrop" type="button" aria-label="关闭导航" onClick={() => setMobileOpen(false)} /> : null}
        <aside className={`lg-console-sidebar${mobileOpen ? ' is-open' : ''}`} aria-label="主导航">
          <div className="lg-sidebar-mobile-heading"><span>导航</span><button type="button" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><X size={18} /></button></div>
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
        </aside>
        <main className="lg-console-content"><Outlet /></main>
      </div>
    </div>
  );
}
