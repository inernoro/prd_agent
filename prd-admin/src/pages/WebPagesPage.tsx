import { useCallback, useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { Dialog } from '@/components/ui/Dialog';
import {
  listWebPages,
  createWebPage,
  updateWebPage,
  deleteWebPage,
  batchDeleteWebPages,
  toggleWebPageFavorite,
  listWebPageFolders,
  listWebPageTags,
  createWebPageShare,
  listWebPageShares,
  revokeWebPageShare,
} from '@/services';
import type { WebPageItem, WebPageShareLinkItem, TagCount } from '@/services/real/webPages';
import {
  Plus,
  Search,
  Star,
  Trash2,
  ExternalLink,
  Share2,
  Edit3,
  Grid3X3,
  List,
  FolderOpen,
  Tag,
  Eye,
  Copy,
  Check,
  X,
  Lock,
  Globe,
  Clock,
  RefreshCw,
  Link2,
  ChevronDown,
} from 'lucide-react';

// ─── Utility ───

function fmtDate(s: string | null | undefined) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relativeTime(s: string | null | undefined) {
  if (!s) return '';
  const now = Date.now();
  const t = new Date(s).getTime();
  const diff = now - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDate(s);
}

function getDomain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ─── Main Page ───

export default function WebPagesPage() {
  const [pages, setPages] = useState<WebPageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [showFavOnly, setShowFavOnly] = useState(false);
  const [sort, setSort] = useState('newest');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [folders, setFolders] = useState<string[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editItem, setEditItem] = useState<WebPageItem | null>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareTargetId, setShareTargetId] = useState<string | null>(null);
  const [showSharesPanel, setShowSharesPanel] = useState(false);
  const [shares, setShares] = useState<WebPageShareLinkItem[]>([]);

  // ─── Load ───

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listWebPages({
      keyword: keyword || undefined,
      folder: activeFolder || undefined,
      tag: activeTag || undefined,
      isFavorite: showFavOnly || undefined,
      sort,
      limit: 200,
    });
    if (res.success) {
      setPages(res.data.items);
      setTotal(res.data.total);
    }
    setLoading(false);
  }, [keyword, activeFolder, activeTag, showFavOnly, sort]);

  const loadMeta = useCallback(async () => {
    const [fRes, tRes] = await Promise.all([listWebPageFolders(), listWebPageTags()]);
    if (fRes.success) setFolders(fRes.data.folders);
    if (tRes.success) setTags(tRes.data.tags);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  // ─── Actions ───

  const handleToggleFavorite = async (id: string) => {
    const res = await toggleWebPageFavorite(id);
    if (res.success) {
      setPages(prev => prev.map(p => p.id === id ? { ...p, isFavorite: res.data.isFavorite } : p));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此网页收藏？')) return;
    const res = await deleteWebPage(id);
    if (res.success) {
      setPages(prev => prev.filter(p => p.id !== id));
      setTotal(prev => prev - 1);
      loadMeta();
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`确定删除选中的 ${selectedIds.size} 个网页收藏？`)) return;
    const res = await batchDeleteWebPages([...selectedIds]);
    if (res.success) {
      setSelectedIds(new Set());
      load();
      loadMeta();
    }
  };

  const handleShare = (id: string) => {
    setShareTargetId(id);
    setShowShareDialog(true);
  };

  const handleBatchShare = () => {
    if (selectedIds.size === 0) return;
    setShareTargetId(null); // collection mode
    setShowShareDialog(true);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ─── Render ───

  return (
    <div className="h-full flex flex-col gap-4 p-4 overflow-auto" style={{ background: 'var(--bg-base)' }}>
      <PageHeader
        title="网页收藏"
        description="收藏、整理和分享你发现的好网页"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowSharesPanel(true)}>
              <Link2 size={14} className="mr-1" /> 分享管理
            </Button>
            <Button size="sm" onClick={() => { setEditItem(null); setShowAddDialog(true); }}>
              <Plus size={14} className="mr-1" /> 添加网页
            </Button>
          </div>
        }
      />

      {/* Toolbar */}
      <GlassCard className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="搜索标题、URL、描述..."
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: 'var(--bg-sunken)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-default)',
              }}
            />
          </div>

          {/* Folder filter */}
          {folders.length > 0 && (
            <select
              value={activeFolder ?? ''}
              onChange={e => setActiveFolder(e.target.value || null)}
              className="px-3 py-2 rounded-lg text-sm outline-none cursor-pointer"
              style={{
                background: 'var(--bg-sunken)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-default)',
              }}
            >
              <option value="">全部文件夹</option>
              {folders.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          )}

          {/* Fav toggle */}
          <button
            onClick={() => setShowFavOnly(v => !v)}
            className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{
              background: showFavOnly ? 'rgba(234, 179, 8, 0.15)' : 'var(--bg-sunken)',
              color: showFavOnly ? '#eab308' : 'var(--text-muted)',
              border: '1px solid var(--border-default)',
            }}
          >
            <Star size={14} fill={showFavOnly ? '#eab308' : 'none'} /> 收藏
          </button>

          {/* Sort */}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm outline-none cursor-pointer"
            style={{
              background: 'var(--bg-sunken)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default)',
            }}
          >
            <option value="newest">最新添加</option>
            <option value="oldest">最早添加</option>
            <option value="title">按标题</option>
            <option value="most-viewed">最多浏览</option>
          </select>

          {/* View mode */}
          <div className="flex items-center rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-default)' }}>
            <button
              onClick={() => setViewMode('grid')}
              className="p-2 transition-colors"
              style={{ background: viewMode === 'grid' ? 'var(--bg-elevated)' : 'var(--bg-sunken)', color: 'var(--text-primary)' }}
            >
              <Grid3X3 size={14} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className="p-2 transition-colors"
              style={{ background: viewMode === 'list' ? 'var(--bg-elevated)' : 'var(--bg-sunken)', color: 'var(--text-primary)' }}
            >
              <List size={14} />
            </button>
          </div>

          {/* Refresh */}
          <button
            onClick={() => { load(); loadMeta(); }}
            className="p-2 rounded-lg transition-colors"
            style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <button
              onClick={() => setActiveTag(null)}
              className="px-2 py-0.5 rounded-full text-xs transition-colors"
              style={{
                background: !activeTag ? 'var(--accent-primary)' : 'var(--bg-sunken)',
                color: !activeTag ? '#fff' : 'var(--text-muted)',
              }}
            >
              全部
            </button>
            {tags.slice(0, 20).map(t => (
              <button
                key={t.tag}
                onClick={() => setActiveTag(t.tag === activeTag ? null : t.tag)}
                className="px-2 py-0.5 rounded-full text-xs transition-colors"
                style={{
                  background: activeTag === t.tag ? 'var(--accent-primary)' : 'var(--bg-sunken)',
                  color: activeTag === t.tag ? '#fff' : 'var(--text-muted)',
                }}
              >
                {t.tag} ({t.count})
              </button>
            ))}
          </div>
        )}

        {/* Batch actions */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>已选 {selectedIds.size} 项</span>
            <Button size="xs" variant="outline" onClick={handleBatchShare}><Share2 size={12} className="mr-1" /> 合集分享</Button>
            <Button size="xs" variant="danger" onClick={handleBatchDelete}><Trash2 size={12} className="mr-1" /> 批量删除</Button>
            <Button size="xs" variant="ghost" onClick={() => setSelectedIds(new Set())}>取消选择</Button>
          </div>
        )}
      </GlassCard>

      {/* Stats */}
      <div className="flex items-center gap-4 text-sm" style={{ color: 'var(--text-muted)' }}>
        <span>共 {total} 个收藏</span>
        {activeFolder && <span>文件夹: {activeFolder}</span>}
        {activeTag && <span>标签: {activeTag}</span>}
      </div>

      {/* Content */}
      {loading && pages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      ) : pages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-muted)' }}>
          <Globe size={48} strokeWidth={1} />
          <p>还没有收藏的网页</p>
          <Button size="sm" onClick={() => { setEditItem(null); setShowAddDialog(true); }}>
            <Plus size={14} className="mr-1" /> 添加第一个网页
          </Button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {pages.map(page => (
            <WebPageCard
              key={page.id}
              page={page}
              selected={selectedIds.has(page.id)}
              onSelect={() => toggleSelect(page.id)}
              onFavorite={() => handleToggleFavorite(page.id)}
              onEdit={() => { setEditItem(page); setShowAddDialog(true); }}
              onDelete={() => handleDelete(page.id)}
              onShare={() => handleShare(page.id)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {pages.map(page => (
            <WebPageListItem
              key={page.id}
              page={page}
              selected={selectedIds.has(page.id)}
              onSelect={() => toggleSelect(page.id)}
              onFavorite={() => handleToggleFavorite(page.id)}
              onEdit={() => { setEditItem(page); setShowAddDialog(true); }}
              onDelete={() => handleDelete(page.id)}
              onShare={() => handleShare(page.id)}
            />
          ))}
        </div>
      )}

      {/* Add/Edit Dialog */}
      {showAddDialog && (
        <AddEditDialog
          item={editItem}
          folders={folders}
          onClose={() => { setShowAddDialog(false); setEditItem(null); }}
          onSaved={() => { setShowAddDialog(false); setEditItem(null); load(); loadMeta(); }}
        />
      )}

      {/* Share Dialog */}
      {showShareDialog && (
        <ShareDialog
          webPageId={shareTargetId}
          webPageIds={shareTargetId ? undefined : [...selectedIds]}
          onClose={() => { setShowShareDialog(false); setShareTargetId(null); }}
        />
      )}

      {/* Shares Panel */}
      {showSharesPanel && (
        <SharesPanel
          shares={shares}
          setShares={setShares}
          onClose={() => setShowSharesPanel(false)}
        />
      )}
    </div>
  );
}

