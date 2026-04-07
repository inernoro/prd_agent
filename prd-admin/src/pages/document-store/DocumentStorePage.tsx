import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Library,
  Plus,
  FileText,
  Upload,
  Search,
  Trash2,
  Sparkle,
  Loader2,
  FolderOpen,
  ArrowLeft,
  X,
  File,
  RefreshCw,
  Rss,
  Globe,
  Github,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  listDocumentStores,
  createDocumentStore,
  deleteDocumentStore,
  listDocumentEntries,
  deleteDocumentEntry,
  uploadDocumentFile,
  getDocumentContent,
  addSubscription,
  addGitHubSubscription,
  setPrimaryEntry,
  triggerSync,
} from '@/services';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import type {
  DocumentStore,
  DocumentEntry,
} from '@/services/contracts/documentStore';
import { useNavigate } from 'react-router-dom';
import { toast } from '@/lib/toast';

const ACCEPT_TYPES = '.md,.txt,.pdf,.doc,.docx,.json,.yaml,.yml,.csv';

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

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
              新建文档空间
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

// ── 文档条目详情面板（含内容预览 + 同步控制）──
function EntryDetailPanel({ entry, onClose, onDelete, onUpdate }: {
  entry: DocumentEntry;
  onClose: () => void;
  onDelete: (entryId: string) => void;
  onUpdate?: (entry: DocumentEntry) => void;
}) {
  const navigate = useNavigate();
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const loadContent = useCallback(async () => {
    setContentLoading(true);
    const res = await getDocumentContent(entry.id);
    if (res.success && res.data.hasContent) {
      setContent(res.data.content);
    } else {
      setContent(null);
    }
    setContentLoading(false);
    setShowContent(true);
  }, [entry.id]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    const res = await triggerSync(entry.id);
    if (res.success) {
      toast.info('同步已触发', '后台正在拉取最新内容…');
    } else {
      toast.error('同步失败', res.error?.message);
    }
    setSyncing(false);
  }, [entry.id]);

  const isSubscription = entry.sourceType === 'subscription';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[520px] max-w-[92vw] max-h-[80vh] rounded-[16px] p-6 overflow-y-auto"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 24px 48px -12px rgba(0,0,0,0.5)',
        }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{entry.title}</h3>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {entry.summary && (
          <p className="text-[12px] leading-[1.6] mb-4" style={{ color: 'var(--text-secondary)' }}>{entry.summary}</p>
        )}

        <div className="space-y-2 mb-4">
          {[
            { label: '来源', value: isSubscription ? `订阅源` : entry.sourceType },
            ...(isSubscription && entry.sourceUrl ? [{ label: '源地址', value: entry.sourceUrl }] : []),
            { label: '类型', value: entry.contentType || '未知' },
            { label: '大小', value: formatFileSize(entry.fileSize) },
            { label: '创建时间', value: new Date(entry.createdAt).toLocaleString() },
            ...(entry.lastSyncAt ? [{ label: '上次同步', value: new Date(entry.lastSyncAt).toLocaleString() }] : []),
            ...(entry.syncStatus && entry.syncStatus !== 'idle' ? [{ label: '同步状态', value: entry.syncStatus === 'error' ? `错误: ${entry.syncError || '未知'}` : entry.syncStatus }] : []),
          ].map(r => (
            <div key={r.label} className="flex items-center justify-between text-[12px] gap-2">
              <span className="flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{r.label}</span>
              <span className="truncate text-right" style={{ color: 'var(--text-secondary)' }}>{r.value}</span>
            </div>
          ))}
        </div>

        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {entry.tags.map(t => (
              <span key={t} className="px-2 py-0.5 rounded-[6px] text-[10px]"
                style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.12)', color: 'rgba(59,130,246,0.85)' }}>
                {t}
              </span>
            ))}
          </div>
        )}

        {/* 内容预览 */}
        {!showContent ? (
          <button onClick={loadContent} disabled={contentLoading}
            className="w-full py-2.5 rounded-[10px] text-[12px] font-semibold cursor-pointer transition-colors duration-200 mb-4"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}>
            {contentLoading ? '加载中…' : '查看文档内容'}
          </button>
        ) : content ? (
          <div className="mb-4 p-3 rounded-[10px] max-h-[300px] overflow-y-auto"
            style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <pre className="text-[11px] leading-[1.6] whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
              {content.slice(0, 5000)}{content.length > 5000 ? '\n\n…（内容过长，已截取前 5000 字符）' : ''}
            </pre>
          </div>
        ) : (
          <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>无文本内容（可能是二进制文件）</p>
        )}

        <div className="flex justify-between gap-2 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex gap-2">
            <Button variant="primary" size="xs" onClick={() => {
              onClose();
              navigate(`/emergence?seedSourceType=document&seedSourceId=${entry.id}&seedTitle=${encodeURIComponent(entry.title)}`);
            }}>
              <Sparkle size={13} /> 涌现
            </Button>
            {isSubscription && (
              <Button variant="secondary" size="xs" onClick={handleSync} disabled={syncing}>
                {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                同步
              </Button>
            )}
          </div>
          <Button variant="ghost" size="xs" onClick={() => { onDelete(entry.id); onClose(); }}
            style={{ color: 'rgba(239,68,68,0.7)' }}>
            <Trash2 size={13} /> 删除
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 空间详情视图（文档列表 + 上传）──
function StoreDetailView({ store: initialStore, onBack }: {
  store: DocumentStore;
  onBack: () => void;
}) {
  const [store, setStore] = useState(initialStore);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>(undefined);
  const [showSubscribe, setShowSubscribe] = useState(false);

  // 文件上传状态
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const res = await listDocumentEntries(store.id, 1, 200);
    if (res.success) setEntries(res.data.items);
    setLoading(false);
  }, [store.id]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  // 文件上传处理 — 调用真实上传端点（文件存盘 + 文本提取 + 解析）
  const handleFiles = useCallback(async (files: File[]) => {
    setUploading(true);
    let successCount = 0;
    for (const file of files) {
      const res = await uploadDocumentFile(store.id, file);
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
  }, [store.id]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(files);
  }, [handleFiles]);

  const handleSetPrimary = useCallback(async (entryId: string) => {
    const res = await setPrimaryEntry(store.id, entryId);
    if (res.success) {
      setStore(prev => ({ ...prev, primaryEntryId: entryId }));
      toast.success('已设为主文档');
    }
  }, [store.id]);

  const loadContent = useCallback(async (entryId: string): Promise<string | null> => {
    const res = await getDocumentContent(entryId);
    if (res.success && res.data.hasContent) return res.data.content;
    return null;
  }, []);

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
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
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
          selectedEntryId={selectedEntryId}
          onSelectEntry={setSelectedEntryId}
          onSetPrimary={handleSetPrimary}
          loadContent={loadContent}
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
          storeId={store.id}
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
  const [stores, setStores] = useState<DocumentStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedStore, setSelectedStore] = useState<DocumentStore | null>(null);

  const loadStores = useCallback(async () => {
    setLoading(true);
    const res = await listDocumentStores(1, 50);
    if (res.success) setStores(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { loadStores(); }, [loadStores]);

  // 空间详情视图
  if (selectedStore) {
    return <StoreDetailView store={selectedStore} onBack={() => { setSelectedStore(null); loadStores(); }} />;
  }

  // 空间列表视图
  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5">
      <TabBar
        title="文档空间"
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
              文档空间
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
          /* 空间列表 */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-stretch">
            {stores.map(s => (
              <GlassCard key={s.id} animated interactive padding="none"
                className="group flex flex-col h-full"
                onClick={() => setSelectedStore(s)}>
                <div className="p-4 pb-3 flex-1 flex flex-col">
                  <div className="flex items-start justify-between gap-2 mb-3">
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

                  <div className="flex-1" />
                  <div className="flex items-center justify-between mt-3 pt-2.5"
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
          onCreated={(s) => { setShowCreate(false); setSelectedStore(s); }}
        />
      )}
    </div>
  );
}
