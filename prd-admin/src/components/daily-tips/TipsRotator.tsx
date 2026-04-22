import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { trackTip, type DailyTip } from '@/services/real/dailyTips';

const ROTATE_MS = 5500;

/** 下一页跳转后,SpotlightOverlay 会读取此 key 并对目标元素加脉冲光圈(仅向后兼容)。 */
export const SPOTLIGHT_TARGET_KEY = 'spotlightTargetSelector';

/**
 * 下一页跳转后 SpotlightOverlay 读取的完整动作包:
 * { selector, title?, body?, ctaText?, autoAction? }。
 * 存 JSON 字符串;与 SPOTLIGHT_TARGET_KEY 至少有一个命中即触发。
 */
export const SPOTLIGHT_ACTION_KEY = 'spotlightAction';

/** sessionStorage 写入后广播的自定义事件,供同路由 SpotlightOverlay 立即重读。
 * 场景:用户在 /defect-agent 页点「从头开始」,tip.actionUrl 也是 /defect-agent,
 * React Router 不 re-mount → SpotlightOverlay 的 mount effect 不会再跑。
 * 用这个事件通知它手动重读一次。 */
export const SPOTLIGHT_PAYLOAD_UPDATED_EVENT = 'spotlight-payload-updated';

export interface SpotlightActionPayload {
  /** tip.id —— Tour 全部完成时用于永久 dismiss(配合撒花) */
  id?: string;
  selector: string;
  title?: string;
  body?: string | null;
  ctaText?: string | null;
  autoAction?: import('@/services/real/dailyTips').DailyTipAutoAction | null;
}

/**
 * 将点击中的 tip 信息写入 sessionStorage，给下一页的 SpotlightOverlay 消费。
 * tip 只要有 targetSelector 或 autoAction(哪怕一个 step)就写。
 */
export function writeSpotlightPayload(tip: DailyTip) {
  const selector = tip.targetSelector
    ?? tip.autoAction?.steps?.[0]?.selector
    ?? null;
  if (!selector && !tip.autoAction) return;

  // 旧版 key：只有一个 selector 字符串，保留以便向前兼容
  if (selector) {
    try { sessionStorage.setItem(SPOTLIGHT_TARGET_KEY, selector); } catch { /* noop */ }
  }

  if (!selector) return;
  const payload: SpotlightActionPayload = {
    id: tip.id,
    selector,
    title: tip.title,
    body: tip.body ?? null,
    ctaText: tip.ctaText ?? null,
    autoAction: tip.autoAction ?? null,
  };
  try {
    sessionStorage.setItem(SPOTLIGHT_ACTION_KEY, JSON.stringify(payload));
  } catch {
    /* noop */
  }

  // 广播:如果目标 URL 就是当前 URL,同一 SpotlightOverlay 实例不会 re-mount,
  // 必须通过事件让它手动重读 sessionStorage
  try {
    window.dispatchEvent(new CustomEvent(SPOTLIGHT_PAYLOAD_UPDATED_EVENT));
  } catch {
    /* noop */
  }
}

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
    writeSpotlightPayload(current);
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
