import { useEffect, useState, useCallback, useRef } from 'react';
import { FileAudio, FileText, Plus, Trash2, CheckCircle2, AlertCircle, ChevronDown, ChevronRight, X, Sparkles, Eye } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { toast } from '@/lib/toast';
import { UploadDropzone } from './UploadDropzone';
import type { TranscriptItem } from '@/services/contracts/transcriptAgent';

interface TranscriptSidebarProps {
  selectedItemId: string | null;
  selectedRunId?: string | null;
  onSelectItem: (item: TranscriptItem | null) => void;
  onGenerate?: (item: TranscriptItem) => void;
  onSelectRun?: (runId: string) => void;
}

export function TranscriptSidebar({ selectedItemId, selectedRunId, onSelectItem, onGenerate, onSelectRun }: TranscriptSidebarProps) {
  const {
    workspaces, currentWorkspace, items, runs, uploading,
    fetchWorkspaces, selectWorkspace, createWorkspace, deleteWorkspace,
    uploadFile, deleteItem, renameItem, deleteRun,
  } = useTranscriptStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [wsExpanded, setWsExpanded] = useState(true);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmDeleteRunId, setConfirmDeleteRunId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { fetchWorkspaces(); }, []);

  // 3 秒自动复位删除确认状态
  useEffect(() => {
    if (!confirmDeleteRunId) return;
    const t = setTimeout(() => setConfirmDeleteRunId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteRunId]);

  useEffect(() => {
    if (editingItemId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [editingItemId]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    const ws = await createWorkspace(newTitle.trim());
    if (ws) {
      setNewTitle('');
      setShowCreate(false);
      await selectWorkspace(ws.id);
      toast.success('工作区已创建');
    }
  };

  const handleUpload = useCallback((file: File) => {
    uploadFile(file);
  }, [uploadFile]);

  const handleDeleteWorkspace = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('删除此工作区及所有素材？')) {
      deleteWorkspace(id);
      onSelectItem(null);
    }
  };

  const handleDeleteItem = (itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('删除此素材？')) {
      deleteItem(itemId);
      if (selectedItemId === itemId) onSelectItem(null);
    }
  };

  const startRename = (item: TranscriptItem) => {
    setEditingItemId(item.id);
    setEditingName(item.fileName);
  };

  const commitRename = (itemId: string) => {
    const trimmed = editingName.trim();
    if (trimmed && trimmed !== items.find(i => i.id === itemId)?.fileName) {
      renameItem(itemId, trimmed);
    }
    setEditingItemId(null);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />;
      case 'processing': case 'pending': return <MapSpinner size={12} className="shrink-0" />;
      case 'failed': return <AlertCircle className="w-3 h-3 text-destructive shrink-0" />;
      default: return null;
    }
  };

  const getItemCopywriteRuns = (itemId: string) =>
    runs.filter(r => r.itemId === itemId && r.type === 'copywrite' &&
      (r.status === 'completed' || r.status === 'processing' || r.status === 'queued'));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <h1 className="text-sm font-semibold flex items-center gap-1.5">
          <FileAudio className="w-4 h-4" />
          转录工作台
        </h1>
        <button
          onClick={() => setShowCreate(true)}
          className="p-1 rounded-md hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
          title="新建工作区"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Create workspace inline */}
      {showCreate && (
        <div className="px-3 py-2 border-b border-border/50 bg-muted/30">
          <div className="flex items-center gap-1.5">
            <input
              className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded-md bg-muted/40 border border-border outline-none focus:border-border transition-colors"
              placeholder="工作区名称"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') { setShowCreate(false); setNewTitle(''); }
              }}
              autoFocus
            />
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim()}
              className="px-2 py-1.5 text-xs rounded-md bg-muted/40 hover:bg-muted/60 transition-colors disabled:opacity-40"
            >
              创建
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewTitle(''); }}
              className="p-1 rounded-md hover:bg-muted/50 transition-colors"
            >
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          </div>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Workspace section */}
        <div className="px-2 pt-2">
          <button
            onClick={() => setWsExpanded(!wsExpanded)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground/80 transition-colors w-full"
          >
            {wsExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            工作区
          </button>
        </div>

        {wsExpanded && (
          <div className="px-2 pb-1">
            {workspaces.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground/60 text-center">
                暂无工作区
              </div>
            ) : (
              workspaces.map(ws => (
                <button
                  key={ws.id}
                  onClick={() => {
                    selectWorkspace(ws.id);
                    onSelectItem(null);
                  }}
                  className="surface-row w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs font-medium group cursor-pointer"
                  data-active={currentWorkspace?.id === ws.id || undefined}
                >
                  <FileAudio className="w-3.5 h-3.5 shrink-0 text-primary/60" />
                  <span className="flex-1 min-w-0 truncate">{ws.title}</span>
                  <button
                    onClick={(e) => handleDeleteWorkspace(ws.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-all"
                  >
                    <Trash2 className="w-3 h-3 text-muted-foreground" />
                  </button>
                </button>
              ))
            )}
          </div>
        )}

        {/* Items section (when a workspace is selected) */}
        {currentWorkspace && (
          <>
            <div className="mx-3 my-1 border-t border-border/50" />
            <div className="px-2">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                素材 ({items.length})
              </div>
            </div>
            <div className="px-2 pb-2">
              {items.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground/60 text-center">
                  {uploading ? '上传中...' : '暂无素材，请上传音视频'}
                </div>
              ) : (
                items.map(item => {
                  const copywriteRuns = getItemCopywriteRuns(item.id);
                  return (
                    <div key={item.id}>
                      {/* Item row */}
                      <button
                        onClick={() => onSelectItem(item)}
                        className="surface-row w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs group cursor-pointer"
                        data-active={selectedItemId === item.id || undefined}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            {statusIcon(item.transcribeStatus)}
                            {editingItemId === item.id ? (
                              <input
                                ref={renameInputRef}
                                className="flex-1 min-w-0 px-1 py-0 text-xs bg-muted/40 border border-border rounded outline-none focus:border-primary/50 text-foreground/80"
                                value={editingName}
                                onChange={e => setEditingName(e.target.value)}
                                onBlur={() => commitRename(item.id)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') commitRename(item.id);
                                  if (e.key === 'Escape') setEditingItemId(null);
                                }}
                                onClick={e => e.stopPropagation()}
                              />
                            ) : (
                              <span
                                className="truncate text-foreground/80"
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  startRename(item);
                                }}
                              >
                                {item.fileName}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground/60 ml-[18px]">
                            {formatFileSize(item.fileSize)}
                          </span>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          {item.transcribeStatus === 'completed' && onGenerate && (
                            <button
                              onClick={(e) => { e.stopPropagation(); onGenerate(item); }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-all"
                              title="生成文案"
                            >
                              <Sparkles className="w-3 h-3 text-muted-foreground" />
                            </button>
                          )}
                          <button
                            onClick={(e) => handleDeleteItem(item.id, e)}
                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-all"
                          >
                            <Trash2 className="w-3 h-3 text-muted-foreground" />
                          </button>
                        </div>
                      </button>

                      {/* Copywrite sub-runs */}
                      {copywriteRuns.length > 0 && (
                        <div className="ml-6 pl-2 border-l-2 border-primary/20">
                          {copywriteRuns.map(run => (
                            <button
                              key={run.id}
                              onClick={() => {
                                onSelectItem(item);
                                onSelectRun?.(run.id);
                              }}
                              className="surface-row w-full flex items-center gap-2 pl-2 pr-3 py-1.5 text-left text-[11px] group cursor-pointer"
                              data-active={selectedRunId === run.id || undefined}
                            >
                              {run.status === 'completed' ? (
                                <FileText className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                              ) : (
                                <MapSpinner size={12} className="shrink-0" />
                              )}
                              <span className="flex-1 truncate text-muted-foreground">
                                {run.status === 'completed' ? `文案 ${formatTime(run.createdAt)}` : '生成中...'}
                              </span>
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                                <span
                                  role="button"
                                  onClick={(e) => { e.stopPropagation(); onSelectItem(item); onSelectRun?.(run.id); }}
                                  className="p-0.5 rounded hover:bg-muted"
                                  title="查看"
                                >
                                  <Eye className="w-3 h-3 text-muted-foreground" />
                                </span>
                                <span
                                  role="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (confirmDeleteRunId === run.id) {
                                      deleteRun(run.id);
                                      setConfirmDeleteRunId(null);
                                      toast.success('已删除');
                                    } else {
                                      setConfirmDeleteRunId(run.id);
                                    }
                                  }}
                                  className={`p-0.5 rounded transition-all ${
                                    confirmDeleteRunId === run.id
                                      ? 'bg-destructive/20 text-destructive opacity-100'
                                      : 'hover:bg-muted text-muted-foreground'
                                  }`}
                                  title={confirmDeleteRunId === run.id ? '再次点击确认删除' : '删除'}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      {/* Bottom upload area */}
      {currentWorkspace && (
        <div className="px-3 py-3 border-t border-border/50">
          <UploadDropzone onUpload={handleUpload} uploading={uploading} />
        </div>
      )}
    </div>
  );
}
