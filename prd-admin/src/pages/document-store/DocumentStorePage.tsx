import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Library,
  Plus,
  FileText,
  Upload,
  Search,
  Trash2,
  Edit3,
  Sparkle,
  Loader2,
  FolderOpen,
  ArrowLeft,
  X,
  File,
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
  addDocumentEntry,
  deleteDocumentEntry,
} from '@/services';
import type {
  DocumentStore,
  DocumentEntry,
} from '@/services/contracts/documentStore';
import { useNavigate } from 'react-router-dom';

// ── 文件上传读取 ──
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

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

// ── 文档条目详情面板 ──
function EntryDetailPanel({ entry, onClose, onDelete }: {
  entry: DocumentEntry;
  onClose: () => void;
  onDelete: (entryId: string) => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full sm:w-[520px] max-h-[85vh] rounded-t-[16px] sm:rounded-[16px] p-6 overflow-y-auto"
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

        <div className="space-y-2 mb-5">
          {[
            { label: '来源', value: entry.sourceType },
            { label: '类型', value: entry.contentType || '未知' },
            { label: '大小', value: formatFileSize(entry.fileSize) },
            { label: '创建时间', value: new Date(entry.createdAt).toLocaleString() },
          ].map(r => (
            <div key={r.label} className="flex items-center justify-between text-[12px]">
              <span style={{ color: 'var(--text-muted)' }}>{r.label}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{r.value}</span>
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

        <div className="flex justify-between gap-2 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <Button variant="primary" size="xs" onClick={() => {
            onClose();
            navigate(`/emergence?seedSourceType=document&seedSourceId=${entry.id}&seedContent=${encodeURIComponent(entry.title)}`);
          }}>
            <Sparkle size={13} /> 从此文档涌现
          </Button>
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
function StoreDetailView({ store, onBack }: {
  store: DocumentStore;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<DocumentEntry | null>(null);

  // 文件上传状态
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const res = await listDocumentEntries(store.id, 1, 100, keyword || undefined);
    if (res.success) setEntries(res.data.items);
    setLoading(false);
  }, [store.id, keyword]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  // 文件上传处理
  const handleFiles = useCallback(async (files: File[]) => {
    setUploading(true);
    for (const file of files) {
      let summary: string | undefined;
      try {
        const text = await readFileAsText(file);
        summary = text.slice(0, 200).trim() || undefined;
      } catch { /* binary file, skip summary */ }

      const res = await addDocumentEntry(store.id, {
        title: file.name.replace(/\.[^.]+$/, ''),
        summary,
        sourceType: 'upload',
        contentType: file.type || 'application/octet-stream',
        fileSize: file.size,
      });
      if (res.success) {
        setEntries(prev => [res.data, ...prev]);
      }
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

  const handleDeleteEntry = useCallback(async (entryId: string) => {
    const res = await deleteDocumentEntry(entryId);
    if (res.success) setEntries(prev => prev.filter(e => e.id !== entryId));
  }, []);

  const navigate = useNavigate();

  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5"
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
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{entries.length} 个文档</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
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

      <div className="px-5 pb-6 w-full">
        {/* 搜索栏 */}
        <div className="mb-4 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-muted)' }} />
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="搜索文档…"
            className="w-full h-9 pl-9 pr-3 rounded-[10px] text-[13px] outline-none transition-colors duration-200"
            style={{
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <MapSpinner size={16} />
            <span className="ml-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</span>
          </div>
        ) : entries.length === 0 ? (
          /* 空状态 — 带引导 */
          <div className="flex flex-col items-center justify-center py-16">
            <FolderOpen size={44} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 20 }} />
            <p className="text-[14px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {keyword ? '没有找到匹配的文档' : '还没有文档'}
            </p>
            <p className="text-[12px] mb-6" style={{ color: 'var(--text-muted)' }}>
              {keyword ? '换个关键词试试' : '上传文档到这个空间，或直接拖拽文件到页面'}
            </p>
            {!keyword && (
              <Button variant="primary" size="md" onClick={() => fileInputRef.current?.click()}>
                <Upload size={15} /> 上传第一个文档
              </Button>
            )}
          </div>
        ) : (
          /* 文档列表 */
          <div className="space-y-2">
            {entries.map(entry => (
              <GlassCard key={entry.id} animated interactive padding="none"
                className="group" onClick={() => setSelectedEntry(entry)}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.1)' }}>
                    {entry.contentType.startsWith('text/') ? (
                      <FileText size={16} style={{ color: 'rgba(59,130,246,0.7)' }} />
                    ) : (
                      <File size={16} style={{ color: 'rgba(59,130,246,0.7)' }} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {entry.title}
                    </h4>
                    <div className="flex items-center gap-3 mt-0.5">
                      {entry.summary && (
                        <span className="text-[11px] truncate flex-1 min-w-0" style={{ color: 'var(--text-muted)' }}>
                          {entry.summary.slice(0, 80)}
                        </span>
                      )}
                      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        {formatFileSize(entry.fileSize)}
                      </span>
                      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        {new Date(entry.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
                      title="从此文档涌现"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/emergence?seedSourceType=document&seedSourceId=${entry.id}&seedContent=${encodeURIComponent(entry.title)}`);
                      }}
                      style={{ color: 'rgba(147,51,234,0.7)' }}>
                      <Sparkle size={14} />
                    </button>
                    <button
                      className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
                      title="删除"
                      onClick={(e) => { e.stopPropagation(); handleDeleteEntry(entry.id); }}
                      style={{ color: 'rgba(239,68,68,0.5)' }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>
        )}
      </div>

      {selectedEntry && (
        <EntryDetailPanel entry={selectedEntry} onClose={() => setSelectedEntry(null)} onDelete={handleDeleteEntry} />
      )}
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
