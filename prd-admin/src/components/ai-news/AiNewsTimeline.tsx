import { useCallback, useEffect, useMemo, useState } from 'react';
import { Radio, RefreshCw, ExternalLink, Newspaper, Sparkles, ChevronDown } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { glassPanel } from '@/lib/glassStyles';
import { getAiNewsLatest, type AiNewsFeed, type AiNewsItem } from '@/services/real/aiNews';
import {
  labelMeta,
  itemTime,
  relTime,
  parseTime,
  bucketOf,
  BUCKET_LABEL,
  FEATURED_THRESHOLD,
  sortByRecency,
  type Bucket,
} from './aiNewsShared';
import './aiNews.css';

/**
 * 更新中心「AI 大事」时间线。
 *
 * 时间分组（刚刚 / 今天 / 昨天 / 更早）+ 响应式资讯卡网格，比首页小卡 teaser 看得更全、更远。
 * - live 脉冲 + 90s 轮询 + 切回标签页刷新 + 相对时间跳秒
 * - 全部 / 精选筛选
 * - 「加载更多」逐批揭示，可一直往下看（后端返回上限已提到 200 条）
 */

const POLL_MS = 90_000;
const TICK_MS = 30_000;
const PAGE = 24; // 每批揭示条数

type Tab = 'all' | 'featured';

