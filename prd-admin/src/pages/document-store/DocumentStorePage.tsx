import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Library,
  Plus,
  Upload,
  FolderOpen,
  ArrowLeft,
  X,
  Rss,
  Github,
  Sparkle,
  Trash2,
  FileText,
  Share2,
  Globe,
  Lock as GlobeLock,
  Copy,
  Link as LinkIcon,
  Calendar,
  Eye,
  Pencil,
  Heart,
  Bookmark,
  Users,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  listDocumentStoresWithPreview,
  createDocumentStore,
  deleteDocumentStore,
  listDocumentEntries,
  uploadDocumentFile,
  getDocumentContent,
  addSubscription,
  addGitHubSubscription,
  setPrimaryEntry,
  createFolder,
  togglePinnedEntry,
  searchDocumentEntries,
  getDocumentStore,
  deleteDocumentEntry,
  moveDocumentEntry,
  updateDocumentContent,
  setFolderPrimaryChild,
  rebuildContentIndex,
  addDocumentEntry,
  updateDocumentStore,
  createDocStoreShareLink,
  listDocStoreShareLinks,
  revokeDocStoreShareLink,
  listMyFavoriteDocumentStores,
  listMyLikedDocumentStores,
} from '@/services';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import type {
  DocumentStore,
  DocumentStoreWithPreview,
  DocumentEntry,
  DocumentStoreShareLink,
  InteractionStoreCard,
} from '@/services/contracts/documentStore';
import type { DocBrowserEntry, EntryPreview } from '@/components/doc-browser/DocBrowser';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { SubscriptionDetailDrawer } from './SubscriptionDetailDrawer';
import { SubtitleGenerationDrawer } from './SubtitleGenerationDrawer';
import { ReprocessDrawer } from './ReprocessDrawer';
import { ViewersDrawer } from './ViewersDrawer';

const ACCEPT_TYPES = '.md,.txt,.pdf,.doc,.docx,.json,.yaml,.yml,.csv';

