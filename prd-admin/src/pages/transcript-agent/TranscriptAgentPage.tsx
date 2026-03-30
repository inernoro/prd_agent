import { useEffect, useRef, useState, useCallback } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { toast } from '@/lib/toast';
import { FileAudio, Plus, Trash2, Upload, Download, FileText, Loader2, ArrowLeft, Clock, ChevronRight, Mic, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { exportItem } from '@/services/real/transcriptAgent';
import type { TranscriptItem } from '@/services/contracts/transcriptAgent';

export default function TranscriptAgentPage() {
  const {
    workspaces, currentWorkspace, items, templates, loading, uploading,
    fetchWorkspaces, selectWorkspace, createWorkspace, deleteWorkspace,
    uploadFile, deleteItem, fetchTemplates, createCopywrite, refreshItems, pollRun,
  } = useTranscriptStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [selectedItem, setSelectedItem] = useState<TranscriptItem | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [copywriteResult, setCopywriteResult] = useState('');
  const [exportFormats, setExportFormats] = useState<Set<string>>(new Set(['timestamped']));
  const [exporting, setExporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { fetchWorkspaces(); fetchTemplates(); }, []);

  useEffect(() => {
    const pending = items.filter(i => i.transcribeStatus === 'pending' || i.transcribeStatus === 'processing');
    if (pending.length === 0) return;
    const timer = setInterval(() => refreshItems(), 3000);
    return () => clearInterval(timer);
  }, [items, refreshItems]);

  useEffect(() => {
    if (selectedItem) {
      const updated = items.find(i => i.id === selectedItem.id);
      if (updated) setSelectedItem(updated);
    }
  }, [items]);

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

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file);
    e.target.value = '';
  };

  const handleCopywrite = async () => {
    if (!selectedItem || !selectedTemplateId) return;
    setGenerating(true);
    setCopywriteResult('');
    const run = await createCopywrite(selectedItem.id, selectedTemplateId);
    if (run) {
      const poll = async () => {
        const r = await pollRun(run.id);
        if (!r) { setGenerating(false); return; }
        if (r.status === 'completed') {
          setCopywriteResult(r.result ?? '');
          setGenerating(false);
          toast.success('文案生成完成');
        } else if (r.status === 'failed') {
          setGenerating(false);
          toast.error(r.error ?? '生成失败');
        } else {
          setTimeout(poll, 2000);
        }
      };
      setTimeout(poll, 2000);
    } else { setGenerating(false); }
  };

  const handleExport = async () => {
    if (!selectedItem || exportFormats.size === 0) return;
    setExporting(true);
    const res = await exportItem(selectedItem.id, [...exportFormats]);
    if (res.success && res.data) {
      Object.entries(res.data).forEach(([fmt, content]) => {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${selectedItem.fileName.replace(/\.[^.]+$/, '')}_${fmt}.txt`;
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

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
      case 'processing': case 'pending': return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
      case 'failed': return <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
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

  // ─── 视图：转写详情（选中素材后） ───
  if (selectedItem) {
    return (
      <div className="flex flex-col h-full">
        {/* 顶栏 */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
          <button onClick={() => { setSelectedItem(null); setCopywriteResult(''); }}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors">
            <ArrowLeft className="w-5 h-5 text-white/60" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-medium truncate">{selectedItem.fileName}</h1>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-white/40">
              <span className="flex items-center gap-1">{statusIcon(selectedItem.transcribeStatus)} {statusText(selectedItem.transcribeStatus)}</span>
              <span>{formatFileSize(selectedItem.fileSize)}</span>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => { if (confirm('删除此素材？')) { deleteItem(selectedItem.id); setSelectedItem(null); } }}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        {/* 内容 */}
        {selectedItem.transcribeStatus !== 'completed' ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-xs">
              {selectedItem.transcribeStatus === 'failed' ? (
                <>
                  <AlertCircle className="w-10 h-10 mx-auto mb-3 text-red-400/60" />
                  <p className="text-sm text-red-400">{selectedItem.transcribeError ?? '转写失败'}</p>
                  <p className="text-xs text-white/30 mt-2">请检查文件格式是否支持，或重新上传</p>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/10 flex items-center justify-center">
                    <Loader2 className="w-7 h-7 text-blue-400 animate-spin" />
                  </div>
                  <p className="text-sm text-white/60">正在转写中</p>
                  <p className="text-xs text-white/30 mt-1">AI 正在识别语音内容，请稍候...</p>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            {/* 转写结果 */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {selectedItem.segments?.map((seg, i) => (
                <div key={i} className="flex gap-4 py-2.5 group">
                  <span className="font-mono text-xs text-white/25 pt-0.5 w-14 shrink-0 text-right tabular-nums">
                    {formatTime(seg.start)}
                  </span>
                  <p className="text-sm text-white/75 leading-relaxed flex-1">{seg.text}</p>
                </div>
              ))}
            </div>

            {/* 底部操作栏 */}
            <div className="border-t border-white/5 px-6 py-4">
              <div className="flex items-center gap-4">
                {/* 模板转文案 */}
                <div className="flex items-center gap-2 flex-1">
                  <select
                    className="px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 outline-none focus:border-white/20 transition-colors min-w-[140px]"
                    value={selectedTemplateId}
                    onChange={e => setSelectedTemplateId(e.target.value)}>
                    <option value="">选择模板...</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <Button size="sm" onClick={handleCopywrite} disabled={!selectedTemplateId || generating}>
                    {generating ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <FileText className="w-4 h-4 mr-1" />}
                    生成文案
                  </Button>
                </div>

                {/* 导出 */}
                <div className="flex items-center gap-2">
                  {[
                    { key: 'timestamped', label: '时间戳' },
                    { key: 'txt', label: '纯文本' },
                    { key: 'srt', label: 'SRT' },
                  ].map(({ key, label }) => (
                    <button key={key}
                      className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
                        exportFormats.has(key)
                          ? 'border-white/20 bg-white/10 text-white/80'
                          : 'border-white/5 text-white/30 hover:border-white/10'
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

              {/* 文案结果 */}
              {copywriteResult && (
                <div className="mt-3 p-4 bg-white/[0.03] rounded-lg border border-white/5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-white/40">生成结果</span>
                    <button className="text-xs text-white/30 hover:text-white/50" onClick={() => {
                      navigator.clipboard.writeText(copywriteResult);
                      toast.success('已复制');
                    }}>复制</button>
                  </div>
                  <pre className="text-sm text-white/70 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">{copywriteResult}</pre>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── 视图：工作区内容（选中工作区后） ───
  if (currentWorkspace) {
    return (
      <div className="flex flex-col h-full">
        {/* 顶栏 */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
          <button onClick={() => useTranscriptStore.setState({ currentWorkspace: null, items: [], runs: [] })}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors">
            <ArrowLeft className="w-5 h-5 text-white/60" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-medium">{currentWorkspace.title}</h1>
            <p className="text-xs text-white/30 mt-0.5">{items.length} 个素材</p>
          </div>
          <input ref={fileInputRef} type="file" className="hidden"
            accept="audio/*,video/mp4,video/webm,video/quicktime"
            onChange={handleUpload} />
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Upload className="w-4 h-4 mr-1.5" />}
            {uploading ? '上传中...' : '上传'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { if (confirm('删除此工作区及所有素材？')) deleteWorkspace(currentWorkspace.id); }}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        {/* 素材列表 */}
        {items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            {uploading ? (
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
                </div>
                <p className="text-sm text-white/60">正在上传并处理...</p>
                <p className="text-xs text-white/30 mt-1">文件上传后将自动开始转写</p>
              </div>
            ) : (
              <button onClick={() => fileInputRef.current?.click()}
                className="text-center group cursor-pointer">
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-white/[0.03] border border-dashed border-white/10 flex items-center justify-center group-hover:border-white/20 group-hover:bg-white/[0.05] transition-all">
                  <Mic className="w-8 h-8 text-white/20 group-hover:text-white/40 transition-colors" />
                </div>
                <p className="text-sm text-white/40 group-hover:text-white/60 transition-colors">上传音视频文件开始转写</p>
                <p className="text-xs text-white/20 mt-1">支持 MP3, WAV, MP4, M4A 等格式，最大 100MB</p>
              </button>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="grid gap-2">
              {items.map(item => (
                <button key={item.id}
                  onClick={() => { setSelectedItem(item); setCopywriteResult(''); }}
                  className="w-full flex items-center gap-4 px-4 py-3.5 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.05] hover:border-white/10 transition-all text-left group">
                  <div className="w-10 h-10 rounded-lg bg-white/[0.04] flex items-center justify-center shrink-0">
                    <FileAudio className="w-5 h-5 text-white/30" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.fileName}</p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-white/30">
                      <span className="flex items-center gap-1">{statusIcon(item.transcribeStatus)} {statusText(item.transcribeStatus)}</span>
                      <span>{formatFileSize(item.fileSize)}</span>
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-white/10 group-hover:text-white/30 transition-colors shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── 视图：工作区列表（默认首页） ───
  return (
    <div className="flex flex-col h-full">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <FileAudio className="w-5 h-5" /> 转录工作台
          </h1>
          <p className="text-xs text-white/30 mt-0.5">上传音视频，AI 自动转写，一键生成文案</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1.5" /> 新建工作区
        </Button>
      </div>

      {/* 创建弹层 */}
      {showCreate && (
        <div className="px-6 py-3 border-b border-white/5 bg-white/[0.02]">
          <div className="flex items-center gap-3 max-w-md">
            <input
              className="flex-1 px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 outline-none focus:border-white/25 transition-colors"
              placeholder="输入工作区名称，如「3月产品评审会」"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
              autoFocus
            />
            <Button size="sm" onClick={handleCreate} disabled={!newTitle.trim()}>创建</Button>
            <button onClick={() => { setShowCreate(false); setNewTitle(''); }}
              className="p-1.5 rounded-lg hover:bg-white/5 transition-colors">
              <X className="w-4 h-4 text-white/40" />
            </button>
          </div>
        </div>
      )}

      {/* 工作区网格 */}
      {workspaces.length === 0 && !loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-white/[0.03] border border-dashed border-white/10 flex items-center justify-center">
              <FileAudio className="w-8 h-8 text-white/15" />
            </div>
            <p className="text-sm text-white/40">还没有工作区</p>
            <p className="text-xs text-white/20 mt-1">创建一个工作区，开始你的第一次转录</p>
            <Button size="sm" className="mt-4" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4 mr-1" /> 新建工作区
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {workspaces.map(ws => (
              <button key={ws.id}
                onClick={() => selectWorkspace(ws.id)}
                className="text-left p-4 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.05] hover:border-white/10 transition-all group">
                <div className="flex items-start justify-between">
                  <div className="w-10 h-10 rounded-lg bg-white/[0.04] flex items-center justify-center mb-3">
                    <FileAudio className="w-5 h-5 text-white/25" />
                  </div>
                  <ChevronRight className="w-4 h-4 text-white/0 group-hover:text-white/30 transition-colors mt-1" />
                </div>
                <h3 className="text-sm font-medium truncate">{ws.title}</h3>
                <p className="text-xs text-white/25 mt-1 flex items-center gap-1.5">
                  <Clock className="w-3 h-3" />
                  {new Date(ws.createdAt).toLocaleDateString()}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
