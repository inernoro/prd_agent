import { useState, useCallback, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import {
  Home,
  Compass,
  Plus,
  BookOpen,
  UserCircle,
  Image,
  PenLine,
  Bug,
  FileBarChart,
  Presentation,
  ChevronRight,
  X,
  type LucideIcon,
} from 'lucide-react';

/* ── 快速创建入口 ── */
interface CreateAction {
  key: string;
  label: string;
  desc?: string;
  icon: LucideIcon;
  path: string;
  color: string;
}

/** 最近热门：平台当前主推的创作方式（带「热门」标签的大行卡） */
const HOT_ACTIONS: CreateAction[] = [
  {
    key: 'kb-article',
    label: '知识库文章',
    desc: '新建一篇文章，沉淀文档与知识',
    icon: BookOpen,
    path: '/document-store',
    color: '#FFB340',
  },
  {
    key: 'md-to-ppt',
    label: 'MD 转网页 PPT',
    desc: '粘贴 Markdown，AI 直出网页演示',
    icon: Presentation,
    path: '/md-to-ppt-agent',
    color: '#7DD3FC',
  },
];

/** 开始创作：核心 Agent 快捷入口（四宫格） */
const AGENT_ACTIONS: CreateAction[] = [
  { key: 'visual',   label: '视觉创作', icon: Image,        path: '/visual-agent',   color: '#FB923C' },
  { key: 'literary', label: '文学创作', icon: PenLine,       path: '/literary-agent', color: '#34D399' },
  { key: 'defect',   label: '缺陷管理', icon: Bug,           path: '/defect-agent',   color: '#F87171' },
  { key: 'report',   label: '周报',     icon: FileBarChart,  path: '/report-agent',   color: '#A78BFA' },
];

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
  { key: 'home',    label: '首页',   icon: Home,       path: '/',               matchPrefix: '/', exactMatch: true },
  { key: 'explore', label: '浏览',   icon: Compass,    path: '/ai-toolbox',     matchPrefix: '/ai-toolbox' },
  { key: 'create',  label: '',       icon: Plus,       path: '',                isCenter: true },
  { key: 'kb',      label: '知识库', icon: BookOpen,   path: '/document-store', matchPrefix: '/document-store' },
  { key: 'me',      label: '我的',   icon: UserCircle, path: '/profile',        matchPrefix: '/profile' },
];

interface MobileTabBarProps {
  className?: string;
}

/**
 * 移动端底部 Tab 导航栏 — 5 固定 Tab + 「快速创建」底部抽屉。
 *
 * | 首页 | 浏览 | + | 知识库 | 我的 |
 *
 * 中间 "+" 点击后从底部滑出创建抽屉（最近热门大行卡 + 核心 Agent 四宫格），
 * 点背景 / × / ESC 关闭。抽屉通过 createPortal 挂到 body（frontend-modal 规则）。
 */
/** 底部 Tab 的根路径集合：tab 根之间互切属同级切换，用 replace 不进 history。 */
const TAB_ROOT_PATHS = new Set(
  FIXED_TABS.filter((t) => !t.isCenter && t.path).map((t) => t.path)
);

