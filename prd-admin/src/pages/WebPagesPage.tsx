import { useCallback, useEffect, useRef, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { SitePreview } from '@/components/SitePreview';
import { Dialog } from '@/components/ui/Dialog';
import {
  uploadSite,
  reuploadSite,
  listSites,
  updateSite,
  deleteSite,
  batchDeleteSites,
  setSiteVisibility,
  listSiteFolders,
  listSiteTags,
  createSiteShareLink,
  listSiteShares,
  revokeSiteShare,
  listShareViewLogs,
} from '@/services';
import type { HostedSite, ShareLinkItem, TagCount, ShareViewLogItem } from '@/services/real/webPages';
import { ShareDock, SHARE_DOCK_MIME } from '@/components/web-hosting/ShareDock';
import { useAuthStore } from '@/stores/authStore';
import {
  Upload,
  Search,
  Trash2,
  ExternalLink,
  Share2,
  Edit3,
  Grid3X3,
  List,
  FolderOpen,
  Eye,
  Copy,
  Check,
  X,
  Lock,
  Clock,
  RefreshCw,
  Link2,
  FileCode2,
  FileArchive,
  HardDrive,
  UploadCloud,
  QrCode,
  Globe,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';

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

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const sourceTypeLabels: Record<string, string> = {
  upload: '手动上传',
  workflow: '工作流',
  api: 'API',
  'saved-share': '从分享保存',
};

// ─── Main Page ───

export default function WebPagesPage() {
  const username = useAuthStore(s => s.user?.username);
  const [sites, setSites] = useState<HostedSite[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeSourceType, setActiveSourceType] = useState<string | null>(null);
  const [sort, setSort] = useState('newest');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [folders, setFolders] = useState<string[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);

  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [editItem, setEditItem] = useState<HostedSite | null>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareTargetId, setShareTargetId] = useState<string | null>(null);
  const [showSharesPanel, setShowSharesPanel] = useState(false);
  const [shares, setShares] = useState<ShareLinkItem[]>([]);
  const [qrSite, setQrSite] = useState<HostedSite | null>(null);

  // ─── Load ───

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listSites({
      keyword: keyword || undefined,
      folder: activeFolder || undefined,
      tag: activeTag || undefined,
      sourceType: activeSourceType || undefined,
      sort,
      limit: 200,
    });
    if (res.success) {
      setSites(res.data.items);
      setTotal(res.data.total);
    }
    setLoading(false);
  }, [keyword, activeFolder, activeTag, activeSourceType, sort]);

  const loadMeta = useCallback(async () => {
    const [fRes, tRes] = await Promise.all([listSiteFolders(), listSiteTags()]);
    if (fRes.success) setFolders(fRes.data.folders);
    if (tRes.success) setTags(tRes.data.tags);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  // ─── Actions ───

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此站点？站点文件将同时被清理。')) return;
    const res = await deleteSite(id);
    if (res.success) {
      setSites(prev => prev.filter(s => s.id !== id));
      setTotal(prev => prev - 1);
      loadMeta();
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`确定删除选中的 ${selectedIds.size} 个站点？`)) return;
    const res = await batchDeleteSites([...selectedIds]);
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

  const handleMakePublic = useCallback(async (site: HostedSite) => {
    if (site.visibility === 'public') {
      if (!confirm(`「${site.title}」已经是公开状态，是否改回私有？`)) return;
      const res = await setSiteVisibility(site.id, 'private');
      if (res.success) {
        setSites(prev => prev.map(s => s.id === site.id ? res.data : s));
      }
      return;
    }
    if (!confirm(`将「${site.title}」设为公开？\n\n任何人都能在你的个人公开页（/u/${username ?? '...'}）看到此站点。`)) return;
    const res = await setSiteVisibility(site.id, 'public');
    if (res.success) {
      setSites(prev => prev.map(s => s.id === site.id ? res.data : s));
    } else {
      alert(res.error?.message || '设置失败');
    }
  }, [username]);

  const handleDropShare = useCallback((site: HostedSite) => {
    setShareTargetId(site.id);
    setShowShareDialog(true);
  }, []);

  const handleDropDelete = useCallback(async (site: HostedSite) => {
    if (!confirm(`确定删除「${site.title}」？站点文件将同时被清理，此操作不可撤销。`)) return;
    const res = await deleteSite(site.id);
    if (res.success) {
      setSites(prev => prev.filter(s => s.id !== site.id));
      setTotal(prev => prev - 1);
      loadMeta();
    }
  }, [loadMeta]);

  const handleBatchShare = () => {
    if (selectedIds.size === 0) return;
    setShareTargetId(null);
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

  return (
    <div className="h-full flex flex-col gap-4 p-4 overflow-auto" style={{ background: 'var(--bg-base)' }}>
      {/* 右上角投放面板：拖站点即可设为公开/分享/删除 */}
      <ShareDock
        publicSites={sites.filter(s => s.visibility === 'public')}
        username={username}
        onMakePublic={handleMakePublic}
        onShare={handleDropShare}
        onDelete={handleDropDelete}
        getSiteById={(id) => sites.find(s => s.id === id)}
      />
      <PageHeader
        title="网页托管"
        description="上传 HTML 或 ZIP 压缩包，托管并分享你的网页"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowSharesPanel(true)}>
              <Link2 size={14} className="mr-1" /> 分享管理
            </Button>
            <Button size="sm" onClick={() => { setEditItem(null); setShowUploadDialog(true); }}>
              <Upload size={14} className="mr-1" /> 上传站点
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
              placeholder="搜索站点名称、描述..."
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
              style={{ background: 'var(--bg-sunken)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
            >
              <option value="">全部文件夹</option>
              {folders.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          )}

          {/* Source type filter */}
          <select
            value={activeSourceType ?? ''}
            onChange={e => setActiveSourceType(e.target.value || null)}
            className="px-3 py-2 rounded-lg text-sm outline-none cursor-pointer"
            style={{ background: 'var(--bg-sunken)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
          >
            <option value="">全部来源</option>
            <option value="upload">手动上传</option>
            <option value="workflow">工作流</option>
            <option value="api">API</option>
            <option value="saved-share">从分享保存</option>
          </select>

          {/* Sort */}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm outline-none cursor-pointer"
            style={{ background: 'var(--bg-sunken)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
          >
            <option value="newest">最新创建</option>
            <option value="oldest">最早创建</option>
            <option value="title">按标题</option>
            <option value="most-viewed">最多浏览</option>
            <option value="largest">最大体积</option>
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
            {loading ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
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
            <Button size="xs" variant="secondary" onClick={handleBatchShare}><Share2 size={12} className="mr-1" /> 合集分享</Button>
            <Button size="xs" variant="danger" onClick={handleBatchDelete}><Trash2 size={12} className="mr-1" /> 批量删除</Button>
            <Button size="xs" variant="ghost" onClick={() => setSelectedIds(new Set())}>取消选择</Button>
          </div>
        )}
      </GlassCard>

      {/* Stats */}
      <div className="flex items-center gap-4 text-sm" style={{ color: 'var(--text-muted)' }}>
        <span>共 {total} 个站点</span>
        {activeFolder && <span>文件夹: {activeFolder}</span>}
        {activeTag && <span>标签: {activeTag}</span>}
        {activeSourceType && <span>来源: {sourceTypeLabels[activeSourceType] ?? activeSourceType}</span>}
      </div>

      {/* Content */}
      {loading && sites.length === 0 ? (
        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      ) : sites.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-muted)' }}>
          <UploadCloud size={48} strokeWidth={1} />
          <p>还没有托管的网页</p>
          <Button size="sm" onClick={() => { setEditItem(null); setShowUploadDialog(true); }}>
            <Upload size={14} className="mr-1" /> 上传第一个站点
          </Button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {sites.map(site => (
            <SiteCard
              key={site.id}
              site={site}
              selected={selectedIds.has(site.id)}
              onSelect={() => toggleSelect(site.id)}
              onEdit={() => { setEditItem(site); setShowUploadDialog(true); }}
              onDelete={() => handleDelete(site.id)}
              onShare={() => handleShare(site.id)}
              onQrCode={() => setQrSite(site)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sites.map(site => (
            <SiteListItem
              key={site.id}
              site={site}
              selected={selectedIds.has(site.id)}
              onSelect={() => toggleSelect(site.id)}
              onEdit={() => { setEditItem(site); setShowUploadDialog(true); }}
              onDelete={() => handleDelete(site.id)}
              onShare={() => handleShare(site.id)}
              onQrCode={() => setQrSite(site)}
            />
          ))}
        </div>
      )}

      {/* Upload / Edit Dialog */}
      {showUploadDialog && (
        <UploadEditDialog
          item={editItem}
          folders={folders}
          onClose={() => { setShowUploadDialog(false); setEditItem(null); }}
          onSaved={() => { setShowUploadDialog(false); setEditItem(null); load(); loadMeta(); }}
        />
      )}

      {/* Share Dialog */}
      {showShareDialog && (
        <ShareDialog
          siteId={shareTargetId}
          siteIds={shareTargetId ? undefined : [...selectedIds]}
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

      {/* QR Code Dialog */}
      {qrSite && (
        <QrCodeDialog site={qrSite} onClose={() => setQrSite(null)} />
      )}
    </div>
  );
}

// ─── Card View ───

// ─── Iframe Thumbnail Preview ───

// ─── QR Code Dialog (auto-creates share link) ───

function QrCodeDialog({ site, onClose }: { site: HostedSite; onClose: () => void }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // 1. 查找该 site 已有的、可用的无密码分享链接
      const listRes = await listSiteShares();
      if (cancelled) return;
      if (listRes.success) {
        const existing = listRes.data.items.find(s =>
          s.siteId === site.id &&
          s.shareType === 'single' &&
          !s.isRevoked &&
          s.accessLevel === 'public' &&
          (!s.expiresAt || new Date(s.expiresAt) > new Date())
        );
        if (existing) {
          setShareUrl(`${window.location.origin}/s/wp/${existing.token}`);
          setLoading(false);
          return;
        }
      }
      // 2. 没有可复用的，才创建新的
      const res = await createSiteShareLink({
        siteId: site.id,
        shareType: 'single',
        expiresInDays: 0,
      });
      if (cancelled) return;
      setLoading(false);
      if (res.success) {
        setShareUrl(`${window.location.origin}${res.data.shareUrl}`);
      } else {
        setError('创建分享链接失败');
      }
    })();
    return () => { cancelled = true; };
  }, [site.id]);

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title="扫码访问"
      description={site.title}
      content={
        <div className="flex flex-col items-center gap-4 py-4">
          {loading ? (
            <MapSectionLoader text="正在生成分享链接…" />
          ) : error ? (
            <p className="text-sm py-8" style={{ color: '#ef4444' }}>{error}</p>
          ) : shareUrl ? (
            <>
              <div className="p-4 rounded-2xl" style={{ background: '#fff' }}>
                <QRCodeSVG value={shareUrl} size={280} level="H" />
              </div>
              <p className="text-xs text-center break-all px-4" style={{ color: 'var(--text-muted)', maxWidth: 320 }}>
                {shareUrl}
              </p>
            </>
          ) : null}
        </div>
      }
    />
  );
}

// SitePreview 已提取到 @/components/SitePreview

function SiteCard({ site, selected, onSelect, onEdit, onDelete, onShare, onQrCode }: {
  site: HostedSite;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onQrCode: () => void;
}) {
  const isPublic = site.visibility === 'public';
  return (
    <GlassCard
      className="group relative flex flex-col overflow-hidden transition-all duration-200 cursor-grab active:cursor-grabbing"
      style={{ border: selected ? '2px solid var(--accent-primary)' : undefined }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SHARE_DOCK_MIME, site.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      {/* Thumbnail preview */}
      <div
        className="relative cursor-pointer"
        style={{ aspectRatio: '16 / 9', background: 'var(--bg-sunken)' }}
        onClick={() => window.open(site.siteUrl, '_blank')}
      >
        {site.coverImageUrl ? (
          <img src={site.coverImageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <SitePreview url={site.siteUrl} className="w-full h-full" />
        )}
        {/* Hover overlay with actions */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-200 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
          <button onClick={(e) => { e.stopPropagation(); window.open(site.siteUrl, '_blank'); }} className="p-1.5 rounded-full bg-white/20 backdrop-blur-sm hover:bg-white/30" title="访问">
            <ExternalLink size={14} style={{ color: '#fff' }} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onShare(); }} className="p-1.5 rounded-full bg-white/20 backdrop-blur-sm hover:bg-white/30" title="分享">
            <Share2 size={14} style={{ color: '#fff' }} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onQrCode(); }} className="p-1.5 rounded-full bg-white/20 backdrop-blur-sm hover:bg-white/30" title="二维码">
            <QrCode size={14} style={{ color: '#fff' }} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="p-1.5 rounded-full bg-white/20 backdrop-blur-sm hover:bg-white/30" title="编辑">
            <Edit3 size={14} style={{ color: '#fff' }} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="p-1.5 rounded-full bg-white/20 backdrop-blur-sm hover:bg-white/30" title="删除">
            <Trash2 size={14} style={{ color: '#ef4444' }} />
          </button>
        </div>
        {/* Select checkbox */}
        <div className="absolute top-1.5 left-1.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={(e) => { e.stopPropagation(); onSelect(); }} className="p-0.5 rounded bg-black/30 backdrop-blur-sm">
            <input type="checkbox" checked={selected} readOnly className="pointer-events-none" style={{ accentColor: 'var(--accent-primary)' }} />
          </button>
        </div>
        {/* Source badge + visibility */}
        <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
          {isPublic && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-sky-500/30 px-1.5 py-0.5 text-[9px] font-medium text-sky-100 backdrop-blur-sm"
              title="已公开：出现在你的个人公开页"
            >
              <Globe size={9} /> 公开
            </span>
          )}
          <Badge variant={site.sourceType === 'workflow' ? 'subtle' : site.sourceType === 'api' ? 'warning' : 'subtle'}>
            {sourceTypeLabels[site.sourceType] ?? site.sourceType}
          </Badge>
        </div>
      </div>

      {/* Content — compact */}
      <div className="flex-1 px-3 py-2 flex flex-col gap-1">
        <h3
          className="text-[13px] font-medium truncate cursor-pointer hover:underline leading-tight"
          style={{ color: 'var(--text-primary)' }}
          onClick={() => window.open(site.siteUrl, '_blank')}
          title={site.title}
        >
          {site.title}
        </h3>

        {site.description && (
          <p className="text-[11px] line-clamp-1 leading-tight" style={{ color: 'var(--text-secondary)' }}>
            {site.description}
          </p>
        )}

        {/* Meta row: file count + size + tags inline */}
        <div className="flex items-center gap-1.5 flex-wrap text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          <span className="flex items-center gap-0.5"><FileArchive size={9} />{site.files.length}文件</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span className="flex items-center gap-0.5"><HardDrive size={9} />{fmtSize(site.totalSize)}</span>
          {site.tags.slice(0, 2).map(tag => (
            <span
              key={tag}
              className="px-1 py-px rounded"
              style={{ background: 'var(--bg-sunken)', fontSize: '9px' }}
            >
              {tag}
            </span>
          ))}
          {site.tags.length > 2 && <span style={{ fontSize: '9px' }}>+{site.tags.length - 2}</span>}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 mt-auto pt-1.5 text-[10px]" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
          <span className="flex items-center gap-0.5"><Eye size={9} />{site.viewCount}</span>
          <span className="flex items-center gap-0.5"><Clock size={9} />{relativeTime(site.createdAt)}</span>
          {site.folder && <span className="flex items-center gap-0.5 ml-auto"><FolderOpen size={9} />{site.folder}</span>}
        </div>
      </div>
    </GlassCard>
  );
}

