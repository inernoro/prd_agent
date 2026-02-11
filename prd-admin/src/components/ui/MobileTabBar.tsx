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
  X,
  type LucideIcon,
} from 'lucide-react';

/* ── Agent 快捷入口 ── */
interface AgentShortcut {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;
  color: string;
  bg: string;
}

const AGENT_SHORTCUTS: AgentShortcut[] = [
  { key: 'prd',      label: 'PRD',    icon: MessageSquare, path: '/prd-agent',      color: '#818CF8', bg: 'rgba(129,140,248,0.20)' },
  { key: 'visual',   label: '视觉创作', icon: Image,       path: '/visual-agent',   color: '#FB923C', bg: 'rgba(251,146,60,0.20)' },
  { key: 'literary', label: '文学创作', icon: PenLine,      path: '/literary-agent', color: '#34D399', bg: 'rgba(52,211,153,0.20)' },
  { key: 'defect',   label: '缺陷管理', icon: Bug,          path: '/defect-agent',   color: '#F87171', bg: 'rgba(248,113,113,0.20)' },
];

/* ── 环形布局计算 ── */
const RADIAL_RADIUS = 100;
const ARC_START_DEG = -145; // 从左侧开始 (度)
const ARC_END_DEG = -35;    // 到右侧结束 (度)

function radialPosition(index: number, total: number) {
  const deg = ARC_START_DEG + ((ARC_END_DEG - ARC_START_DEG) / (total - 1)) * index;
  const rad = (deg * Math.PI) / 180;
  return {
    x: Math.round(RADIAL_RADIUS * Math.cos(rad)),
    y: Math.round(RADIAL_RADIUS * Math.sin(rad)),
  };
}

/* ── 底部 5 个固定 Tab ── */
interface FixedTab {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;
  matchPrefix?: string;
  exactMatch?: boolean;
  alsoMatch?: string[];   // 额外精确匹配路径（如 /executive 也算首页）
  isCenter?: boolean;
}

const FIXED_TABS: FixedTab[] = [
  { key: 'home',    label: '首页', icon: Home,       path: '/',           matchPrefix: '/', exactMatch: true, alsoMatch: ['/executive'] },
  { key: 'explore', label: '浏览', icon: Compass,    path: '/ai-toolbox', matchPrefix: '/ai-toolbox' },
  { key: 'create',  label: '',     icon: Plus,        path: '',            isCenter: true },
  { key: 'assets',  label: '资产', icon: FolderOpen,  path: '/my-assets',  matchPrefix: '/my-assets' },
  { key: 'me',      label: '我的', icon: UserCircle,  path: '/profile',    matchPrefix: '/profile' },
];

interface MobileTabBarProps {
  className?: string;
}

/**
 * 移动端底部 Tab 导航栏 — 5 固定 Tab + 环形 Agent 扇形菜单。
 *
 * | 首页 | 浏览 | + | 资产 | 我的 |
 *
 * 中间 "+" 点击后扇形展开 Agent 快捷入口，再次点击或点背景关闭。
 */
