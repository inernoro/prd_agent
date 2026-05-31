import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Radio,
  RefreshCw,
  ExternalLink,
  Newspaper,
  Sparkles,
  ChevronDown,
  List,
  LayoutGrid,
  Quote,
  type LucideIcon,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { glassPanel } from '@/lib/glassStyles';
import { getAiNewsLatest, getAiNewsCommentary, type AiNewsFeed, type AiNewsItem } from '@/services/real/aiNews';
import {
  labelMeta,
  itemTime,
  relTime,
  parseTime,
  bucketOf,
  BUCKET_LABEL,
  clockLabel,
  FEATURED_THRESHOLD,
  sortByRecency,
  type LabelMeta,
  type Bucket,
} from './aiNewsShared';
import './aiNews.css';

/**
 * 更新中心「AI 大事」资讯阅读区。
 *
 * 默认单列新闻流时间线（像新闻 App / RSS 阅读器，逐条从上到下，配来源站图标），
 * 可切换到网格视图。比首页小卡 teaser 看得更全、更远。
 * - live 脉冲 + 90s 轮询 + 切回标签页刷新 + 相对时间跳秒
 * - 全部 / 精选筛选 + 时间线 / 网格视图切换
 * - 「加载更多」逐批揭示（后端返回上限已提到 200 条）
 * - 图片：阶段一用来源站 favicon（失败回退分类图标），阶段二再上文章 og:image 大图
 */

const POLL_MS = 90_000;
const TICK_MS = 30_000;
const PAGE = 24; // 每批揭示条数

