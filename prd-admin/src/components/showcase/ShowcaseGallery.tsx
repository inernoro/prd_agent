import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ChevronDown } from 'lucide-react';
import { SubmissionCard } from './SubmissionCard';
import { SubmissionDetailModal } from './SubmissionDetailModal';
import {
  listPublicSubmissions,
  likeSubmission,
  unlikeSubmission,
  type SubmissionItem,
} from '@/services/real/submissions';

const TABS = [
  { key: '', label: '全部' },
  { key: 'visual', label: '视觉创作' },
  { key: 'literary', label: '文学创作' },
] as const;

const PAGE_SIZE = 20;

export function ShowcaseGallery() {
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

      {/* Loading skeleton */}
      {loading && (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="animate-pulse rounded-2xl"
              style={{
                height: [220, 280, 340, 200, 300, 260][i % 6],
                background: 'rgba(255,255,255,0.03)',
              }}
            />
          ))}
        </div>
      )}

      {/* Grid — 按行排列，保持 API 返回顺序（LikeCount DESC → CreatedAt DESC） */}
      {!loading && items.length > 0 && (
        <>
          <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {items.map((item) => (
              <SubmissionCard key={item.id} item={item} onLikeToggle={handleLikeToggle} onClick={() => setSelectedId(item.id)} />
            ))}
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center mt-8 mb-4">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="flex items-center gap-2 px-6 py-2.5 rounded-full text-xs font-medium transition-all duration-200 hover:scale-[1.02]"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-muted, rgba(255,255,255,0.5))',
                }}
              >
                {loadingMore ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ChevronDown size={14} />
                )}
                {loadingMore ? '加载中...' : '加载更多'}
              </button>
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
