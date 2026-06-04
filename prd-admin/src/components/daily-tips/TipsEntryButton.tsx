import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { useAuthStore } from '@/stores/authStore';
import { matchPageGuide, filterPageTips } from './pageGuideMatch';

/** 点击内嵌入口时派发,TipsDrawer 监听后展开抽屉(多套教程时弹选择面板)。入口与抽屉解耦,入口可内嵌进任意页头。 */
export const OPEN_TIPS_DRAWER_EVENT = 'open-tips-drawer';
/** 本页仅一套教程时直接开讲(跳过选择面板),detail.tipId 指定要开的 tip。 */
export const START_TUTORIAL_EVENT = 'start-tutorial';

/**
 * 内嵌进各页头部的「本页教程」入口 —— 不是右上角悬浮浮层,而是融入页面头部布局的一个普通按钮。
 * 用户 2026-06-02 要求:「不是悬浮 而是融入」。
 *
 * 两态(按「本页教程是否走完」):
 * - 新人(本页有没走完的 *-page-guide):强调色 + 柔和脉冲光环,吸引注意。
 * - 老人 / 本页无教程:中性 ghost 样式、不脉冲,安静融入头部,不突兀。
 *
 * 点击 → 派发 OPEN_TIPS_DRAWER_EVENT,由 App 根挂载的 TipsDrawer 展开教程抽屉。
 */
export function TipsEntryButton({ className, compact = false }: { className?: string; compact?: boolean }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loaded = useDailyTipsStore((s) => s.loaded);
  const load = useDailyTipsStore((s) => s.load);
  const items = useDailyTipsStore((s) => s.items);
  const dismissed = useDailyTipsStore((s) => s.dismissed);

  // 自己也确保 tips 已加载:按钮可能挂在某些不挂 TipsDrawer 的场景里,
  // 不主动 load 就会因 items 为空而永远不显示(rules-of-hooks:hook 必须在 early-return 前)。
  useEffect(() => {
    if (isAuthenticated && !loaded) load();
  }, [isAuthenticated, loaded, load]);

  // 本页相关教程(与 TipsDrawer 抽屉作用域共用同一过滤逻辑)。带 location.search:query-scoped
  // 的 tip(如 nav-order-customize 的 ?tab=nav-order)只在对应 tab 才算「本页」(Codex P2)。
  const pageTips = useMemo(
    () => filterPageTips(items, dismissed, location.pathname, location.search),
    [items, dismissed, location.pathname, location.search],
  );
  // newbie:本页有「未走完的 *-page-guide」→ 强调色 + 脉冲,提示有完整上手教程没走完。
  const newbie = useMemo(
    () => !!matchPageGuide(items, dismissed, location.pathname, location.search),
    [items, dismissed, location.pathname, location.search],
  );

  // 未登录不渲染:像 /library 这种公开页匿名访客也会渲染头部,但根挂载的 TipsDrawer 仅登录后挂,
  // 此时入口点了没人接、还会打 401 的 daily-tips 接口。所以匿名一律不显示入口(放在所有 hook 之后,满足 rules-of-hooks)。
  if (!isAuthenticated) return null;
  // 本页没有任何教程 → 不显示按钮(用户 2026-06-04 要求:该页面没有教程就不显示这个按钮)。
  if (pageTips.length === 0) return null;

  return (
    <button
      type="button"
      className={className}
      data-tour-entry="1"
      title={newbie ? '本页教程 · 跟着走一遍' : '本页教程 / 新手指引'}
      onClick={() => {
        // 诉求 4/7:本页只有一套教程 → 直接开讲(不弹面板);多套 → 弹选择面板(抽屉列表)让用户挑。
        // 拉取 tips 的职责统一在 TipsDrawer 的监听里(load({force:true})),避免两处重复请求。
        const tutorials = pageTips.filter((t) => (t.autoAction?.steps?.length ?? 0) > 0);
        if (tutorials.length === 1) {
          window.dispatchEvent(new CustomEvent(START_TUTORIAL_EVENT, { detail: { tipId: tutorials[0].id } }));
        } else {
          window.dispatchEvent(new CustomEvent(OPEN_TIPS_DRAWER_EVENT));
        }
      }}
      style={{
        height: 28,
        padding: compact ? '0 8px' : '0 10px',
        borderRadius: 8,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: newbie ? 600 : 500,
        whiteSpace: 'nowrap',
        background: newbie
          ? 'linear-gradient(135deg, rgba(168,85,247,0.20), rgba(99,102,241,0.14))'
          : 'transparent',
        border: newbie
          ? '1px solid rgba(196,181,253,0.45)'
          : '1px solid var(--border-subtle, rgba(127,127,127,0.18))',
        color: newbie ? 'var(--accent-primary, #a78bfa)' : 'var(--text-muted)',
        opacity: newbie ? 1 : 0.8,
        transition: 'background 160ms ease-out, border-color 160ms ease-out, opacity 160ms ease-out',
        animation: newbie ? 'tipsEntryPulse 2.4s ease-in-out infinite' : undefined,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = newbie ? '1' : '0.8'; }}
    >
      <BookOpen size={13} strokeWidth={2} />
      {compact ? '教程' : '本页教程'}
      <style>{`@keyframes tipsEntryPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(168,85,247,0); }
        50% { box-shadow: 0 0 0 3px rgba(168,85,247,0.14); }
      }`}</style>
    </button>
  );
}