// ─── Card View ───

function WebPageCard({ page, selected, onSelect, onFavorite, onEdit, onDelete, onShare }: {
  page: WebPageItem;
  selected: boolean;
  onSelect: () => void;
  onFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  return (
    <GlassCard
      className="group relative flex flex-col overflow-hidden transition-all duration-200"
      style={{
        border: selected ? '2px solid var(--accent-primary)' : undefined,
      }}
    >
      {/* Cover */}
      {page.coverImageUrl ? (
        <div className="h-40 overflow-hidden">
          <img
            src={page.coverImageUrl}
            alt=""
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        </div>
      ) : (
        <div
          className="h-24 flex items-center justify-center"
          style={{ background: 'var(--bg-sunken)' }}
        >
          <Globe size={32} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 p-4 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {page.faviconUrl && (
              <img src={page.faviconUrl} alt="" className="w-4 h-4 rounded-sm shrink-0" />
            )}
            <h3
              className="text-sm font-medium truncate cursor-pointer hover:underline"
              style={{ color: 'var(--text-primary)' }}
              onClick={() => window.open(page.url, '_blank')}
              title={page.title}
            >
              {page.title}
            </h3>
          </div>
          <button
            onClick={onFavorite}
            className="shrink-0 transition-transform hover:scale-110"
          >
            <Star size={16} fill={page.isFavorite ? '#eab308' : 'none'} color={page.isFavorite ? '#eab308' : 'var(--text-muted)'} />
          </button>
        </div>

        <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
          {getDomain(page.url)}
        </p>

        {page.description && (
          <p className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
            {page.description}
          </p>
        )}

        {page.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {page.tags.slice(0, 4).map(tag => (
              <span
                key={tag}
                className="px-1.5 py-0.5 rounded text-[10px]"
                style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}
              >
                {tag}
              </span>
            ))}
            {page.tags.length > 4 && (
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>+{page.tags.length - 4}</span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between mt-auto pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span className="flex items-center gap-1"><Eye size={10} /> {page.viewCount}</span>
            <span className="flex items-center gap-1"><Clock size={10} /> {relativeTime(page.createdAt)}</span>
            {page.folder && (
              <span className="flex items-center gap-1"><FolderOpen size={10} /> {page.folder}</span>
            )}
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={onSelect} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="选择">
              <input type="checkbox" checked={selected} readOnly className="pointer-events-none" style={{ accentColor: 'var(--accent-primary)' }} />
            </button>
            <button onClick={() => window.open(page.url, '_blank')} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="打开">
              <ExternalLink size={13} style={{ color: 'var(--text-muted)' }} />
            </button>
            <button onClick={onShare} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="分享">
              <Share2 size={13} style={{ color: 'var(--text-muted)' }} />
            </button>
            <button onClick={onEdit} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="编辑">
              <Edit3 size={13} style={{ color: 'var(--text-muted)' }} />
            </button>
            <button onClick={onDelete} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="删除">
              <Trash2 size={13} style={{ color: '#ef4444' }} />
            </button>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}

// ─── List View ───

function WebPageListItem({ page, selected, onSelect, onFavorite, onEdit, onDelete, onShare }: {
  page: WebPageItem;
  selected: boolean;
  onSelect: () => void;
  onFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  return (
    <GlassCard
      className="group flex items-center gap-4 p-3"
      style={{ border: selected ? '2px solid var(--accent-primary)' : undefined }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        className="shrink-0"
        style={{ accentColor: 'var(--accent-primary)' }}
      />

      {page.faviconUrl ? (
        <img src={page.faviconUrl} alt="" className="w-5 h-5 rounded-sm shrink-0" />
      ) : (
        <Globe size={20} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-sm font-medium truncate cursor-pointer hover:underline"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => window.open(page.url, '_blank')}
          >
            {page.title}
          </span>
          <span className="text-xs truncate shrink-0" style={{ color: 'var(--text-muted)' }}>
            {getDomain(page.url)}
          </span>
        </div>
        {page.tags.length > 0 && (
          <div className="flex gap-1 mt-1">
            {page.tags.slice(0, 5).map(tag => (
              <span key={tag} className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}>
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
        {page.folder && <span className="flex items-center gap-1"><FolderOpen size={12} /> {page.folder}</span>}
        <span className="flex items-center gap-1"><Eye size={12} /> {page.viewCount}</span>
        <span>{relativeTime(page.createdAt)}</span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button onClick={onFavorite} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <Star size={14} fill={page.isFavorite ? '#eab308' : 'none'} color={page.isFavorite ? '#eab308' : 'var(--text-muted)'} />
        </button>
        <button onClick={() => window.open(page.url, '_blank')} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <ExternalLink size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
        <button onClick={onShare} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <Share2 size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
        <button onClick={onEdit} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <Edit3 size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
        <button onClick={onDelete} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <Trash2 size={14} style={{ color: '#ef4444' }} />
        </button>
      </div>
    </GlassCard>
  );
}

// ─── Add/Edit Dialog ───

function AddEditDialog({ item, folders, onClose, onSaved }: {
  item: WebPageItem | null;
  folders: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(item?.url ?? '');
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [faviconUrl, setFaviconUrl] = useState(item?.faviconUrl ?? '');
  const [coverImageUrl, setCoverImageUrl] = useState(item?.coverImageUrl ?? '');
  const [tagInput, setTagInput] = useState((item?.tags ?? []).join(', '));
  const [folder, setFolder] = useState(item?.folder ?? '');
  const [note, setNote] = useState(item?.note ?? '');
  const [isFavorite, setIsFavorite] = useState(item?.isFavorite ?? false);
  const [isPublic, setIsPublic] = useState(item?.isPublic ?? false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!url.trim() || !title.trim()) return;
    setSaving(true);
    const tags = tagInput.split(/[,，]/).map(t => t.trim()).filter(Boolean);

    const data = {
      url: url.trim(),
      title: title.trim(),
      description: description.trim() || undefined,
      faviconUrl: faviconUrl.trim() || undefined,
      coverImageUrl: coverImageUrl.trim() || undefined,
      tags,
      folder: folder.trim() || undefined,
      note: note.trim() || undefined,
      isFavorite,
      isPublic,
    };

    const res = item
      ? await updateWebPage(item.id, data)
      : await createWebPage(data);

    setSaving(false);
    if (res.success) onSaved();
  };

  const inputStyle = {
    background: 'var(--bg-sunken)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  };

  return (
    <Dialog open onClose={onClose} title={item ? '编辑网页' : '添加网页'}>
      <div className="flex flex-col gap-3 max-h-[65vh] overflow-y-auto pr-1">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>URL *</span>
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="px-3 py-2 rounded-lg text-sm outline-none"
            style={inputStyle}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>标题 *</span>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="网页标题"
            className="px-3 py-2 rounded-lg text-sm outline-none"
            style={inputStyle}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>描述</span>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="简短描述这个网页..."
            rows={2}
            className="px-3 py-2 rounded-lg text-sm outline-none resize-none"
            style={inputStyle}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Favicon URL</span>
            <input
              type="url"
              value={faviconUrl}
              onChange={e => setFaviconUrl(e.target.value)}
              placeholder="https://example.com/favicon.ico"
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={inputStyle}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>封面图 URL</span>
            <input
              type="url"
              value={coverImageUrl}
              onChange={e => setCoverImageUrl(e.target.value)}
              placeholder="https://example.com/cover.jpg"
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={inputStyle}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>标签（逗号分隔）</span>
          <input
            type="text"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            placeholder="前端, React, 教程"
            className="px-3 py-2 rounded-lg text-sm outline-none"
            style={inputStyle}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>文件夹</span>
          <input
            type="text"
            value={folder}
            onChange={e => setFolder(e.target.value)}
            placeholder="输入文件夹名或留空"
            list="folder-suggestions"
            className="px-3 py-2 rounded-lg text-sm outline-none"
            style={inputStyle}
          />
          <datalist id="folder-suggestions">
            {folders.map(f => <option key={f} value={f} />)}
          </datalist>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>备注</span>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="个人备注..."
            rows={2}
            className="px-3 py-2 rounded-lg text-sm outline-none resize-none"
            style={inputStyle}
          />
        </label>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={isFavorite} onChange={e => setIsFavorite(e.target.checked)} style={{ accentColor: '#eab308' }} />
            <Star size={14} /> 收藏
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} style={{ accentColor: 'var(--accent-primary)' }} />
            <Globe size={14} /> 公开
          </label>
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button onClick={handleSave} disabled={saving || !url.trim() || !title.trim()}>
          {saving ? '保存中...' : item ? '更新' : '添加'}
        </Button>
      </div>
    </Dialog>
  );
}

// ─── Share Dialog ───

function ShareDialog({ webPageId, webPageIds, onClose }: {
  webPageId: string | null;
  webPageIds?: string[];
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(0);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ shareUrl: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const isCollection = !webPageId && webPageIds && webPageIds.length > 1;

  const handleCreate = async () => {
    setCreating(true);
    const res = await createWebPageShare({
      webPageId: webPageId || undefined,
      webPageIds: isCollection ? webPageIds : undefined,
      shareType: isCollection ? 'collection' : 'single',
      title: title.trim() || undefined,
      password: password.trim() || undefined,
      expiresInDays,
    });
    setCreating(false);
    if (res.success) {
      setResult({ shareUrl: res.data.shareUrl, token: res.data.token });
    }
  };

  const handleCopy = () => {
    const fullUrl = `${window.location.origin}${result!.shareUrl}`;
    navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const inputStyle = {
    background: 'var(--bg-sunken)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  };

  return (
    <Dialog open onClose={onClose} title={result ? '分享链接已创建' : '创建分享链接'}>
      {result ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)' }}>
            <Check size={16} style={{ color: '#22c55e' }} />
            <span className="text-sm" style={{ color: '#22c55e' }}>分享链接已生成</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={`${window.location.origin}${result.shareUrl}`}
              readOnly
              className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
              style={inputStyle}
            />
            <Button size="sm" onClick={handleCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>关闭</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {isCollection && (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              将分享 {webPageIds!.length} 个网页的合集
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>分享标题（可选）</span>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="给分享起个名字"
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={inputStyle}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              <Lock size={12} className="inline mr-1" />访问密码（留空则公开）
            </span>
            <input
              type="text"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="留空 = 任何人可访问"
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={inputStyle}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              <Clock size={12} className="inline mr-1" />过期时间
            </span>
            <select
              value={expiresInDays}
              onChange={e => setExpiresInDays(Number(e.target.value))}
              className="px-3 py-2 rounded-lg text-sm outline-none cursor-pointer"
              style={inputStyle}
            >
              <option value={0}>永不过期</option>
              <option value={1}>1 天</option>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
            </select>
          </label>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? '生成中...' : '生成链接'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ─── Shares Panel ───

function SharesPanel({ shares, setShares, onClose }: {
  shares: WebPageShareLinkItem[];
  setShares: (s: WebPageShareLinkItem[]) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await listWebPageShares();
      if (res.success) setShares(res.data.items);
      setLoading(false);
    })();
  }, [setShares]);

  const handleRevoke = async (shareId: string) => {
    if (!confirm('确定撤销此分享链接？')) return;
    const res = await revokeWebPageShare(shareId);
    if (res.success) {
      setShares(shares.filter(s => s.id !== shareId));
    }
  };

  const handleCopy = (token: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/s/wp/${token}`);
  };

  return (
    <Dialog open onClose={onClose} title="分享管理" wide>
      {loading ? (
        <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : shares.length === 0 ? (
        <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          还没有创建过分享链接
        </div>
      ) : (
        <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
          {shares.map(share => (
            <div
              key={share.id}
              className="flex items-center gap-3 p-3 rounded-lg"
              style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Link2 size={14} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {share.title || (share.shareType === 'collection' ? `合集 (${share.webPageIds.length} 页)` : '单页分享')}
                  </span>
                  <Badge variant={share.accessLevel === 'password' ? 'warning' : 'success'}>
                    {share.accessLevel === 'password' ? '密码保护' : '公开'}
                  </Badge>
                  {share.shareType === 'collection' && (
                    <Badge variant="info">{share.webPageIds.length} 页合集</Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span className="flex items-center gap-1"><Eye size={10} /> {share.viewCount} 次浏览</span>
                  <span>创建于 {fmtDate(share.createdAt)}</span>
                  {share.expiresAt && <span>过期于 {fmtDate(share.expiresAt)}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="xs" variant="ghost" onClick={() => handleCopy(share.token)} title="复制链接">
                  <Copy size={12} />
                </Button>
                <Button size="xs" variant="ghost" onClick={() => window.open(`/s/wp/${share.token}`, '_blank')} title="预览">
                  <ExternalLink size={12} />
                </Button>
                <Button size="xs" variant="danger" onClick={() => handleRevoke(share.id)} title="撤销">
                  <X size={12} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end mt-4 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
        <Button variant="ghost" onClick={onClose}>关闭</Button>
      </div>
    </Dialog>
  );
}
