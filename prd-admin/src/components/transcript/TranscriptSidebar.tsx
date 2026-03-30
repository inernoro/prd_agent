import { useEffect, useState, useCallback } from 'react';
import { FileAudio, Plus, Trash2, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import { UploadDropzone } from './UploadDropzone';
import type { TranscriptItem } from '@/services/contracts/transcriptAgent';

interface TranscriptSidebarProps {
  selectedItemId: string | null;
  onSelectItem: (item: TranscriptItem | null) => void;
}

export function TranscriptSidebar({ selectedItemId, onSelectItem }: TranscriptSidebarProps) {
  const {
    workspaces, currentWorkspace, items, uploading,
    fetchWorkspaces, selectWorkspace, createWorkspace, deleteWorkspace,
    uploadFile, deleteItem,
  } = useTranscriptStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [wsExpanded, setWsExpanded] = useState(true);

  useEffect(() => { fetchWorkspaces(); }, []);

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

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />;
      case 'processing': case 'pending': return <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />;
      case 'failed': return <AlertCircle className="w-3 h-3 text-destructive shrink-0" />;
      default: return null;
    }
  };

  return (
    <div className="w-60 shrink-0 flex flex-col h-full bg-muted/30 border-r border-border/50">
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
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left text-xs transition-all group',
                    currentWorkspace?.id === ws.id
                      ? 'bg-muted/60 border-l-2 border-primary text-foreground'
                      : 'hover:bg-muted/50 text-foreground/80',
                  )}
                >
                  <FileAudio className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
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
                items.map(item => (
                  <button
                    key={item.id}
                    onClick={() => onSelectItem(item)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left text-xs transition-all group',
                      selectedItemId === item.id
                        ? 'bg-muted/60 border-l-2 border-primary'
                        : 'hover:bg-muted/50',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {statusIcon(item.transcribeStatus)}
                        <span className="truncate text-foreground/80">{item.fileName}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 ml-[18px]">
                        {formatFileSize(item.fileSize)}
                      </span>
                    </div>
                    <button
                      onClick={(e) => handleDeleteItem(item.id, e)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-all shrink-0"
                    >
                      <Trash2 className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </button>
                ))
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
