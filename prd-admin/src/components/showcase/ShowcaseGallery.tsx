import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ChevronDown } from 'lucide-react';
import { SubmissionCard } from './SubmissionCard';
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
  const initialLoadDone = useRef(false);
  const fetchIdRef = useRef(0); // 防止 tab 切换 race condition

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
      // 丢弃过期请求的响应（用户已切换 tab）
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

  const hasMore = items.length < total;

  if (!loading && items.length === 0 && initialLoadDone.current) return null;

  return (
    <section className="mt-8">
      {/* Section header with tabs */}
      <div className="flex items-center justify-between mb-4">
        <div
          className="text-[11px] font-medium tracking-widest uppercase"
          style={{ color: 'var(--text-muted, rgba(255,255,255,0.35))' }}
        >
          作品广场
        </div>
        <div className="flex items-center gap-1" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => handleTabChange(tab.key)}
              className="px-3 py-1 rounded-md text-xs transition-colors duration-150"
              style={{
                background:
                  activeTab === tab.key ? 'rgba(99,102,241,0.15)' : 'transparent',
                color:
                  activeTab === tab.key
                    ? 'var(--accent-primary, #818CF8)'
                    : 'var(--text-muted, rgba(255,255,255,0.4))',
                border:
                  activeTab === tab.key
                    ? '1px solid rgba(99,102,241,0.3)'
                    : '1px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center h-40">
          <Loader2
            size={24}
            className="animate-spin"
            style={{ color: 'var(--accent-primary)' }}
          />
        </div>
      )}

      {/* Masonry grid */}
      {!loading && items.length > 0 && (
        <>
          <div
            style={{
              columns: 'auto 220px',
              columnGap: 12,
            }}
          >
            {items.map((item) => (
              <div key={item.id} style={{ marginBottom: 12 }}>
                <SubmissionCard item={item} onLikeToggle={handleLikeToggle} />
              </div>
            ))}
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center mt-4">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs transition-colors duration-150"
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

      {/* Empty state (only after tab switch, not initial) */}
      {!loading && items.length === 0 && activeTab && (
        <div
          className="flex flex-col items-center justify-center h-32 gap-2"
          style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}
        >
          <span className="text-sm">暂无作品</span>
        </div>
      )}
    </section>
  );
}
