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
  /** 请求成功但后端有来源查挂了：列表不完整，空列表也不代表「还没有动态」 */
  feedDegraded: boolean;
  /** 重新拉一次，供失败态的「重试」用 */
  reload: () => void;
}

type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

/**
 * Web 端已下线、路由被重定向回首页的入口。
 *
 * 后端的动态流仍会吐 PRD 会话（`navigateTo: '/prd-agent'`），但 App.tsx 把这条路由
 * 整条重定向到 `/`——点一下等于把首页重刷一遍，用户不会以为"这条坏了"，
 * 只会以为"这个系统点了没反应"。与其给一条死链，不如不列。
 *
 * 这份清单必须与 App.tsx 里 `<Route … element={<Navigate to="/" replace />} />`
 * 的路径一致，守卫会对账（homePulse.test.ts），漏一条就会重新长出死链。
 */
export const RETIRED_ROUTES = ['/prd-agent', '/stats'];

function isDeadLink(navigateTo: string | undefined): boolean {
  if (!navigateTo) return true;
  const path = navigateTo.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return RETIRED_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

/**
 * 两路响应 → 页面要渲染的状态（纯函数，好让「失败 vs 空」这件事真的能被断言）。
 *
 * 判据只有一条：**只有确认成功才允许把数据当真**。请求 reject、`success:false`、
 * 甚至 `data` 缺失，都算没取到——落回 `stats:null` / `feed:[]` 加一个失败标记，
 * 由渲染层显示「--」和「取不到」，而不是 0 和「你还没用过」。
 */
export function resolveHomePulse(
  statsRes: Settled<{ success: boolean; data?: MobileStats | null }>,
  feedRes: Settled<{ success: boolean; data?: { items?: FeedItem[]; degradedSources?: string[] } | null }>,
  visibleLimit?: number,
): Omit<HomePulse, 'loading' | 'reload'> {
  const statsOk = statsRes.status === 'fulfilled' && statsRes.value.success && !!statsRes.value.data;
  const feedOk = feedRes.status === 'fulfilled' && feedRes.value.success && !!feedRes.value.data;
  // 死链条目在这一层就丢掉：两端共用这个 hook，过滤写在渲染层就会漏一端。
  // 先过滤再截断——反过来的话，被服务端排在前面的死链会先占掉名额，
  // 过滤完剩下一个空列表，页面又去说"你还没用过"。
  const live = feedOk ? (feedRes.value.data!.items ?? []).filter((item) => !isDeadLink(item.navigateTo)) : [];
  // 后端逐来源查库、单个失败不整体 500。只看 HTTP 成不成功的话，
  // 「两个来源都查挂了」会以 200 + 空列表的形式回来，被读成「你还没用过」。
  const degradedSources = feedOk ? feedRes.value.data!.degradedSources ?? [] : [];
  return {
    stats: statsOk ? statsRes.value.data! : null,
    feed: visibleLimit == null ? live : live.slice(0, visibleLimit),
    statsFailed: !statsOk,
    feedFailed: !feedOk,
    feedDegraded: degradedSources.length > 0,
  };
}

/**
 * 多要几条再过滤，给死链留出补位空间。
 *
 * 服务端是「合并所有来源 → 排序 → Take(limit)」，截断发生在它那边。
 * 要 8 条就只拿 8 条的话，只要最新的 8 条恰好都是已下线入口，
 * 客户端一过滤就全空，页面转头去说"你还没用过"——修死链反而制造了新的谎话。
 * 服务端 limit 上限是 50，所以按 3 倍取、封顶 50。
 *
 * 这只是过渡期的补位：真正的解法是后端不再产出已下线入口的条目（本次同批已改）。
 * 补位仍留着——旧构建的部署还在跑，且下一个页面下线时它是第一道垫子。
 */
const FEED_OVERFETCH = 3;
const FEED_LIMIT_MAX = 50;

export function useHomePulse(feedLimit = 8): HomePulse {
  const [stats, setStats] = useState<MobileStats | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statsFailed, setStatsFailed] = useState(false);
  const [feedFailed, setFeedFailed] = useState(false);
  const [feedDegraded, setFeedDegraded] = useState(false);
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
        getMobileFeed({ limit: Math.min(feedLimit * FEED_OVERFETCH, FEED_LIMIT_MAX) }),
      ]);
      if (!alive) return;

      const resolved = resolveHomePulse(statsRes, feedRes, feedLimit);
      // 失败时保留上一轮拿到过的数据（重试期间不要把已显示的数字抹成空），
      // 但失败标记照打——渲染层据此说明"这份是旧的/取不到"。
      if (!resolved.statsFailed) setStats(resolved.stats);
      if (!resolved.feedFailed) setFeed(resolved.feed);
      setStatsFailed(resolved.statsFailed);
      setFeedFailed(resolved.feedFailed);
      setFeedDegraded(resolved.feedDegraded);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [feedLimit, attempt]);

  return { stats, feed, loading, statsFailed, feedFailed, feedDegraded, reload };
}

/** 万 / 亿 紧凑计数（两端同一口径，移动首页从这里再导出，别再写第二份） */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(value);
}
