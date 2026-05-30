import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Radio,
  RefreshCw,
  ExternalLink,
  Rocket,
  Sparkles,
  Wrench,
  FlaskConical,
  ScrollText,
  TrendingUp,
  Landmark,
  Megaphone,
  Boxes,
  Newspaper,
  type LucideIcon,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getAiNewsLatest, type AiNewsFeed, type AiNewsItem } from '@/services/real/aiNews';
import './AiNewsRadar.css';

/**
 * 首页「AI 大事早知道」资讯雷达。
 *
 * 位于首页四大板块（更新中心）右侧的整列 rail，以时间线形式滚动展示最近 24h AI 资讯。
 * 数据走 prd-api 代理（缓存 ai-news-radar 公共源）。
 *
 * 「活的」体验：
 * - live 脉冲灯 + 雷达扩散圈
 * - 相对时间每 30s 自动跳秒（"3 分钟前" → "4 分钟前"）
 * - 90s 轮询 + 切回标签页自动刷新；拉到更新内容时浮出「有新内容」并高亮首条
 * - 新条目入场动画
 */

// ── ai_label → 中文 / 颜色 / 图标 注册表（禁止组件内 switch，遵守注册表模式规则）──
interface LabelMeta {
  label: string;
  color: string;
  icon: LucideIcon;
}

const LABEL_REGISTRY: Record<string, LabelMeta> = {
  model_release: { label: '模型发布', color: '#4ade80', icon: Rocket },
  ai_general: { label: 'AI 动态', color: '#a5b4fc', icon: Sparkles },
  product: { label: '产品', color: '#22d3ee', icon: Boxes },
  product_launch: { label: '新品', color: '#22d3ee', icon: Boxes },
  tool: { label: '工具', color: '#fbbf24', icon: Wrench },
  research: { label: '研究', color: '#f472b6', icon: FlaskConical },
  paper: { label: '论文', color: '#f472b6', icon: ScrollText },
  funding: { label: '融资', color: '#34d399', icon: TrendingUp },
  business: { label: '商业', color: '#34d399', icon: TrendingUp },
  policy: { label: '政策', color: '#fb923c', icon: Landmark },
  opinion: { label: '观点', color: '#fbbf24', icon: Megaphone },
};

const DEFAULT_LABEL: LabelMeta = { label: '资讯', color: '#94a3b8', icon: Newspaper };

function labelMeta(key: string): LabelMeta {
  return LABEL_REGISTRY[key] ?? DEFAULT_LABEL;
}

// ── 时间工具 ──

function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function itemTime(it: AiNewsItem): number | null {
  return parseTime(it.publishedAt) ?? parseTime(it.firstSeenAt);
}

