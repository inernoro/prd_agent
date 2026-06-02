import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';

/** 点击内嵌入口时派发,TipsDrawer 监听后展开抽屉。入口与抽屉解耦,入口可内嵌进任意页头。 */
export const OPEN_TIPS_DRAWER_EVENT = 'open-tips-drawer';

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
  const items = useDailyTipsStore((s) => s.items);
  const dismissed = useDailyTipsStore((s) => s.dismissed);
  const loaded = useDailyTipsStore((s) => s.loaded);
  const load = useDailyTipsStore((s) => s.load);

  const newbie = useMemo(() => {
    return items.some((t) => {
      if (dismissed.has(t.id)) return false;
      if (t.kind !== 'card' && t.kind !== 'spotlight') return false;
      if (typeof t.sourceId !== 'string' || !t.sourceId.endsWith('-page-guide') || !t.actionUrl) return false;
      const isEditor = t.sourceId.includes('editor');
      if (location.pathname === t.actionUrl) return !isEditor;
      if (location.pathname.startsWith(t.actionUrl + '/')) return isEditor;
      return false;
    });
  }, [items, dismissed, location.pathname]);

  return (
    <button
      type="button"
      className={className}
      title={newbie ? '本页教程 · 跟着走一遍' : '本页教程 / 新手指引'}
      onClick={() => {
        if (!loaded) load(); else void load({ force: true });
        window.dispatchEvent(new CustomEvent(OPEN_TIPS_DRAWER_EVENT));
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