type Tab = 'all' | 'featured';
type View = 'timeline' | 'grid';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 来源站图标：favicon 优先，加载失败回退到分类图标色块。 */
function SourceAvatar({ url, meta, size = 40 }: { url: string; meta: LabelMeta; size?: number }) {
  const host = useMemo(() => hostOf(url), [url]);
  const [failed, setFailed] = useState(false);
  const Icon = meta.icon;

  if (!host || failed) {
    return (
      <div
        className="shrink-0 inline-flex items-center justify-center rounded-lg"
        style={{ width: size, height: size, background: `${meta.color}24`, border: `1px solid ${meta.color}40` }}
      >
        <Icon size={Math.round(size * 0.46)} style={{ color: meta.color }} />
      </div>
    );
  }
  return (
    <img
      src={`https://${host}/favicon.ico`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-lg object-cover"
      style={{ width: size, height: size, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))' }}
    />
  );
}

export function AiNewsTimeline() {
  const [feed, setFeed] = useState<AiNewsFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [view, setView] = useState<View>('timeline');
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(PAGE);
  // AI 一句话解读：id -> 文本；已请求过的 id 记到 ref 避免重复拉取
  const [commentary, setCommentary] = useState<Record<string, string>>({});
  const requestedRef = useRef<Set<string>>(new Set());

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

  // 渐进拉取可见条目的「一句话 AI 解读」：每出现一批新 id 就请求一次（后端缓存 + 批量 LLM）
  useEffect(() => {
    const ids = shown.map((i) => i.id).filter((id) => id && !requestedRef.current.has(id));
    if (ids.length === 0) return;
    ids.forEach((id) => requestedRef.current.add(id));
    let alive = true;
    void (async () => {
      // 分批（与后端单次上限对齐），逐批回填，体验上「逐条活起来」
      for (let i = 0; i < ids.length; i += 10) {
        if (!alive) return;
        const chunk = ids.slice(i, i + 10);
        const res = await getAiNewsCommentary(chunk);
        if (alive && res.success && res.data) {
          setCommentary((prev) => ({ ...prev, ...res.data }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [shown]);

  // ── 来源身份行：favicon + 来源名 + 站点名 + 相对时间 ──
  const sourceHeader = (it: AiNewsItem, meta: LabelMeta) => (
    <div className="flex items-center gap-2 min-w-0">
      <SourceAvatar url={it.url} meta={meta} size={26} />
      <span className="text-[12px] font-semibold truncate max-w-[180px]" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.82))' }}>
        {it.source || hostOf(it.url)}
      </span>
      {it.siteName && it.siteName !== it.source && (
        <span className="text-[11px] truncate max-w-[120px]" style={{ color: 'var(--text-muted)' }}>
          {it.siteName}
        </span>
      )}
      <span className="text-[11px] ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>
        {relTime(itemTime(it), now)}
      </span>
    </div>
  );

  // ── 标签行：分类 + 精选 + 命中关键词（最多 3 个）──
  const tagRow = (it: AiNewsItem, meta: LabelMeta) => {
    const Icon = meta.icon;
    const featured = it.aiScore >= FEATURED_THRESHOLD;
    const signals = (it.aiSignals ?? []).filter(Boolean).slice(0, 3);
    return (
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
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
        {signals.map((s) => (
          <span
            key={s}
            className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))' }}
          >
            {s}
          </span>
        ))}
      </div>
    );
  };

  // ── AI 一句话解读（内容主体）：未生成时呼吸占位，生成后淡入 ──
  const commentaryBlock = (it: AiNewsItem, meta: LabelMeta) => {
    const text = commentary[it.id];
    return (
      <div
        className="mt-2.5 flex items-start gap-2 rounded-lg pl-2.5 pr-3 py-2"
        style={{ background: `${meta.color}12`, borderLeft: `2px solid ${meta.color}` }}
      >
        <Quote size={12} className="shrink-0 mt-0.5" style={{ color: meta.color }} />
        {text ? (
          <span className="ainews-commentary text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.82))' }}>
            {text}
          </span>
        ) : (
          <span className="ainews-shimmer text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            AI 正在解读这条资讯…
          </span>
        )}
      </div>
    );
  };

  const ViewToggleBtn = ({ v, icon: Icon, label }: { v: View; icon: LucideIcon; label: string }) => {
    const on = view === v;
    return (
      <button
        type="button"
        onClick={() => setView(v)}
        aria-label={label}
        title={label}
        className="w-8 h-8 rounded-lg inline-flex items-center justify-center transition-colors"
        style={{
          background: on ? 'rgba(34,211,238,0.14)' : 'transparent',
          border: `1px solid ${on ? 'rgba(34,211,238,0.34)' : 'var(--border-subtle, rgba(255,255,255,0.08))'}`,
          color: on ? '#67e8f9' : 'var(--text-muted)',
        }}
      >
        <Icon size={15} />
      </button>
    );
  };

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

        {/* 筛选 + 视图切换 + 刷新 */}
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
          <span className="w-px h-5 mx-0.5" style={{ background: 'var(--border-subtle, rgba(255,255,255,0.1))' }} />
          <ViewToggleBtn v="timeline" icon={List} label="时间线视图" />
          <ViewToggleBtn v="grid" icon={LayoutGrid} label="网格视图" />
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
      <div className="flex-1 min-h-0 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
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
          // 单列新闻流时间线居中阅读列；网格视图铺满宽度
          <div style={view === 'timeline' ? { maxWidth: 900, margin: '0 auto' } : undefined} className="flex flex-col gap-5">
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

                {view === 'timeline' ? (
                  // ── 单列新闻流：左侧绝对时间轴(HH:MM) + 贯穿时间脊 + 流动条目(不单独框) ──
                  <div className="relative">
                    {/* 时间脊（贯穿整组时间轴列） */}
                    <span
                      className="absolute top-3 bottom-3 w-px"
                      style={{ left: 47, background: 'var(--border-subtle, rgba(255,255,255,0.12))' }}
                    />
                    {g.items.map((it, idx) => {
                      const meta = labelMeta(it.aiLabel);
                      const isLast = idx === g.items.length - 1;
                      return (
                        <a
                          key={it.id || it.url}
                          href={it.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ainews-item group relative flex items-stretch gap-3 transition-colors hover:bg-[rgba(255,255,255,0.025)] rounded-lg"
                          style={{
                            animationDelay: `${Math.min(idx, 12) * 24}ms`,
                            borderBottom: isLast ? 'none' : '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
                          }}
                        >
                          {/* 左：绝对时间 + 脊上节点 */}
                          <div className="shrink-0 relative" style={{ width: 40 }}>
                            <span
                              className="block text-[12px] font-mono font-semibold pt-4 text-right"
                              style={{ color: 'var(--text-secondary, rgba(255,255,255,0.65))' }}
                            >
                              {clockLabel(itemTime(it), g.bucket)}
                            </span>
                            <span
                              className="absolute rounded-full z-10"
                              style={{ left: 47 - 12, top: 19, width: 9, height: 9, background: meta.color, boxShadow: `0 0 0 3px var(--bg-card, #1E1F20), 0 0 8px ${meta.color}80` }}
                            />
                          </div>
                          {/* 右：流动内容（无边框卡） */}
                          <div className="flex-1 min-w-0 py-3.5 pr-2">
                            {sourceHeader(it, meta)}
                            <div
                              className="text-[15px] font-semibold leading-snug line-clamp-2 mt-2 group-hover:underline"
                              style={{ color: 'var(--text-primary)', textDecorationColor: meta.color }}
                            >
                              {it.title}
                              <ExternalLink
                                size={12}
                                className="inline-block ml-1 mb-0.5 opacity-0 group-hover:opacity-60 transition-opacity"
                                style={{ color: 'var(--text-muted)' }}
                              />
                            </div>
                            {commentaryBlock(it, meta)}
                            {tagRow(it, meta)}
                          </div>
                        </a>
                      );
                    })}
                  </div>
                ) : (
                  // ── 网格视图 ──
                  <div className="grid" style={{ gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                    {g.items.map((it, idx) => {
                      const meta = labelMeta(it.aiLabel);
                      return (
                        <a
                          key={it.id || it.url}
                          href={it.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ainews-item group relative rounded-xl overflow-hidden flex flex-col p-4 transition-all duration-200 hover:-translate-y-0.5"
                          style={{ ...glassPanel, animationDelay: `${Math.min(idx, 10) * 26}ms` }}
                        >
                          <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: meta.color }} />
                          <span
                            className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                            style={{ boxShadow: `inset 0 0 0 1px ${meta.color}55, 0 0 22px ${meta.color}1a` }}
                          />
                          {sourceHeader(it, meta)}
                          <div
                            className="text-[13.5px] font-medium leading-snug line-clamp-2 transition-colors mt-2"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {it.title}
                          </div>
                          {commentaryBlock(it, meta)}
                          {tagRow(it, meta)}
                        </a>
                      );
                    })}
                  </div>
                )}
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