export function AiNewsTimeline() {
  const [feed, setFeed] = useState<AiNewsFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(PAGE);

  const load = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    const res = await getAiNewsLatest();
    if (res.success && res.data) {
      setFeed(res.data);
      setError(false);
    } else if (initial) {
      setError(true);
    }
    setNow(Date.now());
    if (initial) setLoading(false);
    else setRefreshing(false);
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(false), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') void load(false);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // 切换筛选时重置揭示数量
  useEffect(() => {
    setVisible(PAGE);
  }, [tab]);

  const allItems = useMemo(() => {
    const all = sortByRecency(feed?.items ?? []);
    return tab === 'featured' ? all.filter((x) => x.aiScore >= FEATURED_THRESHOLD) : all;
  }, [feed, tab]);

  const shown = useMemo(() => allItems.slice(0, visible), [allItems, visible]);
  const hasMore = visible < allItems.length;
  const generatedMs = useMemo(() => parseTime(feed?.generatedAt ?? null), [feed]);

  // 揭示的条目按时间分组
  const groups = useMemo(() => {
    const out: Array<{ bucket: Bucket; items: AiNewsItem[] }> = [];
    let cur: { bucket: Bucket; items: AiNewsItem[] } | null = null;
    for (const it of shown) {
      const b = bucketOf(itemTime(it), now);
      if (!cur || cur.bucket !== b) {
        cur = { bucket: b, items: [] };
        out.push(cur);
      }
      cur.items.push(it);
    }
    return out;
  }, [shown, now]);

  const featuredCount = useMemo(
    () => (feed?.items ?? []).filter((x) => x.aiScore >= FEATURED_THRESHOLD).length,
    [feed],
  );

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* ── Header ── */}
      <header style={glassPanel} className="rounded-2xl px-5 py-4 flex items-center gap-3 shrink-0 flex-wrap">
        <span
          className="ainews-live-dot inline-flex shrink-0"
          style={{ width: 10, height: 10, borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 10px #22d3ee' }}
        >
          <span className="ainews-live-core" style={{ width: 10, height: 10, borderRadius: '50%', background: '#22d3ee' }} />
        </span>
        <Radio size={17} style={{ color: '#22d3ee' }} />
        <div className="flex flex-col min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
            AI 大事 · 实时资讯
          </h2>
          <div className="text-[11px] flex items-center gap-1.5 flex-wrap mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {feed && !error ? (
              <>
                <span>最近同步 {relTime(generatedMs, now) || '刚刚'}</span>
                <span style={{ opacity: 0.5 }}>·</span>
                <span>监测 {feed.total} 条 · 每 30 分钟自更新</span>
                {feed.stale && (
                  <>
                    <span style={{ opacity: 0.5 }}>·</span>
                    <span style={{ color: '#fbbf24' }}>暂用缓存</span>
                  </>
                )}
              </>
            ) : (
              <span>来自 ai-news-radar 公共源</span>
            )}
          </div>
        </div>

        {/* 筛选 */}
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          {(['all', 'featured'] as Tab[]).map((t) => {
            const on = tab === t;
            const cnt = t === 'all' ? feed?.items.length ?? 0 : featuredCount;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="text-[12px] px-3 py-1.5 rounded-full transition-colors"
                style={{
                  color: on ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: on ? 'rgba(34,211,238,0.14)' : 'transparent',
                  border: `1px solid ${on ? 'rgba(34,211,238,0.34)' : 'var(--border-subtle, rgba(255,255,255,0.08))'}`,
                }}
              >
                {t === 'featured' ? '精选' : '全部'}
                {feed && <span style={{ opacity: 0.55, marginLeft: 5 }}>{cnt}</span>}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => void load(false)}
            disabled={refreshing}
            aria-label="刷新资讯"
            className="w-8 h-8 rounded-lg inline-flex items-center justify-center transition-colors"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))' }}
          >
            <RefreshCw size={14} className={refreshing ? 'ainews-spinning' : ''} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div
        className="flex-1 min-h-0 overflow-y-auto pr-1"
        style={{ overscrollBehavior: 'contain' }}
      >
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <MapSpinner size={26} color="#22d3ee" />
          </div>
        ) : error || (feed?.degraded ?? false) ? (
          <div style={glassPanel} className="rounded-2xl flex flex-col items-center justify-center text-center gap-2 py-20">
            <Newspaper size={30} style={{ color: 'var(--text-muted)' }} />
            <div className="text-[14px]" style={{ color: 'var(--text-primary)' }}>暂无最新资讯</div>
            <div className="text-[12px] max-w-[260px]" style={{ color: 'var(--text-muted)' }}>
              资讯源暂时不可达，稍后会自动恢复
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              className="mt-1 text-[13px] px-4 py-1.5 rounded-lg inline-flex items-center gap-1.5"
              style={{ background: 'rgba(34,211,238,0.14)', color: '#67e8f9', border: '1px solid rgba(34,211,238,0.34)' }}
            >
              <RefreshCw size={13} /> 重试
            </button>
          </div>
        ) : allItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-20">
            <Sparkles size={26} style={{ color: 'var(--text-muted)' }} />
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>该筛选下暂无资讯，试试「全部」</div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((g, gi) => (
              <section key={`${g.bucket}-${gi}`} className="flex flex-col gap-3">
                {/* 分组标题 */}
                <div className="flex items-center gap-2.5">
                  <span className="text-[12px] font-semibold shrink-0" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.75))' }}>
                    {BUCKET_LABEL[g.bucket]}
                  </span>
                  <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{g.items.length}</span>
                  <span className="flex-1 h-px" style={{ background: 'var(--border-subtle, rgba(255,255,255,0.08))' }} />
                </div>

                {/* 资讯卡网格 */}
                <div
                  className="grid"
                  style={{ gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
                >
                  {g.items.map((it, idx) => {
                    const meta = labelMeta(it.aiLabel);
                    const Icon = meta.icon;
                    const featured = it.aiScore >= FEATURED_THRESHOLD;
                    return (
                      <a
                        key={it.id || it.url}
                        href={it.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ainews-item group relative rounded-xl overflow-hidden flex flex-col p-4 transition-all duration-200 hover:-translate-y-0.5"
                        style={{
                          ...glassPanel,
                          animationDelay: `${Math.min(idx, 10) * 26}ms`,
                        }}
                      >
                        {/* 左侧类别色条 */}
                        <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: meta.color }} />
                        {/* hover 辉光 */}
                        <span
                          className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                          style={{ boxShadow: `inset 0 0 0 1px ${meta.color}55, 0 0 22px ${meta.color}1a` }}
                        />

                        <div
                          className="text-[13.5px] font-medium leading-snug line-clamp-3 transition-colors"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {it.title}
                          <ExternalLink
                            size={12}
                            className="inline-block ml-1 mb-0.5 opacity-0 group-hover:opacity-60 transition-opacity"
                            style={{ color: 'var(--text-muted)' }}
                          />
                        </div>

                        <div className="flex items-center gap-2 mt-auto pt-3 flex-wrap">
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded"
                            style={{ background: `${meta.color}1f`, color: meta.color }}
                          >
                            <Icon size={10} />
                            {meta.label}
                          </span>
                          {featured && (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded"
                              style={{ background: 'rgba(34,211,238,0.14)', color: '#67e8f9' }}
                            >
                              <Sparkles size={9} /> 精选
                            </span>
                          )}
                          {it.source && (
                            <span className="text-[11px] truncate max-w-[140px]" style={{ color: 'var(--text-muted)' }}>
                              {it.source}
                            </span>
                          )}
                          <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>
                            {relTime(itemTime(it), now)}
                          </span>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </section>
            ))}

            {/* 加载更多 / 看更远 */}
            {hasMore ? (
              <button
                type="button"
                onClick={() => setVisible((v) => v + PAGE)}
                className="self-center mt-1 mb-2 text-[13px] px-5 py-2 rounded-full inline-flex items-center gap-1.5 transition-colors"
                style={{ background: 'rgba(34,211,238,0.12)', color: '#67e8f9', border: '1px solid rgba(34,211,238,0.3)' }}
              >
                <ChevronDown size={14} /> 加载更多 · 还有 {allItems.length - visible} 条
              </button>
            ) : (
              allItems.length > PAGE && (
                <div className="self-center mt-1 mb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  已到底 · 共 {allItems.length} 条
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