// ─── List View ───

function SiteListItem({ site, selected, onSelect, onEdit, onDelete, onShare, onQrCode }: {
  site: HostedSite;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onQrCode: () => void;
}) {
  const isPublic = site.visibility === 'public';
  return (
    <GlassCard
      className="group flex items-center gap-4 p-3 cursor-grab active:cursor-grabbing"
      style={{ border: selected ? '2px solid var(--accent-primary)' : undefined }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SHARE_DOCK_MIME, site.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        className="shrink-0"
        style={{ accentColor: 'var(--accent-primary)' }}
      />

      {site.coverImageUrl ? (
        <img src={site.coverImageUrl} alt="" className="shrink-0 w-10 h-10 rounded object-cover" />
      ) : (
        <div className="shrink-0 w-10 h-10 rounded overflow-hidden" style={{ background: 'var(--bg-sunken)' }}>
          <SitePreview url={site.siteUrl} className="w-full h-full" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-sm font-medium truncate cursor-pointer hover:underline"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => window.open(site.siteUrl, '_blank')}
          >
            {site.title}
          </span>
          <Badge variant={site.sourceType === 'workflow' ? 'subtle' : site.sourceType === 'api' ? 'warning' : 'subtle'}>
            {sourceTypeLabels[site.sourceType] ?? site.sourceType}
          </Badge>
          {isPublic && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-sky-500/25 px-1.5 py-0.5 text-[10px] font-medium text-sky-200"
              title="已公开"
            >
              <Globe size={10} /> 公开
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{site.files.length} 个文件</span>
          <span>{fmtSize(site.totalSize)}</span>
          <span>{site.entryFile}</span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
        {site.folder && <span className="flex items-center gap-1"><FolderOpen size={12} /> {site.folder}</span>}
        <span className="flex items-center gap-1"><Eye size={12} /> {site.viewCount}</span>
        <span>{relativeTime(site.createdAt)}</span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button onClick={() => window.open(site.siteUrl, '_blank')} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <ExternalLink size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
        <button onClick={onShare} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <Share2 size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
        <button onClick={onQrCode} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="二维码">
          <QrCode size={14} style={{ color: 'var(--text-muted)' }} />
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

// ─── Upload / Edit Dialog ───

function UploadEditDialog({ item, folders, onClose, onSaved }: {
  item: HostedSite | null;
  folders: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!item;
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [tagInput, setTagInput] = useState((item?.tags ?? []).join(', '));
  const [folder, setFolder] = useState(item?.folder ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  };

  const handleSave = async () => {
    setSaving(true);

    if (isEdit) {
      if (file) {
        // Reupload
        const res = await reuploadSite(item.id, file);
        if (!res.success) { setSaving(false); return; }
      }
      // Update metadata
      const tags = tagInput.split(/[,，]/).map(t => t.trim()).filter(Boolean);
      const res = await updateSite(item.id, {
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        tags,
        folder: folder.trim() || undefined,
      });
      setSaving(false);
      if (res.success) onSaved();
    } else {
      if (!file) { setSaving(false); return; }
      const tags = tagInput.split(/[,，]/).map(t => t.trim()).filter(Boolean);
      const res = await uploadSite({
        file,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        folder: folder.trim() || undefined,
        tags: tags.length > 0 ? tags.join(',') : undefined,
      });
      setSaving(false);
      if (res.success) onSaved();
    }
  };

  const inputStyle = {
    background: 'var(--bg-sunken)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  };

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title={isEdit ? '编辑站点' : '上传站点'}
      content={
        <>
          <div className="flex flex-col gap-3 max-h-[65vh] overflow-y-auto pr-1">

            {/* File drop zone */}
            {(!isEdit || file !== null) ? (
              <div
                className="flex flex-col items-center justify-center gap-2 p-6 rounded-lg cursor-pointer transition-colors"
                style={{
                  background: dragOver ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-sunken)',
                  border: `2px dashed ${dragOver ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                }}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <UploadCloud size={32} style={{ color: 'var(--text-muted)' }} />
                {file ? (
                  <div className="text-center">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{file.name}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{fmtSize(file.size)}</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>拖拽文件到此处，或点击选择</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>支持 .html / .htm / .zip 文件，最大 50MB</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".html,.htm,.zip"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); }}
                />
              </div>
            ) : (
              <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}>
                <FileCode2 size={20} style={{ color: 'var(--accent-primary)' }} />
                <div className="flex-1">
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{item.entryFile}</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.files.length} 个文件, {fmtSize(item.totalSize)}</p>
                </div>
                <Button size="xs" variant="secondary" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={12} className="mr-1" /> 重新上传
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".html,.htm,.zip"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); }}
                />
              </div>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>站点标题</span>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="站点标题（留空使用文件名）"
                className="px-3 py-2 rounded-lg text-sm outline-none"
                style={inputStyle}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>描述</span>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="站点描述..."
                rows={2}
                className="px-3 py-2 rounded-lg text-sm outline-none resize-none"
                style={inputStyle}
              />
            </label>

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
          </div>

          <div className="flex justify-end gap-2 mt-4 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button onClick={handleSave} disabled={saving || (!isEdit && !file)}>
              {saving ? '处理中...' : isEdit ? '保存' : '上传并创建'}
            </Button>
          </div>
        </>
      }
    />
  );
}

// ─── Share Dialog ───

function genPassword(len = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => chars[b % chars.length]).join('');
}

function ShareDialog({ siteId, siteIds, onClose }: {
  siteId: string | null;
  siteIds?: string[];
  onClose: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ shareUrl: string; token: string; password?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(0);

  const isCollection = !siteId && siteIds && siteIds.length > 1;

  const handleCreate = async () => {
    setCreating(true);
    const pwd = usePassword ? (password.trim() || undefined) : undefined;
    const res = await createSiteShareLink({
      siteId: siteId || undefined,
      siteIds: isCollection ? siteIds : undefined,
      shareType: isCollection ? 'collection' : 'single',
      password: pwd,
      expiresInDays,
    });
    setCreating(false);
    if (res.success) {
      const shareResult = { shareUrl: res.data.shareUrl, token: res.data.token, password: pwd };
      setResult(shareResult);
      // 自动复制链接和密码
      let text = `${window.location.origin}${shareResult.shareUrl}`;
      if (shareResult.password) text += `\n访问密码：${shareResult.password}`;
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopy = () => {
    let text = `${window.location.origin}${result!.shareUrl}`;
    if (result!.password) text += `\n访问密码：${result!.password}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const inputStyle = {
    background: 'var(--bg-sunken)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  };

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title={result ? '分享链接已创建' : '快速分享'}
      content={
        result ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)' }}>
              <Check size={16} style={{ color: '#22c55e' }} />
              <span className="text-sm" style={{ color: '#22c55e' }}>分享链接已生成，已复制到剪贴板</span>
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
            {result.password && (
              <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.25)' }}>
                <Lock size={16} style={{ color: 'rgba(59, 130, 246, 0.9)', flexShrink: 0 }} />
                <div className="flex-1">
                  <div className="text-xs mb-1" style={{ color: 'rgba(59, 130, 246, 0.8)' }}>访问密码</div>
                  <code className="text-sm font-mono font-bold tracking-wider" style={{ color: 'var(--text-primary)' }}>{result.password}</code>
                </div>
                <Button size="sm" variant="ghost" onClick={() => {
                  navigator.clipboard.writeText(result!.password!);
                }}>
                  <Copy size={14} />
                </Button>
              </div>
            )}
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {result.password ? '复制按钮会同时复制链接和密码' : '此链接无需密码，任何人可直接访问'}
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose}>关闭</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {isCollection && (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                将分享 {siteIds!.length} 个站点的合集
              </p>
            )}
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              点击下方按钮即可一键生成分享链接，标题会自动生成。
            </p>

            {/* 分享选项 */}
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={usePassword}
                  onChange={e => {
                    setUsePassword(e.target.checked);
                    if (e.target.checked) {
                      setPassword(genPassword());
                    } else {
                      setPassword('');
                    }
                  }}
                />
                <Lock size={12} style={{ color: 'var(--text-muted)' }} />
                <span style={{ color: 'var(--text-secondary)' }}>密码保护</span>
              </label>
              {usePassword && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="输入密码"
                      className="flex-1 px-3 py-1.5 rounded-lg text-sm outline-none"
                      style={inputStyle}
                    />
                    <Button size="xs" variant="ghost" onClick={() => setPassword(genPassword())} title="随机生成密码">
                      <RefreshCw size={12} />
                    </Button>
                  </div>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    可修改密码或点击右侧按钮重新生成
                  </span>
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  <Clock size={12} className="inline mr-1" />过期时间
                </span>
                <select
                  value={expiresInDays}
                  onChange={e => setExpiresInDays(Number(e.target.value))}
                  className="px-3 py-1.5 rounded-lg text-sm outline-none cursor-pointer"
                  style={inputStyle}
                >
                  <option value={0}>永不过期</option>
                  <option value={1}>1 天</option>
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                </select>
              </label>
            </div>

            <div className="flex justify-end gap-2 mt-2">
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? '生成中...' : '一键分享'}
              </Button>
            </div>
          </div>
        )
      }
    />
  );
}

// ─── Shares Panel ───

function SharesPanel({ shares, setShares, onClose }: {
  shares: ShareLinkItem[];
  setShares: (s: ShareLinkItem[]) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [viewLogsToken, setViewLogsToken] = useState<string | null>(null);
  const [viewLogs, setViewLogs] = useState<ShareViewLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await listSiteShares();
      if (res.success) setShares(res.data.items);
      setLoading(false);
    })();
  }, [setShares]);

  const handleRevoke = async (shareId: string) => {
    if (!confirm('确定撤销此分享链接？')) return;
    const res = await revokeSiteShare(shareId);
    if (res.success) {
      setShares(shares.filter(s => s.id !== shareId));
    }
  };

  const handleCopy = (token: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/s/wp/${token}`);
  };

  const handleShowLogs = async (token: string) => {
    setViewLogsToken(token);
    setLogsLoading(true);
    const res = await listShareViewLogs(token, 200);
    if (res.success) setViewLogs(res.data.items);
    setLogsLoading(false);
  };

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title="分享管理"
      maxWidth={900}
      content={
        <>
          {loading ? (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : shares.length === 0 ? (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              还没有创建过分享链接
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
              {shares.map(share => (
                <div key={share.id}>
                  <div
                    className="flex items-center gap-3 p-3 rounded-lg"
                    style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Link2 size={14} style={{ color: 'var(--text-muted)' }} />
                        <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {share.title || (share.shareType === 'collection' ? `合集 (${share.siteIds.length} 站)` : '单站点分享')}
                        </span>
                        <Badge variant={share.accessLevel === 'password' ? 'warning' : 'success'}>
                          {share.accessLevel === 'password' ? '密码保护' : '公开'}
                        </Badge>
                        {share.shareType === 'collection' && (
                          <Badge variant="subtle">{share.siteIds.length} 站合集</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                        <span className="flex items-center gap-1"><Eye size={10} /> {share.viewCount} 次浏览</span>
                        <span>创建于 {fmtDate(share.createdAt)}</span>
                        {share.expiresAt && <span>过期于 {fmtDate(share.expiresAt)}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="xs"
                        variant={viewLogsToken === share.token ? 'secondary' : 'ghost'}
                        onClick={() => viewLogsToken === share.token ? setViewLogsToken(null) : handleShowLogs(share.token)}
                        title="观看记录"
                      >
                        <Eye size={12} />
                      </Button>
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
                  {/* View logs sub-panel */}
                  {viewLogsToken === share.token && (
                    <div
                      className="ml-6 mt-1 mb-2 p-3 rounded-lg text-xs"
                      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                    >
                      <div className="font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>观看记录</div>
                      {logsLoading ? (
                        <div style={{ color: 'var(--text-muted)' }}>加载中...</div>
                      ) : viewLogs.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)' }}>暂无观看记录</div>
                      ) : (
                        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                          {viewLogs.map(log => (
                            <div key={log.id} className="flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
                              <span style={{ color: log.viewerName ? 'var(--text-primary)' : 'var(--text-muted)', minWidth: 70 }}>
                                {log.viewerName || '匿名访客'}
                              </span>
                              <span>{fmtDate(log.viewedAt)}</span>
                              {log.ipAddress && <span className="opacity-60">{log.ipAddress}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end mt-4 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <Button variant="ghost" onClick={onClose}>关闭</Button>
          </div>
        </>
      }
    />
  );
}
