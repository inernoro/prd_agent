import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import {
  getModelLeaderboardTop,
  type ModelLeaderboardEntry,
} from '@/services/real/modelLeaderboard';

/** 轮播间隔。四秒够看清一行，又不至于让眼角一直被它拽走。 */
const ROTATE_MS = 4000;
/** 换行时的淡出时长，与 CSS 里的 transition 对齐。 */
const SWAP_MS = 340;

/**
 * 首页状态栏右上角的模型榜挂件（替代原来的「教程中心」徽章环，教程已挪进左下角头像菜单）。
 *
 * ## 为什么轮播
 *
 * 榜单每天才同步一次，如果挂件钉死第一名，它在视觉上就是一张静态截图——用户没有任何理由
 * 相信它是活的。轮播前三名让「这里有东西在更新」不点开也看得见（用户 2026-09-14 定的）。
 * 关掉动效偏好（prefers-reduced-motion）时不轮播，只显示榜首。
 *
 * ## 拿不到数据就不显示
 *
 * 首次同步还没跑完（ready=false）、请求失败、或者榜是空的，一律不渲染这一格——
 * 状态栏是首页的门面，宁可少一格，也不要挂一个「加载中」或者「暂无数据」在那儿。
 * 与同位置原有的 TipsEntryButton 是一样的处理。
 *
 * ## 数据陈旧时不装新鲜
 *
 * 后端 stale=true（超过两天没同步成功）时，实时点变灰、标签写出数据日期。
 * 绝不让一个绿色呼吸点挂在一份三天前的数据上。
 */
export function ModelRankWidget({ board = 'agent' }: { board?: string } = {}) {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [entries, setEntries] = useState<ModelLeaderboardEntry[]>([]);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [swapping, setSwapping] = useState(false);

  // 组件卸载后不再 setState：轮播定时器和淡出 setTimeout 都可能在卸载后才回来。
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      const res = await getModelLeaderboardTop(board, 3);
      if (cancelled || !aliveRef.current) return;
      if (res.success && res.data?.ready && res.data.entries?.length) {
        setEntries(res.data.entries);
        setStale(!!res.data.stale);
        setFetchedAt(res.data.fetchedAt ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, board]);

  const reduceMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  useEffect(() => {
    if (reduceMotion || entries.length < 2) return;
    const timer = window.setInterval(() => {
      setSwapping(true);
      window.setTimeout(() => {
        if (!aliveRef.current) return;
        setIndex((i) => (i + 1) % entries.length);
        setSwapping(false);
      }, SWAP_MS);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [entries.length, reduceMotion]);

  if (!isAuthenticated || entries.length === 0) return null;

  const current = entries[Math.min(index, entries.length - 1)];
  const isLead = current.rank === 1;

  // 数据日期只在陈旧时才占状态栏的字数，正常时标签就写榜名，保持状态栏一贯的简短。
  const staleLabel = fetchedAt
    ? `数据截至 ${new Date(fetchedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`
    : '数据可能已过期';

  return (
    <button
      type="button"
      onClick={() => navigate('/model-leaderboard')}
      data-tour-id="home-model-rank"
      title={
        stale
          ? `模型排行榜（${staleLabel}）`
          : '模型排行榜：arena.ai 公开榜单，看业界模型怎么排'
      }
      className="home-model-rank"
      aria-label="打开模型排行榜"
    >
      <span
        className={`home-model-rank-dot ${stale ? 'is-stale' : ''}`}
        aria-hidden="true"
      />
      <span className={`home-model-rank-slot ${swapping ? 'is-swapping' : ''}`}>
        <span className="home-model-rank-no">
          {String(current.rank).padStart(2, '0')}
        </span>
        <span className={`home-model-rank-mark ${isLead ? 'is-lead' : ''}`}>
          {markOf(current.organization)}
        </span>
        <span className="home-model-rank-name">{current.name}</span>
        <span className="home-model-rank-score">
          {formatScore(current.netImprovement?.value)}
        </span>
      </span>
      <span className="home-model-rank-tag">{stale ? staleLabel : '模型榜'}</span>
      <ArrowRight size={12} className="home-model-rank-arrow" />
    </button>
  );
}

/**
 * 厂商缩写。没有现成的品牌图标就用两个字母的中性标记——
 * 状态栏这一格只有 20px，贴图既看不清也会让这一行的高度失控。
 */
function markOf(organization: string | null): string {
  if (!organization) return '--';
  const cleaned = organization.trim();
  if (!cleaned) return '--';
  // 多词取首字母（Z.ai → ZA），单词取前两个字母（Anthropic → AN）
  const words = cleaned.split(/[\s.·]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * agent 榜的分数是净改进百分比，正数带加号才读得出方向。
 * 负号用真正的减号 U+2212，与榜单页同一口径（连字符在等宽字里太短，容易看漏）。
 */
function formatScore(score: number | undefined): string {
  if (score == null) return '';
  const fixed = Math.abs(score).toFixed(2);
  return score < 0 ? `−${fixed}%` : `+${fixed}%`;
}
