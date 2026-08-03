import { useCallback, useEffect, useState } from 'react';
import { getMobileFeed, getMobileStats } from '@/services';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';

/**
 * 首页脉搏：近 7 日真实用量 + 我的动态。
 *
 * 桌面首页与移动首页读同一份（端点也同一个），保证两端「近 7 日」数字一致；
 * 谁也不许各拉各的，否则同一时刻两端显示不同数字会直接毁掉信任。
 *
 * 两路数据各自记成败：**「没取到」和「真的是零」必须分得开**。
 * 混作一谈的话，服务挂了会显示成「AI 调用 0 / 生图 0」+「用过之后动态会出现在这里」——
 * 等于当着老用户的面说他什么都没干过，比直接报错更伤（expectation-management：
 * 用户任何时刻都该知道现在发生了什么）。
 */
export interface HomePulse {
  stats: MobileStats | null;
  feed: FeedItem[];
  loading: boolean;
  /** 用量没取到（网络 / 服务不可用），不是「用量为零」 */
  statsFailed: boolean;
  /** 动态没取到，不是「还没有动态」 */
  feedFailed: boolean;
  /** 重新拉一次，供失败态的「重试」用 */
  reload: () => void;
}

type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

/**
 * 两路响应 → 页面要渲染的状态（纯函数，好让「失败 vs 空」这件事真的能被断言）。
 *
 * 判据只有一条：**只有确认成功才允许把数据当真**。请求 reject、`success:false`、
 * 甚至 `data` 缺失，都算没取到——落回 `stats:null` / `feed:[]` 加一个失败标记，
 * 由渲染层显示「--」和「取不到」，而不是 0 和「你还没用过」。
 */
export function resolveHomePulse(
  statsRes: Settled<{ success: boolean; data?: MobileStats | null }>,
  feedRes: Settled<{ success: boolean; data?: { items?: FeedItem[] } | null }>,
): Omit<HomePulse, 'loading' | 'reload'> {
  const statsOk = statsRes.status === 'fulfilled' && statsRes.value.success && !!statsRes.value.data;
  const feedOk = feedRes.status === 'fulfilled' && feedRes.value.success && !!feedRes.value.data;
  return {
    stats: statsOk ? statsRes.value.data! : null,
    feed: feedOk ? feedRes.value.data!.items ?? [] : [],
    statsFailed: !statsOk,
    feedFailed: !feedOk,
  };
}

export function useHomePulse(feedLimit = 8): HomePulse {
  const [stats, setStats] = useState<MobileStats | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statsFailed, setStatsFailed] = useState(false);
  const [feedFailed, setFeedFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      // allSettled：一路挂掉不许把另一路也拖成未知态，
      // 也不许让 loading 永远停在骨架上。
      const [statsRes, feedRes] = await Promise.allSettled([
        getMobileStats({ days: 7 }),
        getMobileFeed({ limit: feedLimit }),
      ]);
      if (!alive) return;

      const resolved = resolveHomePulse(statsRes, feedRes);
      // 失败时保留上一轮拿到过的数据（重试期间不要把已显示的数字抹成空），
      // 但失败标记照打——渲染层据此说明"这份是旧的/取不到"。
      if (!resolved.statsFailed) setStats(resolved.stats);
      if (!resolved.feedFailed) setFeed(resolved.feed);
      setStatsFailed(resolved.statsFailed);
      setFeedFailed(resolved.feedFailed);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [feedLimit, attempt]);

  return { stats, feed, loading, statsFailed, feedFailed, reload };
}

/** 万 / 亿 紧凑计数（两端同一口径，移动首页从这里再导出，别再写第二份） */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(value);
}
