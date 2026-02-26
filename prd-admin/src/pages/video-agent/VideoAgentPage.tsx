import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/authStore';
import {
  createVideoGenRunReal,
  listVideoGenRunsReal,
  getVideoGenRunReal,
  cancelVideoGenRunReal,
  getVideoGenStreamUrl,
  getVideoGenDownloadUrl,
} from '@/services/real/videoAgent';
import type { VideoGenRun, VideoGenRunListItem } from '@/services/contracts/videoAgent';
import { ScriptPreview } from './components/ScriptPreview';
import { RenderProgress } from './components/RenderProgress';

const ACTIVE_STATUSES = ['Queued', 'Scripting', 'Producing', 'Rendering', 'Packaging'];

export const VideoAgentPage: React.FC = () => {
  const token = useAuthStore((s) => s.token);

  // 左侧面板状态
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  // 任务列表
  const [runs, setRuns] = useState<VideoGenRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<VideoGenRun | null>(null);

  // SSE
  const eventSourceRef = useRef<EventSource | null>(null);

  // 加载任务列表
  const loadRuns = useCallback(async () => {
    try {
      const res = await listVideoGenRunsReal({ limit: 20 });
      if (res.success) {
        setRuns(res.data.items);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // 选中任务时加载详情
  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      return;
    }

    const loadDetail = async () => {
      try {
        const res = await getVideoGenRunReal(selectedRunId);
        if (res.success) {
          setSelectedRun(res.data);
        }
      } catch {
        // ignore
      }
    };

    loadDetail();
  }, [selectedRunId]);

  // SSE 连接
  useEffect(() => {
    if (!selectedRunId || !selectedRun) return;
    if (!ACTIVE_STATUSES.includes(selectedRun.status)) return;

    const url = getVideoGenStreamUrl(selectedRunId);
    const fullUrl = `${import.meta.env.VITE_API_BASE_URL || ''}${url}`;

    // 使用 fetch + ReadableStream 处理 SSE（带 auth header）
    const abortController = new AbortController();

    const connectSSE = async () => {
      try {
        const response = await fetch(fullUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const payload = JSON.parse(line.slice(6));
                // 更新进度
                if (payload.phase) {
                  setSelectedRun((prev) =>
                    prev ? { ...prev, currentPhase: payload.phase, phaseProgress: payload.progress ?? 0 } : prev
                  );
                }
                if (payload.percent !== undefined) {
                  setSelectedRun((prev) => (prev ? { ...prev, phaseProgress: payload.percent } : prev));
                }
                if (payload.scenes) {
                  setSelectedRun((prev) =>
                    prev
                      ? { ...prev, scenes: payload.scenes, totalDurationSeconds: payload.totalDuration ?? 0 }
                      : prev
                  );
                }
              } catch {
                // ignore parse errors
              }
            }
            if (line.startsWith('event: run.completed') || line.startsWith('event: run.error') || line.startsWith('event: run.cancelled')) {
              // 重新加载详情和列表
              setTimeout(() => {
                loadRuns();
                if (selectedRunId) {
                  getVideoGenRunReal(selectedRunId).then((res) => {
                    if (res.success) setSelectedRun(res.data);
                  });
                }
              }, 500);
            }
          }
        }
      } catch {
        // abort or network error
      }
    };

    connectSSE();

    return () => {
      abortController.abort();
    };
  }, [selectedRunId, selectedRun?.status, token, loadRuns]);

  // 创建任务
  const handleCreate = async () => {
    if (!markdown.trim()) return;
    setCreating(true);
    try {
      const res = await createVideoGenRunReal({
        articleMarkdown: markdown,
        articleTitle: title || undefined,
      });
      if (res.success) {
        setSelectedRunId(res.data.runId);
        setMarkdown('');
        setTitle('');
        await loadRuns();
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  // 取消任务
  const handleCancel = async () => {
    if (!selectedRunId) return;
    await cancelVideoGenRunReal(selectedRunId);
    await loadRuns();
  };

  const isActive = selectedRun && ACTIVE_STATUSES.includes(selectedRun.status);

  return (
    <div className="flex h-full gap-4 p-4">
      {/* 左侧面板 */}
      <div className="flex w-[400px] flex-shrink-0 flex-col gap-4">
        {/* 文章输入 */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">文章转视频</h3>
          <input
            type="text"
            placeholder="视频标题（可选）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <textarea
            placeholder="粘贴 Markdown 文章内容..."
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={10}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary resize-none"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !markdown.trim()}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? '创建中...' : '开始生成视频'}
          </button>
        </div>

        {/* 历史任务 */}
        <div className="flex-1 overflow-auto rounded-lg border border-border bg-card p-4 space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">历史任务</h3>
          {runs.length === 0 && (
            <div className="text-xs text-muted-foreground py-4 text-center">暂无任务</div>
          )}
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              className={`w-full rounded-md border p-3 text-left text-sm transition-colors ${
                selectedRunId === run.id
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/50 bg-background hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium truncate">
                  {run.articleTitle || `任务 ${run.id.slice(0, 8)}`}
                </span>
                <StatusBadge status={run.status} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {new Date(run.createdAt).toLocaleString('zh-CN')}
                {run.totalDurationSeconds > 0 && ` · ${(run.totalDurationSeconds / 60).toFixed(1)}min`}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 右侧详情面板 */}
      <div className="flex-1 overflow-auto rounded-lg border border-border bg-card p-6">
        {!selectedRun ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            选择一个任务查看详情，或创建新任务
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {selectedRun.articleTitle || `任务 ${selectedRun.id.slice(0, 8)}`}
              </h2>
              {isActive && (
                <button
                  onClick={handleCancel}
                  className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/5"
                >
                  取消
                </button>
              )}
            </div>

            {/* 进度 */}
            <RenderProgress
              currentPhase={selectedRun.currentPhase}
              phaseProgress={selectedRun.phaseProgress}
              status={selectedRun.status}
              errorMessage={selectedRun.errorMessage}
            />

            {/* 脚本预览 */}
            {selectedRun.scenes.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">脚本预览</h3>
                <ScriptPreview
                  scenes={selectedRun.scenes}
                  totalDuration={selectedRun.totalDurationSeconds}
                />
              </div>
            )}

            {/* 产出物下载 */}
            {selectedRun.status === 'Completed' && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">产出物</h3>
                <div className="flex flex-wrap gap-2">
                  {selectedRun.videoAssetUrl && (
                    <a
                      href={selectedRun.videoAssetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/20"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
                        <path d="M8 2v8m0 0L5 7m3 3l3-3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      下载 MP4
                    </a>
                  )}
                  <DownloadButton runId={selectedRun.id} type="srt" label="下载 SRT" />
                  <DownloadButton runId={selectedRun.id} type="narration" label="配音台词" />
                  <DownloadButton runId={selectedRun.id} type="script" label="视频脚本" />
                </div>
              </div>
            )}

            {/* 台词预览 */}
            {selectedRun.narrationDoc && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">配音台词</h3>
                <pre className="rounded-md bg-muted/50 p-4 text-xs text-muted-foreground whitespace-pre-wrap max-h-60 overflow-auto">
                  {selectedRun.narrationDoc}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** 状态标签 */
const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const config: Record<string, { label: string; className: string }> = {
    Queued: { label: '排队中', className: 'bg-muted text-muted-foreground' },
    Scripting: { label: '分析中', className: 'bg-blue-500/10 text-blue-500' },
    Producing: { label: '生成中', className: 'bg-purple-500/10 text-purple-500' },
    Rendering: { label: '渲染中', className: 'bg-orange-500/10 text-orange-500' },
    Packaging: { label: '打包中', className: 'bg-cyan-500/10 text-cyan-500' },
    Completed: { label: '已完成', className: 'bg-green-500/10 text-green-500' },
    Failed: { label: '失败', className: 'bg-destructive/10 text-destructive' },
    Cancelled: { label: '已取消', className: 'bg-muted text-muted-foreground' },
  };

  const c = config[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
};

/** 下载按钮 */
const DownloadButton: React.FC<{
  runId: string;
  type: 'srt' | 'narration' | 'script';
  label: string;
}> = ({ runId, type, label }) => {
  const token = useAuthStore((s) => s.token);

  const handleDownload = async () => {
    const url = getVideoGenDownloadUrl(runId, type);
    const fullUrl = `${import.meta.env.VITE_API_BASE_URL || ''}${url}`;
    try {
      const res = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${runId.slice(0, 8)}.${type === 'srt' ? 'srt' : 'md'}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      // ignore
    }
  };

  return (
    <button
      onClick={handleDownload}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/50"
    >
      {label}
    </button>
  );
};
