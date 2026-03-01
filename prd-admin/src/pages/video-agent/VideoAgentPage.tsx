import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { WorkflowProgressBar } from '@/components/ui/WorkflowProgressBar';
import { cn } from '@/lib/cn';
import {
  Upload,
  Sparkles,
  Settings,
  FileText,
  RefreshCw,
  Download,
  DownloadCloud,
  Video,
  Loader2,
  Play,
  X,
  ImageIcon,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  createVideoGenRunReal,
  listVideoGenRunsReal,
  getVideoGenRunReal,
  cancelVideoGenRunReal,
  updateVideoSceneReal,
  regenerateVideoSceneReal,
  triggerVideoRenderReal,
  generateScenePreviewReal,
  generateSceneBgImageReal,
  getVideoGenStreamUrl,
  getVideoGenDownloadUrl,
} from '@/services/real/videoAgent';
import type { VideoGenRun, VideoGenRunListItem } from '@/services/contracts/videoAgent';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ─── Types ───

type WorkflowPhase = 0 | 1 | 2; // 0=upload, 1=preview/editing, 2=scenesGenerated

// ─── Constants ───

const SCENE_TYPE_LABELS: Record<string, string> = {
  intro: '开场', concept: '概念', steps: '步骤', code: '代码',
  comparison: '对比', diagram: '图表', summary: '总结', outro: '结尾',
};

const ACTIVE_STATUSES = ['Queued', 'Scripting', 'Rendering'];

const PRD_MD_STYLE = `
  .prd-md { font-size: 14px; line-height: 1.72; color: var(--text-secondary); white-space: normal; word-break: break-word; }
  .prd-md h1,.prd-md h2,.prd-md h3 { color: var(--text-primary); font-weight: 700; margin: 16px 0 10px; }
  .prd-md h1 { font-size: 20px; letter-spacing: 0.2px; }
  .prd-md h2 { font-size: 17px; }
  .prd-md h3 { font-size: 15px; }
  .prd-md p { margin: 10px 0; }
  .prd-md ul,.prd-md ol { margin: 10px 0; padding-left: 18px; }
  .prd-md li { margin: 6px 0; }
  .prd-md hr { border: 0; border-top: 1px solid var(--border-default); margin: 14px 0; }
  .prd-md blockquote { margin: 12px 0; padding: 8px 12px; border-left: 3px solid rgba(236,72,153,0.35); background: rgba(236,72,153,0.06); color: rgba(236,72,153,0.92); border-radius: 10px; }
  .prd-md a { color: rgba(147, 197, 253, 0.95); text-decoration: underline; }
  .prd-md img { max-width: 100%; border-radius: 8px; margin: 8px 0; }
  .prd-md code { font-size: 13px; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; }
  .prd-md pre { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px; overflow-x: auto; margin: 8px 0; }
  .prd-md pre code { background: none; padding: 0; }
`;

const phaseSteps = [
  { key: 0, label: '上传文章' },
  { key: 1, label: '生成分镜' },
  { key: 2, label: '分镜编辑' },
];

// ─── PanelCard ───

const panelCardStyle: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border-default)',
  boxShadow: 'var(--shadow-card)',
};

const PanelCard = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <GlassCard
    variant="subtle"
    padding="sm"
    className={cn('rounded-[16px]', className)}
    style={panelCardStyle}
  >
    {children}
  </GlassCard>
);

// ─── Config pills style ───

const configPillBaseClass = 'flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs cursor-pointer transition-colors';
const configPillTextClass = 'truncate flex-1';

/**
 * 视频 Agent 页面 —— 借鉴文学创作的交互模式
 * 流程：文章上传 → 预览 → 分镜标记生成 → 逐条编辑/重试/预览图 → 导出
 */
