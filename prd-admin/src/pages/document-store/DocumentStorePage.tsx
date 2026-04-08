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
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
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
} from '@/services';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import type {
  DocumentStore,
  DocumentStoreWithPreview,
  DocumentEntry,
} from '@/services/contracts/documentStore';
import type { DocBrowserEntry, EntryPreview } from '@/components/doc-browser/DocBrowser';
import { toast } from '@/lib/toast';

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

// ── 主页面 ──
export function DocumentStorePage() {
  const [stores, setStores] = useState<DocumentStoreWithPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
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

  useEffect(() => { loadStores(); }, [loadStores]);

  // 持久化选中的 storeId 到 sessionStorage（修复刷新丢失 bug）
  useEffect(() => {
    if (selectedStoreId) {
      sessionStorage.setItem('doc-store-selected-id', selectedStoreId);
    } else {
      sessionStorage.removeItem('doc-store-selected-id');
    }
  }, [selectedStoreId]);

  // 空间详情视图
  if (selectedStoreId) {
    return <StoreDetailView storeId={selectedStoreId} onBack={() => { setSelectedStoreId(null); loadStores(); }} />;
  }

  // 空间列表视图
  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5">
      <TabBar
        title="知识库"
        icon={<Library size={14} />}
        actions={
          <Button variant="primary" size="xs" onClick={() => setShowCreate(true)}>
            <Plus size={13} /> 新建空间
          </Button>
        }
      />

      <div className="px-5 pb-6 w-full">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <MapSpinner size={16} />
            <span className="ml-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</span>
          </div>
        ) : stores.length === 0 ? (
          /* 空状态引导 */
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
        ) : (
          /* 空间列表 - 增大卡片高度，显示文档预览 */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-stretch">
            {stores.map(s => (
              <GlassCard key={s.id} animated interactive padding="none"
                className="group flex flex-col h-full"
                onClick={() => setSelectedStoreId(s.id)}>
                <div className="p-4 pb-2 flex-1 flex flex-col">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0"
                        style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.12)' }}>
                        <Library size={16} style={{ color: 'rgba(59,130,246,0.85)' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {s.name}
                        </h3>
                        {s.description && (
                          <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {s.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

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
                  <button
                    className="surface-row h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    title="删除空间"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const res = await deleteDocumentStore(s.id);
                      if (res.success) setStores(prev => prev.filter(x => x.id !== s.id));
                    }}
                    style={{ color: 'rgba(239,68,68,0.5)' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </GlassCard>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateStoreDialog
          onClose={() => setShowCreate(false)}
          onCreated={(s) => { setShowCreate(false); setSelectedStoreId(s.id); }}
        />
      )}
    </div>
  );
}
