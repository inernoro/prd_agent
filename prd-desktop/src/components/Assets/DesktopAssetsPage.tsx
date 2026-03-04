import { useEffect, useMemo, useCallback, useRef } from 'react';
import { useAssetStore } from '../../stores/assetStore';
import type { AssetItem } from '../../types';
import AssetsToolbar from './AssetsToolbar';
import AssetDetailPanel from './AssetDetailPanel';

// ── Helpers ────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  } catch { return iso; }
}

const TYPE_LABELS: Record<string, string> = {
  image: '图片',
  document: '文档',
  attachment: '附件',
};

const TYPE_COLORS: Record<string, string> = {
  image: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  document: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  attachment: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
};

// ── Card Component ─────────────────────────────────────────────

function AssetCard({ item, isSelected, onSelect }: { item: AssetItem; isSelected: boolean; onSelect: () => void }) {
  const isImage = item.type === 'image';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`group relative rounded-xl border transition-all duration-200 cursor-pointer overflow-hidden ${
        isSelected
          ? 'border-primary-500 ring-1 ring-primary-500/30 shadow-md'
          : 'border-black/8 dark:border-white/8 hover:border-primary-400/50 hover:shadow-sm'
      } bg-white/50 dark:bg-white/[0.03]`}
    >
      {/* Thumbnail */}
      <div className="aspect-[4/3] bg-black/[0.03] dark:bg-white/[0.03] flex items-center justify-center overflow-hidden">
        {isImage && item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl || item.url}
            alt={item.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-1.5 px-3 text-text-secondary/60 h-full">
            {item.summary ? (
              <p className="text-[11px] leading-relaxed text-text-secondary/80 line-clamp-4 text-center">
                {item.summary}
              </p>
            ) : (
              <>
                {item.type === 'document' ? (
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                ) : (
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                  </svg>
                )}
                <span className="text-xs">{item.mime?.split('/')[1] || item.type}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-2.5 space-y-1.5">
        <div className="text-sm font-medium text-text-primary truncate" title={item.title}>
          {item.title}
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${TYPE_COLORS[item.type] || ''}`}>
              {TYPE_LABELS[item.type] || item.type}
            </span>
            {item.source && (
              <span className="text-[10px] text-text-secondary/60">{item.source}</span>
            )}
          </div>
          <span className="text-[10px] text-text-secondary">{formatBytes(item.sizeBytes)}</span>
        </div>
      </div>
    </div>
  );
}

// ── List Row Component ─────────────────────────────────────────

function AssetListRow({ item, isSelected, onSelect }: { item: AssetItem; isSelected: boolean; onSelect: () => void }) {
  const isImage = item.type === 'image';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-all duration-150 cursor-pointer ${
        isSelected
          ? 'border-primary-500 bg-primary-50/50 dark:bg-primary-500/10'
          : 'border-transparent hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
      }`}
    >
      {/* Thumbnail */}
      <div className="w-10 h-8 rounded bg-black/[0.03] dark:bg-white/[0.03] overflow-hidden flex-shrink-0 flex items-center justify-center">
        {isImage && item.thumbnailUrl ? (
          <img src={item.thumbnailUrl || item.url} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <svg className="w-4 h-4 text-text-secondary/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        )}
      </div>

      {/* Title + Summary */}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary truncate">{item.title}</div>
        {item.summary && (
          <div className="text-[10px] text-text-secondary/60 truncate">{item.summary}</div>
        )}
      </div>

      {/* Source */}
      {item.source && (
        <span className="text-[10px] text-text-secondary/50 flex-shrink-0">{item.source}</span>
      )}

      {/* Type badge */}
      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${TYPE_COLORS[item.type] || ''}`}>
        {TYPE_LABELS[item.type] || item.type}
      </span>

      {/* Size */}
      <span className="text-xs text-text-secondary w-16 text-right flex-shrink-0">{formatBytes(item.sizeBytes)}</span>

      {/* Date */}
      <span className="text-xs text-text-secondary w-20 text-right flex-shrink-0">{formatDate(item.createdAt)}</span>
    </div>
  );
}

// ── Empty State ────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-20 text-text-secondary">
      <svg className="w-16 h-16 mb-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 3h18M3 3v18h18V3" />
      </svg>
      <div className="text-sm font-medium mb-1">暂无资产</div>
      <div className="text-xs text-text-secondary/70">通过 AI Agent 生成的图片、文档将自动出现在此处</div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────

export default function DesktopAssetsPage() {
  const {
    items, total, hasMore, loading, loadingMore, error,
    searchQuery, sortBy, sortDesc, viewMode, selectedId,
    fetchAssets, loadMore, selectAsset,
  } = useAssetStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Initial fetch
  useEffect(() => {
    if (items.length === 0 && !loading) {
      fetchAssets();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  // Filter + sort on client side
  const filteredItems = useMemo(() => {
    let list = items;

    // Search filter (client-side)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((i) => i.title.toLowerCase().includes(q) || i.summary?.toLowerCase().includes(q) || i.source?.toLowerCase().includes(q));
    }

    // Sort
    const dir = sortDesc ? -1 : 1;
    list = [...list].sort((a, b) => {
      if (sortBy === 'date') return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (sortBy === 'size') return dir * (a.sizeBytes - b.sizeBytes);
      return dir * a.title.localeCompare(b.title);
    });

    return list;
  }, [items, searchQuery, sortBy, sortDesc]);

  const selectedAsset = useMemo(
    () => (selectedId ? items.find((i) => i.id === selectedId) ?? null : null),
    [items, selectedId]
  );

  // Stats for toolbar
  const stats = useMemo(() => {
    const s = { image: 0, document: 0, attachment: 0 };
    items.forEach((i) => { if (i.type in s) s[i.type as keyof typeof s]++; });
    return s;
  }, [items]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      selectAsset(null);
    }
  }, [selectAsset]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" onKeyDown={handleKeyDown}>
      {/* Toolbar */}
      <AssetsToolbar stats={stats} total={total} />

      {/* Content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Main list/grid */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          {loading && items.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center py-20 text-text-secondary">
              <div className="text-sm text-red-500 mb-2">{error}</div>
              <button onClick={fetchAssets} className="text-sm text-primary-500 hover:underline">重试</button>
            </div>
          ) : filteredItems.length === 0 ? (
            <EmptyState />
          ) : viewMode === 'grid' ? (
            /* Grid view */
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {filteredItems.map((item) => (
                <AssetCard
                  key={item.id}
                  item={item}
                  isSelected={item.id === selectedId}
                  onSelect={() => selectAsset(item.id === selectedId ? null : item.id)}
                />
              ))}
            </div>
          ) : (
            /* List view */
            <div className="space-y-0.5">
              {/* List header */}
              <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] font-medium text-text-secondary/70 uppercase tracking-wider">
                <div className="w-10 flex-shrink-0" />
                <div className="flex-1">名称</div>
                <div className="w-12 flex-shrink-0 text-center">类型</div>
                <div className="w-16 text-right flex-shrink-0">大小</div>
                <div className="w-20 text-right flex-shrink-0">日期</div>
              </div>
              {filteredItems.map((item) => (
                <AssetListRow
                  key={item.id}
                  item={item}
                  isSelected={item.id === selectedId}
                  onSelect={() => selectAsset(item.id === selectedId ? null : item.id)}
                />
              ))}
            </div>
          )}

          {/* Sentinel for infinite scroll */}
          {hasMore && <div ref={sentinelRef} className="h-px" />}

          {/* Loading more indicator */}
          {loadingMore && (
            <div className="flex justify-center py-4">
              <div className="w-5 h-5 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedAsset && (
          <AssetDetailPanel asset={selectedAsset} onClose={() => selectAsset(null)} />
        )}
      </div>
    </div>
  );
}
