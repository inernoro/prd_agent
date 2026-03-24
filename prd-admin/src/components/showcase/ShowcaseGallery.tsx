import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, BookOpen, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { SubmissionDetailModal } from './SubmissionDetailModal';
import {
  listPublicSubmissions,
  likeSubmission,
  unlikeSubmission,
  adminWithdrawSubmission,
  type SubmissionItem,
} from '@/services/real/submissions';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import { HeartLikeButton } from '@/components/effects/HeartLikeButton';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';

const TABS = [
  { key: '', label: '全部' },
  { key: 'visual', label: '视觉创作' },
  { key: 'literary', label: '文学创作' },
] as const;

const PAGE_SIZE = 20;

/** Distribute items into columns by shortest-column-first for waterfall layout */
function distributeToColumns<T extends { coverWidth: number; coverHeight: number }>(
  items: T[],
  columnCount: number,
): T[][] {
  const columns: T[][] = Array.from({ length: columnCount }, () => []);
  const heights = new Array(columnCount).fill(0);
  for (const item of items) {
    const ratio = item.coverWidth && item.coverHeight ? item.coverHeight / item.coverWidth : 0.625;
    const shortest = heights.indexOf(Math.min(...heights));
    columns[shortest].push(item);
    heights[shortest] += ratio;
  }
  return columns;
}

/** Get aspect ratio string for a submission item */
function getAspectRatio(item: SubmissionItem): string {
  if (item.coverWidth && item.coverHeight) {
    return `${item.coverWidth}/${item.coverHeight}`;
  }
  return '16/10';
}

/* ── NotebookLM-style gradient fallbacks ── */
const FALLBACK_GRADIENTS = [
  'linear-gradient(135deg, #1a1a2e 0%, #16213e 40%, #0f3460 100%)',
  'linear-gradient(135deg, #2d1b69 0%, #11998e 100%)',
  'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
  'linear-gradient(135deg, #0f2027 0%, #203a43 40%, #2c5364 100%)',
  'linear-gradient(135deg, #1a002e 0%, #3d1f5c 50%, #5c3d7a 100%)',
  'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
];

function getFallbackGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return FALLBACK_GRADIENTS[Math.abs(hash) % FALLBACK_GRADIENTS.length];
}

/* ── Unified NotebookLM-style Card ── */

