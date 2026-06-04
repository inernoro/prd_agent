/**
 * 产品管理智能体 — 共享左侧导航布局（管理层总览 / 单产品视图 两级复用）。
 *
 * 全屏 app 自带左侧持久导航栏 + 右侧主内容区。深色 + 青色强调，当前项高亮。
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem<K extends string = string> {
  key: K;
  label: string;
  icon: LucideIcon;
  hidden?: boolean;
  /** 分隔线（在该项之前画一条分隔） */
  dividerBefore?: boolean;
}

export function ProductAgentLayout<K extends string>({
  title,
  subtitle,
  topSlot,
  items,
  active,
  onSelect,
  children,
}: {
  title: string;
  subtitle?: string;
  topSlot?: ReactNode;
  items: NavItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  children: ReactNode;
}) {
  return (
    <div className="h-screen min-h-0 flex bg-[#0f1014]">
      {/* 左侧导航 */}
      <aside className="w-52 shrink-0 flex flex-col border-r border-white/10 bg-[#121317]">
        <div className="px-4 py-4 border-b border-white/10 shrink-0">
          {topSlot}
          <div className="text-white font-semibold truncate">{title}</div>
          {subtitle && <div className="text-[11px] text-white/40 mt-0.5 truncate">{subtitle}</div>}
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5" style={{ overscrollBehavior: 'contain' }}>
          {items
            .filter((it) => !it.hidden)
            .map((it) => {
              const Icon = it.icon;
              const isActive = it.key === active;
              return (
                <div key={it.key}>
                  {it.dividerBefore && <div className="my-1.5 mx-2 border-t border-white/10" />}
                  <button
                    onClick={() => onSelect(it.key)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors border-l-2 ${
                      isActive
                        ? 'bg-cyan-500/10 text-white border-cyan-400'
                        : 'text-white/55 hover:text-white hover:bg-white/5 border-transparent'
                    }`}
                  >
                    <Icon size={16} className="shrink-0" style={isActive ? { color: '#22D3EE' } : undefined} />
                    <span className="truncate">{it.label}</span>
                  </button>
                </div>
              );
            })}
        </nav>
      </aside>

      {/* 主内容 */}
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</main>
    </div>
  );
}

/** 区块容器：标题栏 + 可滚动内容（统一各 section 的页头与留白）。 */
export function SectionShell({
  title,
  desc,
  actions,
  children,
}: {
  title: string;
  desc?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-b border-white/10">
        <div>
          <h2 className="text-base font-semibold text-white">{title}</h2>
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
