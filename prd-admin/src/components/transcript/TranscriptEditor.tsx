import { useState, useCallback, useEffect, useRef } from 'react';
import { Mic, Trash2, Download, AlertCircle, CheckCircle2, ArrowLeft, Copy, Save } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/design/Button';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { TranscribeProgress } from './TranscribeProgress';
import { exportItem } from '@/services/real/transcriptAgent';
import { toast } from '@/lib/toast';
import { AudioPlayer } from './AudioPlayer';
import { SegmentList } from './SegmentList';
import type { TranscriptItem } from '@/services/contracts/transcriptAgent';

interface TranscriptEditorProps {
  item: TranscriptItem | null;
  selectedRunId?: string | null;
  onItemDeleted: () => void;
  onCloseRun?: () => void;
}

export function TranscriptEditor({ item, selectedRunId, onItemDeleted, onCloseRun }: TranscriptEditorProps) {
  const { deleteItem, updateSegments, runs, refreshItems, renameItem, saveRunResult } = useTranscriptStore();
  const [exportFormats, setExportFormats] = useState<Set<string>>(new Set(['timestamped']));
  const [exporting, setExporting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [previewMode, setPreviewMode] = useState(true);
  const [editDraft, setEditDraft] = useState('');

  // Resolve the selected copywrite run
  const selectedRun = selectedRunId ? runs.find(r => r.id === selectedRunId) : null;

  // Sync editDraft when selectedRun changes
  useEffect(() => {
    if (selectedRun?.result) {
      setEditDraft(selectedRun.result);
      setPreviewMode(true);
    }
  }, [selectedRunId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStartEditTitle = () => {
    setTitleDraft(item?.fileName ?? '');
    setEditingTitle(true);
  };

  const handleSaveTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== item?.fileName && item) {
      renameItem(item.id, trimmed);
    }
    setEditingTitle(false);
  };

  const handleSeek = useCallback((time: number) => {
    setSeekTo(time);
    // Reset after a tick so the same timestamp can be sought again
    requestAnimationFrame(() => setSeekTo(undefined));
  }, []);

  // Debounced segment text change — saves 500ms after last keystroke
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const handleTextChange = useCallback((index: number, newText: string) => {
    if (!item?.segments) return;
    const updated = item.segments.map((s, i) => i === index ? { ...s, text: newText } : s);
    clearTimeout(segmentTimerRef.current);
    segmentTimerRef.current = setTimeout(() => {
      updateSegments(item.id, updated);
    }, 500);
  }, [item, updateSegments]);

  // ── Empty state ──
  if (!item) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-muted/30 border border-dashed border-border flex items-center justify-center">
            <Mic className="w-7 h-7 text-muted-foreground/60" />
          </div>
          <p className="text-sm text-muted-foreground">选择一个素材开始编辑</p>
          <p className="text-xs text-muted-foreground/60 mt-1">从左侧列表选择已转录的音视频文件</p>
        </div>
      </div>
    );
  }

  const handleDelete = () => {
    if (confirm('删除此素材？')) {
      deleteItem(item.id);
      onItemDeleted();
    }
  };

  const handleExport = async () => {
    if (exportFormats.size === 0) return;
    setExporting(true);
    const res = await exportItem(item.id, [...exportFormats]);
    if (res.success && res.data) {
      Object.entries(res.data).forEach(([fmt, content]) => {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${item.fileName.replace(/\.[^.]+$/, '')}_${fmt}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      });
      toast.success('导出完成');
    }
    setExporting(false);
  };

  const toggleFormat = (fmt: string) => {
    setExportFormats(prev => {
      const next = new Set(prev);
      next.has(fmt) ? next.delete(fmt) : next.add(fmt);
      return next;
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
      case 'processing': case 'pending': return <MapSpinner size={14} />;
      case 'failed': return <AlertCircle className="w-3.5 h-3.5 text-destructive" />;
      default: return null;
    }
  };

  const statusText = (status: string) => {
    switch (status) {
      case 'completed': return '转写完成';
      case 'processing': return '转写中...';
      case 'pending': return '排队中';
      case 'failed': return '转写失败';
      default: return status;
    }
  };

  // ── Pending / Processing state ──
  if (item.transcribeStatus === 'pending' || item.transcribeStatus === 'processing') {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-medium truncate">{item.fileName}</h1>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">{statusIcon(item.transcribeStatus)} {statusText(item.transcribeStatus)}</span>
              <span>{formatFileSize(item.fileSize)}</span>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={handleDelete}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        {/* TranscribeProgress with live text */}
        {(() => {
          const latestRun = runs.find(r => r.itemId === item.id && r.type === 'asr' &&
            (r.status === 'queued' || r.status === 'processing'));
          return latestRun ? (
            <TranscribeProgress
              runId={latestRun.id}
              itemName={item.fileName}
              onCompleted={() => refreshItems()}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-xs">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
                  <MapSpinner size={28} />
                </div>
                <p className="text-sm text-foreground/80">正在转写中</p>
                <p className="text-xs text-muted-foreground mt-1">AI 正在识别语音内容，请稍候...</p>
              </div>
            </div>
          );
        })()}
      </div>
    );
  }

  // ── Failed state ──
  if (item.transcribeStatus === 'failed') {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-medium truncate">{item.fileName}</h1>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">{statusIcon(item.transcribeStatus)} {statusText(item.transcribeStatus)}</span>
              <span>{formatFileSize(item.fileSize)}</span>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={handleDelete}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-xs">
            <AlertCircle className="w-10 h-10 mx-auto mb-3 text-destructive/60" />
            <p className="text-sm text-destructive">{item.transcribeError ?? '转写失败'}</p>
            <p className="text-xs text-muted-foreground mt-2">请检查文件格式是否支持，或重新上传</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Copywrite run viewer ──
  if (selectedRun?.result && item) {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
          <button onClick={onCloseRun} className="p-1 rounded hover:bg-muted transition-colors">
            <ArrowLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-medium truncate">文案 — {item.fileName}</h1>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
              <span>{new Date(selectedRun.createdAt).toLocaleString()}</span>
            </div>
          </div>
          {/* Preview / Edit toggle */}
          <div className="flex items-center bg-muted/30 rounded-lg p-0.5 text-xs">
            <button
              className={`px-3 py-1 rounded-md transition-colors font-medium ${previewMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setPreviewMode(true)}
            >
              预览
            </button>
            <button
              className={`px-3 py-1 rounded-md transition-colors font-medium ${!previewMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setPreviewMode(false)}
            >
              编辑
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
          {previewMode ? (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown>{selectedRun.result ?? ''}</ReactMarkdown>
            </div>
          ) : (
            <textarea
              className="w-full h-full text-sm text-foreground/80 bg-muted/10 border border-border/50 rounded-lg p-4 outline-none resize-none leading-relaxed ring-1 ring-primary/20 focus:ring-primary/40 transition-shadow"
              value={editDraft}
              onChange={e => setEditDraft(e.target.value)}
            />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border/50 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{(previewMode ? selectedRun.result : editDraft)?.length ?? 0} 字</span>
            {!previewMode && editDraft !== (selectedRun.result ?? '') && (
              <span className="text-xs text-amber-400">未保存</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!previewMode && editDraft !== (selectedRun.result ?? '') && (
              <Button size="sm" variant="ghost" onClick={() => saveRunResult(selectedRun.id, editDraft)}>
                <Save className="w-4 h-4 mr-1" /> 保存
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(previewMode ? (selectedRun.result ?? '') : editDraft); toast.success('已复制'); }}>
              <Copy className="w-4 h-4 mr-1" /> 复制
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Completed state ──
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              className="text-base font-medium bg-transparent border-b border-primary/30 outline-none w-full"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={handleSaveTitle}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
              autoFocus
            />
          ) : (
            <h1
              className="text-base font-medium truncate cursor-pointer hover:text-foreground/60 transition-colors"
              onClick={handleStartEditTitle}
              title="点击编辑标题"
            >
              {item.fileName}
            </h1>
          )}
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">{statusIcon(item.transcribeStatus)} {statusText(item.transcribeStatus)}</span>
            <span>{formatFileSize(item.fileSize)}</span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={handleDelete}>
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {/* Audio player */}
      <AudioPlayer
        src={item.fileUrl}
        onTimeUpdate={setCurrentTime}
        seekTo={seekTo}
      />

      {/* Segment list */}
      <SegmentList
        segments={item.segments ?? []}
        currentTime={currentTime}
        onSeek={handleSeek}
        onTextChange={handleTextChange}
        className="flex-1 overflow-y-auto px-3 py-2 min-h-0"
      />

      {/* Bottom action bar */}
      <div className="border-t border-border/50 px-6 py-4">
        <div className="flex items-center justify-end gap-2">
          {[
            { key: 'timestamped', label: '时间戳' },
            { key: 'txt', label: '纯文本' },
            { key: 'srt', label: 'SRT' },
          ].map(({ key, label }) => (
            <button key={key}
              className={`px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                exportFormats.has(key)
                  ? 'bg-primary/15 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
              onClick={() => toggleFormat(key)}>
              {label}
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={handleExport} disabled={exportFormats.size === 0 || exporting}>
            <Download className="w-4 h-4 mr-1" />
            导出
          </Button>
        </div>
      </div>
    </div>
  );
}
