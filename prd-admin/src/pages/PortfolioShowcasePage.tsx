import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Search,
  Loader2,
  ChevronDown,
  Sparkles,
  Eye,
  ImageOff,
  TrendingUp,
  Flame,
  X,
} from 'lucide-react';
import {
  listPublicSubmissions,
  likeSubmission,
  unlikeSubmission,
  type SubmissionItem,
} from '@/services/real/submissions';
import { SubmissionDetailModal } from '@/components/showcase/SubmissionDetailModal';
import { HeartLikeButton } from '@/components/effects/HeartLikeButton';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import { useBreakpoint } from '@/hooks/useBreakpoint';

// ── Constants ──

const TABS = [
  { key: '', label: '全部', icon: Sparkles },
  { key: 'visual', label: '视觉创作', icon: Eye },
  { key: 'literary', label: '文学创作', icon: TrendingUp },
] as const;

const PAGE_SIZE = 24;

// ── Masonry Card ──

function MasonryCard({
  item,
  onLikeToggle,
  onClick,
}: {
  item: SubmissionItem;
  onLikeToggle: (id: string, liked: boolean) => Promise<void>;
  onClick: () => void;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [liked, setLiked] = useState(item.likedByMe);
  const [likeCount, setLikeCount] = useState(item.likeCount);
  const [liking, setLiking] = useState(false);

  useEffect(() => { setLiked(item.likedByMe); }, [item.likedByMe]);
  useEffect(() => { setLikeCount(item.likeCount); }, [item.likeCount]);

  const avatarUrl = resolveAvatarUrl({ avatarFileName: item.ownerAvatarFileName });

  const handleLike = async () => {
    if (liking) return;
    setLiking(true);
    const newLiked = !liked;
    setLiked(newLiked);
    setLikeCount((c) => c + (newLiked ? 1 : -1));
    try {
      await onLikeToggle(item.id, newLiked);
    } catch {
      setLiked(!newLiked);
      setLikeCount((c) => c + (newLiked ? -1 : 1));
    } finally {
      setLiking(false);
    }
  };

  return (
    <div
      className="group cursor-pointer break-inside-avoid mb-5"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
    >
      {/* Image */}
      <div
        className="relative w-full overflow-hidden rounded-2xl"
        style={{
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        {/* Skeleton */}
        {!imgLoaded && !imgError && (
          <div
            className="w-full animate-pulse"
            style={{
              aspectRatio: item.coverWidth && item.coverHeight
                ? `${item.coverWidth}/${item.coverHeight}`
                : '3/4',
              minHeight: 180,
              background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)',
            }}
          />
        )}
        {imgError && (
          <div
            className="w-full flex items-center justify-center"
            style={{
              aspectRatio: '3/4',
              minHeight: 180,
              background: 'rgba(255,255,255,0.03)',
            }}
          >
            <ImageOff size={32} style={{ color: 'rgba(255,255,255,0.08)' }} />
          </div>
        )}
        {item.coverUrl && !imgError && (
          <img
            src={item.coverUrl}
            alt={item.title}
            className="w-full block transition-transform duration-700 ease-out group-hover:scale-[1.04]"
            style={{
              opacity: imgLoaded ? 1 : 0,
              transition: 'opacity 0.5s ease, transform 0.7s ease',
              position: imgLoaded ? 'relative' : 'absolute',
              top: 0,
              left: 0,
            }}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => { setImgError(true); setImgLoaded(true); }}
          />
        )}

        {/* Hover overlay with gradient */}
        <div
          className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
          style={{
            background: 'linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.65) 100%)',
          }}
        />

        {/* Hover glow border */}
        <div
          className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
          style={{
            boxShadow: 'inset 0 0 0 1px rgba(129,140,248,0.3), 0 0 30px rgba(129,140,248,0.08)',
          }}
        />

        {/* Floating stats on hover */}
        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-all duration-400 translate-y-2 group-hover:translate-y-0 pointer-events-none">
          <div className="flex items-center gap-2">
            {item.viewCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full"
                style={{
                  background: 'rgba(0,0,0,0.5)',
                  backdropFilter: 'blur(8px)',
                  color: 'rgba(255,255,255,0.85)',
                }}>
                <Eye size={11} />
                {item.viewCount >= 10000
                  ? `${(item.viewCount / 10000).toFixed(1)}万`
                  : item.viewCount}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Info section */}
      <div className="flex items-center gap-2.5 mt-3 px-1">
        <img
          src={avatarUrl}
          alt={item.ownerUserName}
          className="w-7 h-7 rounded-full shrink-0 object-cover ring-1 ring-white/10 transition-transform duration-300 group-hover:scale-110"
          onError={(e) => { (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK; }}
        />
        <span
          className="text-[13px] font-medium truncate flex-1 transition-colors duration-300"
          style={{ color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}
        >
          {item.ownerUserName}
        </span>
        <div
          className="flex items-center gap-0.5 shrink-0"
          style={{ color: liked ? '#F43F5E' : 'var(--text-muted, rgba(255,255,255,0.3))' }}
          onClick={(e) => e.stopPropagation()}
        >
          <HeartLikeButton
            size={22}
            liked={liked}
            heartColor="#F43F5E"
            disabled={liking}
            onClick={handleLike}
          />
          {likeCount > 0 && <span className="text-[11px]">{likeCount}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Skeleton Grid ──

function SkeletonGrid() {
  const heights = [260, 340, 220, 300, 280, 360, 240, 320, 200, 290, 330, 250];
  return (
    <>
      {heights.map((h, i) => (
        <div
          key={i}
          className="break-inside-avoid mb-5 animate-pulse rounded-2xl"
          style={{
            height: h,
            background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)',
          }}
        />
      ))}
    </>
  );
}

// ── Main Page ──

export default function PortfolioShowcasePage() {
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();
  const [activeTab, setActiveTab] = useState('');
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const fetchIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track scroll for parallax hero
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => setScrollY(el.scrollTop);
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, []);

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
    fetchItems('', 0, false);
  }, [fetchItems]);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    setItems([]);
    fetchItems(tab, 0, false);
  };

  const handleLoadMore = () => {
    if (loadingMore) return;
    fetchItems(activeTab, items.length, true);
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

  const handleDetailLikeChanged = (id: string, likedByMe: boolean, count: number) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, likedByMe, likeCount: count } : item)),
    );
  };

  const hasMore = items.length < total;

  // Column count based on viewport
  const columnCount = isMobile ? 2 : 4;

  const heroOpacity = Math.max(0, 1 - scrollY / 300);
  const heroScale = 1 + scrollY * 0.0003;

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: '#0a0a0f' }}>
      {/* ── Floating top bar ── */}
      <div
        className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between transition-all duration-500"
        style={{
          padding: isMobile ? '12px 16px' : '16px 32px',
          background: scrollY > 80
            ? 'rgba(10,10,15,0.85)'
            : 'transparent',
          backdropFilter: scrollY > 80 ? 'blur(20px) saturate(1.5)' : 'none',
          borderBottom: scrollY > 80 ? '1px solid rgba(255,255,255,0.06)' : '1px solid transparent',
        }}
      >
        {/* Left: Back button + Title */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 hover:scale-105"
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <ArrowLeft size={16} style={{ color: 'rgba(255,255,255,0.8)' }} />
          </button>
          <div
            className="text-[15px] font-semibold tracking-wide transition-opacity duration-300"
            style={{
              color: '#fff',
              opacity: scrollY > 120 ? 1 : 0,
            }}
          >
            作品广场
          </div>
        </div>

        {/* Right: Search */}
        <div className="relative" style={{ width: isMobile ? 160 : 240 }}>
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none transition-colors duration-200"
            style={{ color: searchFocused ? 'rgba(129,140,248,0.8)' : 'rgba(255,255,255,0.3)' }}
          />
          <input
            type="text"
            placeholder="搜索作品..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="w-full h-8 pl-8 pr-3 rounded-lg text-[12px] outline-none transition-all duration-200"
            style={{
              background: searchFocused ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
              border: searchFocused ? '1px solid rgba(129,140,248,0.4)' : '1px solid rgba(255,255,255,0.08)',
              color: '#fff',
            }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2"
            >
              <X size={12} style={{ color: 'rgba(255,255,255,0.4)' }} />
            </button>
          )}
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {/* ── Hero Section ── */}
        <div
          className="relative overflow-hidden"
          style={{ height: isMobile ? 280 : 380 }}
        >
          {/* Animated gradient background */}
          <div
            className="absolute inset-0"
            style={{
              opacity: heroOpacity,
              transform: `scale(${heroScale})`,
              transition: 'transform 0.1s linear',
            }}
          >
            {/* Multi-layer gradient orbs */}
            <div className="absolute inset-0" style={{
              background: `
                radial-gradient(ellipse 80% 60% at 20% 40%, rgba(99,102,241,0.15) 0%, transparent 60%),
                radial-gradient(ellipse 60% 80% at 80% 30%, rgba(168,85,247,0.12) 0%, transparent 55%),
                radial-gradient(ellipse 50% 50% at 50% 80%, rgba(236,72,153,0.08) 0%, transparent 50%),
                radial-gradient(ellipse 90% 40% at 60% 10%, rgba(59,130,246,0.10) 0%, transparent 50%)
              `,
            }} />

            {/* Animated floating particles effect via CSS */}
            <div className="absolute inset-0" style={{
              backgroundImage: `
                radial-gradient(1.5px 1.5px at 10% 20%, rgba(255,255,255,0.15), transparent),
                radial-gradient(1px 1px at 30% 60%, rgba(255,255,255,0.1), transparent),
                radial-gradient(1.5px 1.5px at 50% 30%, rgba(255,255,255,0.12), transparent),
                radial-gradient(1px 1px at 70% 70%, rgba(255,255,255,0.08), transparent),
                radial-gradient(1.5px 1.5px at 90% 40%, rgba(255,255,255,0.1), transparent),
                radial-gradient(1px 1px at 15% 80%, rgba(255,255,255,0.06), transparent),
                radial-gradient(1.5px 1.5px at 85% 15%, rgba(255,255,255,0.08), transparent)
              `,
            }} />

            {/* Mesh grid lines */}
            <div className="absolute inset-0 opacity-[0.03]" style={{
              backgroundImage: `
                linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)
              `,
              backgroundSize: '60px 60px',
            }} />
          </div>

          {/* Bottom gradient fade */}
          <div
            className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none"
            style={{
              background: 'linear-gradient(180deg, transparent 0%, #0a0a0f 100%)',
            }}
          />

          {/* Hero text content */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center z-10"
            style={{
              opacity: heroOpacity,
              transform: `translateY(${-scrollY * 0.3}px)`,
            }}
          >
            {/* Glowing accent badge */}
            <div
              className="flex items-center gap-2 px-4 py-1.5 rounded-full mb-5"
              style={{
                background: 'rgba(129,140,248,0.1)',
                border: '1px solid rgba(129,140,248,0.2)',
                boxShadow: '0 0 20px rgba(129,140,248,0.1)',
              }}
            >
              <Sparkles size={13} style={{ color: '#818CF8' }} />
              <span className="text-[11px] font-medium tracking-wider" style={{ color: '#A5B4FC' }}>
                PORTFOLIO SHOWCASE
              </span>
            </div>

            <h1
              className="font-bold tracking-tight text-center"
              style={{
                fontSize: isMobile ? 32 : 48,
                lineHeight: 1.1,
                color: '#fff',
                textShadow: '0 2px 20px rgba(0,0,0,0.3)',
              }}
            >
              <span style={{
                background: 'linear-gradient(135deg, #fff 0%, #c7d2fe 40%, #818cf8 70%, #a78bfa 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}>
                作品广场
              </span>
            </h1>
            <p
              className="mt-3 text-center max-w-md"
              style={{
                fontSize: isMobile ? 13 : 15,
                color: 'rgba(255,255,255,0.45)',
                lineHeight: 1.6,
              }}
            >
              探索由 AI 驱动的创意作品，发现无限灵感
            </p>

            {/* Stats row */}
            {total > 0 && (
              <div className="flex items-center gap-6 mt-6">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#818CF8', boxShadow: '0 0 6px #818CF8' }} />
                  <span className="text-[12px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
                    {total} 件作品
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#34D399', boxShadow: '0 0 6px #34D399' }} />
                  <span className="text-[12px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
                    持续更新中
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Filter bar (sticky) ── */}
        <div
          className="sticky top-0 z-40"
          style={{
            background: 'rgba(10,10,15,0.8)',
            backdropFilter: 'blur(20px) saturate(1.5)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: isMobile ? '12px 16px' : '14px 48px' }}
          >
            {/* Tabs */}
            <div className="flex items-center gap-1.5" role="tablist">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => handleTabChange(tab.key)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-medium transition-all duration-300"
                    style={{
                      background: isActive
                        ? 'linear-gradient(135deg, rgba(99,102,241,0.2) 0%, rgba(168,85,247,0.15) 100%)'
                        : 'transparent',
                      color: isActive ? '#A5B4FC' : 'rgba(255,255,255,0.4)',
                      border: isActive ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                      boxShadow: isActive ? '0 0 15px rgba(99,102,241,0.1)' : 'none',
                    }}
                  >
                    <Icon size={13} />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Sort indicator */}
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
              <Flame size={12} />
              <span>最受欢迎</span>
            </div>
          </div>
        </div>

        {/* ── Gallery content ── */}
        <div style={{ padding: isMobile ? '20px 12px 80px' : '32px 48px 80px' }}>
          {/* Loading skeleton */}
          {loading && (
            <div
              style={{
                columnCount,
                columnGap: isMobile ? 12 : 20,
              }}
            >
              <SkeletonGrid />
            </div>
          )}

          {/* Masonry grid */}
          {!loading && items.length > 0 && (
            <>
              <div
                style={{
                  columnCount,
                  columnGap: isMobile ? 12 : 20,
                }}
              >
                {items.map((item) => (
                  <MasonryCard
                    key={item.id}
                    item={item}
                    onLikeToggle={handleLikeToggle}
                    onClick={() => setSelectedId(item.id)}
                  />
                ))}
              </div>

              {/* Load more */}
              {hasMore && (
                <div className="flex justify-center mt-12">
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    className="group flex items-center gap-2.5 px-8 py-3 rounded-full text-[13px] font-medium transition-all duration-300 hover:scale-[1.03]"
                    style={{
                      background: 'linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(168,85,247,0.08) 100%)',
                      border: '1px solid rgba(99,102,241,0.2)',
                      color: 'rgba(255,255,255,0.6)',
                      boxShadow: '0 0 20px rgba(99,102,241,0.05)',
                    }}
                  >
                    {loadingMore ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <ChevronDown size={14} className="transition-transform duration-300 group-hover:translate-y-0.5" />
                    )}
                    {loadingMore ? '加载中...' : `加载更多 · 还有 ${total - items.length} 件`}
                  </button>
                </div>
              )}
            </>
          )}

          {/* Empty state */}
          {!loading && items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-32 gap-4">
              <div
                className="w-20 h-20 rounded-2xl flex items-center justify-center"
                style={{
                  background: 'rgba(129,140,248,0.08)',
                  border: '1px solid rgba(129,140,248,0.15)',
                }}
              >
                <Sparkles size={32} style={{ color: 'rgba(129,140,248,0.4)' }} />
              </div>
              <p className="text-[15px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
                暂无作品，创作第一件作品吧
              </p>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="mt-2 px-6 py-2.5 rounded-full text-[13px] font-medium transition-all duration-200 hover:scale-105"
                style={{
                  background: 'linear-gradient(135deg, #6366F1, #8B5CF6)',
                  color: '#fff',
                  boxShadow: '0 4px 20px rgba(99,102,241,0.3)',
                }}
              >
                开始创作
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Detail modal ── */}
      <SubmissionDetailModal
        submissionId={selectedId}
        onClose={() => setSelectedId(null)}
        onLikeChanged={handleDetailLikeChanged}
      />
    </div>
  );
}
