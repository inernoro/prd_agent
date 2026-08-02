import { useEffect, useState } from 'react';
import { getMobileFeed, getMobileStats } from '@/services';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';

/**
 * 首页脉搏：近 7 日真实用量 + 我的动态。
 *
 * 桌面首页与移动首页读同一份（端点也同一个），保证两端「近 7 日」数字一致；
 * 谁也不许各拉各的，否则同一时刻两端显示不同数字会直接毁掉信任。
 */
export interface HomePulse {
  stats: MobileStats | null;
  feed: FeedItem[];
  loading: boolean;
}

export function useHomePulse(feedLimit = 8): HomePulse {
  const [stats, setStats] = useState<MobileStats | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [statsRes, feedRes] = await Promise.all([
        getMobileStats({ days: 7 }),
        getMobileFeed({ limit: feedLimit }),
      ]);
      if (!alive) return;
      if (statsRes.success) setStats(statsRes.data);
      if (feedRes.success) setFeed(feedRes.data.items ?? []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [feedLimit]);

  return { stats, feed, loading };
}

/** 万 / 亿 紧凑计数（两端同一口径，移动首页从这里再导出，别再写第二份） */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(value);
}