export function MobileTabBar({ className }: MobileTabBarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  // 视觉值统一由 tokens.css 的主题契约提供；此处不再维护两套明暗分支。
  const T = {
    barBg: 'var(--mobile-tab-bg)',
    barBorder: 'var(--mobile-tab-border)',
    barHighlight: 'var(--mobile-tab-highlight)',
    iconActive: 'var(--mobile-tab-active)',
    iconIdle: 'var(--mobile-tab-idle)',
    labelActive: 'var(--mobile-tab-active)',
    labelIdle: 'var(--mobile-tab-idle)',
    centerBg: 'var(--mobile-tab-center-bg)',
    centerBgOpen: 'var(--mobile-tab-center-bg-open)',
    centerBorder: 'var(--mobile-tab-center-border)',
    centerShadow: 'var(--mobile-tab-center-shadow)',
    centerIcon: 'var(--mobile-tab-center-icon)',
    sheetBg: 'var(--mobile-sheet-bg)',
    sheetBorder: 'var(--mobile-sheet-border)',
    sheetShadow: 'var(--mobile-sheet-shadow)',
    sheetGrip: 'var(--mobile-sheet-grip)',
    sheetTitle: 'var(--mobile-sheet-title)',
    sheetSub: 'var(--mobile-sheet-copy)',
    sheetLabel: 'var(--mobile-sheet-copy)',
    sheetItemBg: 'var(--mobile-sheet-item-bg)',
    sheetItemBorder: 'var(--mobile-sheet-item-border)',
    sheetItemDivider: 'var(--mobile-sheet-item-divider)',
    sheetItemTitle: 'var(--text-primary)',
    sheetItemDesc: 'var(--mobile-sheet-copy)',
    sheetChevron: 'var(--mobile-sheet-chevron)',
    closeBg: 'var(--mobile-sheet-close-bg)',
    closeBorder: 'var(--mobile-sheet-close-border)',
    closeIcon: 'var(--mobile-sheet-close-icon)',
    activePress: 'mobile-press-soft',
  } as const;

  const handleActionSelect = useCallback((path: string) => {
    setMenuOpen(false);
    navigate(path);
  }, [navigate]);

  const toggleMenu = useCallback(() => {
    setMenuOpen((v) => !v);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  // ESC 关闭抽屉
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  /** 抽屉内条目的入场动画（开启时轻微上浮 + 淡入，逐项错峰） */
  const itemAnim = (index: number): CSSProperties => ({
    opacity: menuOpen ? 1 : 0,
    transform: menuOpen ? 'translateY(0)' : 'translateY(10px)',
    transition: menuOpen
      ? `opacity 0.3s ease ${index * 40 + 90}ms, transform 0.34s cubic-bezier(0.22, 1, 0.36, 1) ${index * 40 + 90}ms`
      : 'opacity 0.12s ease, transform 0.12s ease',
  });

  /* ── 「快速创建」底部抽屉 ── */
  const createSheet = (
    <div
      aria-hidden={!menuOpen}
      className="fixed inset-0"
      style={{
        zIndex: 200,
        pointerEvents: menuOpen ? 'auto' : 'none',
        visibility: menuOpen ? 'visible' : 'hidden',
        transition: menuOpen ? 'visibility 0s' : 'visibility 0s linear 0.3s',
      }}
    >
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(0, 0, 0, 0.55)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          opacity: menuOpen ? 1 : 0,
          transition: 'opacity 0.28s ease',
        }}
        onClick={closeMenu}
      />

      {/* 抽屉本体 */}
      <div
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen ? 'true' : undefined}
        aria-label="快速创建"
        className="absolute left-0 right-0 bottom-0"
        style={{
          borderRadius: '24px 24px 0 0',
          background: T.sheetBg,
          border: T.sheetBorder,
          borderBottom: 'none',
          boxShadow: T.sheetShadow,
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
          transform: menuOpen ? 'translateY(0)' : 'translateY(105%)',
          transition: menuOpen
            ? 'transform 0.38s cubic-bezier(0.32, 0.72, 0, 1)'
            : 'transform 0.26s cubic-bezier(0.55, 0, 1, 0.45)',
        }}
      >
        {/* 顶部拖拽指示条 */}
        <div className="flex justify-center pt-2.5 pb-1">
          <div style={{ width: 36, height: 4, borderRadius: 999, background: T.sheetGrip }} />
        </div>

        {/* 标题行 */}
        <div className="flex items-center justify-between px-5 pt-1 pb-1">
          <div>
            <div className="text-[17px] font-bold" style={{ color: T.sheetTitle }}>
              快速创建
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: T.sheetSub }}>
              选一种方式，开始今天的产出
            </div>
          </div>
          <button
            onClick={closeMenu}
            aria-label="关闭"
            className="flex items-center justify-center active:scale-90 transition-transform"
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              background: T.closeBg,
              border: T.closeBorder,
            }}
          >
            <X size={16} style={{ color: T.closeIcon }} />
          </button>
        </div>

        {/* 最近热门 */}
        <div className="px-5 mt-3" style={itemAnim(0)}>
          <div className="text-[11px] font-semibold tracking-wide mb-2" style={{ color: T.sheetLabel }}>
            最近热门
          </div>
          <div
            className="rounded-2xl overflow-hidden"
            style={{ background: T.sheetItemBg, border: T.sheetItemBorder }}
          >
            {HOT_ACTIONS.map((action, i) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.key}
                  onClick={() => handleActionSelect(action.path)}
                  className={cn('w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors', T.activePress)}
                  style={{
                    minHeight: 'var(--mobile-min-touch, 44px)',
                    borderBottom: i < HOT_ACTIONS.length - 1 ? T.sheetItemDivider : 'none',
                  }}
                >
                  <div
                    className="flex items-center justify-center shrink-0"
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 12,
                      background: `${action.color}1F`,
                      border: `1px solid ${action.color}30`,
                    }}
                  >
                    <Icon size={19} style={{ color: action.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[14px] font-semibold" style={{ color: T.sheetItemTitle }}>
                        {action.label}
                      </span>
                      <span
                        className="px-1.5 py-px rounded-full text-[10px] font-semibold shrink-0"
                        style={{
                          background: 'rgba(255,159,10,0.16)',
                          color: '#FFB340',
                          border: '1px solid rgba(255,159,10,0.25)',
                        }}
                      >
                        热门
                      </span>
                    </div>
                    <div className="text-[11px] mt-0.5 truncate" style={{ color: T.sheetItemDesc }}>
                      {action.desc}
                    </div>
                  </div>
                  <ChevronRight size={16} className="shrink-0" style={{ color: T.sheetChevron }} />
                </button>
              );
            })}
          </div>
        </div>

        {/* 开始创作 */}
        <div className="px-5 mt-4" style={itemAnim(1)}>
          <div className="text-[11px] font-semibold tracking-wide mb-2" style={{ color: T.sheetLabel }}>
            开始创作
          </div>
          <div className="grid grid-cols-4 gap-2">
            {AGENT_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.key}
                  onClick={() => handleActionSelect(action.path)}
                  className="flex flex-col items-center gap-1.5 py-3 rounded-2xl active:scale-95 transition-transform"
                  style={{
                    background: T.sheetItemBg,
                    border: T.sheetItemBorder,
                    minHeight: 'var(--mobile-min-touch, 44px)',
                  }}
                >
                  <div
                    className="flex items-center justify-center"
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 14,
                      background: `${action.color}1F`,
                      border: `1px solid ${action.color}30`,
                      boxShadow: `0 0 16px ${action.color}14`,
                    }}
                  >
                    <Icon size={20} style={{ color: action.color }} />
                  </div>
                  <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: T.sheetItemTitle }}>
                    {action.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {createPortal(createSheet, document.body)}

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
            background: T.barBg,
            borderTop: T.barBorder,
            backdropFilter: 'blur(48px) saturate(200%)',
            WebkitBackdropFilter: 'blur(48px) saturate(200%)',
          }}
        />
        {/* 顶部高光线 */}
        <div
          className="absolute top-0 left-[12%] right-[12%] h-px"
          style={{ background: T.barHighlight }}
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
              /* ── 中间 "+" 按钮（展开创建抽屉） ── */
              return (
                <button
                  key={tab.key}
                  onClick={toggleMenu}
                  aria-label="快速创建"
                  title="快速创建"
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
                      background: menuOpen ? T.centerBgOpen : T.centerBg,
                      boxShadow: T.centerShadow,
                      border: T.centerBorder,
                      transition: 'background 0.3s ease',
                    }}
                  >
                    <Icon
                      size={22}
                      strokeWidth={2.5}
                      style={{
                        color: T.centerIcon,
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
                onClick={() => {
                  if (location.pathname === tab.path) return;
                  // tab 根之间互切（首页/浏览/知识库/我的）用 replace：不把导航页压进
                  // history，手机右滑返回/浏览器返回直接回到进入 tab 前的真实上一页，
                  // 而不是逐个回放之前点过的每个 tab（2026-07-12 用户反馈的「奇怪导航页」主源）。
                  // 从内容页（非 tab 根）进 tab 仍然 push，保证能返回该内容页。
                  navigate(tab.path, { replace: TAB_ROOT_PATHS.has(location.pathname) });
                }}
                className="flex-1 flex flex-col items-center justify-center gap-[3px] transition-all duration-200 active:scale-95"
                style={{ minHeight: 'var(--mobile-min-touch, 44px)' }}
              >
                <Icon
                  size={21}
                  strokeWidth={active ? 2.2 : 1.6}
                  style={{
                    color: active ? T.iconActive : T.iconIdle,
                    transition: 'color 0.2s ease',
                  }}
                />
                <span
                  className={cn('text-[10px] leading-none', active ? 'font-semibold' : 'font-normal')}
                  style={{
                    color: active ? T.labelActive : T.labelIdle,
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
                    background: active ? T.iconActive : 'transparent',
                    boxShadow: active ? `0 0 6px 1px ${T.iconActive}59` : 'none',
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
