import { useEffect, useRef, useState, useCallback } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { toast } from '@/lib/toast';
import { FileAudio, Plus, Trash2, Upload, Download, FileText, Loader2 } from 'lucide-react';
import { exportItem } from '@/services/real/transcriptAgent';
import type { TranscriptItem } from '@/services/contracts/transcriptAgent';

export default function TranscriptAgentPage() {
  const {
    workspaces, currentWorkspace, items, templates, loading,
    fetchWorkspaces, selectWorkspace, createWorkspace, deleteWorkspace,
    uploadFile, deleteItem, fetchTemplates, createCopywrite, refreshItems, pollRun,
  } = useTranscriptStore();

  const [newTitle, setNewTitle] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedItem, setSelectedItem] = useState<TranscriptItem | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [copywriteResult, setCopywriteResult] = useState('');
  const [exportFormats, setExportFormats] = useState<Set<string>>(new Set(['timestamped']));
  const [exporting, setExporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchWorkspaces();
    fetchTemplates();
  }, []);

  // 轮询转写状态
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
    toast.success('文件上传成功，正在转写...');
    e.target.value = '';
  };

  const handleCopywrite = async () => {
    if (!selectedItem || !selectedTemplateId) return;
    setGenerating(true);
    setCopywriteResult('');
    const run = await createCopywrite(selectedItem.id, selectedTemplateId);
    if (run) {
      // 轮询等待完成
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
    } else {
      setGenerating(false);
    }
  };

  const handleExport = async () => {
    if (!selectedItem || exportFormats.size === 0) return;
    setExporting(true);
    const res = await exportItem(selectedItem.id, [...exportFormats]);
    if (res.ok && res.data) {
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

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex h-full gap-4 p-4">
      {/* 左侧：工作区列表 */}
      <GlassCard className="w-64 shrink-0 flex flex-col">
        <div className="flex items-center justify-between p-3 border-b border-white/10">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <FileAudio className="w-4 h-4" /> 工作区
          </h2>
          <Button size="sm" variant="ghost" onClick={() => setShowCreate(!showCreate)}>
            <Plus className="w-4 h-4" />
          </Button>
        </div>

        {showCreate && (
          <div className="p-3 border-b border-white/10 flex gap-2">
            <input
              className="flex-1 px-2 py-1 text-sm rounded bg-white/5 border border-white/10 outline-none focus:border-white/30"
              placeholder="工作区名称..."
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <Button size="sm" onClick={handleCreate}>创建</Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {workspaces.map(ws => (
            <div
              key={ws.id}
              className={`px-3 py-2 cursor-pointer hover:bg-white/5 text-sm transition-colors ${
                currentWorkspace?.id === ws.id ? 'bg-white/10 font-medium' : ''
              }`}
              onClick={() => selectWorkspace(ws.id)}
            >
              <div className="truncate">{ws.title}</div>
              <div className="text-xs text-white/40 mt-0.5">
                {new Date(ws.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))}
          {workspaces.length === 0 && !loading && (
            <div className="p-4 text-sm text-white/40 text-center">暂无工作区，点击 + 创建</div>
          )}
        </div>
      </GlassCard>

      {/* 右侧：主内容区 */}
      <div className="flex-1 flex flex-col gap-4 min-w-0">
        {!currentWorkspace ? (
          <GlassCard className="flex-1 flex items-center justify-center">
            <div className="text-center text-white/40">
              <FileAudio className="w-12 h-12 mx-auto mb-3 opacity-40" />
              <p>选择或创建一个工作区开始</p>
            </div>
          </GlassCard>
        ) : (
          <>
            {/* 工作区头部 */}
            <GlassCard className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-lg font-semibold">{currentWorkspace.title}</h1>
                  <p className="text-xs text-white/40 mt-1">{items.length} 个素材</p>
                </div>
                <div className="flex gap-2">
                  <input ref={fileInputRef} type="file" className="hidden"
                    accept="audio/*,video/mp4,video/webm,video/quicktime"
                    onChange={handleUpload} />
                  <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                    <Upload className="w-4 h-4 mr-1" /> 上传音视频
                  </Button>
                  <Button size="sm" variant="ghost"
                    onClick={() => { if (confirm('确定删除此工作区？')) deleteWorkspace(currentWorkspace.id); }}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </GlassCard>

            {/* 素材列表 + 转写详情 */}
            <div className="flex-1 flex gap-4 min-h-0">
              {/* 素材列表 */}
              <GlassCard className="w-72 shrink-0 flex flex-col">
                <div className="p-3 border-b border-white/10 text-sm font-medium">素材列表</div>
                <div className="flex-1 overflow-y-auto">
                  {items.map(item => (
                    <div
                      key={item.id}
                      className={`px-3 py-2 cursor-pointer hover:bg-white/5 text-sm border-b border-white/5 ${
                        selectedItem?.id === item.id ? 'bg-white/10' : ''
                      }`}
                      onClick={() => { setSelectedItem(item); setCopywriteResult(''); }}
                    >
                      <div className="truncate font-medium">{item.fileName}</div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-white/40">
                        <span>{formatDuration(item.duration)}</span>
                        <span>·</span>
                        <span className={
                          item.transcribeStatus === 'completed' ? 'text-green-400' :
                          item.transcribeStatus === 'failed' ? 'text-red-400' :
                          item.transcribeStatus === 'processing' ? 'text-yellow-400' : ''
                        }>
                          {item.transcribeStatus === 'completed' ? '已转写' :
                           item.transcribeStatus === 'failed' ? '转写失败' :
                           item.transcribeStatus === 'processing' ? '转写中...' : '等待转写'}
                        </span>
                      </div>
                    </div>
                  ))}
                  {items.length === 0 && (
                    <div className="p-4 text-sm text-white/40 text-center">上传音视频文件开始</div>
                  )}
                </div>
              </GlassCard>

              {/* 转写详情 + 操作区 */}
              <div className="flex-1 flex flex-col gap-4 min-w-0">
                {!selectedItem ? (
                  <GlassCard className="flex-1 flex items-center justify-center text-white/40 text-sm">
                    选择一个素材查看转写结果
                  </GlassCard>
                ) : selectedItem.transcribeStatus !== 'completed' ? (
                  <GlassCard className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      {selectedItem.transcribeStatus === 'failed' ? (
                        <p className="text-red-400">{selectedItem.transcribeError ?? '转写失败'}</p>
                      ) : (
                        <>
                          <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin text-white/40" />
                          <p className="text-white/40 text-sm">正在转写中，请稍候...</p>
                        </>
                      )}
                    </div>
                  </GlassCard>
                ) : (
                  <>
                    {/* 转写结果 */}
                    <GlassCard className="flex-1 overflow-y-auto p-4">
                      <div className="text-sm font-medium mb-3">转写结果</div>
                      <div className="space-y-1">
                        {selectedItem.segments?.map((seg, i) => (
                          <div key={i} className="flex gap-3 py-1 hover:bg-white/5 rounded px-2 -mx-2 group text-sm">
                            <span className="text-white/30 font-mono text-xs shrink-0 pt-0.5 w-12">
                              {formatTime(seg.start)}
                            </span>
                            <span className="text-white/80">{seg.text}</span>
                          </div>
                        ))}
                      </div>
                    </GlassCard>

                    {/* 操作栏：模板转文案 + 导出 */}
                    <GlassCard className="p-4">
                      <div className="flex items-start gap-6">
                        {/* 模板转文案 */}
                        <div className="flex-1">
                          <div className="text-sm font-medium mb-2 flex items-center gap-2">
                            <FileText className="w-4 h-4" /> 模板转文案
                          </div>
                          <div className="flex gap-2">
                            <select
                              className="flex-1 px-2 py-1.5 text-sm rounded bg-white/5 border border-white/10 outline-none"
                              value={selectedTemplateId}
                              onChange={e => setSelectedTemplateId(e.target.value)}
                            >
                              <option value="">选择模板...</option>
                              {templates.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                            <Button size="sm" onClick={handleCopywrite}
                              disabled={!selectedTemplateId || generating}>
                              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : '生成'}
                            </Button>
                          </div>
                          {copywriteResult && (
                            <pre className="mt-2 p-3 text-xs bg-white/5 rounded max-h-40 overflow-y-auto whitespace-pre-wrap">
                              {copywriteResult}
                            </pre>
                          )}
                        </div>

                        {/* 导出 */}
                        <div className="shrink-0">
                          <div className="text-sm font-medium mb-2 flex items-center gap-2">
                            <Download className="w-4 h-4" /> 导出
                          </div>
                          <div className="flex flex-col gap-1.5 text-xs">
                            {[
                              { key: 'timestamped', label: '带时间戳文本' },
                              { key: 'txt', label: '纯文本' },
                              { key: 'srt', label: 'SRT 字幕' },
                            ].map(({ key, label }) => (
                              <label key={key} className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={exportFormats.has(key)}
                                  onChange={() => toggleFormat(key)}
                                  className="rounded" />
                                {label}
                              </label>
                            ))}
                          </div>
                          <Button size="sm" className="mt-2 w-full" onClick={handleExport}
                            disabled={exportFormats.size === 0 || exporting}>
                            {exporting ? '导出中...' : '批量导出'}
                          </Button>
                        </div>
                      </div>
                    </GlassCard>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