// ── 创建空间对话框 ──
function CreateStoreDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (store: DocumentStore) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) { setError('空间名称不能为空'); return; }
    setLoading(true);
    setError('');
    const res = await createDocumentStore({ name: name.trim(), description: description.trim() || undefined });
    if (res.success) {
      onCreated(res.data);
    } else {
      setError(res.error?.message ?? '创建失败');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[420px] max-w-[92vw] rounded-[16px] p-6"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 24px 48px -12px rgba(0,0,0,0.5)',
        }}>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.12)' }}>
              <Library size={15} style={{ color: 'rgba(59,130,246,0.85)' }} />
            </div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              新建知识库
            </span>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>空间名称</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如：产品文档库"
            className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none transition-colors duration-200"
            style={{
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
              color: 'var(--text-primary)',
            }}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
          />
        </div>
        <div className="mb-4">
          <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>描述（可选）</label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="这个空间用来存放什么文档"
            className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none transition-colors duration-200"
            style={{
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {error && <p className="text-[12px] mb-3" style={{ color: 'rgba(239,68,68,0.9)' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleCreate} disabled={loading}>
            {loading ? '创建中…' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 编辑知识库对话框（重命名 + 打标签） ──
function EditStoreDialog({ storeId, initialName, initialTags, onClose, onSaved }: {
  storeId: string;
  initialName: string;
  initialTags: string[];
  onClose: () => void;
  onSaved: (patch: { name: string; tags: string[] }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagInput, setTagInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addTag = (raw: string) => {
    const trimmed = raw.trim().replace(/^#/, '');
    if (!trimmed) return;
    if (trimmed.length > 20) { setError('单个标签最多 20 个字'); return; }
    if (tags.includes(trimmed)) { setTagInput(''); return; }
    if (tags.length >= 10) { setError('最多 10 个标签'); return; }
    setError('');
    setTags(prev => [...prev, trimmed]);
    setTagInput('');
  };

  const removeTag = (t: string) => setTags(prev => prev.filter(x => x !== t));

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  const sameAsInitial = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError('空间名称不能为空'); return; }
    // 把未提交的输入也当作一个标签
    const pendingTag = tagInput.trim().replace(/^#/, '');
    const finalTags = pendingTag && !tags.includes(pendingTag) ? [...tags, pendingTag] : tags;

    const nameChanged = trimmedName !== initialName;
    const tagsChanged = !sameAsInitial(finalTags, initialTags);
    if (!nameChanged && !tagsChanged) { onClose(); return; }

    setLoading(true);
    setError('');
    const res = await updateDocumentStore(storeId, {
      ...(nameChanged ? { name: trimmedName } : {}),
      ...(tagsChanged ? { tags: finalTags } : {}),
    });
    if (res.success) {
      onSaved({ name: trimmedName, tags: finalTags });
      toast.success('已更新');
      onClose();
    } else {
      setError(res.error?.message ?? '更新失败');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[440px] max-w-[92vw] rounded-[16px] p-6"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 24px 48px -12px rgba(0,0,0,0.5)',
        }}>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.12)' }}>
              <Pencil size={14} style={{ color: 'rgba(59,130,246,0.85)' }} />
            </div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              编辑知识库
            </span>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>空间名称</label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="如：产品文档库"
            className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none transition-colors duration-200"
            style={{
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
              color: 'var(--text-primary)',
            }}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
          />
        </div>

        <div className="mb-4">
          <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
            标签 <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>（回车或逗号分隔，最多 10 个）</span>
          </label>
          <div
            className="min-h-9 px-2 py-1.5 rounded-[10px] flex flex-wrap items-center gap-1.5"
            style={{
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
            }}>
            {tags.map(t => (
              <span key={t}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-[6px] text-[11px] font-medium"
                style={{
                  background: 'rgba(59,130,246,0.1)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  color: 'rgba(59,130,246,0.9)',
                }}>
                # {t}
                <button
                  onClick={() => removeTag(t)}
                  className="ml-0.5 cursor-pointer flex items-center justify-center"
                  style={{ color: 'rgba(59,130,246,0.7)' }}
                  title="移除">
                  <X size={10} />
                </button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder={tags.length === 0 ? '如：产品、需求' : ''}
              className="flex-1 min-w-[80px] h-6 bg-transparent outline-none text-[12px]"
              style={{ color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        {error && <p className="text-[12px] mb-3" style={{ color: 'rgba(239,68,68,0.9)' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleSave} disabled={loading}>
            {loading ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 分享对话框（创建短链 + 列表 + 撤销） ──
function ShareDialog({ storeId, storeName, isPublic, onClose }: {
  storeId: string;
  storeName: string;
  isPublic: boolean;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<DocumentStoreShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(0);

  const loadLinks = useCallback(async () => {
    setLoading(true);
    const res = await listDocStoreShareLinks(storeId);
    if (res.success) setLinks(res.data.items);
    setLoading(false);
  }, [storeId]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const handleCreate = async () => {
    setCreating(true);
    const res = await createDocStoreShareLink(storeId, { title: title.trim() || undefined, expiresInDays });
    if (res.success) {
      setLinks(prev => [res.data, ...prev]);
      setTitle('');
      toast.success('分享链接已创建', '快去复制吧');
    } else {
      toast.error('创建失败', res.error?.message);
    }
    setCreating(false);
  };

  const handleRevoke = async (linkId: string) => {
    if (!confirm('确认撤销此分享链接？已访问的用户无法再次打开。')) return;
    const res = await revokeDocStoreShareLink(linkId);
    if (res.success) {
      setLinks(prev => prev.map(l => l.id === linkId ? { ...l, isRevoked: true } : l));
      toast.success('已撤销');
    }
  };

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/library/share/${token}`;
    navigator.clipboard.writeText(url).then(() => toast.success('链接已复制'));
  };

  const directLink = `${window.location.origin}/library/${storeId}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[640px] max-w-[92vw] max-h-[85vh] flex flex-col rounded-[16px] p-6"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 24px 48px -12px rgba(0,0,0,0.5)',
        }}>
        <div className="flex items-center justify-between mb-5 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)' }}>
              <Share2 size={15} style={{ color: 'rgba(168,85,247,0.9)' }} />
            </div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              分享「{storeName}」
            </span>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* 公开访问直链 */}
        {isPublic && (
          <div className="mb-5 p-4 rounded-[12px]"
            style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)' }}>
            <div className="flex items-center gap-2 mb-2">
              <Globe size={12} style={{ color: 'rgba(168,85,247,0.9)' }} />
              <span className="text-[12px] font-semibold" style={{ color: 'rgba(216,180,254,0.95)' }}>
                公开访问链接
              </span>
            </div>
            <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
              已发布到智识殿堂，任何人都可以通过此链接访问
            </p>
            <div className="flex items-center gap-2">
              <input value={directLink} readOnly
                className="flex-1 h-8 px-3 rounded-[8px] text-[11px] outline-none font-mono"
                style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)' }} />
              <button
                onClick={() => navigator.clipboard.writeText(directLink).then(() => toast.success('已复制'))}
                className="h-8 px-3 rounded-[8px] text-[11px] font-semibold cursor-pointer flex items-center gap-1"
                style={{ background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)', color: 'rgba(216,180,254,0.95)' }}>
                <Copy size={11} /> 复制
              </button>
            </div>
          </div>
        )}

        {/* 创建分享链接 */}
        <div className="mb-5">
          <div className="text-[12px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
            创建分享短链
          </div>
          <div className="space-y-2">
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="自定义标题（可选）"
              className="w-full h-9 px-3 rounded-[10px] text-[12px] outline-none"
              style={{
                background: 'var(--input-bg, rgba(255,255,255,0.05))',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--text-primary)',
              }} />
            <div className="flex gap-2">
              <select value={expiresInDays} onChange={e => setExpiresInDays(Number(e.target.value))}
                className="flex-1 h-9 px-3 rounded-[10px] text-[12px] outline-none cursor-pointer"
                style={{
                  background: 'var(--input-bg, rgba(255,255,255,0.05))',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-primary)',
                }}>
                <option value={0}>永不过期</option>
                <option value={1}>1 天后过期</option>
                <option value={7}>7 天后过期</option>
                <option value={30}>30 天后过期</option>
                <option value={90}>90 天后过期</option>
              </select>
              <Button variant="primary" size="xs" onClick={handleCreate} disabled={creating}>
                {creating ? <MapSpinner size={12} /> : <LinkIcon size={12} />}
                {creating ? '创建中…' : '生成链接'}
              </Button>
            </div>
          </div>
        </div>

        {/* 分享链接列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="text-[12px] font-semibold mb-3 sticky top-0 py-1" style={{ color: 'var(--text-primary)' }}>
            已有分享链接 ({links.filter(l => !l.isRevoked).length})
          </div>
          {loading ? (
            <div className="flex justify-center py-6"><MapSpinner size={14} /></div>
          ) : links.length === 0 ? (
            <p className="text-[11px] text-center py-6" style={{ color: 'var(--text-muted)' }}>
              暂无分享链接，创建一个开始分享吧
            </p>
          ) : (
            <div className="space-y-2">
              {links.map(link => (
                <div key={link.id} className="p-3 rounded-[10px]"
                  style={{
                    background: link.isRevoked ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    opacity: link.isRevoked ? 0.5 : 1,
                  }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {link.title || '未命名分享'}
                      </div>
                      <div className="text-[10px] mt-0.5 font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                        /library/share/{link.token}
                      </div>
                    </div>
                    {!link.isRevoked && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => copyLink(link.token)}
                          className="w-7 h-7 rounded-[6px] flex items-center justify-center cursor-pointer hover:bg-white/6"
                          style={{ color: 'var(--text-muted)' }}
                          title="复制链接">
                          <Copy size={12} />
                        </button>
                        <button
                          onClick={() => handleRevoke(link.id)}
                          className="w-7 h-7 rounded-[6px] flex items-center justify-center cursor-pointer hover:bg-white/6"
                          style={{ color: 'rgba(239,68,68,0.7)' }}
                          title="撤销">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    <span className="flex items-center gap-1">
                      <Eye size={9} /> {link.viewCount}
                    </span>
                    {link.expiresAt && (
                      <span className="flex items-center gap-1">
                        <Calendar size={9} />
                        {new Date(link.expiresAt).toLocaleDateString()} 过期
                      </span>
                    )}
                    {link.isRevoked && (
                      <span style={{ color: 'rgba(239,68,68,0.8)' }}>已撤销</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 空间详情视图（文档列表 + 上传）──
function StoreDetailView({ storeId, onBack }: {
  storeId: string;
  onBack: () => void;
}) {
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>(undefined);
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 当前打开的订阅详情 entryId（null = 未打开） */
  const [subscriptionDetailId, setSubscriptionDetailId] = useState<string | null>(null);
  /** 当前打开的字幕生成 Drawer 目标 entry（null = 未打开） */
  const [subtitleTarget, setSubtitleTarget] = useState<{ id: string; title: string } | null>(null);
  /** 当前打开的再加工 Drawer 目标 entry（null = 未打开） */
  const [reprocessTarget, setReprocessTarget] = useState<{ id: string; title: string } | null>(null);

  // 文件上传状态
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 加载空间详情和条目
  const loadStore = useCallback(async () => {
    const res = await getDocumentStore(storeId);
    if (res.success) setStore(res.data);
  }, [storeId]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const res = await listDocumentEntries(storeId, 1, 200);
    if (res.success) setEntries(res.data.items);
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    loadStore();
    loadEntries();
  }, [loadStore, loadEntries]);

  // 文件上传处理
  const handleFiles = useCallback(async (files: File[]) => {
    setUploading(true);
    let successCount = 0;
    for (const file of files) {
      const res = await uploadDocumentFile(storeId, file);
      if (res.success) {
        setEntries(prev => [res.data.entry, ...prev]);
        successCount++;
      } else {
        toast.error(`上传失败: ${file.name}`, res.error?.message);
      }
    }
    if (successCount > 0) {
      toast.success(`上传完成`, `${successCount} 个文件已存储`);
    }
    setUploading(false);
  }, [storeId]);

  // 仅响应外部文件拖入（排除内部条目拖拽，避免误触发上传遮罩）
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(files);
  }, [handleFiles]);

  // 设置主文档：根级条目设为 store 主文档，文件夹内条目设为该文件夹主文档
  const handleSetPrimary = useCallback(async (entryId: string) => {
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    if (entry.parentId) {
      // 文件夹内条目：设为文件夹的主子项
      const res = await setFolderPrimaryChild(entry.parentId, entryId);
      if (res.success) {
        // 更新本地 entries 中父文件夹的 metadata
        setEntries(prev => prev.map(e =>
          e.id === entry.parentId
            ? { ...e, metadata: { ...(e.metadata ?? {}), primaryChildId: entryId } }
            : e));
        toast.success('已设为此文件夹的主文档');
      } else {
        toast.error('设置失败', res.error?.message);
      }
    } else {
      // 根级条目：设为 store 主文档
      const res = await setPrimaryEntry(storeId, entryId);
      if (res.success) {
        setStore(prev => prev ? { ...prev, primaryEntryId: entryId } : prev);
        toast.success('已设为主文档');
      }
    }
  }, [storeId, entries]);

  const handleTogglePin = useCallback(async (entryId: string, pin: boolean) => {
    const res = await togglePinnedEntry(storeId, entryId, pin);
    if (res.success) {
      setStore(prev => prev ? { ...prev, pinnedEntryIds: res.data.pinnedEntryIds } : prev);
      toast.success(pin ? '已置顶' : '已取消置顶');
    }
  }, [storeId]);

  const handleDeleteEntry = useCallback(async (entryId: string) => {
    const res = await deleteDocumentEntry(entryId);
    if (res.success) {
      setEntries(prev => prev.filter(e => e.id !== entryId));
      if (selectedEntryId === entryId) setSelectedEntryId(undefined);
      toast.success('已删除');
    } else {
      toast.error('删除失败', res.error?.message);
    }
  }, [selectedEntryId]);

  const handleMoveEntry = useCallback(async (entryId: string, targetFolderId: string | null) => {
    const res = await moveDocumentEntry(entryId, targetFolderId);
    if (res.success) {
      setEntries(prev => prev.map(e =>
        e.id === entryId ? { ...e, parentId: targetFolderId ?? undefined } : e));
      toast.success('已移动');
    } else {
      toast.error('移动失败', res.error?.message);
    }
  }, []);

  const handleSaveContent = useCallback(async (entryId: string, newContent: string) => {
    const res = await updateDocumentContent(entryId, newContent);
    if (res.success) {
      // 更新本地 entries 中的 summary（前 200 字）
      const summary = newContent.length > 200 ? newContent.slice(0, 200) : newContent;
      setEntries(prev => prev.map(e =>
        e.id === entryId ? { ...e, summary: summary.trim() } : e));
      toast.success('已保存');
    } else {
      toast.error('保存失败', res.error?.message);
      throw new Error(res.error?.message ?? '保存失败');
    }
  }, []);

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
    const res = await getDocumentContent(entryId);
    if (!res.success) return null;
    return {
      text: res.data.hasContent ? res.data.content : null,
      fileUrl: res.data.fileUrl,
      contentType: res.data.contentType,
    };
  }, []);

  const handleCreateFolder = useCallback(async (name: string) => {
    const res = await createFolder(storeId, name);
    if (res.success) {
      setEntries(prev => [res.data, ...prev]);
      toast.success('文件夹已创建');
    } else {
      toast.error('创建失败', res.error?.message);
    }
  }, [storeId]);

  const handleCreateDocument = useCallback(async () => {
    // 直接创建一个空白文档，后续支持在 Edit 模式中填充
    const res = await addDocumentEntry(storeId, {
      title: '新建文档',
      sourceType: 'upload',
      contentType: 'text/markdown',
      summary: '',
    });
    if (res.success) {
      setEntries(prev => [res.data, ...prev]);
      setSelectedEntryId(res.data.id);
      toast.success('已创建文档，点击编辑按钮开始写作');
    } else {
      toast.error('创建失败', res.error?.message);
    }
  }, [storeId]);

  const handleSearch = useCallback(async (keyword: string, contentSearch: boolean): Promise<DocBrowserEntry[] | null> => {
    // 启用内容搜索时，先触发一次 ContentIndex 回填（后端对已有 ContentIndex 的条目会跳过）
    if (contentSearch) {
      await rebuildContentIndex(storeId);
    }
    const res = await searchDocumentEntries(storeId, keyword, contentSearch);
    if (res.success) return res.data.items;
    return null;
  }, [storeId]);

  // 切换发布到智识殿堂
  const handleTogglePublish = useCallback(async () => {
    if (!store) return;
    setPublishing(true);
    const newVal = !store.isPublic;
    const res = await updateDocumentStore(storeId, { isPublic: newVal });
    if (res.success) {
      setStore(prev => prev ? { ...prev, isPublic: newVal } : prev);
      toast.success(
        newVal ? '已发布到智识殿堂' : '已取消发布',
        newVal ? '其他用户现在可以浏览你的知识库了' : '知识库已设为私有',
      );
    } else {
      toast.error('操作失败', res.error?.message);
    }
    setPublishing(false);
  }, [store, storeId]);

  if (!store) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ minHeight: 'calc(100vh - 160px)' }}>
        <MapSpinner size={16} />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden"
      onDragEnter={handleDragEnter} onDragLeave={handleDragLeave}
      onDragOver={handleDragOver} onDrop={handleDrop}>
      <input ref={fileInputRef} type="file" className="hidden" accept={ACCEPT_TYPES} multiple
        onChange={e => { const f = Array.from(e.target.files ?? []); if (f.length) handleFiles(f); e.target.value = ''; }} />

      <TabBar
        title={
          <div className="flex items-center gap-2">
            <button onClick={onBack}
              className="text-[12px] cursor-pointer hover:bg-white/6 px-2 py-1 rounded-[8px] transition-colors duration-200"
              style={{ color: 'var(--text-muted)' }}>
              <ArrowLeft size={14} />
            </button>
            <Library size={14} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{store.name}</span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{entries.filter(e => e.sourceType !== 'github_directory').length} 个文档</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* 发布到智识殿堂开关 */}
            <button
              onClick={handleTogglePublish}
              disabled={publishing}
              className="h-7 px-3 rounded-[8px] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer transition-all"
              style={{
                background: store.isPublic ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)',
                border: store.isPublic ? '1px solid rgba(168,85,247,0.35)' : '1px solid rgba(255,255,255,0.08)',
                color: store.isPublic ? 'rgba(216,180,254,0.95)' : 'var(--text-muted)',
              }}
              title={store.isPublic ? '已发布到智识殿堂，点击取消发布' : '发布到智识殿堂，让更多人看到'}
            >
              {publishing ? <MapSpinner size={11} /> : (store.isPublic ? <Globe size={11} /> : <GlobeLock size={11} />)}
              {store.isPublic ? '已发布' : '发布到智识殿堂'}
            </button>
            <Button variant="secondary" size="xs" onClick={() => setShowViewers(true)}>
              <Users size={13} /> 访客
            </Button>
            <Button variant="secondary" size="xs" onClick={() => setShowShareDialog(true)}>
              <Share2 size={13} /> 分享
            </Button>
            <Button variant="secondary" size="xs" onClick={() => setShowSubscribe(true)}>
              <Rss size={13} /> 添加订阅
            </Button>
            <Button variant="primary" size="xs" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? <MapSpinner size={14} /> : <Upload size={13} />}
              {uploading ? '上传中…' : '上传文档'}
            </Button>
          </div>
        }
      />

      {/* 全局拖拽遮罩 */}
      {dragging && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
          style={{ background: 'rgba(59,130,246,0.05)', border: '3px dashed rgba(59,130,246,0.3)' }}>
          <div className="text-center">
            <Upload size={32} style={{ color: 'rgba(59,130,246,0.6)', margin: '0 auto 8px' }} />
            <p className="text-[14px] font-semibold" style={{ color: 'rgba(59,130,246,0.8)' }}>释放文件到此处上传</p>
          </div>
        </div>
      )}

      {/* 左右分栏文档浏览器 */}
      <div className="flex-1 min-h-0 flex flex-col px-5 pb-4 pt-3">
        <DocBrowser
          entries={entries}
          primaryEntryId={store.primaryEntryId}
          pinnedEntryIds={store.pinnedEntryIds ?? []}
          selectedEntryId={selectedEntryId}
          onSelectEntry={setSelectedEntryId}
          onSetPrimary={handleSetPrimary}
          onTogglePin={handleTogglePin}
          onDeleteEntry={handleDeleteEntry}
          onMoveEntry={handleMoveEntry}
          onSaveContent={handleSaveContent}
          loadContent={loadContent}
          onCreateFolder={handleCreateFolder}
          onCreateDocument={handleCreateDocument}
          onUploadFile={() => fileInputRef.current?.click()}
          onSearch={handleSearch}
          onOpenSubscription={(id) => setSubscriptionDetailId(id)}
          onGenerateSubtitle={(id) => {
            const entry = entries.find(e => e.id === id);
            if (entry) setSubtitleTarget({ id, title: entry.title });
          }}
          onReprocess={(id) => {
            const entry = entries.find(e => e.id === id);
            if (entry) setReprocessTarget({ id, title: entry.title });
          }}
          loading={loading}
          emptyState={
            <div className="flex-1 flex flex-col items-center justify-center py-16">
              <FolderOpen size={44} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 20 }} />
              <p className="text-[14px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>还没有文档</p>
              <p className="text-[12px] mb-6" style={{ color: 'var(--text-muted)' }}>上传文档到这个空间，或直接拖拽文件到页面</p>
              <Button variant="primary" size="md" onClick={() => fileInputRef.current?.click()}>
                <Upload size={15} /> 上传第一个文档
              </Button>
            </div>
          }
        />
      </div>

      {/* 添加订阅对话框 */}
      {showSubscribe && (
        <SubscribeDialog
          storeId={storeId}
          onClose={() => setShowSubscribe(false)}
          onCreated={(entry) => { setShowSubscribe(false); setEntries(prev => [entry, ...prev]); }}
        />
      )}

      {/* 分享对话框 */}
      {showShareDialog && (
        <ShareDialog
          storeId={storeId}
          storeName={store.name}
          isPublic={store.isPublic}
          onClose={() => setShowShareDialog(false)}
        />
      )}

      {/* 订阅详情抽屉 */}
      {subscriptionDetailId && (
        <SubscriptionDetailDrawer
          entryId={subscriptionDetailId}
          onClose={() => setSubscriptionDetailId(null)}
          onChanged={() => loadEntries()}
        />
      )}

      {/* 字幕生成抽屉 */}
      {subtitleTarget && (
        <SubtitleGenerationDrawer
          entryId={subtitleTarget.id}
          entryTitle={subtitleTarget.title}
          onClose={() => setSubtitleTarget(null)}
          onDone={(newId) => {
            loadEntries();
            setSelectedEntryId(newId);
          }}
        />
      )}

      {/* 文档再加工抽屉 */}
      {reprocessTarget && (
        <ReprocessDrawer
          entryId={reprocessTarget.id}
          entryTitle={reprocessTarget.title}
          onClose={() => setReprocessTarget(null)}
          onDone={(newId) => {
            loadEntries();
            setSelectedEntryId(newId);
          }}
        />
      )}

      {/* 访客记录抽屉（批次 C） */}
      {showViewers && (
        <ViewersDrawer
          storeId={storeId}
          storeName={store.name}
          onClose={() => setShowViewers(false)}
        />
      )}
    </div>
  );
}