export function MobileTabBar({ className }: MobileTabBarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleAgentSelect = useCallback((path: string) => {
    setMenuOpen(false);
    navigate(path);
  }, [navigate]);

  const toggleMenu = useCallback(() => {
    setMenuOpen((v) => !v);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  return (
    <>
      {/* ── 环形菜单遮罩层 ── */}
      <div
        className="fixed inset-0"
        style={{
          zIndex: 200,
          pointerEvents: menuOpen ? 'auto' : 'none',
        }}
      >
        {/* 背景遮罩 */}
        <div
          className="absolute inset-0"
          style={{
            background: 'rgba(0, 0, 0, 0.55)',
            opacity: menuOpen ? 1 : 0,
            transition: 'opacity 0.3s ease',
          }}
          onClick={closeMenu}
        />

        {/* 环形内容区 — 锚定在底部中心 */}
        <div
          className="absolute bottom-0 left-0 right-0"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          {/* 半圆形背景 — 宽高需包住所有扇形项 + 底部 × 按钮 + tab 栏区域 */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: '50%',
              width: 380,
              height: 270,
              borderRadius: '190px 190px 0 0',
              background: 'radial-gradient(ellipse at 50% 100%, rgba(38,38,52,0.99) 0%, rgba(26,26,36,0.98) 50%, rgba(18,18,26,0.97) 100%)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderBottom: 'none',
              transform: `translateX(-50%) scale(${menuOpen ? 1 : 0})`,
              transformOrigin: '50% 100%',
              transition: menuOpen
                ? 'transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1)'
                : 'transform 0.22s cubic-bezier(0.55, 0, 1, 0.45)',
            }}
          >
            {/* 半圆顶部高光弧线 */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: '10%',
                right: '10%',
                height: 1,
                borderRadius: '50%',
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.10) 30%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.10) 70%, transparent)',
              }}
            />
          </div>

          {/* Agent 扇形项 */}
          {AGENT_SHORTCUTS.map((agent, i) => {
            const { x, y } = radialPosition(i, AGENT_SHORTCUTS.length);
            const Icon = agent.icon;
            const stagger = i * 50 + 80;
            return (
              <button
                key={agent.key}
                className="absolute flex flex-col items-center gap-1.5"
                style={{
                  bottom: 38,
                  left: '50%',
                  transform: menuOpen
                    ? `translate(calc(-50% + ${x}px), ${y}px) scale(1)`
                    : 'translate(-50%, 0px) scale(0)',
                  opacity: menuOpen ? 1 : 0,
                  transition: menuOpen
                    ? `transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) ${stagger}ms, opacity 0.28s ease ${stagger}ms`
                    : 'transform 0.18s ease, opacity 0.12s ease',
                  pointerEvents: menuOpen ? 'auto' : 'none',
                }}
                onClick={() => handleAgentSelect(agent.path)}
              >
                <div
                  className="flex items-center justify-center active:scale-90 transition-transform"
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 26,
                    background: agent.bg,
                    border: `1.5px solid ${agent.color}30`,
                    boxShadow: `0 0 20px ${agent.bg}, 0 0 40px ${agent.bg.replace('0.20', '0.08')}`,
                  }}
                >
                  <Icon size={24} style={{ color: agent.color }} />
                </div>
                <span
                  className="text-[11px] font-medium whitespace-nowrap"
                  style={{ color: 'rgba(255,255,255,0.82)' }}
                >
                  {agent.label}
                </span>
              </button>
            );
          })}

          {/* × 关闭按钮 — 居中于 tab 栏高度 */}
          <button
            className="absolute flex items-center justify-center active:scale-90 transition-transform"
            style={{
              bottom: 8,
              left: '50%',
              transform: `translateX(-50%) rotate(${menuOpen ? '0deg' : '-90deg'}) scale(${menuOpen ? 1 : 0})`,
              width: 44,
              height: 44,
              borderRadius: 22,
              background: 'rgba(255,255,255,0.08)',
              border: '1.5px solid rgba(255,255,255,0.12)',
              opacity: menuOpen ? 1 : 0,
              transition: menuOpen
                ? 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) 60ms, opacity 0.25s ease 60ms'
                : 'transform 0.18s ease, opacity 0.12s ease',
              pointerEvents: menuOpen ? 'auto' : 'none',
            }}
            onClick={closeMenu}
          >
            <X size={20} strokeWidth={2.5} style={{ color: 'rgba(255,255,255,0.85)' }} />
          </button>
        </div>
      </div>

      {/* ── Tab Bar ── */}
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
                ? location.pathname === prefix || (tab.alsoMatch?.includes(location.pathname) ?? false)
                : location.pathname === prefix || location.pathname.startsWith(prefix + '/')
            );
            const Icon = tab.icon;

            if (tab.isCenter) {
              /* ── 中间 "+" 按钮（展开环形菜单） ── */
              return (
                <button
                  key={tab.key}
                  onClick={toggleMenu}
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
                      background: menuOpen
                        ? 'rgba(255, 255, 255, 0.18)'
                        : 'rgba(255, 255, 255, 0.12)',
                      boxShadow: '0 0 12px 1px rgba(255, 255, 255, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.15)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      transition: 'background 0.3s ease',
                    }}
                  >
                    <Icon
                      size={22}
                      strokeWidth={2.5}
                      style={{
                        color: 'rgba(255, 255, 255, 0.90)',
                        transform: `rotate(${menuOpen ? '45deg' : '0deg'})`,
                        transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
                      }}
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
    </>
  );
}
