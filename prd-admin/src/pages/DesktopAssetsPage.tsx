import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FolderOpen,
  Image,
  FileText,
  Paperclip,
  Loader2,
  Search,
  LayoutGrid,
  List,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  Download,
  Copy,
  ExternalLink,
  X,
  RefreshCw,
  Calendar,
  HardDrive,
  Type,
  Eye,
} from 'lucide-react';
import { getMobileAssets } from '@/services';
import type { MobileAssetItem } from '@/services/contracts/mobile';

/* ── Types ── */
type AssetTab = 'all' | 'image' | 'document' | 'attachment';
type SortBy = 'date' | 'size' | 'name';
type ViewMode = 'grid' | 'list';

/* ── Constants ── */
const TABS: { key: AssetTab; label: string; icon: typeof Image }[] = [
  { key: 'all', label: '全部', icon: FolderOpen },
  { key: 'image', label: '图片', icon: Image },
  { key: 'document', label: '文档', icon: FileText },
  { key: 'attachment', label: '附件', icon: Paperclip },
];

const PAGE_SIZE = 50;

/* ── Helpers ── */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '-';
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
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day} ${h}:${min}`;
  } catch {
    return iso;
  }
}

function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  } catch {
    return iso;
  }
}

const TYPE_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  image: { label: '图片', bg: 'rgba(251,146,60,0.15)', text: '#FB923C' },
  document: { label: '文档', bg: 'rgba(129,140,248,0.15)', text: '#818CF8' },
  attachment: { label: '附件', bg: 'rgba(255,255,255,0.08)', text: 'var(--text-muted)' },
};

/** 判断是否为图片：type 为 image 或 MIME 以 image/ 开头 */
function isImageAsset(asset: MobileAssetItem): boolean {
  return asset.type === 'image' || (!!asset.mime && asset.mime.startsWith('image/'));
}

/** url 是否可用 */
function hasUrl(asset: MobileAssetItem): boolean {
  return !!asset.url;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

/* ── Asset Grid Card ── */
function AssetGridCard({
  asset,
  isSelected,
  onSelect,
}: {
  asset: MobileAssetItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className="group relative rounded-xl overflow-hidden cursor-pointer transition-all duration-200"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: isSelected
          ? '1px solid var(--accent-primary, #818CF8)'
          : '1px solid rgba(255,255,255,0.06)',
        boxShadow: isSelected ? '0 0 0 2px rgba(129,140,248,0.15)' : undefined,
      }}
    >
      {/* Thumbnail */}
      <div
        className="w-full aspect-[4/3] flex items-center justify-center overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.02)' }}
      >
        {asset.thumbnailUrl || (isImageAsset(asset) && asset.url) ? (
          <img
            src={asset.thumbnailUrl || asset.url || ''}
            alt=""
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            loading="lazy"
          />
        ) : asset.summary ? (
          <div className="flex items-center justify-center h-full px-4">
            <p className="text-[11px] leading-relaxed text-center" style={{ color: 'rgba(255,255,255,0.45)', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {asset.summary}
            </p>
          </div>
        ) : asset.type === 'image' || isImageAsset(asset) ? (
          <Image size={28} style={{ color: 'rgba(255,255,255,0.12)' }} />
        ) : asset.type === 'document' ? (
          <FileText size={28} style={{ color: 'rgba(255,255,255,0.12)' }} />
        ) : (
          <Paperclip size={28} style={{ color: 'rgba(255,255,255,0.12)' }} />
        )}
      </div>

      {/* Info */}
      <div className="p-3">
        <div
          className="text-[13px] font-medium truncate"
          style={{ color: 'var(--text-primary)' }}
          title={asset.title}
        >
          {asset.title}
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span
            className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{
              background: TYPE_CONFIG[asset.type]?.bg,
              color: TYPE_CONFIG[asset.type]?.text,
            }}
          >
            {TYPE_CONFIG[asset.type]?.label || asset.type}
          </span>
          {asset.source && (
            <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {asset.source}
            </span>
          )}
          <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>
            {formatShortDate(asset.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Asset List Row ── */
function AssetListRow({
  asset,
  isSelected,
  onSelect,
}: {
  asset: MobileAssetItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-150"
      style={{
        background: isSelected ? 'rgba(129,140,248,0.08)' : 'transparent',
        border: isSelected
          ? '1px solid rgba(129,140,248,0.25)'
          : '1px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.background = 'transparent';
      }}
    >
      {/* Thumbnail */}
      <div
        className="w-10 h-8 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center"
        style={{ background: 'rgba(255,255,255,0.04)' }}
      >
        {asset.thumbnailUrl || (isImageAsset(asset) && asset.url) ? (
          <img src={asset.thumbnailUrl || asset.url || ''} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <FileText size={14} style={{ color: 'rgba(255,255,255,0.2)' }} />
        )}
      </div>

      {/* Title + Summary */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>
          {asset.title}
        </div>
        {asset.summary && (
          <div className="text-[10px] truncate" style={{ color: 'rgba(255,255,255,0.35)' }}>
            {asset.summary}
          </div>
        )}
      </div>

      {/* Source */}
      {asset.source && (
        <span className="text-[10px] flex-shrink-0" style={{ color: 'rgba(255,255,255,0.30)' }}>
          {asset.source}
        </span>
      )}

      {/* Type */}
      <span
        className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
        style={{
          background: TYPE_CONFIG[asset.type]?.bg,
          color: TYPE_CONFIG[asset.type]?.text,
        }}
      >
        {TYPE_CONFIG[asset.type]?.label || asset.type}
      </span>

      {/* Size */}
      <span className="text-[12px] w-16 text-right flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
        {formatBytes(asset.sizeBytes)}
      </span>

      {/* Date */}
      <span className="text-[12px] w-24 text-right flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
        {formatShortDate(asset.createdAt)}
      </span>
    </div>
  );
}

/* ── Detail Panel ── */
function DetailPanel({
  asset,
  onClose,
}: {
  asset: MobileAssetItem;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isImage = isImageAsset(asset);

  const handleCopy = async () => {
    if (!asset.url) return;
    await copyToClipboard(asset.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="w-[340px] flex-shrink-0 flex flex-col overflow-hidden"
      style={{
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          资产详情
        </span>
        <button
          type="button"
          onClick={onClose}
          className="h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors hover:bg-white/8"
          style={{ color: 'var(--text-muted)' }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Preview */}
      <div className="px-4 pt-4">
        <div
          className="w-full rounded-xl overflow-hidden flex items-center justify-center"
          style={{
            aspectRatio: isImage ? '4/3' : '3/2',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {asset.thumbnailUrl || (isImage && asset.url) ? (
            <img
              src={asset.url || asset.thumbnailUrl || ''}
              alt={asset.title}
              className="w-full h-full object-contain"
            />
          ) : asset.summary ? (
            <div className="flex items-center justify-center h-full px-5">
              <p className="text-[12px] leading-relaxed text-center" style={{ color: 'rgba(255,255,255,0.45)', display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {asset.summary}
              </p>
            </div>
          ) : asset.type === 'document' ? (
            <FileText size={40} style={{ color: 'rgba(255,255,255,0.12)' }} />
          ) : (
            <Paperclip size={40} style={{ color: 'rgba(255,255,255,0.12)' }} />
          )}
        </div>
      </div>

      {/* Title */}
      <div className="px-4 mt-3">
        <div className="text-[14px] font-semibold break-words" style={{ color: 'var(--text-primary)' }}>
          {asset.title}
        </div>
      </div>

      {/* Metadata */}
      <div className="px-4 mt-4 space-y-3 flex-1 overflow-auto">
        <MetaRow icon={<Eye size={13} />} label="类型" value={`${TYPE_CONFIG[asset.type]?.label || asset.type}${asset.source ? ` · ${asset.source}` : ''}`} />
        {asset.summary && <MetaRow icon={<FileText size={13} />} label="摘要" value={asset.summary} />}
        <MetaRow icon={<HardDrive size={13} />} label="大小" value={formatBytes(asset.sizeBytes)} />
        <MetaRow icon={<Calendar size={13} />} label="创建时间" value={formatDate(asset.createdAt)} />
        {asset.mime && <MetaRow icon={<Type size={13} />} label="MIME" value={asset.mime} />}
        {isImage && asset.width > 0 && asset.height > 0 && (
          <MetaRow icon={<Image size={13} />} label="尺寸" value={`${asset.width} × ${asset.height} px`} />
        )}
      </div>

      {/* Actions */}
      <div className="px-4 py-4 flex flex-col gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {asset.url && (
          <>
            <button
              type="button"
              onClick={() => asset.url && window.open(asset.url, '_blank', 'noopener,noreferrer')}
              className="flex items-center justify-center gap-2 w-full h-9 rounded-lg text-[13px] font-medium transition-colors"
              style={{
                background: 'var(--accent-primary, #818CF8)',
                color: '#fff',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '0.85';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '1';
              }}
            >
              <ExternalLink size={14} />
              在浏览器中打开
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center justify-center gap-1.5 flex-1 h-8 rounded-lg text-[12px] font-medium transition-colors"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: copied ? '#22c55e' : 'var(--text-secondary)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <Copy size={12} />
                {copied ? '已复制' : '复制链接'}
              </button>
              <a
                href={asset.url || '#'}
                download={asset.title}
                className="flex items-center justify-center gap-1.5 flex-1 h-8 rounded-lg text-[12px] font-medium transition-colors no-underline"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--text-secondary)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <Download size={12} />
                下载
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MetaRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5" style={{ color: 'var(--text-muted)' }}>{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </div>
        <div className="text-[13px] break-all" style={{ color: 'var(--text-primary)' }}>
          {value}
        </div>
      </div>
    </div>
  );
}

/* ── Empty State ── */
function EmptyState({ tab }: { tab: AssetTab }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3">
      <FolderOpen size={40} style={{ color: 'rgba(255,255,255,0.1)' }} />
      <div className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
        {tab === 'all' ? '还没有任何资产' : '该分类下暂无内容'}
      </div>
      <div className="text-[12px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
        使用 Agent 创作后，产出物会自动出现在这里
      </div>
    </div>
  );
}

/* ── Main Page ── */
export default function DesktopAssetsPage() {
  const [activeTab, setActiveTab] = useState<AssetTab>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [assets, setAssets] = useState<MobileAssetItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 全局计数：始终从 "all" 请求获取，切换 Tab 不影响
  const [allStats, setAllStats] = useState<{ total: number; image: number; document: number; attachment: number }>({
    total: 0, image: 0, document: 0, attachment: 0,
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [sortDesc, setSortDesc] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem('prd-admin-assets-view');
      if (v === 'list') return 'list';
    } catch { /* ignore */ }
    return 'grid';
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 加载全局分类计数（只在首次和刷新时调用）
  const fetchAllStats = useCallback(async () => {
    try {
      const res = await getMobileAssets({ limit: PAGE_SIZE, skip: 0 });
      if (res.success) {
        const items = res.data.items ?? [];
        const s = { image: 0, document: 0, attachment: 0 };
        items.forEach((a) => { if (a.type in s) s[a.type as keyof typeof s]++; });
        setAllStats({ total: res.data.total ?? items.length, ...s });
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch assets
  const fetchAssets = useCallback(async (category?: AssetTab, refreshStats = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getMobileAssets({
        category: category === 'all' ? undefined : category,
        limit: PAGE_SIZE,
        skip: 0,
      });
      if (res.success) {
        const items = res.data.items ?? [];
        setAssets(items);
        setTotal(res.data.total ?? 0);
        setHasMore(res.data.hasMore ?? false);

        // 如果是 "all" 分类，同步更新 stats
        if (category === 'all' || !category) {
          const s = { image: 0, document: 0, attachment: 0 };
          items.forEach((a) => { if (a.type in s) s[a.type as keyof typeof s]++; });
          setAllStats({ total: res.data.total ?? items.length, ...s });
        } else if (refreshStats) {
          fetchAllStats();
        }
      } else {
        setError(res.error?.message || '加载失败');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [fetchAllStats]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getMobileAssets({
        category: activeTab === 'all' ? undefined : activeTab,
        limit: PAGE_SIZE,
        skip: assets.length,
      });
      if (res.success) {
        setAssets((prev) => [...prev, ...(res.data.items ?? [])]);
        setTotal(res.data.total ?? 0);
        setHasMore(res.data.hasMore ?? false);
      }
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, activeTab, assets.length]);

  useEffect(() => {
    fetchAssets(activeTab);
    setSelectedId(null);
  }, [activeTab, fetchAssets]);

  // Infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  // Filter + sort
  const filtered = useMemo(() => {
    let list = assets;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((a) => a.title.toLowerCase().includes(q) || a.summary?.toLowerCase().includes(q) || a.source?.toLowerCase().includes(q));
    }

    const dir = sortDesc ? -1 : 1;
    list = [...list].sort((a, b) => {
      if (sortBy === 'date') return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (sortBy === 'size') return dir * (a.sizeBytes - b.sizeBytes);
      return dir * a.title.localeCompare(b.title);
    });

    return list;
  }, [assets, searchQuery, sortBy, sortDesc]);

  const selectedAsset = useMemo(
    () => (selectedId ? assets.find((a) => a.id === selectedId) ?? null : null),
    [assets, selectedId],
  );

  // Stats 使用全局计数，不依赖当前 Tab 的 assets
  const stats = allStats;

  const handleSort = (col: SortBy) => {
    if (sortBy === col) {
      setSortDesc((d) => !d);
    } else {
      setSortBy(col);
      setSortDesc(col === 'date');
    }
  };

  const handleViewMode = (m: ViewMode) => {
    setViewMode(m);
    try {
      localStorage.setItem('prd-admin-assets-view', m);
    } catch { /* ignore */ }
  };

  const handleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  const SortIcon = sortDesc ? ArrowDown : ArrowUp;

  return (
    <div
      className="h-full min-h-0 flex flex-col"
      style={{ background: 'var(--bg-base)' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setSelectedId(null);
      }}
    >
      {/* ── Toolbar ── */}
      <div
        className="shrink-0 px-5 py-3 flex items-center gap-4 flex-wrap"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        {/* Tabs */}
        <div className="flex items-center gap-1">
          {TABS.map((tab) => {
            const active = activeTab === tab.key;
            const TabIcon = tab.icon;
            const count =
              tab.key === 'all'
                ? allStats.total
                : allStats[tab.key as keyof Omit<typeof allStats, 'total'>] ?? 0;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200"
                style={{
                  background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                  border: active
                    ? '1px solid rgba(255,255,255,0.10)'
                    : '1px solid transparent',
                }}
              >
                <TabIcon size={13} />
                {tab.label}
                {count > 0 && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{
                      background: active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
                      color: active ? 'var(--text-secondary)' : 'var(--text-muted)',
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Search */}
        <div className="relative w-52">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-muted)' }}
          />
          <input
            type="text"
            placeholder="搜索资产..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-3 rounded-lg text-[12px] outline-none transition-all duration-200"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'var(--text-primary)',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent-primary, #818CF8)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
            }}
          />
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1">
          {([
            { key: 'date' as SortBy, label: '日期', icon: Calendar },
            { key: 'size' as SortBy, label: '大小', icon: HardDrive },
            { key: 'name' as SortBy, label: '名称', icon: ArrowUpDown },
          ]).map((s) => {
            const active = sortBy === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => handleSort(s.key)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
                style={{
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                }}
              >
                {s.label}
                {active && <SortIcon size={11} />}
              </button>
            );
          })}
        </div>

        {/* View toggle */}
        <div
          className="flex items-center rounded-lg overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <button
            type="button"
            onClick={() => handleViewMode('grid')}
            className="h-7 w-8 inline-flex items-center justify-center transition-colors"
            style={{
              background: viewMode === 'grid' ? 'rgba(255,255,255,0.08)' : 'transparent',
              color: viewMode === 'grid' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
            title="网格视图"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            type="button"
            onClick={() => handleViewMode('list')}
            className="h-7 w-8 inline-flex items-center justify-center transition-colors"
            style={{
              background: viewMode === 'list' ? 'rgba(255,255,255,0.08)' : 'transparent',
              color: viewMode === 'list' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
            title="列表视图"
          >
            <List size={14} />
          </button>
        </div>

        {/* Refresh */}
        <button
          type="button"
          onClick={() => fetchAssets(activeTab)}
          disabled={loading}
          className="h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors hover:bg-white/6"
          style={{ color: 'var(--text-muted)' }}
          title="刷新"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Main area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          {loading && assets.length === 0 ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 size={28} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-24 gap-3">
              <div className="text-sm" style={{ color: 'rgba(239,68,68,0.8)' }}>{error}</div>
              <button
                type="button"
                onClick={() => fetchAssets(activeTab)}
                className="text-[13px] px-3 py-1.5 rounded-lg transition-colors"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--accent-primary, #818CF8)',
                }}
              >
                重试
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState tab={activeTab} />
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
              {filtered.map((asset) => (
                <AssetGridCard
                  key={asset.id}
                  asset={asset}
                  isSelected={asset.id === selectedId}
                  onSelect={() => handleSelect(asset.id)}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-0.5">
              {/* List header */}
              <div
                className="flex items-center gap-3 px-3 py-2 text-[10px] font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-muted)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
              >
                <div className="w-10 flex-shrink-0" />
                <div className="flex-1">名称</div>
                <div className="w-14 flex-shrink-0 text-center">类型</div>
                <div className="w-16 text-right flex-shrink-0">大小</div>
                <div className="w-24 text-right flex-shrink-0">日期</div>
              </div>
              {filtered.map((asset) => (
                <AssetListRow
                  key={asset.id}
                  asset={asset}
                  isSelected={asset.id === selectedId}
                  onSelect={() => handleSelect(asset.id)}
                />
              ))}
            </div>
          )}

          {/* Infinite scroll sentinel */}
          {hasMore && <div ref={sentinelRef} className="h-px" />}

          {/* Loading more */}
          {loadingMore && (
            <div className="flex justify-center py-4">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedAsset && (
          <DetailPanel
            asset={selectedAsset}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}