function ShowcaseCard({
  item,
  onLikeToggle,
  onClick,
  isAdmin,
  onAdminWithdraw,
}: {
  item: SubmissionItem;
  onLikeToggle?: (id: string, liked: boolean) => Promise<void>;
  onClick?: () => void;
  isAdmin?: boolean;
  onAdminWithdraw?: (id: string) => void;
}) {
  const [liked, setLiked] = useState(item.likedByMe);
  const [likeCount, setLikeCount] = useState(item.likeCount);
  const [liking, setLiking] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => { setLiked(item.likedByMe); }, [item.likedByMe]);
  useEffect(() => { setLikeCount(item.likeCount); }, [item.likeCount]);

  const avatarUrl = resolveAvatarUrl({ avatarFileName: item.ownerAvatarFileName });
  const hasCover = !!item.coverUrl && !imgError;

  const handleLike = async () => {
    if (liking) return;
    setLiking(true);
    const newLiked = !liked;
    setLiked(newLiked);
    setLikeCount((c) => c + (newLiked ? 1 : -1));
    try {
      await onLikeToggle?.(item.id, newLiked);
    } catch {
      setLiked(!newLiked);
      setLikeCount((c) => c + (newLiked ? -1 : 1));
    } finally {
      setLiking(false);
    }
  };

  return (
    <div
      className="group cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
    >
      {/* Card — full-bleed image/gradient, natural aspect ratio for waterfall */}
      <div
        className="relative w-full overflow-hidden rounded-xl transition-all duration-300 group-hover:shadow-xl group-hover:shadow-black/30 group-hover:scale-[1.02]"
        style={{
          aspectRatio: getAspectRatio(item),
          background: hasCover ? '#0a0a0f' : getFallbackGradient(item.id),
        }}
      >
        {/* Cover image */}
        {item.coverUrl && !imgError && (
          <img
            src={item.coverUrl}
            alt={item.title}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.06]"
            style={{ opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.5s ease' }}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
          />
        )}

        {/* Decorative quote for no-image literary cards */}
        {!hasCover && item.contentType === 'literary' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
            <span className="text-[100px] font-serif leading-none" style={{ color: 'rgba(255,255,255,0.04)' }}>"</span>
          </div>
        )}

        {/* Bottom gradient overlay for text readability */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: hasCover
              ? 'linear-gradient(180deg, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0.12) 35%, rgba(0,0,0,0.72) 100%)'
              : 'linear-gradient(180deg, transparent 30%, rgba(0,0,0,0.4) 100%)',
          }}
        />

        {/* Admin withdraw button */}
        {isAdmin && (
          <button
            type="button"
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-20 flex items-center justify-center w-6 h-6 rounded-full"
            style={{
              background: 'rgba(239, 68, 68, 0.85)',
              backdropFilter: 'blur(8px)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)',
            }}
            title="管理员撤稿"
            onClick={(e) => {
              e.stopPropagation();
              onAdminWithdraw?.(item.id);
            }}
          >
            <X size={12} />
          </button>
        )}

        {/* Content overlay — all at the bottom, NotebookLM style */}
        <div className="absolute inset-0 z-10 flex flex-col justify-end p-3.5 gap-2">
          {/* Source badge — avatar + name (like NotebookLM's source icon) */}
          <div className="flex items-center gap-2">
            <img
              src={avatarUrl}
              alt={item.ownerUserName}
              className="w-5 h-5 rounded-full shrink-0 object-cover ring-1 ring-white/20"
              onError={(e) => { (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK; }}
            />
            <span
              className="text-[11px] font-medium truncate drop-shadow"
              style={{ color: 'rgba(255,255,255,0.8)' }}
            >
              {item.ownerUserName}
            </span>
            {item.contentType === 'literary' && (
              <div
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full ml-auto shrink-0"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                <BookOpen size={9} style={{ color: 'rgba(165,180,252,0.9)' }} />
                <span className="text-[9px]" style={{ color: 'rgba(255,255,255,0.6)' }}>文学创作</span>
              </div>
            )}
          </div>

          {/* Title — large and bold */}
          <h3
            className="text-[15px] font-bold leading-snug line-clamp-2 drop-shadow-lg"
            style={{ color: '#fff', textShadow: '0 1px 6px rgba(0,0,0,0.5)' }}
          >
            {item.title || '未命名'}
          </h3>

          {/* Bottom row: date + stats */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] drop-shadow" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {new Date(item.createdAt).toLocaleDateString()}
            </span>
            <div className="flex-1" />
            {item.viewCount > 0 && (
              <span
                className="flex items-center gap-0.5 text-[10px] drop-shadow"
                style={{ color: 'rgba(255,255,255,0.5)' }}
              >
                <Eye size={10} />
                {item.viewCount >= 10000 ? `${(item.viewCount / 10000).toFixed(1)}万` : item.viewCount}
              </span>
            )}
            <div
              className="flex items-center gap-0.5"
              style={{ color: liked ? '#F43F5E' : 'rgba(255,255,255,0.45)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <HeartLikeButton
                size={18}
                liked={liked}
                heartColor="#F43F5E"
                disabled={liking}
                onClick={handleLike}
              />
              {likeCount > 0 && <span className="text-[10px] drop-shadow">{likeCount}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── ShowcaseGallery ── */

export function ShowcaseGallery() {
  const { isMobile } = useBreakpoint();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'ADMIN';
  const [activeTab, setActiveTab] = useState('');
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const initialLoadDone = useRef(false);
  const fetchIdRef = useRef(0);

  const fetchItems = useCallback(async (contentType: string, skip: number, append: boolean) => {
    const myFetchId = ++fetchIdRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);

    try {
      const res = await listPublicSubmissions({
        contentType: contentType || undefined,
        skip,
        limit: PAGE_SIZE,
      });
      if (fetchIdRef.current !== myFetchId) return;
      if (res.success) {
        setItems((prev) => (append ? [...prev, ...res.data.items] : res.data.items));
        setTotal(res.data.total);
      }
    } finally {
      if (fetchIdRef.current === myFetchId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      fetchItems('', 0, false);
    }
  }, [fetchItems]);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    setItems([]);
    fetchItems(tab, 0, false);
  };

  const handleLikeToggle = async (id: string, liked: boolean) => {
    const res = liked ? await likeSubmission(id) : await unlikeSubmission(id);
    if (res.success) {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, likedByMe: res.data.likedByMe, likeCount: res.data.count }
            : item,
        ),
      );
    } else {
      throw new Error(res.error?.message || '操作失败');
    }
  };

  const handleAdminWithdraw = async (id: string) => {
    const target = items.find((x) => x.id === id);
    const confirmMsg = target
      ? `确定撤稿「${target.title}」（${target.ownerUserName}）？`
      : '确定撤稿？';
    if (!window.confirm(confirmMsg)) return;

    try {
      const res = await adminWithdrawSubmission(id);
      if (res.success) {
        setItems((prev) => prev.filter((x) => x.id !== id));
        setTotal((t) => t - 1);
        toast.success('已撤稿');
      } else {
        toast.error(res.error?.message || '撤稿失败');
      }
    } catch {
      toast.error('撤稿失败');
    }
  };

  const handleDetailLikeChanged = (id: string, likedByMe: boolean, count: number) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, likedByMe, likeCount: count } : item)),
    );
  };

  const hasMore = items.length < total;

  // Waterfall column count
  const columnCount = isMobile ? 2 : 4;
  const gap = isMobile ? 12 : 16;
  const columns = useMemo(() => distributeToColumns(items, columnCount), [items, columnCount]);

  // Infinite scroll: observe a sentinel at the bottom
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && !loadingMore && items.length < total) {
          fetchItems(activeTab, items.length, true);
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, loadingMore, items.length, total, activeTab, fetchItems]);

  // 只在初始加载（全部tab）没有数据时隐藏整个区域
  if (!loading && items.length === 0 && initialLoadDone.current && !activeTab) return null;

  return (
    <section className="mt-10">
      {/* Section header with tabs */}
      <div className="flex items-center justify-between mb-6">
        <div
          className="text-sm font-medium"
          style={{ color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}
        >
          作品广场
        </div>
        <div className="flex items-center gap-1.5" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => handleTabChange(tab.key)}
              className="px-3.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200"
              style={{
                background:
                  activeTab === tab.key ? 'rgba(99,102,241,0.15)' : 'transparent',
                color:
                  activeTab === tab.key
                    ? 'var(--accent-primary, #818CF8)'
                    : 'var(--text-muted, rgba(255,255,255,0.4))',
                border:
                  activeTab === tab.key
                    ? '1px solid rgba(99,102,241,0.25)'
                    : '1px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeleton — waterfall */}
      {loading && (
        <div style={{ display: 'flex', gap, alignItems: 'flex-start' }}>
          {Array.from({ length: columnCount }).map((_, col) => (
            <div key={col} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap }}>
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-xl"
                  style={{
                    aspectRatio: ['3/4', '16/10', '1/1'][i % 3],
                    background: 'rgba(255,255,255,0.03)',
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Waterfall layout — natural aspect ratio cards */}
      {!loading && items.length > 0 && (
        <>
          <div style={{ display: 'flex', gap, alignItems: 'flex-start' }}>
            {columns.map((col, colIdx) => (
              <div key={colIdx} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap }}>
                {col.map((item) => (
                  <ShowcaseCard
                    key={item.id}
                    item={item}
                    onLikeToggle={handleLikeToggle}
                    onClick={() => setSelectedId(item.id)}
                    isAdmin={isAdmin}
                    onAdminWithdraw={handleAdminWithdraw}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Infinite scroll sentinel + loading indicator */}
          <div ref={sentinelRef} className="h-1" />
          {loadingMore && (
            <div className="flex justify-center py-6">
              <MapSpinner size={20} />
            </div>
          )}
          {!hasMore && items.length > 0 && (
            <div className="flex justify-center py-6">
              <span className="text-[11px]" style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}>
                已展示全部作品
              </span>
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && activeTab && (
        <div
          className="flex flex-col items-center justify-center h-40 gap-2"
          style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}
        >
          <span className="text-sm">暂无作品</span>
        </div>
      )}

      {/* Detail modal */}
      <SubmissionDetailModal
        submissionId={selectedId}
        onClose={() => setSelectedId(null)}
        onLikeChanged={handleDetailLikeChanged}
      />
    </section>
  );
}