export const VideoAgentPage: React.FC = () => {
  const token = useAuthStore((s) => s.token);
  const { isMobile } = useBreakpoint();

  // ─── Workflow state ───
  const [phase, setPhase] = useState<WorkflowPhase>(0);
  const [mobileTab, setMobileTab] = useState<'article' | 'scenes'>('article');

  // ─── Input state ───
  const [articleContent, setArticleContent] = useState('');
  const [articleTitle, setArticleTitle] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Config state ───
  const [systemPrompt, setSystemPrompt] = useState('');
  const [styleDescription, setStyleDescription] = useState('');

  // ─── Run state ───
  const [runs, setRuns] = useState<VideoGenRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<VideoGenRun | null>(null);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ─── Scene editing state ───
  const [editingNarrations, setEditingNarrations] = useState<Record<number, string>>({});

  // ─── Streaming state (real-time thinking + text output) ───
  const [streamingThinking, setStreamingThinking] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const streamEndRef = useRef<HTMLDivElement>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sceneListRef = useRef<HTMLDivElement>(null);

  // ─── Computed ───
  const isEditing = selectedRun?.status === 'Editing';
  const isActive = selectedRun && ACTIVE_STATUSES.includes(selectedRun.status);
  const isCompleted = selectedRun?.status === 'Completed';
  const isBusy = creating || !!isActive;
  const scenesReady = selectedRun?.scenes.filter((s) => s.imageStatus === 'done').length ?? 0;
  const scenesTotal = selectedRun?.scenes.length ?? 0;

  // ─── Phase calculation ───
  useEffect(() => {
    if (!selectedRun) {
      setPhase(0);
    } else if (selectedRun.status === 'Editing' || selectedRun.status === 'Completed') {
      setPhase(2);
    } else if (ACTIVE_STATUSES.includes(selectedRun.status)) {
      setPhase(1);
    }
  }, [selectedRun?.status]);

  // ─── Load runs ───
  const loadRuns = useCallback(async () => {
    try {
      const res = await listVideoGenRunsReal({ limit: 20 });
      if (res.success) setRuns(res.data.items);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // ─── Load run detail ───
  const loadDetail = useCallback(async (runId: string) => {
    try {
      const res = await getVideoGenRunReal(runId);
      if (res.success) {
        setSelectedRun(res.data);
        setEditingNarrations({});
        // Restore article content for preview
        if (res.data.articleMarkdown) {
          setArticleContent(res.data.articleMarkdown);
          setArticleTitle(res.data.articleTitle || '');
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (selectedRunId) {
      loadDetail(selectedRunId);
    } else {
      setSelectedRun(null);
    }
    // 切换任务时重置流式状态
    setStreamingThinking('');
    setStreamingText('');
  }, [selectedRunId, loadDetail]);

  // ─── SSE / Polling ───

  // 是否有需要轮询的分镜（Generating 或 imageStatus=running 或 backgroundImageStatus=running）
  const needsScenePolling = selectedRun?.status === 'Editing' && selectedRun.scenes.some(
    (s) => s.status === 'Generating' || s.imageStatus === 'running' || s.backgroundImageStatus === 'running'
  );

  useEffect(() => {
    if (!selectedRunId || !selectedRun) return;
    const status = selectedRun.status;

    if (ACTIVE_STATUSES.includes(status)) {
      const url = getVideoGenStreamUrl(selectedRunId);
      const fullUrl = `${import.meta.env.VITE_API_BASE_URL || ''}${url}`;
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
          let currentEvent = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
              if (line.startsWith('data: ')) {
                try {
                  const payload = JSON.parse(line.slice(6));
                  if (currentEvent === 'phase.changed' && payload.phase) {
                    setSelectedRun((prev) => prev
                      ? { ...prev, currentPhase: payload.phase, phaseProgress: payload.progress ?? 0 }
                      : prev);
                  }
                  if (currentEvent === 'render.progress' && payload.percent !== undefined) {
                    setSelectedRun((prev) => prev ? { ...prev, phaseProgress: payload.percent } : prev);
                  }
                  if (currentEvent === 'thinking.delta' && payload.content) {
                    setStreamingThinking((prev) => prev + payload.content);
                  }
                  if (currentEvent === 'text.delta' && payload.content) {
                    setStreamingText((prev) => prev + payload.content);
                  }
                  if (currentEvent === 'scene.added' && payload.scene) {
                    // 流式分镜：实时追加新分镜到列表
                    setSelectedRun((prev) => {
                      if (!prev) return prev;
                      const newScene = {
                        ...payload.scene,
                        imageStatus: payload.scene.imageStatus || 'idle',
                        backgroundImageStatus: payload.scene.backgroundImageStatus || 'idle',
                      };
                      const exists = prev.scenes.some((s) => s.index === newScene.index);
                      if (exists) return prev;
                      return {
                        ...prev,
                        scenes: [...prev.scenes, newScene],
                        phaseProgress: Math.min(20 + (prev.scenes.length + 1) * 7, 90),
                      };
                    });
                  }
                  if (currentEvent === 'script.done') {
                    setStreamingThinking('');
                    setStreamingText('');
                    if (selectedRunId) loadDetail(selectedRunId);
                    loadRuns();
                  }
                  if (currentEvent === 'scene.regenerated' || currentEvent === 'scene.error') {
                    if (selectedRunId) loadDetail(selectedRunId);
                  }
                  if (['run.completed', 'run.error', 'run.cancelled'].includes(currentEvent)) {
                    setTimeout(() => { loadRuns(); if (selectedRunId) loadDetail(selectedRunId); }, 500);
                  }
                } catch { /* parse error */ }
              }
            }
          }
        } catch { /* abort */ }
      };

      connectSSE();
      return () => { abortController.abort(); };
    }

    if (needsScenePolling) {
      pollingRef.current = setInterval(async () => {
        if (selectedRunId) {
          try {
            const res = await getVideoGenRunReal(selectedRunId);
            if (res.success) setSelectedRun(res.data);
          } catch { /* ignore */ }
        }
      }, 2000);
      return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, selectedRun?.status, needsScenePolling, token, loadRuns, loadDetail]);

  // ─── Auto-scroll streaming content ───
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamingThinking, streamingText]);

  // ─── Background polling: keep runs list fresh when active runs exist ───
  useEffect(() => {
    const hasActiveRuns = runs.some((r) => ACTIVE_STATUSES.includes(r.status));
    if (!hasActiveRuns) return;

    const timer = setInterval(async () => {
      try {
        const res = await listVideoGenRunsReal({ limit: 20 });
        if (res.success) setRuns(res.data.items);
      } catch { /* ignore */ }
    }, 5000);

    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.map((r) => `${r.id}:${r.status}`).join(',')]);

  // ─── File upload handler ───
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      setArticleContent(text);
      if (!articleTitle) {
        // Auto-extract title from first heading
        const match = text.match(/^#\s+(.+)/m);
        if (match) setArticleTitle(match[1]);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset
  };

  // ─── Create run ───
  const handleCreate = async () => {
    if (!articleContent.trim()) {
      toast.warning('缺少文章内容', '请先上传或粘贴文章');
      return;
    }
    setCreating(true);
    try {
      const res = await createVideoGenRunReal({
        articleMarkdown: articleContent,
        articleTitle: articleTitle || undefined,
        systemPrompt: systemPrompt || undefined,
        styleDescription: styleDescription || undefined,
      });
      if (res.success) {
        toast.success('已提交', '正在生成分镜脚本...');
        setSelectedRunId(res.data.runId);
        await loadRuns();
      } else {
        toast.error('创建失败', (res as { message?: string }).message || '服务器返回失败');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '网络请求失败';
      toast.error('请求异常', msg);
      console.error('[VideoAgent] createRun error:', err);
    } finally { setCreating(false); }
  };

  // ─── Cancel run ───
  const handleCancel = async () => {
    if (!selectedRunId) return;
    try {
      await cancelVideoGenRunReal(selectedRunId);
      await loadRuns();
      loadDetail(selectedRunId);
    } catch (err) {
      console.error('[VideoAgent] cancel error:', err);
      toast.error('取消失败', err instanceof Error ? err.message : '请求异常');
    }
  };

  // ─── Update scene narration ───
  const handleSaveScene = async (sceneIndex: number) => {
    if (!selectedRunId || !selectedRun) return;
    const newNarration = editingNarrations[sceneIndex];
    const scene = selectedRun.scenes[sceneIndex];
    if (!scene || newNarration === undefined || newNarration === scene.narration) return;

    try {
      const res = await updateVideoSceneReal(selectedRunId, sceneIndex, { narration: newNarration });
      if (res.success) loadDetail(selectedRunId);
    } catch { /* ignore */ }
  };

  // ─── Regenerate scene ───
  const handleRegenerateScene = async (sceneIndex: number) => {
    if (!selectedRunId) return;
    try {
      await regenerateVideoSceneReal(selectedRunId, sceneIndex);
      setSelectedRun((prev) => {
        if (!prev) return prev;
        const scenes = [...prev.scenes];
        scenes[sceneIndex] = { ...scenes[sceneIndex], status: 'Generating', errorMessage: undefined };
        return { ...prev, scenes };
      });
    } catch (err) {
      console.error('[VideoAgent] regenerateScene error:', err);
      toast.error('重试失败', err instanceof Error ? err.message : '请求异常');
    }
  };

  // ─── Preview video generation (Remotion) ───
  const handleGeneratePreview = async (sceneIndex: number) => {
    if (!selectedRunId || !selectedRun) return;

    // Optimistic UI: mark scene as rendering
    setSelectedRun((prev) => {
      if (!prev) return prev;
      const scenes = [...prev.scenes];
      scenes[sceneIndex] = { ...scenes[sceneIndex], imageStatus: 'running', imageUrl: undefined };
      return { ...prev, scenes };
    });

    try {
      const res = await generateScenePreviewReal(selectedRunId, sceneIndex);
      if (!res.success) {
        setSelectedRun((prev) => {
          if (!prev) return prev;
          const scenes = [...prev.scenes];
          scenes[sceneIndex] = { ...scenes[sceneIndex], imageStatus: 'error' };
          return { ...prev, scenes };
        });
        toast.error('渲染失败', '无法启动分镜渲染');
      }
      // Worker picks up the rendering; polling will detect completion
    } catch (err) {
      setSelectedRun((prev) => {
        if (!prev) return prev;
        const scenes = [...prev.scenes];
        if (scenes[sceneIndex]?.imageStatus === 'running') {
          scenes[sceneIndex] = { ...scenes[sceneIndex], imageStatus: 'error' };
        }
        return { ...prev, scenes };
      });
      toast.error('请求异常', err instanceof Error ? err.message : '网络错误');
    }
  };

  const handleBatchGeneratePreviews = () => {
    if (!selectedRun) return;
    selectedRun.scenes.forEach((scene, idx) => {
      if (scene.imageStatus !== 'running') handleGeneratePreview(idx);
    });
  };

  // ─── Generate background image (AI) ───
  const handleGenerateBgImage = async (sceneIndex: number) => {
    if (!selectedRunId || !selectedRun) return;

    // Optimistic UI
    setSelectedRun((prev) => {
      if (!prev) return prev;
      const scenes = [...prev.scenes];
      scenes[sceneIndex] = { ...scenes[sceneIndex], backgroundImageStatus: 'running', backgroundImageUrl: undefined };
      return { ...prev, scenes };
    });

    try {
      const res = await generateSceneBgImageReal(selectedRunId, sceneIndex);
      if (!res.success) {
        setSelectedRun((prev) => {
          if (!prev) return prev;
          const scenes = [...prev.scenes];
          scenes[sceneIndex] = { ...scenes[sceneIndex], backgroundImageStatus: 'error' };
          return { ...prev, scenes };
        });
        toast.error('生图失败', '无法启动背景图生成');
      }
    } catch (err) {
      setSelectedRun((prev) => {
        if (!prev) return prev;
        const scenes = [...prev.scenes];
        if (scenes[sceneIndex]?.backgroundImageStatus === 'running') {
          scenes[sceneIndex] = { ...scenes[sceneIndex], backgroundImageStatus: 'error' };
        }
        return { ...prev, scenes };
      });
      toast.error('请求异常', err instanceof Error ? err.message : '网络错误');
    }
  };

  const handleBatchGenerateBgImages = () => {
    if (!selectedRun) return;
    selectedRun.scenes.forEach((scene, idx) => {
      if (scene.backgroundImageStatus !== 'running') handleGenerateBgImage(idx);
    });
  };

  // ─── Export ───
  const handleExport = async () => {
    if (!selectedRunId) return;
    setExporting(true);
    try {
      const res = await triggerVideoRenderReal(selectedRunId);
      if (res.success) { await loadRuns(); loadDetail(selectedRunId); }
      else { toast.error('导出失败', (res as { message?: string }).message || '服务器返回失败'); }
    } catch (err) {
      console.error('[VideoAgent] export error:', err);
      toast.error('导出异常', err instanceof Error ? err.message : '请求异常');
    } finally { setExporting(false); }
  };

  // ─── Step click handler ───
  const handleStepClick = (stepKey: number) => {
    if (isBusy) return;
    if (stepKey === 0 && !selectedRun) setPhase(0);
  };

  // ─── Active button (depends on phase) ───
  const activeButton = (() => {
    if ((phase === 0 || phase === 1) && !selectedRun) {
      return { label: '生成分镜标记', icon: Sparkles, action: handleCreate, disabled: !articleContent.trim() };
    }
    if (isEditing) {
      return { label: exporting ? '渲染中...' : '导出视频', icon: Video, action: handleExport, disabled: exporting };
    }
    return null;
  })();

  // ─── New task handler ───
  const handleNewTask = () => {
    setSelectedRunId(null);
    setSelectedRun(null);
    setArticleContent('');
    setArticleTitle('');
    setUploadedFileName(null);
    setPhase(0);
  };

  return (
    <div
      className="h-full min-h-0 flex flex-col"
      style={{ background: 'var(--bg-base)' }}
    >
      <style>{PRD_MD_STYLE}</style>

      {/* Mobile tabs */}
      {isMobile && (
        <div className="flex-shrink-0 flex rounded-lg overflow-hidden mx-3 mt-3" style={{ border: '1px solid var(--border-default)' }}>
          <button
            className={cn('flex-1 px-4 py-2 text-sm font-medium transition-colors', mobileTab === 'article' ? 'bg-white/10' : '')}
            style={{ color: mobileTab === 'article' ? 'var(--text-primary)' : 'var(--text-muted)' }}
            onClick={() => setMobileTab('article')}
          >
            文章预览
          </button>
          <button
            className={cn('flex-1 px-4 py-2 text-sm font-medium transition-colors', mobileTab === 'scenes' ? 'bg-white/10' : '')}
            style={{ color: mobileTab === 'scenes' ? 'var(--text-primary)' : 'var(--text-muted)' }}
            onClick={() => setMobileTab('scenes')}
          >
            分镜工作台
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-4 p-4 overflow-hidden">
        {/* ═══ LEFT PANEL: Article Preview ═══ */}
        <div className={cn('flex-1 min-w-0 flex flex-col gap-4', isMobile && mobileTab !== 'article' && 'hidden')}>
          <GlassCard
            variant="subtle"
            padding="sm"
            className="flex-1 min-h-0 flex flex-col rounded-[16px]"
            style={panelCardStyle}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 mb-3 flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <FileText size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {uploadedFileName || articleTitle || '文章内容'}
                </span>
                {articleContent && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                    {articleContent.length} 字符
                  </span>
                )}
              </div>
              {phase > 0 && !isActive && (
                <button
                  className="text-[11px] px-2.5 py-1 rounded-md hover:bg-white/10 transition-colors flex-shrink-0 border"
                  style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
                  onClick={handleNewTask}
                >
                  新建任务
                </button>
              )}
            </div>

            {/* Content area */}
            <div className="flex-1 min-h-0 overflow-auto">
              {phase === 0 ? (
                /* Upload / Input phase — textarea always visible */
                <div className="h-full flex flex-col gap-4 p-2">
                  {/* File upload button */}
                  <div className="flex items-center gap-3">
                    <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                      <Upload size={14} />
                      选择文件
                    </Button>
                    {uploadedFileName && (
                      <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                        {uploadedFileName}
                      </span>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".md,.txt,.markdown"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </div>
                  {/* Article content textarea — always visible, won't unmount */}
                  <textarea
                    placeholder="粘贴 Markdown 文章内容，或点击上方按钮选择文件..."
                    value={articleContent}
                    onChange={(e) => setArticleContent(e.target.value)}
                    className="flex-1 w-full rounded-[14px] px-3 py-2.5 text-sm outline-none resize-none prd-field"
                    style={{ minHeight: 200 }}
                  />
                </div>
              ) : selectedRun && (selectedRun.status === 'Scripting' || selectedRun.status === 'Queued') ? (
                /* Streaming display — 实时显示思考过程和 LLM 输出 */
                <div className="h-full flex flex-col">
                  {/* Header bar */}
                  <div className="flex items-center gap-2 mb-2 flex-shrink-0">
                    <Loader2 size={14} className="animate-spin" style={{ color: 'rgba(236, 72, 153, 0.7)' }} />
                    <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                      {streamingText
                        ? 'AI 正在输出分镜脚本...'
                        : streamingThinking
                          ? 'AI 正在思考...'
                          : '排队等待中...'}
                    </span>
                    <div className="flex-1" />
                    <Button variant="secondary" size="xs" onClick={handleNewTask}>返回</Button>
                    <Button variant="secondary" size="xs" onClick={handleCancel}>
                      <X size={12} />
                      取消
                    </Button>
                  </div>

                  {/* Streaming content */}
                  <div className="flex-1 min-h-0 overflow-auto space-y-2">
                    {streamingThinking && (
                      <div>
                        <div className="text-[11px] font-medium mb-1 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                          <Sparkles size={10} />
                          思考过程
                        </div>
                        <div
                          className="text-xs leading-relaxed whitespace-pre-wrap rounded-lg p-3 max-h-[45vh] overflow-auto"
                          style={{ background: 'rgba(147, 197, 253, 0.06)', border: '1px solid rgba(147, 197, 253, 0.12)', color: 'var(--text-secondary)' }}
                        >
                          {streamingThinking}
                        </div>
                      </div>
                    )}
                    {streamingText && (
                      <div>
                        <div className="text-[11px] font-medium mb-1 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                          <FileText size={10} />
                          输出内容
                        </div>
                        <div
                          className="text-xs leading-relaxed whitespace-pre-wrap rounded-lg p-3 font-mono max-h-[45vh] overflow-auto"
                          style={{ background: 'rgba(236, 72, 153, 0.04)', border: '1px solid rgba(236, 72, 153, 0.1)', color: 'var(--text-secondary)' }}
                        >
                          {streamingText}
                        </div>
                      </div>
                    )}
                    {!streamingThinking && !streamingText && (
                      <div className="flex flex-col items-center justify-center h-32 gap-2">
                        <Loader2 size={24} className="animate-spin" style={{ color: 'rgba(236, 72, 153, 0.4)' }} />
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>等待模型响应...</span>
                      </div>
                    )}
                    <div ref={streamEndRef} />
                  </div>
                </div>
              ) : (
                /* Article preview (markdown render) */
                <div className="prd-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {articleContent}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            {/* History list at bottom */}
            {runs.length > 0 && (
              <div className="flex-shrink-0 mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>历史任务</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{runs.length} 个</span>
                </div>
                <div className="max-h-[120px] overflow-auto space-y-1">
                  {runs.map((run) => (
                    <button
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className="w-full rounded-lg p-2 text-left text-xs transition-colors"
                      style={{
                        background: selectedRunId === run.id ? 'rgba(236, 72, 153, 0.08)' : 'transparent',
                        border: selectedRunId === run.id ? '1px solid rgba(236, 72, 153, 0.2)' : '1px solid transparent',
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {ACTIVE_STATUSES.includes(run.status) && (
                            <Loader2 size={12} className="animate-spin flex-shrink-0" style={{ color: 'rgba(236, 72, 153, 0.7)' }} />
                          )}
                          <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                            {run.articleTitle || `任务 ${run.id.slice(0, 8)}`}
                          </span>
                        </div>
                        <RunStatusBadge status={run.status} />
                      </div>
                      <div className="mt-0.5 flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                        <span>{new Date(run.createdAt).toLocaleString('zh-CN')}</span>
                        {run.scenesCount > 0 && <span>{run.scenesReady}/{run.scenesCount} 镜头</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </GlassCard>
        </div>

        {/* ═══ RIGHT PANEL: Workflow + Scene List ═══ */}
        <div className={cn('flex flex-col gap-3', isMobile ? 'w-full' : 'w-[520px] flex-shrink-0', isMobile && mobileTab !== 'scenes' && 'hidden')}>
          {/* Top: Workflow progress + Config */}
          <PanelCard>
            <WorkflowProgressBar
              steps={phaseSteps}
              currentStep={phase}
              onStepClick={handleStepClick}
              disabled={isBusy}
              allCompleted={
                phase === 2 &&
                scenesTotal > 0 &&
                selectedRun?.scenes.every((s) => s.imageStatus === 'done') === true
              }
            />

            {/* Active button */}
            {activeButton && (
              <Button
                variant="primary"
                className="w-full"
                onClick={() => void activeButton.action()}
                disabled={isBusy || activeButton.disabled}
              >
                <activeButton.icon size={16} />
                {isBusy && !exporting ? '生成中...' : activeButton.label}
              </Button>
            )}

            {/* Config pills: 齿轮 | 提示词 | 风格 | 配置按钮 */}
            <div className="mt-3 pt-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <Settings size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />

              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                {/* 系统提示词 pill */}
                <div
                  className={configPillBaseClass}
                  style={{
                    background: systemPrompt ? 'rgba(147, 197, 253, 0.08)' : 'var(--nested-block-bg)',
                    border: systemPrompt ? '1px solid rgba(147, 197, 253, 0.15)' : '1px solid var(--border-subtle)',
                  }}
                  title={systemPrompt || '自定义LLM提示词（点击编辑）'}
                >
                  <FileText size={12} style={{ color: systemPrompt ? '#93C5FD' : '#9CA3AF', flexShrink: 0 }} />
                  <span className={configPillTextClass} style={{ color: systemPrompt ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {systemPrompt ? '提示词' : '自动风格'}
                  </span>
                </div>

                {/* 风格描述 pill */}
                <div
                  className={configPillBaseClass}
                  style={{
                    background: styleDescription ? 'rgba(192, 132, 252, 0.08)' : 'var(--nested-block-bg)',
                    border: styleDescription ? '1px solid rgba(192, 132, 252, 0.15)' : '1px solid var(--border-subtle)',
                  }}
                  title={styleDescription || '视觉风格描述（点击编辑）'}
                >
                  <Video size={12} style={{ color: styleDescription ? '#C084FC' : '#9CA3AF', flexShrink: 0 }} />
                  <span className={configPillTextClass} style={{ color: styleDescription ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {styleDescription ? '风格' : '风格'}
                  </span>
                </div>
              </div>

              {/* Config button */}
              <button
                type="button"
                className="text-[11px] px-2.5 py-1 rounded-md hover:bg-white/10 transition-colors flex-shrink-0 border"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
                onClick={() => {
                  // TODO: Open full config dialog like literary-agent
                  toast.info('配置', '配置面板开发中');
                }}
                title="打开全部配置"
              >
                配置
              </button>
            </div>

            {/* Inline config inputs (simple version before config dialog is implemented) */}
            {!selectedRun && (
              <div className="mt-3 space-y-2">
                <div>
                  <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>视频标题</label>
                  <input
                    type="text"
                    value={articleTitle}
                    onChange={(e) => setArticleTitle(e.target.value)}
                    placeholder="可选，自动从文章提取"
                    className="w-full rounded-[10px] px-2.5 py-1.5 text-[12px] outline-none prd-field"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>系统提示词</label>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="旁白语言活泼轻松，面向初学者..."
                    rows={2}
                    className="w-full rounded-[10px] px-2.5 py-1.5 text-[12px] outline-none resize-none prd-field"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>风格描述</label>
                  <textarea
                    value={styleDescription}
                    onChange={(e) => setStyleDescription(e.target.value)}
                    placeholder="科技感、深色背景、霓虹色系..."
                    rows={2}
                    className="w-full rounded-[10px] px-2.5 py-1.5 text-[12px] outline-none resize-none prd-field"
                  />
                </div>
              </div>
            )}
          </PanelCard>

          {/* Scene list (visible when scenes exist — including during streaming) */}
          {selectedRun && selectedRun.scenes.length > 0 && phase >= 1 && (
            <PanelCard className="flex-1 min-h-0 flex flex-col">
              {/* Compact title bar */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>分镜标记</span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                  >
                    {scenesReady}/{scenesTotal}
                  </span>
                  {selectedRun?.status === 'Scripting' && (
                    <span className="flex items-center gap-1 text-[10px]" style={{ color: 'rgba(236, 72, 153, 0.8)' }}>
                      <Loader2 size={10} className="animate-spin" />
                      生成中...
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={!isEditing || scenesTotal === 0}
                    onClick={handleBatchGenerateBgImages}
                    title="批量 AI 生成背景图"
                  >
                    <ImageIcon size={12} />
                    生成背景图
                  </Button>
                  <Button
                    size="xs"
                    variant="primary"
                    disabled={!isEditing || scenesTotal === 0}
                    onClick={handleBatchGeneratePreviews}
                    title="批量渲染分镜视频"
                  >
                    <Sparkles size={12} />
                    渲染
                  </Button>
                  {isCompleted && selectedRun.videoAssetUrl && (
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => window.open(selectedRun.videoAssetUrl!, '_blank')}
                      title="下载视频"
                    >
                      <DownloadCloud size={12} />
                      下载
                    </Button>
                  )}
                </div>
              </div>

              {/* Scene cards */}
              <div ref={sceneListRef} className="flex-1 min-h-0 overflow-auto space-y-1.5">
                {selectedRun.scenes.map((scene, idx) => {
                  const statusLabel =
                    scene.status === 'Generating' ? '生成中'
                    : scene.status === 'Done' ? '完成'
                    : scene.status === 'Error' ? '失败'
                    : '等待';

                  const showPlaceholder = scene.imageStatus === 'running';
                  const canShow = Boolean(scene.imageUrl) && scene.imageStatus === 'done';
                  const hasVideo = Boolean(scene.imageUrl);
                  const genLabel = hasVideo ? '重新渲染' : '渲染分镜';

                  const narration = editingNarrations[idx] ?? scene.narration;

                  return (
                    <div
                      key={scene.index}
                      className="p-2.5 rounded"
                      style={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-subtle)',
                        position: 'relative',
                      }}
                    >
                      {/* Header row */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                            镜头 {idx + 1}
                          </span>
                          <span
                            className="text-[10px] px-1 py-0.5 rounded"
                            style={{ background: 'rgba(236, 72, 153, 0.1)', color: 'rgba(236, 72, 153, 0.8)' }}
                          >
                            {SCENE_TYPE_LABELS[scene.sceneType] || scene.sceneType}
                          </span>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {scene.durationSeconds.toFixed(1)}s
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Status badge */}
                          <div
                            className="text-[11px] px-2 py-0.5 rounded-full font-semibold"
                            style={{
                              background:
                                scene.status === 'Done'
                                  ? 'rgba(34, 197, 94, 0.12)'
                                  : scene.status === 'Error'
                                    ? 'rgba(239, 68, 68, 0.12)'
                                    : scene.status === 'Generating'
                                      ? 'rgba(250, 204, 21, 0.12)'
                                      : 'var(--bg-input-hover)',
                              border:
                                scene.status === 'Done'
                                  ? '1px solid rgba(34, 197, 94, 0.28)'
                                  : scene.status === 'Error'
                                    ? '1px solid rgba(239, 68, 68, 0.28)'
                                    : scene.status === 'Generating'
                                      ? '1px solid rgba(250, 204, 21, 0.24)'
                                      : '1px solid var(--border-default)',
                              color:
                                scene.status === 'Done'
                                  ? 'rgba(34, 197, 94, 0.95)'
                                  : scene.status === 'Error'
                                    ? 'rgba(239, 68, 68, 0.95)'
                                    : scene.status === 'Generating'
                                      ? 'rgba(250, 204, 21, 0.95)'
                                      : 'var(--text-secondary)',
                            }}
                          >
                            {statusLabel}
                          </div>
                        </div>
                      </div>

                      {/* Error message */}
                      {scene.errorMessage && (
                        <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.92)' }}>
                          {scene.errorMessage}
                        </div>
                      )}

                      {/* Video preview box (16:9 aspect ratio) */}
                      <div
                        className="mt-1.5 rounded-[10px] overflow-hidden relative group"
                        style={{
                          aspectRatio: '16 / 9',
                          background: 'rgba(0,0,0,0.18)',
                          border: '1px solid var(--border-default)',
                        }}
                      >
                        {showPlaceholder ? (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                            <Loader2 size={28} className="animate-spin" style={{ color: 'rgba(236, 72, 153, 0.7)' }} />
                            <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.5)' }}>渲染中…</span>
                          </div>
                        ) : canShow ? (
                          <>
                            <video
                              src={scene.imageUrl!}
                              className="w-full h-full block"
                              style={{ objectFit: 'contain' }}
                              controls
                              preload="metadata"
                            />
                            {/* Download on hover */}
                            <div
                              className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                className="p-1.5 rounded-lg"
                                style={{ background: 'rgba(0, 0, 0, 0.6)', border: '1px solid rgba(255, 255, 255, 0.2)' }}
                                onClick={() => {
                                  const link = document.createElement('a');
                                  link.href = scene.imageUrl!;
                                  link.download = `镜头-${idx + 1}.mp4`;
                                  link.target = '_blank';
                                  link.click();
                                }}
                                title="下载分镜视频"
                              >
                                <DownloadCloud size={14} style={{ color: 'white' }} />
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                            <div
                              className="rounded-lg flex items-center justify-center"
                              style={{
                                width: 160,
                                height: 90,
                                background: 'var(--nested-block-bg)',
                                border: '1.5px dashed rgba(236, 72, 153, 0.3)',
                              }}
                            >
                              <Play size={18} style={{ opacity: 0.4 }} />
                            </div>
                          </div>
                        )}

                        {/* Render error overlay */}
                        {scene.imageStatus === 'error' && (
                          <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.1)' }}>
                            <span className="text-xs" style={{ color: 'rgba(239,68,68,0.9)' }}>渲染失败</span>
                          </div>
                        )}
                      </div>

                      {/* Background image row */}
                      <div className="mt-1.5 flex items-center gap-2">
                        {scene.backgroundImageStatus === 'running' ? (
                          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            <Loader2 size={12} className="animate-spin" style={{ color: 'rgba(147, 197, 253, 0.7)' }} />
                            <span>背景图生成中...</span>
                          </div>
                        ) : scene.backgroundImageStatus === 'done' && scene.backgroundImageUrl ? (
                          <div className="flex items-center gap-2">
                            <img
                              src={scene.backgroundImageUrl}
                              alt="背景图"
                              className="rounded"
                              style={{ width: 48, height: 27, objectFit: 'cover', border: '1px solid var(--border-subtle)' }}
                            />
                            <span className="text-[11px]" style={{ color: 'rgba(34,197,94,0.8)' }}>背景图已生成</span>
                          </div>
                        ) : scene.backgroundImageStatus === 'error' ? (
                          <span className="text-[11px]" style={{ color: 'rgba(239,68,68,0.8)' }}>背景图生成失败</span>
                        ) : (
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>无背景图</span>
                        )}
                      </div>

                      {/* Narration textarea */}
                      <textarea
                        value={narration}
                        onChange={(e) => {
                          setEditingNarrations((prev) => ({ ...prev, [idx]: e.target.value }));
                        }}
                        onBlur={() => {
                          if (editingNarrations[idx] !== undefined && editingNarrations[idx] !== scene.narration) {
                            handleSaveScene(idx);
                          }
                        }}
                        className="mt-1.5 w-full rounded-[10px] px-2.5 py-1.5 text-[12px] outline-none resize-none prd-field"
                        style={{ minHeight: 56 }}
                        placeholder="旁白台词（可编辑后右下角重新生成）"
                        disabled={scene.status === 'Generating'}
                      />

                      {/* Action buttons */}
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={scene.status === 'Generating'}
                          onClick={() => handleRegenerateScene(idx)}
                          title="AI 重新生成该镜头的分镜内容"
                        >
                          <RefreshCw size={14} />
                          重试
                        </Button>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={scene.backgroundImageStatus === 'running' || scene.status === 'Generating' || !isEditing}
                            onClick={() => handleGenerateBgImage(idx)}
                            title="AI 生成该镜头的背景图"
                          >
                            <ImageIcon size={14} />
                            背景图
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={scene.imageStatus === 'running' || scene.status === 'Generating' || !isEditing}
                            onClick={() => handleGeneratePreview(idx)}
                            title={hasVideo ? '重新渲染该分镜视频' : '渲染该分镜视频'}
                          >
                            <Sparkles size={14} />
                            {genLabel}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Help text */}
              <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                点击"生成"将批量渲染分镜视频；也可在单条卡片内编辑后逐条渲染
              </div>

              {/* Download area for completed runs */}
              {isCompleted && (
                <div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="text-xs font-semibold" style={{ color: 'rgba(34, 197, 94, 0.95)' }}>
                    视频已完成
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedRun.videoAssetUrl && (
                      <Button size="xs" variant="primary" onClick={() => window.open(selectedRun!.videoAssetUrl!, '_blank')}>
                        <Download size={12} />
                        下载 MP4
                      </Button>
                    )}
                    <DownloadButton runId={selectedRun.id} type="srt" label="SRT 字幕" />
                    <DownloadButton runId={selectedRun.id} type="narration" label="配音台词" />
                    <DownloadButton runId={selectedRun.id} type="script" label="视频脚本" />
                  </div>
                </div>
              )}
            </PanelCard>
          )}

          {/* Rendering progress (when in Rendering status) */}
          {selectedRun?.status === 'Rendering' && (
            <PanelCard>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" style={{ color: 'rgba(236, 72, 153, 0.7)' }} />
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    渲染视频中...
                  </span>
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span>渲染进度</span>
                    <span>{selectedRun.phaseProgress}%</span>
                  </div>
                  <div
                    className="h-1.5 w-full rounded-full overflow-hidden"
                    style={{ background: 'rgba(255,255,255,0.08)' }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${selectedRun.phaseProgress}%`,
                        background: 'linear-gradient(90deg, rgba(236, 72, 153, 0.8), rgba(236, 72, 153, 0.5))',
                      }}
                    />
                  </div>
                </div>
                <Button variant="secondary" size="xs" onClick={handleCancel}>
                  <X size={12} />
                  取消
                </Button>
              </div>
            </PanelCard>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Sub-components ───

const RunStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const config: Record<string, { label: string; bg: string; border: string; color: string }> = {
    Queued: { label: '排队', bg: 'var(--bg-input-hover)', border: 'var(--border-default)', color: 'var(--text-secondary)' },
    Scripting: { label: '生成中', bg: 'rgba(250, 204, 21, 0.12)', border: 'rgba(250, 204, 21, 0.24)', color: 'rgba(250, 204, 21, 0.95)' },
    Editing: { label: '编辑中', bg: 'rgba(236, 72, 153, 0.12)', border: 'rgba(236, 72, 153, 0.24)', color: 'rgba(236, 72, 153, 0.95)' },
    Rendering: { label: '渲染中', bg: 'rgba(251, 146, 60, 0.12)', border: 'rgba(251, 146, 60, 0.24)', color: 'rgba(251, 146, 60, 0.95)' },
    Completed: { label: '完成', bg: 'rgba(34, 197, 94, 0.12)', border: 'rgba(34, 197, 94, 0.28)', color: 'rgba(34, 197, 94, 0.95)' },
    Failed: { label: '失败', bg: 'rgba(239, 68, 68, 0.12)', border: 'rgba(239, 68, 68, 0.28)', color: 'rgba(239, 68, 68, 0.95)' },
    Cancelled: { label: '取消', bg: 'var(--bg-input-hover)', border: 'var(--border-default)', color: 'var(--text-secondary)' },
  };
  const c = config[status] ?? { label: status, bg: 'var(--bg-input-hover)', border: 'var(--border-default)', color: 'var(--text-secondary)' };
  return (
    <span
      className="text-[11px] px-2 py-0.5 rounded-full font-semibold"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.color }}
    >
      {c.label}
    </span>
  );
};

const DownloadButton: React.FC<{ runId: string; type: 'srt' | 'narration' | 'script'; label: string }> = ({ runId, type, label }) => {
  const token = useAuthStore((s) => s.token);

  const handleDownload = async () => {
    const url = getVideoGenDownloadUrl(runId, type);
    const fullUrl = `${import.meta.env.VITE_API_BASE_URL || ''}${url}`;
    try {
      const res = await fetch(fullUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${runId.slice(0, 8)}.${type === 'srt' ? 'srt' : 'md'}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { /* ignore */ }
  };

  return (
    <Button size="xs" variant="secondary" onClick={handleDownload}>
      <Download size={12} />
      {label}
    </Button>
  );
};
