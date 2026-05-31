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
  BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { glassPanel } from '@/lib/glassStyles';
import { getAiNewsLatest, getAiNewsExcerpt, getAiNewsCommentary, type AiNewsFeed, type AiNewsItem } from '@/services/real/aiNews';
import {
  labelMeta,
  LABEL_REGISTRY,
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

// 'all' | 'featured' | <aiLabel 分类 key>
type Filter = string;
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
  const [tab, setTab] = useState<Filter>('all');
  const [view, setView] = useState<View>('timeline');
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(PAGE);
  // 默认内容=文章摘要片段；摘要抓不到时回退 AI 解读（备用）。
  const [excerpt, setExcerpt] = useState<Record<string, string>>({});
  const [noExcerpt, setNoExcerpt] = useState<Set<string>>(new Set());
  const [commentary, setCommentary] = useState<Record<string, string>>({});
  const excerptReqRef = useRef<Set<string>>(new Set());
  const commentaryReqRef = useRef<Set<string>>(new Set());

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
    if (tab === 'all') return all;
    if (tab === 'featured') return all.filter((x) => x.aiScore >= FEATURED_THRESHOLD);
    return all.filter((x) => x.aiLabel === tab); // 按分类筛选
  }, [feed, tab]);

  // 当前 feed 里实际出现的分类（带计数，按数量降序），只取注册表里有正式名称/颜色的
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of feed?.items ?? []) {
      if (it.aiLabel && LABEL_REGISTRY[it.aiLabel]) {
        counts.set(it.aiLabel, (counts.get(it.aiLabel) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count, meta: LABEL_REGISTRY[key] }));
  }, [feed]);

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

  // 右侧栏：精选速览列表 + 分类分布最大值（画 mini bar 用）
  const featuredItems = useMemo(
    () => sortByRecency((feed?.items ?? []).filter((x) => x.aiScore >= FEATURED_THRESHOLD)).slice(0, 12),
    [feed],
  );
  const maxCatCount = useMemo(() => categories.reduce((m, c) => Math.max(m, c.count), 0), [categories]);

  // 默认：渐进抓取可见条目的文章摘要片段。抓到的填 excerpt，没抓到的记入 noExcerpt（待回退 AI 解读）。
  useEffect(() => {
    const ids = shown.map((i) => i.id).filter((id) => id && !excerptReqRef.current.has(id));
    if (ids.length === 0) return;
    ids.forEach((id) => excerptReqRef.current.add(id));
    let alive = true;
    void (async () => {
      for (let i = 0; i < ids.length; i += 12) {
        if (!alive) return;
        const chunk = ids.slice(i, i + 12);
        const res = await getAiNewsExcerpt(chunk);
        if (!alive) return;
        const data = res.success && res.data ? res.data : {};
        setExcerpt((prev) => ({ ...prev, ...data }));
        const missing = chunk.filter((id) => !data[id]);
        if (missing.length > 0) {
          setNoExcerpt((prev) => {
            const next = new Set(prev);
            missing.forEach((id) => next.add(id));
            return next;
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [shown]);

  // 备用：仅对「确认抓不到摘要」的条目，回退拉取 AI 一句话解读。
  useEffect(() => {
    const ids = [...noExcerpt].filter((id) => !commentaryReqRef.current.has(id));
    if (ids.length === 0) return;
    ids.forEach((id) => commentaryReqRef.current.add(id));
    let alive = true;
    void (async () => {
      for (let i = 0; i < ids.length; i += 6) {
        if (!alive) return;
        const chunk = ids.slice(i, i + 6);
        const res = await getAiNewsCommentary(chunk);
        if (alive && res.success && res.data) {
          setCommentary((prev) => ({ ...prev, ...res.data }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [noExcerpt]);

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

  // ── 内容片段：默认文章摘要(无标签,纯新闻 dek)；抓不到时回退 AI 解读(带「AI解读」小标签);都没有则占位 ──
  const contentBlock = (it: AiNewsItem, meta: LabelMeta) => {
    const ex = excerpt[it.id];
    const cm = commentary[it.id];
    if (ex) {
      return (
        <div
          className="ainews-commentary mt-2 pl-3 text-[13px] leading-relaxed line-clamp-2"
          style={{ borderLeft: '2px solid var(--border-subtle, rgba(255,255,255,0.16))', color: 'var(--text-secondary, rgba(255,255,255,0.72))' }}
        >
          {ex}
        </div>
      );
    }
    if (cm) {
      return (
        <div
          className="ainews-commentary mt-2 pl-3 flex items-baseline gap-2"
          style={{ borderLeft: `2px solid ${meta.color}` }}
        >
          <span className="text-[11px] font-semibold shrink-0 tracking-wide" style={{ color: meta.color }}>AI解读</span>
          <span className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.72))' }}>{cm}</span>
        </div>
      );
    }
    return (
      <div
        className="mt-2 pl-3"
        style={{ borderLeft: '2px solid var(--border-subtle, rgba(255,255,255,0.12))' }}
      >
        <span className="ainews-shimmer text-[13px]" style={{ color: 'var(--text-muted)' }}>加载摘要…</span>
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

        {/* 视图切换 + 刷新（分类筛选移到下方独立一行） */}
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
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

      {/* ── 分类筛选 chip（全部 / 精选 / 各分类，可横向滚动） ── */}
      <div
        className="shrink-0 flex items-center gap-1.5 overflow-x-auto pb-0.5"
        style={{ scrollbarWidth: 'thin', overscrollBehaviorX: 'contain' }}
      >
        {(() => {
          const chips: Array<{ key: string; label: string; count: number; color?: string; icon?: LucideIcon }> = [
            { key: 'all', label: '全部', count: feed?.items.length ?? 0 },
            { key: 'featured', label: '精选', count: featuredCount, color: '#22d3ee' },
            ...categories.map((c) => ({ key: c.key, label: c.meta.label, count: c.count, color: c.meta.color, icon: c.meta.icon })),
          ];
          return chips.map((chip) => {
            const on = tab === chip.key;
            const accent = chip.color ?? '#22d3ee';
            const Icon = chip.icon;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => setTab(chip.key)}
                className="shrink-0 inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-full transition-colors"
                style={{
                  color: on ? (chip.color ?? 'var(--text-primary)') : 'var(--text-muted)',
                  background: on ? `${accent}1f` : 'transparent',
                  border: `1px solid ${on ? `${accent}59` : 'var(--border-subtle, rgba(255,255,255,0.08))'}`,
                }}
              >
                {Icon && <Icon size={12} style={{ color: on ? accent : 'var(--text-muted)' }} />}
                {chip.label}
                {feed && <span style={{ opacity: 0.55 }}>{chip.count}</span>}
              </button>
            );
          });
        })()}
      </div>

      {/* ── Body：左 feed（居左铺主区）+ 右 侧栏（宽屏显示，填充右侧） ── */}
      <div className="flex-1 min-h-0 flex gap-5">
        <div className="flex-1 min-w-0 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
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

                {view === 'timeline' ? (
                  // ── 单列新闻流：三列布局[时间 | 时间脊 | 内容]，节点与时间各占一列不重叠；扁平、无玻璃感 ──
                  <div className="flex flex-col">
                    {g.items.map((it, idx) => {
                      const meta = labelMeta(it.aiLabel);
                      const isLast = idx === g.items.length - 1;
                      return (
                        <a
                          key={it.id || it.url}
                          href={it.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ainews-item group flex items-stretch transition-colors hover:bg-[rgba(255,255,255,0.02)]"
                          style={{ animationDelay: `${Math.min(idx, 12) * 24}ms` }}
                        >
                          {/* 列1：绝对时间 */}
                          <div
                            className="shrink-0 pt-4 pr-3 text-right text-[12px] font-mono"
                            style={{ width: 56, color: 'var(--text-muted)' }}
                          >
                            {clockLabel(itemTime(it), g.bucket)}
                          </div>
                          {/* 列2：时间脊 + 节点（独立一列，绝不与时间重叠） */}
                          <div className="shrink-0 relative" style={{ width: 14 }}>
                            <span
                              className="absolute top-0 bottom-0"
                              style={{ left: 6, width: 1, background: 'var(--border-subtle, rgba(255,255,255,0.1))' }}
                            />
                            <span
                              className="absolute rounded-full"
                              style={{ left: 3, top: 18, width: 7, height: 7, background: meta.color }}
                            />
                          </div>
                          {/* 列3：流动内容 */}
                          <div
                            className="flex-1 min-w-0 pl-3 py-4 pr-2"
                            style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-subtle, rgba(255,255,255,0.06))' }}
                          >
                            {sourceHeader(it, meta)}
                            <div
                              className="text-[15px] font-semibold leading-snug line-clamp-2 mt-1.5 group-hover:underline"
                              style={{ color: 'var(--text-primary)', textDecorationColor: meta.color }}
                            >
                              {it.title}
                              <ExternalLink
                                size={12}
                                className="inline-block ml-1 mb-0.5 opacity-0 group-hover:opacity-60 transition-opacity"
                                style={{ color: 'var(--text-muted)' }}
                              />
                            </div>
                            {contentBlock(it, meta)}
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
                          {contentBlock(it, meta)}
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

        {/* ── 右侧栏（xl+ 才显示）：今日概览 + 精选速览，填充右侧空白 ── */}
        {!loading && !error && !(feed?.degraded ?? false) && (feed?.items.length ?? 0) > 0 && (
          <aside
            className="hidden xl:flex flex-col w-[340px] shrink-0 overflow-y-auto gap-4 pb-2"
            style={{ overscrollBehavior: 'contain' }}
          >
            {/* 今日概览 + 分类分布（点分类条可筛选） */}
            <section style={glassPanel} className="rounded-2xl p-4 shrink-0">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 size={15} style={{ color: '#22d3ee' }} />
                <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>今日概览</h3>
                <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>监测 {feed?.total ?? 0} 条</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {categories.slice(0, 9).map((c) => {
                  const Icon = c.meta.icon;
                  const pct = maxCatCount > 0 ? Math.round((c.count / maxCatCount) * 100) : 0;
                  const on = tab === c.key;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setTab(on ? 'all' : c.key)}
                      className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[rgba(255,255,255,0.04)]"
                      style={{ background: on ? `${c.meta.color}14` : 'transparent' }}
                    >
                      <Icon size={13} style={{ color: c.meta.color }} className="shrink-0" />
                      <span className="text-[12px] shrink-0 w-16 text-left truncate" style={{ color: on ? c.meta.color : 'var(--text-secondary, rgba(255,255,255,0.8))' }}>
                        {c.meta.label}
                      </span>
                      <span className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-subtle, rgba(255,255,255,0.08))' }}>
                        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: c.meta.color, opacity: on ? 1 : 0.65 }} />
                      </span>
                      <span className="text-[11px] shrink-0 w-7 text-right font-mono" style={{ color: 'var(--text-muted)' }}>{c.count}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* 精选速览 */}
            {featuredItems.length > 0 && (
              <section style={glassPanel} className="rounded-2xl p-4 flex flex-col min-h-0">
                <div className="flex items-center gap-2 mb-3 shrink-0">
                  <Sparkles size={15} style={{ color: '#67e8f9' }} />
                  <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>精选速览</h3>
                  <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>{featuredItems.length} 条高信号</span>
                </div>
                <div className="flex flex-col gap-2.5 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                  {featuredItems.map((it) => {
                    const meta = labelMeta(it.aiLabel);
                    return (
                      <a
                        key={it.id || it.url}
                        href={it.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex items-start gap-2.5"
                      >
                        <SourceAvatar url={it.url} meta={meta} size={28} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12.5px] leading-snug line-clamp-2 group-hover:underline" style={{ color: 'var(--text-primary)', textDecorationColor: meta.color }}>
                            {it.title}
                          </div>
                          <div className="text-[10px] mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                            <span style={{ color: meta.color }}>{meta.label}</span>
                            <span style={{ opacity: 0.5 }}>·</span>
                            <span>{relTime(itemTime(it), now)}</span>
                          </div>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </section>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
