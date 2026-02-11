import { useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import {
  Home,
  Compass,
  Plus,
  FolderOpen,
  UserCircle,
  MessageSquare,
  Image,
  PenLine,
  Bug,
  type LucideIcon,
} from 'lucide-react';
import { BottomSheet } from './BottomSheet';

/* ── Agent 快捷入口定义 ── */
interface AgentShortcut {
  key: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
  path: string;
  color: string;       // 图标主色
  glowColor: string;   // 发光色
}

const AGENT_SHORTCUTS: AgentShortcut[] = [
  {
    key: 'prd-agent',
    label: 'PRD Agent',
    subtitle: '智能解读与问答',
    icon: MessageSquare,
    path: '/prd-agent',
    color: 'rgba(129, 140, 248, 0.95)',
    glowColor: 'rgba(129, 140, 248, 0.3)',
  },
  {
    key: 'visual-agent',
    label: '视觉创作',
    subtitle: '高级视觉工作区',
    icon: Image,
    path: '/visual-agent',
    color: 'rgba(251, 146, 60, 0.95)',
    glowColor: 'rgba(251, 146, 60, 0.3)',
  },
  {
    key: 'literary-agent',
    label: '文学创作',
    subtitle: '文章配图与创作',
    icon: PenLine,
    path: '/literary-agent',
    color: 'rgba(52, 211, 153, 0.95)',
    glowColor: 'rgba(52, 211, 153, 0.3)',
  },
  {
    key: 'defect-agent',
    label: '缺陷管理',
    subtitle: '提交与跟踪',
    icon: Bug,
    path: '/defect-agent',
    color: 'rgba(248, 113, 113, 0.95)',
    glowColor: 'rgba(248, 113, 113, 0.3)',
  },
];

/* ── 底部5个固定Tab ── */
interface FixedTab {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;           // 路由路径（center 无路由）
  matchPrefix?: string;   // active 匹配前缀
  exactMatch?: boolean;   // 是否精确匹配（首页需要）
  isCenter?: boolean;     // 中间 + 按钮
}

const FIXED_TABS: FixedTab[] = [
  { key: 'home',    label: '首页', icon: Home,       path: '/',             matchPrefix: '/', exactMatch: true },
  { key: 'explore', label: '浏览', icon: Compass,    path: '/ai-toolbox',   matchPrefix: '/ai-toolbox' },
  { key: 'create',  label: '',     icon: Plus,        path: '',              isCenter: true },
  { key: 'assets',  label: '资产', icon: FolderOpen,  path: '/my-assets',    matchPrefix: '/my-assets' },
  { key: 'me',      label: '我的', icon: UserCircle,  path: '/profile',      matchPrefix: '/profile' },
];

interface MobileTabBarProps {
  className?: string;
}

/**
 * 移动端底部 Tab 导航栏 — 5 固定 Tab。
 *
 * | 首页 | 浏览 | + | 资产 | 我的 |
 *
 * 中间 "+" 弹出 Agent 快捷面板（BottomSheet），其余 4 个为路由导航。
 */
export function MobileTabBar({ className }: MobileTabBarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleAgentSelect = useCallback((path: string) => {
    setSheetOpen(false);
    navigate(path);
  }, [navigate]);

  return (
    <>
      <nav
        className={cn('fixed left-0 right-0 bottom-0 z-100', className)}
        style={{
          height: 'calc(var(--mobile-tab-height, 60px) + env(safe-area-inset-bottom, 0px))',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* 玻璃底座 */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(0deg, rgba(10, 10, 14, 0.97) 0%, rgba(16, 16, 22, 0.92) 100%)',
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            backdropFilter: 'blur(48px) saturate(200%)',
            WebkitBackdropFilter: 'blur(48px) saturate(200%)',
          }}
        />
        {/* 顶部高光线 */}
        <div
          className="absolute top-0 left-[12%] right-[12%] h-px"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.10) 30%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.10) 70%, transparent 100%)',
          }}
        />

        {/* 5 Tabs */}
        <div className="relative h-[var(--mobile-tab-height,60px)] flex items-stretch">
          {FIXED_TABS.map((tab) => {
            const prefix = tab.matchPrefix ?? tab.path;
            const active = !tab.isCenter && (
              tab.exactMatch
                ? location.pathname === prefix
                : location.pathname === prefix || location.pathname.startsWith(prefix + '/')
            );
            const Icon = tab.icon;

            if (tab.isCenter) {
              /* ── 中间 "+" 按钮 ── */
              return (
                <button
                  key={tab.key}
                  onClick={() => setSheetOpen(true)}
                  className="flex-1 flex items-center justify-center active:scale-95 transition-transform"
                  style={{ minHeight: 'var(--mobile-min-touch, 44px)' }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 14,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(255, 255, 255, 0.12)',
                      boxShadow: '0 0 12px 1px rgba(255, 255, 255, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.15)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                    }}
                  >
                    <Icon
                      size={22}
                      strokeWidth={2.5}
                      style={{ color: 'rgba(255, 255, 255, 0.90)' }}
                    />
                  </div>
                </button>
              );
            }

            /* ── 常规 Tab ── */
            return (
              <button
                key={tab.key}
                onClick={() => navigate(tab.path)}
                className="flex-1 flex flex-col items-center justify-center gap-[3px] transition-all duration-200 active:scale-95"
                style={{ minHeight: 'var(--mobile-min-touch, 44px)' }}
              >
                <Icon
                  size={21}
                  strokeWidth={active ? 2.2 : 1.6}
                  style={{
                    color: active ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.35)',
                    transition: 'color 0.2s ease',
                    filter: active ? 'drop-shadow(0 0 4px rgba(255,255,255,0.15))' : 'none',
                  }}
                />
                <span
                  className={cn('text-[10px] leading-none', active ? 'font-semibold' : 'font-normal')}
                  style={{
                    color: active ? 'rgba(255, 255, 255, 0.88)' : 'rgba(255, 255, 255, 0.30)',
                    transition: 'color 0.2s ease',
                  }}
                >
                  {tab.label}
                </span>
                {/* 激活指示条 */}
                <div
                  className="rounded-full transition-all duration-300"
                  style={{
                    width: active ? 14 : 0,
                    height: 2.5,
                    background: active
                      ? 'linear-gradient(90deg, rgba(245,178,40,0.7), rgba(255,220,100,0.95), rgba(245,178,40,0.7))'
                      : 'transparent',
                    boxShadow: active ? '0 0 6px 1px rgba(245,178,40,0.35)' : 'none',
                    opacity: active ? 1 : 0,
                  }}
                />
              </button>
            );
          })}
        </div>
      </nav>

      {/* ── Agent 快捷入口 BottomSheet ── */}
      <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen} title="选择 Agent">
        <div className="grid grid-cols-2 gap-3 pb-2">
          {AGENT_SHORTCUTS.map((agent) => {
            const AgentIcon = agent.icon;
            return (
              <button
                key={agent.key}
                onClick={() => handleAgentSelect(agent.path)}
                className="flex flex-col items-start gap-3 rounded-2xl p-4 text-left transition-all duration-150 active:scale-[0.97]"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                }}
              >
                <div
                  className="flex items-center justify-center rounded-xl"
                  style={{
                    width: 40,
                    height: 40,
                    background: `${agent.glowColor}`,
                    boxShadow: `0 0 12px ${agent.glowColor}`,
                  }}
                >
                  <AgentIcon size={20} style={{ color: agent.color }} />
                </div>
                <div>
                  <div
                    className="text-sm font-semibold mb-0.5"
                    style={{ color: 'var(--text-primary, rgba(255,255,255,0.95))' }}
                  >
                    {agent.label}
                  </div>
                  <div
                    className="text-[11px]"
                    style={{ color: 'var(--text-muted, rgba(255,255,255,0.45))' }}
                  >
                    {agent.subtitle}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </BottomSheet>
    </>
  );
}
