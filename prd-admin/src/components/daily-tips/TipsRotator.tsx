import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { trackTip } from '@/services/real/dailyTips';

const ROTATE_MS = 5500;

/** 下一页跳转后,SpotlightOverlay 会读取此 key 并对目标元素加脉冲光圈。 */
export const SPOTLIGHT_TARGET_KEY = 'spotlightTargetSelector';

interface Props {
  /** tip 为空时展示的兜底文字(例如原来的 hero subtitle) */
  fallback: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 副标题位文字轮播。
 * - 每 5.5s 切换一条 text 类 tip
 * - 点击 → 写入 spotlight target → 跳转到 tip.actionUrl
 * - 无 tip 或加载失败时回退为 fallback 原文
 */
export function TipsRotator({ fallback, className, style }: Props) {
  const navigate = useNavigate();
  const loaded = useDailyTipsStore((s) => s.loaded);
  const load = useDailyTipsStore((s) => s.load);
  const items = useDailyTipsStore((s) => s.items);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  const textTips = useMemo(() => items.filter((t) => t.kind === 'text'), [items]);
  const [index, setIndex] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (textTips.length <= 1) return;
    const tick = () => setIndex((i) => (i + 1) % textTips.length);
    timerRef.current = window.setInterval(tick, ROTATE_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [textTips.length]);

  const current = textTips[index % Math.max(textTips.length, 1)];

  if (!current) {
    return (
      <p className={className} style={style}>
        {fallback}
      </p>
    );
  }

  const handleClick = () => {
    void trackTip(current.id, 'clicked');
    if (current.targetSelector) {
      try {
        sessionStorage.setItem(SPOTLIGHT_TARGET_KEY, current.targetSelector);
      } catch {
        /* 忽略存储失败 */
      }
    }
    navigate(current.actionUrl || '/');
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      style={{
        ...style,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      title={current.ctaText ?? '去看看'}
    >
      <Sparkles
        size={13}
        style={{
          color: 'var(--accent-primary, #818CF8)',
          filter: 'drop-shadow(0 0 6px rgba(129,140,248,0.5))',
          flexShrink: 0,
        }}
      />
      <span
        key={current.id}
        style={{
          animation: 'tipFadeIn 400ms ease-out',
          borderBottom: '1px dashed rgba(255,255,255,0.25)',
          paddingBottom: 1,
        }}
      >
        {current.title}
      </span>
      <style>{`
        @keyframes tipFadeIn {
          from { opacity: 0; transform: translateY(2px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </button>
  );
}
