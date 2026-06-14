/**
 * Agent 全屏布局 — 左侧持久导航栏 + 右侧主内容区（跨智能体共享）。
 *
 * 由 product-agent 的 ProductAgentLayout 抽取而来，供产品管理 / 项目管理等
 * 全屏智能体复用。深色画布，强调色可按智能体定制（产品=青色，项目=蓝色）。
 */
import { useState, type ReactNode } from 'react';
import { formatListSectionTitle } from '@/lib/listSectionTitle';
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react';
import { SystemDialogHost } from '@/components/ui/SystemDialogHost';

export interface NavItem<K extends string = string> {
  key: K;
  label: string;
  icon: LucideIcon;
  hidden?: boolean;
  /** 分隔线（在该项之前画一条分隔） */
  dividerBefore?: boolean;
  /** 分隔线上方显示的组标题（如「应用」） */
  groupLabel?: string;
}

export function AgentFullscreenLayout<K extends string>({
  title,
  subtitle,
  topSlot,
  items,
  active,
  onSelect,
  accent = '#22D3EE',
  children,
}: {
  title: string;
  subtitle?: string;
  topSlot?: ReactNode;
  items: NavItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  /** 强调色（当前导航项高亮），默认青色 */
  accent?: string;
  children: ReactNode;
}) {
  // 左侧导航可收起（释放横向空间）；纯 UI 偏好，sessionStorage 持久化（遵守 no-localstorage）
  const [collapsed, setCollapsed] = useState(() => sessionStorage.getItem('agent-nav-collapsed') === '1');
  const toggleCollapsed = () => setCollapsed((v) => {
    const next = !v;
    sessionStorage.setItem('agent-nav-collapsed', next ? '1' : '0');
    return next;
  });

  return (
    <div className="h-screen min-h-0 flex bg-[#0f1014]">
      {/* 左侧导航（可收起为图标条） */}
      <aside className={`${collapsed ? 'w-14' : 'w-52'} shrink-0 flex flex-col border-r border-white/10 bg-[#121317] transition-[width] duration-150`}>
        <div className={`${collapsed ? 'px-2' : 'px-4'} py-4 border-b border-white/10 shrink-0`}>
          {!collapsed && topSlot}
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between gap-2'}`}>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-white font-semibold truncate">{title}</div>
                {subtitle && <div className="text-[11px] text-white/40 mt-0.5 truncate">{subtitle}</div>}
              </div>
            )}
            <button
              onClick={toggleCollapsed}
              title={collapsed ? '展开导航' : '收起导航'}
              className="p-1.5 rounded hover:bg-white/10 text-white/50 hover:text-white shrink-0"
            >
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5" style={{ overscrollBehavior: 'contain' }}>
          {items
            .filter((it) => !it.hidden)
            .map((it) => {
              const Icon = it.icon;
              const isActive = it.key === active;
              return (
                <div key={it.key}>
                  {it.dividerBefore && (
                    (it.groupLabel && !collapsed) ? (
                      <div className="px-3 pt-3 pb-1 text-[11px] font-medium text-white/40">{it.groupLabel}</div>
                    ) : (
                      <div className="my-1.5 mx-2 border-t border-white/10" />
                    )
                  )}
                  <button
                    onClick={() => onSelect(it.key)}
                    title={collapsed ? it.label : undefined}
                    className={`w-full flex items-center ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-3'} py-2 rounded-lg text-sm transition-colors border-l-2 ${
                      isActive ? 'text-white' : 'text-white/55 hover:text-white hover:bg-white/5 border-transparent'
                    }`}
                    style={isActive ? { borderLeftColor: accent, background: `${accent}1A` } : undefined}
                  >
                    <Icon size={16} className="shrink-0" style={isActive ? { color: accent } : undefined} />
                    {!collapsed && <span className="truncate">{it.label}</span>}
                  </button>
                </div>
              );
            })}
        </nav>
      </aside>

      {/* 主内容 */}
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</main>

      {/* 全屏布局不经 AppShell，需自挂确认/提示弹窗宿主（systemDialog 才能在本页生效） */}
      <SystemDialogHost />
    </div>
  );
}

/** 区块容器：标题栏 + 可滚动内容（统一各 section 的页头与留白）。 */
export function SectionShell({
  title,
  desc,
  actions,
  count,
  children,
}: {
  title: string;
  desc?: string;
  actions?: ReactNode;
  /** 当前列表真实条数；传入后在标题后展示「（N）」 */
  count?: number;
  children: ReactNode;
}) {
  const displayTitle = count == null ? title : formatListSectionTitle(title, count);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-b border-white/10">
        <div>
          <h2 className="text-base font-semibold text-white">{displayTitle}</h2>
          {desc && <p className="text-xs text-white/40 mt-0.5">{desc}</p>}
        </div>
        {actions}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-6" style={{ overscrollBehavior: 'contain' }}>
        {children}
      </div>
    </div>
  );
}