// ── 订阅源对话框（支持 URL 订阅 + GitHub 目录同步）──
function SubscribeDialog({ storeId, onClose, onCreated }: {
  storeId: string;
  onClose: () => void;
  onCreated: (entry: DocumentEntry) => void;
}) {
  const [mode, setMode] = useState<'url' | 'github'>('url');
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [interval, setInterval] = useState(60);
  const [githubInterval, setGithubInterval] = useState(1440);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    setLoading(true);
    setError('');

    if (mode === 'github') {
      if (!githubUrl.trim()) { setError('GitHub 地址不能为空'); setLoading(false); return; }
      const res = await addGitHubSubscription(storeId, {
        githubUrl: githubUrl.trim(),
        title: title.trim() || undefined,
        syncIntervalMinutes: githubInterval,
      });
      if (res.success) {
        toast.success('GitHub 目录订阅已添加', '后台将立即开始首次同步');
        onCreated(res.data);
      } else {
        setError(res.error?.message ?? '创建失败');
      }
    } else {
      if (!title.trim()) { setError('标题不能为空'); setLoading(false); return; }
      if (!sourceUrl.trim()) { setError('源地址不能为空'); setLoading(false); return; }
      const res = await addSubscription(storeId, {
        title: title.trim(),
        sourceUrl: sourceUrl.trim(),
        syncIntervalMinutes: interval,
      });
      if (res.success) {
        toast.success('订阅添加成功', '后台将按设定间隔自动拉取内容');
        onCreated(res.data);
      } else {
        setError(res.error?.message ?? '创建失败');
      }
    }
    setLoading(false);
  };

  const accentColor = mode === 'github' ? '130,80,223' : '234,179,8';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[560px] max-w-[92vw] rounded-[16px] p-6"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 24px 48px -12px rgba(0,0,0,0.5)',
        }}>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: `rgba(${accentColor},0.08)`, border: `1px solid rgba(${accentColor},0.12)` }}>
              {mode === 'github' ? <Github size={15} style={{ color: `rgba(${accentColor},0.85)` }} /> : <Rss size={15} style={{ color: `rgba(${accentColor},0.85)` }} />}
            </div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>添加订阅源</span>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* 模式切换 */}
        <div className="flex gap-2 mb-4">
          {([['url', 'URL 订阅', Rss], ['github', 'GitHub 目录', Github]] as const).map(([m, label, Icon]) => (
            <button key={m} onClick={() => { setMode(m); setError(''); }}
              className="flex-1 py-2 rounded-[10px] text-[12px] font-semibold cursor-pointer flex items-center justify-center gap-1.5 transition-all duration-200"
              style={{
                background: mode === m ? `rgba(${m === 'github' ? '130,80,223' : '234,179,8'},0.1)` : 'rgba(255,255,255,0.02)',
                border: mode === m ? `1px solid rgba(${m === 'github' ? '130,80,223' : '234,179,8'},0.2)` : '1px solid rgba(255,255,255,0.06)',
                color: mode === m ? `rgba(${m === 'github' ? '130,80,223' : '234,179,8'},0.9)` : 'var(--text-muted)',
              }}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>

        <div className="space-y-4 mb-4">
          {mode === 'github' ? (
            <>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>GitHub 目录地址</label>
                <input value={githubUrl} onChange={e => setGithubUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/tree/main/doc"
                  className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none"
                  style={{ background: 'var(--input-bg, rgba(255,255,255,0.05))', border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', color: 'var(--text-primary)' }} />
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  自动同步目录下所有 .md 文件，支持增量更新（SHA 去重）
                </p>
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>标题（可选，默认用仓库名）</label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="如：项目文档"
                  className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none"
                  style={{ background: 'var(--input-bg, rgba(255,255,255,0.05))', border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>同步间隔</label>
                <div className="flex gap-2">
                  {[60, 360, 720, 1440].map(m => (
                    <button key={m} onClick={() => setGithubInterval(m)}
                      className="flex-1 py-1.5 rounded-[8px] text-[11px] font-semibold cursor-pointer transition-all duration-200"
                      style={{
                        background: githubInterval === m ? 'rgba(130,80,223,0.1)' : 'rgba(255,255,255,0.02)',
                        border: githubInterval === m ? '1px solid rgba(130,80,223,0.2)' : '1px solid rgba(255,255,255,0.06)',
                        color: githubInterval === m ? 'rgba(130,80,223,0.9)' : 'var(--text-muted)',
                      }}>
                      {m < 1440 ? `${m / 60}小时` : '每天'}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>标题</label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="如：React 官方博客"
                  className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none"
                  style={{ background: 'var(--input-bg, rgba(255,255,255,0.05))', border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>源地址（RSS / 网页 URL）</label>
                <input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://example.com/feed.xml"
                  className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none"
                  style={{ background: 'var(--input-bg, rgba(255,255,255,0.05))', border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>同步间隔</label>
                <div className="flex gap-2">
                  {[15, 60, 360, 1440].map(m => (
                    <button key={m} onClick={() => setInterval(m)}
                      className="flex-1 py-1.5 rounded-[8px] text-[11px] font-semibold cursor-pointer transition-all duration-200"
                      style={{
                        background: interval === m ? 'rgba(234,179,8,0.1)' : 'rgba(255,255,255,0.02)',
                        border: interval === m ? '1px solid rgba(234,179,8,0.2)' : '1px solid rgba(255,255,255,0.06)',
                        color: interval === m ? 'rgba(234,179,8,0.9)' : 'var(--text-muted)',
                      }}>
                      {m < 60 ? `${m}分钟` : m < 1440 ? `${m / 60}小时` : '每天'}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {error && <p className="text-[12px] mb-3" style={{ color: 'rgba(239,68,68,0.9)' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleCreate} disabled={loading}>
            {loading ? '添加中…' : mode === 'github' ? '添加 GitHub 同步' : '添加订阅'}
          </Button>
        </div>
      </div>
    </div>
  );
}

type StoreTab = 'mine' | 'favorites' | 'likes';

// ── 主页面 ──
export function DocumentStorePage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<StoreTab>(() => {
    const saved = sessionStorage.getItem('doc-store-tab') as StoreTab | null;
    return saved === 'favorites' || saved === 'likes' ? saved : 'mine';
  });
  const [stores, setStores] = useState<DocumentStoreWithPreview[]>([]);
  const [favorites, setFavorites] = useState<InteractionStoreCard[]>([]);
  const [likes, setLikes] = useState<InteractionStoreCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: string; name: string; tags: string[] } | null>(null);
  // 使用 storeId 而不是 store 对象，这样刷新后可以从 URL 或 sessionStorage 恢复
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(() => {
    return sessionStorage.getItem('doc-store-selected-id');
  });

  const loadStores = useCallback(async () => {
    setLoading(true);
    const res = await listDocumentStoresWithPreview(1, 50);
    if (res.success) setStores(res.data.items);
    setLoading(false);
  }, []);

  const loadFavorites = useCallback(async () => {
    setLoading(true);
    const res = await listMyFavoriteDocumentStores();
    if (res.success) setFavorites(res.data.items);
    setLoading(false);
  }, []);

  const loadLikes = useCallback(async () => {
    setLoading(true);
    const res = await listMyLikedDocumentStores();
    if (res.success) setLikes(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (tab === 'mine') loadStores();
    else if (tab === 'favorites') loadFavorites();
    else loadLikes();
  }, [tab, loadStores, loadFavorites, loadLikes]);

  // 持久化选中的 storeId / tab 到 sessionStorage
  useEffect(() => {
    if (selectedStoreId) {
      sessionStorage.setItem('doc-store-selected-id', selectedStoreId);
    } else {
      sessionStorage.removeItem('doc-store-selected-id');
    }
  }, [selectedStoreId]);

  useEffect(() => {
    sessionStorage.setItem('doc-store-tab', tab);
  }, [tab]);

  // 空间详情视图（仅 mine 标签下可进入编辑视图）
  if (selectedStoreId) {
    return <StoreDetailView storeId={selectedStoreId} onBack={() => { setSelectedStoreId(null); loadStores(); }} />;
  }

  const tabs: { key: StoreTab; label: string; icon: typeof Library }[] = [
    { key: 'mine', label: '我的空间', icon: Library },
    { key: 'favorites', label: '我的收藏', icon: Bookmark },
    { key: 'likes', label: '我的点赞', icon: Heart },
  ];

  const currentList: InteractionStoreCard[] | DocumentStoreWithPreview[] =
    tab === 'mine' ? stores : tab === 'favorites' ? favorites : likes;

  const isEmpty = currentList.length === 0;

  // 空间列表视图
  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5">
      <TabBar
        title="知识库"
        icon={<Library size={14} />}
        actions={
          tab === 'mine' ? (
            <Button variant="primary" size="xs" onClick={() => setShowCreate(true)}>
              <Plus size={13} /> 新建空间
            </Button>
          ) : null
        }
      />

      {/* 标签切换 */}
      <div className="px-5 flex items-center gap-2">
        {tabs.map(t => {
          const active = tab === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="h-8 px-3 rounded-[10px] text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer transition-all duration-200"
              style={{
                background: active ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.03)',
                border: active ? '1px solid rgba(59,130,246,0.2)' : '1px solid rgba(255,255,255,0.06)',
                color: active ? 'rgba(59,130,246,0.9)' : 'var(--text-muted)',
              }}>
              <Icon size={12} /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="px-5 pb-6 w-full">
        {loading ? (
          <MapSectionLoader text="加载中..." />
        ) : isEmpty && tab === 'mine' ? (
          /* 我的空间 空状态引导 */
          <div className="flex flex-col items-center justify-center py-16">
            <Library size={48} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 20 }} />
            <p className="text-[16px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              知识库
            </p>
            <p className="text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>
              集中存储文档，作为 AI 涌现探索的种子来源
            </p>
            <p className="text-[11px] mb-6 max-w-[400px] text-center leading-[1.6]" style={{ color: 'var(--text-muted)' }}>
              上传任何文档（产品文档、需求方案、竞品分析…），然后一键启动涌现探索
            </p>

            {/* 三步引导 */}
            <div className="grid grid-cols-3 gap-4 mb-8 max-w-[560px] w-full">
              {[
                { icon: Library, title: '创建空间', desc: '按项目或主题组织文档' },
                { icon: Upload, title: '上传文档', desc: '拖拽文件即可上传' },
                { icon: Sparkle, title: '涌现探索', desc: '从文档出发，发现新可能' },
              ].map(s => (
                <div key={s.title} className="surface-inset rounded-[12px] p-4 flex flex-col items-center text-center">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center mb-2.5"
                    style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.12)' }}>
                    <s.icon size={14} style={{ color: 'rgba(59,130,246,0.85)' }} />
                  </div>
                  <p className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{s.title}</p>
                  <p className="text-[11px] leading-[1.5]" style={{ color: 'var(--text-muted)' }}>{s.desc}</p>
                </div>
              ))}
            </div>

            <Button variant="primary" size="md" onClick={() => setShowCreate(true)}>
              <Plus size={15} /> 创建第一个空间
            </Button>
          </div>
        ) : isEmpty ? (
          /* 收藏 / 点赞 空状态 */
          <div className="flex flex-col items-center justify-center py-16">
            {tab === 'favorites'
              ? <Bookmark size={40} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 16 }} />
              : <Heart size={40} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 16 }} />}
            <p className="text-[13px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {tab === 'favorites' ? '还没有收藏' : '还没有点赞'}
            </p>
            <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
              去智识殿堂发现感兴趣的知识库吧
            </p>
            <Button variant="ghost" size="xs" onClick={() => navigate('/library')}>
              <Globe size={12} /> 浏览智识殿堂
            </Button>
          </div>
        ) : (
          /* 空间列表 - 增大卡片高度，显示文档预览 */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-stretch">
            {(currentList as (DocumentStoreWithPreview | InteractionStoreCard)[]).map(s => {
              const isInteraction = tab !== 'mine';
              const ownerName = isInteraction ? (s as InteractionStoreCard).ownerName : undefined;
              const isOwnInteraction = isInteraction && (s as InteractionStoreCard).isOwner;
              return (
                <GlassCard key={s.id} animated interactive padding="none"
                  className="group flex flex-col h-full"
                  onClick={() => {
                    if (tab === 'mine' || isOwnInteraction) {
                      setSelectedStoreId(s.id);
                    } else {
                      navigate(`/library/${s.id}`);
                    }
                  }}>
                  <div className="p-4 pb-2 flex-1 flex flex-col">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <div className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0"
                          style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.12)' }}>
                          <Library size={16} style={{ color: 'rgba(59,130,246,0.85)' }} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                            {s.name}
                          </h3>
                          {s.description ? (
                            <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {s.description}
                            </p>
                          ) : ownerName ? (
                            <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              @{ownerName}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      {tab === 'mine' && (
                        <button
                          className="surface-row h-6 w-6 rounded-[6px] flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                          title="编辑名称与标签"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditTarget({ id: s.id, name: s.name, tags: s.tags ?? [] });
                          }}
                          style={{ color: 'rgba(59,130,246,0.7)' }}>
                          <Pencil size={11} />
                        </button>
                      )}
                    </div>

                    {/* 标签展示 */}
                    {(s.tags?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {s.tags.slice(0, 4).map(t => (
                          <span key={t}
                            className="inline-flex items-center h-5 px-1.5 rounded-[5px] text-[10px] font-medium"
                            style={{
                              background: 'rgba(59,130,246,0.08)',
                              border: '1px solid rgba(59,130,246,0.15)',
                              color: 'rgba(59,130,246,0.85)',
                            }}>
                            # {t}
                          </span>
                        ))}
                        {s.tags.length > 4 && (
                          <span className="text-[10px] self-center" style={{ color: 'var(--text-muted)' }}>
                            +{s.tags.length - 4}
                          </span>
                        )}
                      </div>
                    )}

                    {/* 最近文档预览列表 */}
                    <div className="flex-1 mt-1.5 space-y-0.5 min-h-[60px]">
                      {(s.recentEntries?.length ?? 0) > 0 ? (
                        s.recentEntries.map((entry) => (
                          <div key={entry.id} className="flex items-center gap-1.5 py-1 px-1 rounded-[6px] transition-colors hover:bg-white/3">
                            <FileText size={11} className="flex-shrink-0" style={{ color: 'rgba(59,130,246,0.5)' }} />
                            <span className="flex-1 text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
                              {entry.title}
                            </span>
                            <span className="text-[9px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                              {new Date(entry.updatedAt).toLocaleDateString()}
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="flex items-center justify-center h-full">
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>知识库暂无内容</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between mt-2 pt-2.5"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <span><span style={{ color: 'var(--text-secondary)' }}>{s.documentCount}</span> 个文档</span>
                      </div>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {new Date(s.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 px-4 py-2.5 mt-auto"
                    style={{ background: 'rgba(255,255,255,0.03)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <button className="surface-row flex-1 h-7 rounded-[8px] text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
                      style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)', color: 'rgba(59,130,246,0.85)' }}>
                      <FolderOpen size={11} /> 打开
                    </button>
                    {tab === 'mine' && (
                      <button
                        className="surface-row h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                        title="删除空间"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const entryCount = s.documentCount ?? 0;
                          const confirmed = await systemDialog.confirm({
                            title: '确认删除知识库',
                            message: `删除「${s.name}」将永久清除：\n  · ${entryCount} 个文档条目\n  · 所有订阅同步日志\n  · 所有附件文件与解析正文\n  · 所有点赞 / 收藏 / 分享链接\n\n此操作不可恢复。`,
                            tone: 'danger',
                            confirmText: '永久删除',
                            cancelText: '取消',
                          });
                          if (!confirmed) return;
                          const res = await deleteDocumentStore(s.id);
                          if (res.success) {
                            setStores(prev => prev.filter(x => x.id !== s.id));
                            toast.success('知识库已删除', '关联数据已全部清理');
                          } else {
                            toast.error('删除失败', res.error?.message);
                          }
                        }}
                        style={{ color: 'rgba(239,68,68,0.5)' }}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </GlassCard>
              );
            })}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateStoreDialog
          onClose={() => setShowCreate(false)}
          onCreated={(s) => { setShowCreate(false); setSelectedStoreId(s.id); }}
        />
      )}

      {editTarget && (
        <EditStoreDialog
          storeId={editTarget.id}
          initialName={editTarget.name}
          initialTags={editTarget.tags}
          onClose={() => setEditTarget(null)}
          onSaved={(patch) => {
            setStores(prev => prev.map(x => x.id === editTarget.id ? { ...x, name: patch.name, tags: patch.tags } : x));
          }}
        />
      )}
    </div>
  );
}
