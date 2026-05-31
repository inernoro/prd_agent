import { useEffect, useMemo, useRef, useState } from 'react';
import { getAiNewsLatest, type AiNewsItem } from '@/services/real/aiNews';
import { FEATURED_THRESHOLD, labelMeta, sortByRecency } from './aiNewsShared';
import './aiNews.css';

/**
 * 首页「更新中心」卡片上的资讯 teaser。
 *
 * 不占布局：绝对定位在卡片底部，每隔几秒「跳出」一条 AI 资讯标题（淡入升起→停留→淡出），
 * 逐条循环。pointer-events 关闭，点击卡片仍正常进入更新中心。
 * 想看完整时间线 → 卡片点进去（更新中心页「AI 大事」tab）。
 */

const ROTATE_MS = 5400; // 与 CSS .ainews-teaser-line 动画时长一致
const MAX_TEASE = 6;

export function UpdateCenterNewsTeaser() {
  const [items, setItems] = useState<AiNewsItem[]>([]);
  const [idx, setIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getAiNewsLatest();
      if (!alive || !res.success || !res.data) return;
      // 优先高信号条目，最多取 MAX_TEASE 条循环。
      const sorted = sortByRecency(res.data.items);
      const featured = sorted.filter((x) => x.aiScore >= FEATURED_THRESHOLD);
      const pool = (featured.length >= 3 ? featured : sorted).slice(0, MAX_TEASE);
      setItems(pool);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (items.length <= 1) return;
    timerRef.current = setInterval(() => {
      setIdx((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [items.length]);

  const current = items[idx];
  const meta = useMemo(() => (current ? labelMeta(current.aiLabel) : null), [current]);

  if (!current || !meta) return null;

  return (
    <div
      className="absolute inset-x-0 bottom-0 pointer-events-none z-20 flex items-end"
      style={{
        // 对齐卡片内边距，headline 落在 desc 位置之上（下三分之一「breaking news」式）
        paddingLeft: 20,
        paddingRight: 20,
        paddingBottom: 18,
        paddingTop: 34,
        // 底部压暗，遮住静态 desc，让标题在任何卡片底图上都读得清；不挡卡片标题（标题在更上方）
        background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.72) 45%, rgba(0,0,0,0.92) 100%)',
      }}
    >
      {/* key 触发每条重新播放进出动画 */}
      <div
        key={current.id || current.url}
        className="ainews-teaser-line flex items-center gap-2 min-w-0"
      >
        <span
          className="ainews-live-dot inline-flex shrink-0"
          style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color, boxShadow: `0 0 8px ${meta.color}` }}
        >
          <span
            className="ainews-live-core"
            style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color }}
          />
        </span>
        <span
          className="text-[11px] font-semibold shrink-0"
          style={{ color: meta.color, textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}
        >
          {meta.label}
        </span>
        <span
          className="text-[12px] truncate"
          style={{ color: 'rgba(255,255,255,0.94)', textShadow: '0 1px 3px rgba(0,0,0,0.95)' }}
        >
          {current.title}
        </span>
      </div>
    </div>
  );
}
