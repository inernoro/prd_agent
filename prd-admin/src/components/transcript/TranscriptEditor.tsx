import { useState, useEffect, useCallback } from 'react';
import { Mic, Trash2, Download, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { TranscribeProgress } from './TranscribeProgress';
import { exportItem } from '@/services/real/transcriptAgent';
import { toast } from '@/lib/toast';
import { CopywritePanel } from './CopywritePanel';
import { AudioPlayer } from './AudioPlayer';
import { SegmentList } from './SegmentList';
import type { TranscriptItem } from '@/services/contracts/transcriptAgent';

interface TranscriptEditorProps {
  item: TranscriptItem | null;
  onItemDeleted: () => void;
}

export function TranscriptEditor({ item, onItemDeleted }: TranscriptEditorProps) {
  const { templates, fetchTemplates, deleteItem, updateSegments, runs, refreshItems } = useTranscriptStore();
  const [exportFormats, setExportFormats] = useState<Set<string>>(new Set(['timestamped']));
  const [exporting, setExporting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);

  const handleSeek = useCallback((time: number) => {
    setSeekTo(time);
    // Reset after a tick so the same timestamp can be sought again
    requestAnimationFrame(() => setSeekTo(undefined));
  }, []);

  const handleTextChange = useCallback((index: number, newText: string) => {
    if (!item?.segments) return;
    const updated = item.segments.map((s, i) => i === index ? { ...s, text: newText } : s);
    updateSegments(item.id, updated);
  }, [item, updateSegments]);

  useEffect(() => { fetchTemplates(); }, []);

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
      case 'completed': return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />;
      case 'processing': case 'pending': return <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />;
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
                  <Loader2 className="w-7 h-7 text-primary animate-spin" />
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

  // ── Completed state ──
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
        <div className="flex items-center gap-4">
          {/* Copywrite */}
          <div className="flex-1">
            <CopywritePanel item={item} templates={templates} />
          </div>

          {/* Export */}
          <div className="flex items-center gap-2 shrink-0">
            {[
              { key: 'timestamped', label: '时间戳' },
              { key: 'txt', label: '纯文本' },
              { key: 'srt', label: 'SRT' },
            ].map(({ key, label }) => (
              <button key={key}
                className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
                  exportFormats.has(key)
                    ? 'border-border bg-muted/40 text-foreground'
                    : 'border-border/50 text-muted-foreground hover:border-border'
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
    </div>
  );
}