function relTime(ms: number | null, now: number): string {
  if (ms == null) return '';
  const diff = Math.max(0, now - ms);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

type Bucket = 'now' | 'today' | 'yesterday' | 'earlier' | 'unknown';

function bucketOf(ms: number | null, now: number): Bucket {
  if (ms == null) return 'unknown';
  const diff = now - ms;
  if (diff < 3600_000) return 'now';
  const d0 = new Date(now);
  const di = new Date(ms);
  const sameDay = d0.getFullYear() === di.getFullYear() && d0.getMonth() === di.getMonth() && d0.getDate() === di.getDate();
  if (sameDay) return 'today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const isYesterday = y.getFullYear() === di.getFullYear() && y.getMonth() === di.getMonth() && y.getDate() === di.getDate();
  if (isYesterday) return 'yesterday';
  return 'earlier';
}

const BUCKET_LABEL: Record<Bucket, string> = {
  now: '刚刚 · 1 小时内',
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
  unknown: '近期',
};

const POLL_MS = 90_000;
const TICK_MS = 30_000;
// 精选阈值：源站多数条目 ~0.65，0.7 用于挑出更高信号项（0.78~0.92）。
const FEATURED_THRESHOLD = 0.7;

type Tab = 'featured' | 'all';

export function AiNewsRadar() {
  const [feed, setFeed] = useState<AiNewsFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  // 默认「全部」：保证首屏资讯充实、rail 不留白（精选作为可选高信号筛选）。
  const [tab, setTab] = useState<Tab>('all');
  const [now, setNow] = useState(() => Date.now());
  const [justUpdated, setJustUpdated] = useState(false);

  const topIdRef = useRef<string | null>(null);
  const updatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    const res = await getAiNewsLatest();
    if (res.success && res.data) {
      const nextTop = res.data.items[0]?.id ?? null;
      // 非首次加载且首条变化 → 标记「有新内容」
      if (!initial && nextTop && topIdRef.current && nextTop !== topIdRef.current) {
        setJustUpdated(true);
        if (updatedTimerRef.current) clearTimeout(updatedTimerRef.current);
        updatedTimerRef.current = setTimeout(() => setJustUpdated(false), 5000);
      }
      topIdRef.current = nextTop;
      setFeed(res.data);
      setError(false);
    } else if (initial) {
      setError(true);
    }
    setNow(Date.now());
    if (initial) setLoading(false);
    else setRefreshing(false);
  }, []);

  // 首次加载
  useEffect(() => {
    void load(true);
  }, [load]);

  // 轮询 + 切回标签页刷新
  useEffect(() => {
    const id = setInterval(() => void load(false), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') void load(false);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      if (updatedTimerRef.current) clearTimeout(updatedTimerRef.current);
    };
  }, [load]);

  // 相对时间跳秒
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const items = useMemo(() => {
    const all = feed?.items ?? [];
    return tab === 'featured' ? all.filter((x) => x.aiScore >= FEATURED_THRESHOLD) : all;
  }, [feed, tab]);

  const generatedMs = useMemo(() => parseTime(feed?.generatedAt ?? null), [feed]);

  // 渲染时插入分组标签
  const rows = useMemo(() => {
    const out: Array<{ kind: 'group'; bucket: Bucket } | { kind: 'item'; item: AiNewsItem }> = [];
    let last: Bucket | null = null;
    for (const it of items) {
      const b = bucketOf(itemTime(it), now);
      if (b !== last) {
        out.push({ kind: 'group', bucket: b });
        last = b;
      }
      out.push({ kind: 'item', item: it });
    }
    return out;
  }, [items, now]);

  const surface: React.CSSProperties = {
    background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
    border: '1px solid rgba(255,255,255,0.08)',
  };

  return (
    <div className="relative rounded-2xl overflow-hidden flex flex-col min-h-0 h-full" style={{ ...surface, minHeight: 300 }}>
      {/* 顶部柔光 */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: -50,
          right: -30,
          width: 200,
          height: 200,
          background: 'radial-gradient(circle at center, rgba(34,211,238,0.18) 0%, transparent 70%)',
        }}
      />

      {/* Header */}
      <div className="relative z-10 flex items-center gap-2.5 px-4 pt-4 pb-3 shrink-0">
        <span
          className="ainr-live-dot inline-flex shrink-0"
          style={{ width: 9, height: 9, borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 10px #22d3ee' }}
        >
          <span className="ainr-live-core" style={{ width: 9, height: 9, borderRadius: '50%', background: '#22d3ee' }} />
        </span>
        <div className="flex items-center gap-1.5 min-w-0">
          <Radio size={15} style={{ color: '#22d3ee' }} />
          <h2
            className="text-[14px] font-semibold truncate"
            style={{ color: 'var(--text-primary, #fff)', textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
          >
            AI 大事早知道
          </h2>
        </div>

        {justUpdated && (
          <span
            className="ainr-updated-pill ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
            style={{ background: 'rgba(34,211,238,0.18)', color: '#67e8f9', border: '1px solid rgba(34,211,238,0.4)' }}
          >
            有新内容
          </span>
        )}

        <button
          type="button"
          onClick={() => void load(false)}
          disabled={refreshing}
          aria-label="刷新资讯"
          className="ml-auto shrink-0 w-7 h-7 rounded-lg inline-flex items-center justify-center transition-colors"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <RefreshCw size={13} className={refreshing ? 'ainr-spinning' : ''} style={{ color: 'var(--text-muted, rgba(255,255,255,0.6))' }} />
        </button>
      </div>

      {/* 同步状态行 */}
      <div className="relative z-10 px-4 pb-2 shrink-0">
        <div className="text-[11px] flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--text-muted, rgba(255,255,255,0.5))' }}>
          {feed && !error ? (
            <>
              <span>最近同步 {relTime(generatedMs, now) || '刚刚'}</span>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>每 30 分钟自更新</span>
              {feed.stale && (
                <>
                  <span style={{ opacity: 0.5 }}>·</span>
                  <span style={{ color: '#fbbf24' }}>暂用缓存</span>
                </>
              )}
            </>
          ) : (
            <span>实时 AI 资讯雷达</span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="relative z-10 flex items-center gap-1.5 px-4 pb-2 shrink-0">
        {(['featured', 'all'] as Tab[]).map((t) => {
          const on = tab === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="text-[12px] px-3 py-1 rounded-full transition-colors"
              style={{
                color: on ? 'var(--text-primary, #fff)' : 'var(--text-muted, rgba(255,255,255,0.55))',
                background: on ? 'rgba(34,211,238,0.14)' : 'transparent',
                border: `1px solid ${on ? 'rgba(34,211,238,0.34)' : 'transparent'}`,
              }}
            >
              {t === 'featured' ? '精选' : '全部'}
            </button>
          );
        })}
      </div>

      {/* Timeline body */}
      <div
        className="relative z-10 flex-1 min-h-0 overflow-y-auto px-4 pb-3"
        style={{ overscrollBehavior: 'contain' }}
      >
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <MapSpinner size={22} color="#22d3ee" />
          </div>
        ) : error || (feed?.degraded ?? false) ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-14">
            <Newspaper size={26} style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }} />
            <div className="text-[13px]" style={{ color: 'var(--text-primary, #fff)' }}>暂无最新资讯</div>
            <div className="text-[11px] max-w-[220px]" style={{ color: 'var(--text-muted, rgba(255,255,255,0.5))' }}>
              资讯源暂时不可达，稍后会自动恢复
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              className="mt-1 text-[12px] px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5"
              style={{ background: 'rgba(34,211,238,0.14)', color: '#67e8f9', border: '1px solid rgba(34,211,238,0.34)' }}
            >
              <RefreshCw size={12} /> 重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-14">
            <Sparkles size={24} style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }} />
            <div className="text-[12px]" style={{ color: 'var(--text-muted, rgba(255,255,255,0.55))' }}>
              该筛选下暂无资讯，试试「全部」
            </div>
          </div>
        ) : (
          <div className="pt-1">
            {rows.map((row, idx) => {
              if (row.kind === 'group') {
                return (
                  <div
                    key={`g-${row.bucket}-${idx}`}
                    className="flex items-center gap-2 text-[11px] mt-3 mb-2 first:mt-1"
                    style={{ color: 'var(--text-muted, rgba(255,255,255,0.5))' }}
                  >
                    <span className="shrink-0">{BUCKET_LABEL[row.bucket]}</span>
                    <span className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.08)' }} />
                  </div>
                );
              }
              const it = row.item;
              const meta = labelMeta(it.aiLabel);
              const Icon = meta.icon;
              const isTop = idx <= 1 && justUpdated;
              return (
                <a
                  key={it.id || it.url}
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ainr-item group relative block pl-5 pb-3.5"
                  style={{ animationDelay: `${Math.min(idx, 8) * 28}ms` }}
                >
                  {/* 时间线节点 + 竖脊 */}
                  <span
                    className="absolute rounded-full"
                    style={{ left: 2, top: 5, width: 8, height: 8, background: meta.color, boxShadow: `0 0 0 3px ${meta.color}26` }}
                  />
                  <span
                    className="absolute"
                    style={{ left: 5.5, top: 13, bottom: -4, width: 1, background: 'rgba(255,255,255,0.09)' }}
                  />

                  <div
                    className="text-[13px] leading-snug transition-colors"
                    style={{
                      color: isTop ? '#67e8f9' : 'var(--text-primary, #fff)',
                      textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                    }}
                  >
                    <span className="group-hover:underline" style={{ textDecorationColor: meta.color }}>
                      {it.title}
                    </span>
                    <ExternalLink
                      size={11}
                      className="inline-block ml-1 mb-0.5 opacity-0 group-hover:opacity-70 transition-opacity"
                      style={{ color: 'var(--text-muted, rgba(255,255,255,0.6))' }}
                    />
                  </div>

                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span
                      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: `${meta.color}1f`, color: meta.color }}
                    >
                      <Icon size={10} />
                      {meta.label}
                    </span>
                    {it.source && (
                      <span className="text-[11px] truncate max-w-[120px]" style={{ color: 'var(--text-muted, rgba(255,255,255,0.5))' }}>
                        {it.source}
                      </span>
                    )}
                    <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-muted, rgba(255,255,255,0.4))' }}>
                      {relTime(itemTime(it), now)}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      {feed && !error && !feed.degraded && (
        <div
          className="relative z-10 px-4 py-2.5 text-[11px] text-center shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.07)', color: 'var(--text-muted, rgba(255,255,255,0.45))' }}
        >
          雷达监测 {feed.total} 条 · 来自 ai-news-radar
        </div>
      )}
    </div>
  );
}
