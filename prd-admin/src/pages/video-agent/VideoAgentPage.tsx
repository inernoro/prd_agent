import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/authStore';
import {
  createVideoGenRunReal,
  listVideoGenRunsReal,
  getVideoGenRunReal,
  cancelVideoGenRunReal,
  updateVideoSceneReal,
  regenerateVideoSceneReal,
  triggerVideoRenderReal,
  generateScenePreviewReal,
  updateScenePreviewReal,
  getVideoGenStreamUrl,
  getVideoGenDownloadUrl,
  getScenePreviewStreamUrl,
} from '@/services/real/videoAgent';
import type { VideoGenRun, VideoGenRunListItem } from '@/services/contracts/videoAgent';

const SCENE_TYPE_LABELS: Record<string, string> = {
  intro: '开场',
  concept: '概念',
  steps: '步骤',
  code: '代码',
  comparison: '对比',
  diagram: '图表',
  summary: '总结',
  outro: '结尾',
};

const ACTIVE_STATUSES = ['Queued', 'Scripting', 'Rendering'];

/**
 * 视频 Agent 页面 —— 交互式分镜编辑
 * 流程：文章输入 → 配置(提示词/风格) → 分镜生成 → 分镜编辑(可逐条重试) → 导出渲染
 */
export const VideoAgentPage: React.FC = () => {
  const token = useAuthStore((s) => s.token);

  // ─── 输入状态 ───
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [styleDescription, setStyleDescription] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [creating, setCreating] = useState(false);

  // ─── 任务列表 ───
  const [runs, setRuns] = useState<VideoGenRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<VideoGenRun | null>(null);

  // ─── 分镜编辑 ───
  const [activeSceneIndex, setActiveSceneIndex] = useState<number>(0);
  const [editingFields, setEditingFields] = useState<Record<string, string>>({});

  // ─── 渲染/导出 ───
  const [exporting, setExporting] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── 加载任务列表 ───
  const loadRuns = useCallback(async () => {
    try {
      const res = await listVideoGenRunsReal({ limit: 20 });
      if (res.success) setRuns(res.data.items);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // ─── 选中任务时加载详情 ───
  const loadDetail = useCallback(async (runId: string) => {
    try {
      const res = await getVideoGenRunReal(runId);
      if (res.success) {
        setSelectedRun(res.data);
        setActiveSceneIndex(0);
        setEditingFields({});
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (selectedRunId) loadDetail(selectedRunId);
    else { setSelectedRun(null); setActiveSceneIndex(0); }
  }, [selectedRunId, loadDetail]);

  // ─── SSE / 轮询（分镜生成和渲染期间） ───
  useEffect(() => {
    if (!selectedRunId || !selectedRun) return;
    const status = selectedRun.status;

    // 活跃阶段：SSE 监听
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
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              }
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
                  if (currentEvent === 'script.done' && payload.scenes) {
                    // 分镜生成完成 → 刷新详情
                    if (selectedRunId) loadDetail(selectedRunId);
                    loadRuns();
                  }
                  if (currentEvent === 'scene.regenerated') {
                    // 单条分镜重试完成 → 刷新详情
                    if (selectedRunId) loadDetail(selectedRunId);
                  }
                  if (currentEvent === 'scene.error') {
                    if (selectedRunId) loadDetail(selectedRunId);
                  }
                  if (['run.completed', 'run.error', 'run.cancelled'].includes(currentEvent)) {
                    setTimeout(() => {
                      loadRuns();
                      if (selectedRunId) loadDetail(selectedRunId);
                    }, 500);
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

    // Editing 状态：轮询（分镜重试事件）
    if (status === 'Editing') {
      const hasGenerating = selectedRun.scenes.some((s) => s.status === 'Generating');
      if (hasGenerating) {
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
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, selectedRun?.status, token, loadRuns, loadDetail]);

  // ─── 创建任务 ───
  const handleCreate = async () => {
    if (!markdown.trim()) return;
    setCreating(true);
    try {
      const res = await createVideoGenRunReal({
        articleMarkdown: markdown,
        articleTitle: title || undefined,
        systemPrompt: systemPrompt || undefined,
        styleDescription: styleDescription || undefined,
      });
      if (res.success) {
        setSelectedRunId(res.data.runId);
        setMarkdown('');
        setTitle('');
        await loadRuns();
      }
    } catch { /* ignore */ } finally { setCreating(false); }
  };

  // ─── 取消任务 ───
  const handleCancel = async () => {
    if (!selectedRunId) return;
    await cancelVideoGenRunReal(selectedRunId);
    await loadRuns();
    loadDetail(selectedRunId);
  };

  // ─── 更新分镜 ───
  const handleSaveScene = async (sceneIndex: number) => {
    if (!selectedRunId || !selectedRun) return;
    const fields = editingFields;
    const scene = selectedRun.scenes[sceneIndex];
    if (!scene) return;

    const input: Record<string, string> = {};
    if (fields.topic && fields.topic !== scene.topic) input.topic = fields.topic;
    if (fields.narration && fields.narration !== scene.narration) input.narration = fields.narration;
    if (fields.visualDescription && fields.visualDescription !== scene.visualDescription) input.visualDescription = fields.visualDescription;

    if (Object.keys(input).length === 0) return;

    try {
      const res = await updateVideoSceneReal(selectedRunId, sceneIndex, input);
      if (res.success) {
        loadDetail(selectedRunId);
        setEditingFields({});
      }
    } catch { /* ignore */ }
  };

  // ─── 重新生成分镜 ───
  const handleRegenerateScene = async (sceneIndex: number) => {
    if (!selectedRunId) return;
    try {
      await regenerateVideoSceneReal(selectedRunId, sceneIndex);
      // 更新本地状态
      setSelectedRun((prev) => {
        if (!prev) return prev;
        const scenes = [...prev.scenes];
        scenes[sceneIndex] = { ...scenes[sceneIndex], status: 'Generating', errorMessage: undefined };
        return { ...prev, scenes };
      });
    } catch { /* ignore */ }
  };

  // ─── 生成分镜预览图 ───
  const imageAbortRef = useRef<Map<number, AbortController>>(new Map());

  const handleGeneratePreview = async (sceneIndex: number) => {
    if (!selectedRunId || !selectedRun) return;

    // 取消之前的 SSE 连接
    imageAbortRef.current.get(sceneIndex)?.abort();

    // 本地标记 running
    setSelectedRun((prev) => {
      if (!prev) return prev;
      const scenes = [...prev.scenes];
      scenes[sceneIndex] = { ...scenes[sceneIndex], imageStatus: 'running', imageUrl: undefined };
      return { ...prev, scenes };
    });

    try {
      const res = await generateScenePreviewReal(selectedRunId, sceneIndex);
      if (!res.success) return;

      const { imageRunId } = res.data;

      // 启动 SSE 监听图片生成结果
      const ac = new AbortController();
      imageAbortRef.current.set(sceneIndex, ac);

      const sseUrl = getScenePreviewStreamUrl(selectedRunId, sceneIndex);
      const fullUrl = `${import.meta.env.VITE_API_BASE_URL || ''}${sseUrl}`;

      const response = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ac.signal,
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

              if (payload.type === 'imageDone') {
                const imageUrl = payload.base64
                  ? `data:image/png;base64,${payload.base64}`
                  : payload.url || '';

                // 保存到后端
                if (selectedRunId) {
                  await updateScenePreviewReal(selectedRunId, sceneIndex, imageUrl);
                }

                // 更新本地状态
                setSelectedRun((prev) => {
                  if (!prev) return prev;
                  const scenes = [...prev.scenes];
                  scenes[sceneIndex] = { ...scenes[sceneIndex], imageStatus: 'done', imageUrl, imageGenRunId: imageRunId };
                  return { ...prev, scenes };
                });

                ac.abort(); // 拿到图就断开
                imageAbortRef.current.delete(sceneIndex);
                return;
              }

              if (payload.type === 'imageError') {
                setSelectedRun((prev) => {
                  if (!prev) return prev;
                  const scenes = [...prev.scenes];
                  scenes[sceneIndex] = { ...scenes[sceneIndex], imageStatus: 'error' };
                  return { ...prev, scenes };
                });
                ac.abort();
                imageAbortRef.current.delete(sceneIndex);
                return;
              }
            } catch { /* parse error */ }
          }
        }
      }
    } catch {
      // SSE 连接断开
      setSelectedRun((prev) => {
        if (!prev) return prev;
        const scenes = [...prev.scenes];
        if (scenes[sceneIndex]?.imageStatus === 'running') {
          scenes[sceneIndex] = { ...scenes[sceneIndex], imageStatus: 'error' };
        }
        return { ...prev, scenes };
      });
    }
  };

  const handleBatchGeneratePreviews = () => {
    if (!selectedRun) return;
    selectedRun.scenes.forEach((scene, idx) => {
      if (scene.imageStatus !== 'running') {
        handleGeneratePreview(idx);
      }
    });
  };

  // 清理 SSE 连接
  useEffect(() => {
    return () => {
      imageAbortRef.current.forEach((ac) => ac.abort());
    };
  }, [selectedRunId]);

  // ─── 导出/渲染 ───
  const handleExport = async () => {
    if (!selectedRunId) return;
    setExporting(true);
    try {
      const res = await triggerVideoRenderReal(selectedRunId);
      if (res.success) {
        await loadRuns();
        loadDetail(selectedRunId);
      }
    } catch { /* ignore */ } finally { setExporting(false); }
  };

  // ─── 分镜编辑选中 ───
  const activeScene = selectedRun?.scenes[activeSceneIndex];

  useEffect(() => {
    if (activeScene) {
      setEditingFields({
        topic: activeScene.topic,
        narration: activeScene.narration,
        visualDescription: activeScene.visualDescription,
      });
    }
  }, [activeSceneIndex, activeScene?.topic, activeScene?.narration, activeScene?.visualDescription]);

  const isEditing = selectedRun?.status === 'Editing';
  const isActive = selectedRun && ACTIVE_STATUSES.includes(selectedRun.status);
  const isCompleted = selectedRun?.status === 'Completed';

  // ─── 步骤指示器数据 ───
  const steps = [
    { key: 'input', label: '输入文章' },
    { key: 'scripting', label: '生成分镜' },
    { key: 'editing', label: '编辑分镜' },
    { key: 'rendering', label: '渲染导出' },
    { key: 'completed', label: '完成' },
  ];

  const getCurrentStep = (): number => {
    if (!selectedRun) return 0;
    switch (selectedRun.status) {
      case 'Queued':
      case 'Scripting': return 1;
      case 'Editing': return 2;
      case 'Rendering': return 3;
      case 'Completed': return 4;
      default: return 0;
    }
  };

  const currentStep = getCurrentStep();

  return (
    <div className="flex h-full">
      {/* ═══ 左侧面板 ═══ */}
      <div className="flex w-[420px] flex-shrink-0 flex-col border-r border-border">
        {/* 上半：预览 / 输入 */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* 步骤指示器 */}
          {selectedRun && (
            <div className="flex items-center gap-1 mb-2">
              {steps.map((step, idx) => (
                <React.Fragment key={step.key}>
                  <div className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    idx < currentStep
                      ? 'bg-primary/15 text-primary'
                      : idx === currentStep
                      ? 'bg-primary/10 text-primary animate-pulse'
                      : 'bg-muted text-muted-foreground'
                  }`}>
                    {idx < currentStep ? (
                      <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : idx === currentStep ? (
                      <span className="text-xs font-bold">{idx + 1}/{steps.length}</span>
                    ) : null}
                    <span className="hidden lg:inline">{step.label}</span>
                  </div>
                  {idx < steps.length - 1 && (
                    <div className={`w-3 h-px flex-shrink-0 ${idx < currentStep ? 'bg-primary/30' : 'bg-border'}`} />
                  )}
                </React.Fragment>
              ))}
            </div>
          )}

          {/* 场景预览（Editing/Completed 状态） */}
          {activeScene && (isEditing || isCompleted) ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  镜头 {activeSceneIndex + 1}/{selectedRun!.scenes.length}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {SCENE_TYPE_LABELS[activeScene.sceneType] || activeScene.sceneType}
                  </span>
                </h3>
                <span className="text-xs text-muted-foreground">{activeScene.durationSeconds.toFixed(1)}s</span>
              </div>

              {/* 预览卡片 */}
              <div className="rounded-lg border border-border/50 bg-gradient-to-b from-muted/30 to-background p-4 space-y-3">
                <div className="text-sm font-medium">{editingFields.topic ?? activeScene.topic}</div>
                <div className="text-sm text-muted-foreground leading-relaxed">
                  {editingFields.narration ?? activeScene.narration}
                </div>
                <div className="text-xs text-muted-foreground/70 italic">
                  {editingFields.visualDescription ?? activeScene.visualDescription}
                </div>
              </div>

              {/* 编辑区（仅 Editing 状态） */}
              {isEditing && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">主题</label>
                  <input
                    value={editingFields.topic ?? ''}
                    onChange={(e) => setEditingFields((f) => ({ ...f, topic: e.target.value }))}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <label className="text-xs font-medium text-muted-foreground">旁白台词</label>
                  <textarea
                    value={editingFields.narration ?? ''}
                    onChange={(e) => setEditingFields((f) => ({ ...f, narration: e.target.value }))}
                    rows={3}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary resize-none"
                  />
                  <label className="text-xs font-medium text-muted-foreground">画面描述</label>
                  <textarea
                    value={editingFields.visualDescription ?? ''}
                    onChange={(e) => setEditingFields((f) => ({ ...f, visualDescription: e.target.value }))}
                    rows={2}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary resize-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSaveScene(activeSceneIndex)}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      保存修改
                    </button>
                    <button
                      onClick={() => handleRegenerateScene(activeSceneIndex)}
                      disabled={activeScene.status === 'Generating'}
                      className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-50"
                    >
                      {activeScene.status === 'Generating' ? 'AI 重新生成中...' : 'AI 重新生成'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : !selectedRun || selectedRun.status === 'Failed' || selectedRun.status === 'Cancelled' ? (
            /* 文章输入区 */
            <div className="space-y-3">
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
                rows={8}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary resize-none"
              />

              {/* 配置面板（系统提示词 + 风格） */}
              <button
                onClick={() => setShowConfig(!showConfig)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <svg className={`w-3 h-3 transition-transform ${showConfig ? 'rotate-90' : ''}`} viewBox="0 0 12 12" fill="none">
                  <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                高级配置
              </button>

              {showConfig && (
                <div className="space-y-2 rounded-md border border-border/50 bg-muted/20 p-3">
                  <label className="text-xs font-medium text-muted-foreground">系统提示词（可选）</label>
                  <textarea
                    placeholder="自定义 LLM 指导，例如：旁白语言活泼轻松，面向初学者..."
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary resize-none"
                  />
                  <label className="text-xs font-medium text-muted-foreground">风格描述（可选）</label>
                  <textarea
                    placeholder="视觉风格说明，例如：科技感、深色背景、霓虹色系..."
                    value={styleDescription}
                    onChange={(e) => setStyleDescription(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary resize-none"
                  />
                </div>
              )}

              <button
                onClick={handleCreate}
                disabled={creating || !markdown.trim()}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? '创建中...' : '生成分镜'}
              </button>
            </div>
          ) : (
            /* Scripting / Rendering 进度 */
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">
                {selectedRun.articleTitle || `任务 ${selectedRun.id.slice(0, 8)}`}
              </h3>
              <ProgressBar
                phase={selectedRun.currentPhase}
                progress={selectedRun.phaseProgress}
                status={selectedRun.status}
                errorMessage={selectedRun.errorMessage}
              />
              {isActive && (
                <button
                  onClick={handleCancel}
                  className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/5"
                >
                  取消
                </button>
              )}
            </div>
          )}

          {/* 导出按钮（Editing 状态） */}
          {isEditing && (
            <div className="border-t border-border pt-3">
              <button
                onClick={handleExport}
                disabled={exporting}
                className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {exporting ? '渲染中...' : '导出视频'}
              </button>
              <p className="mt-1 text-xs text-muted-foreground text-center">
                确认分镜无误后，点击导出开始渲染
              </p>
            </div>
          )}

          {/* 下载区（Completed 状态） */}
          {isCompleted && (
            <div className="border-t border-border pt-3 space-y-2">
              <h4 className="text-sm font-semibold text-primary">视频已完成</h4>
              <div className="flex flex-wrap gap-2">
                {selectedRun.videoAssetUrl && (
                  <a
                    href={selectedRun.videoAssetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/20"
                  >
                    下载 MP4
                  </a>
                )}
                <DownloadButton runId={selectedRun.id} type="srt" label="SRT 字幕" />
                <DownloadButton runId={selectedRun.id} type="narration" label="配音台词" />
                <DownloadButton runId={selectedRun.id} type="script" label="视频脚本" />
              </div>
            </div>
          )}
        </div>

        {/* 下半：历史任务 */}
        <div className="h-[200px] flex-shrink-0 overflow-auto border-t border-border p-3 space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground mb-1">历史任务</h4>
          {runs.length === 0 && (
            <div className="text-xs text-muted-foreground py-4 text-center">暂无任务</div>
          )}
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              className={`w-full rounded-md border p-2.5 text-left text-xs transition-colors ${
                selectedRunId === run.id
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/50 bg-background hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium truncate">{run.articleTitle || `任务 ${run.id.slice(0, 8)}`}</span>
                <StatusBadge status={run.status} />
              </div>
              <div className="mt-0.5 text-muted-foreground flex items-center gap-2">
                <span>{new Date(run.createdAt).toLocaleString('zh-CN')}</span>
                {run.scenesCount > 0 && <span>{run.scenesReady}/{run.scenesCount} 镜头</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ═══ 右侧面板：分镜列表 ═══ */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedRun || (selectedRun.scenes.length === 0 && !ACTIVE_STATUSES.includes(selectedRun.status)) ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            {selectedRun?.status === 'Failed' ? (
              <div className="text-center space-y-2">
                <div className="text-destructive font-medium">任务失败</div>
                <div className="text-xs">{selectedRun.errorMessage}</div>
              </div>
            ) : selectedRun?.status === 'Cancelled' ? (
              <div className="text-center">任务已取消</div>
            ) : (
              '选择一个任务或创建新任务'
            )}
          </div>
        ) : selectedRun.scenes.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center space-y-2">
              <div className="w-8 h-8 mx-auto border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <div className="text-sm text-muted-foreground">正在分析文章，生成分镜脚本...</div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">
                分镜列表
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  {selectedRun.scenes.length} 个镜头 · {(selectedRun.totalDurationSeconds / 60).toFixed(1)} 分钟
                </span>
              </h3>
              {isEditing && (
                <div className="flex gap-2">
                  <button
                    onClick={handleBatchGeneratePreviews}
                    className="text-xs text-primary hover:text-primary/80"
                  >
                    批量生成预览图
                  </button>
                  <button
                    onClick={() => selectedRun.scenes.forEach((_, idx) => handleRegenerateScene(idx))}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    全部重新生成文案
                  </button>
                </div>
              )}
            </div>

            {/* 分镜卡片网格（每行2个，像文学创作的marker列表） */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {selectedRun.scenes.map((scene, idx) => (
                <div
                  key={scene.index}
                  onClick={() => setActiveSceneIndex(idx)}
                  className={`cursor-pointer rounded-lg border overflow-hidden transition-all ${
                    activeSceneIndex === idx
                      ? 'border-primary/50 ring-1 ring-primary/20 shadow-sm'
                      : 'border-border/50 hover:border-border'
                  }`}
                >
                  {/* 预览图区域 */}
                  <div className="relative aspect-video bg-muted/30">
                    {scene.imageUrl ? (
                      <img
                        src={scene.imageUrl}
                        alt={scene.topic}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="flex items-center justify-center w-full h-full">
                        {scene.imageStatus === 'running' ? (
                          <div className="text-center space-y-1">
                            <div className="w-6 h-6 mx-auto border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                            <span className="text-xs text-muted-foreground">生成中...</span>
                          </div>
                        ) : (
                          <div className="text-center space-y-1">
                            <svg className="w-8 h-8 mx-auto text-muted-foreground/30" viewBox="0 0 24 24" fill="none">
                              <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                              <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
                              <path d="M3 16l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            {isEditing && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleGeneratePreview(idx); }}
                                className="text-xs text-primary hover:text-primary/80"
                              >
                                生成预览图
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 左上角序号 + 类型 */}
                    <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-black/60 text-white text-xs font-bold">
                        {idx + 1}
                      </span>
                      <span className="rounded-md bg-black/50 px-1.5 py-0.5 text-xs text-white/90">
                        {SCENE_TYPE_LABELS[scene.sceneType] || scene.sceneType}
                      </span>
                    </div>

                    {/* 右上角时长 */}
                    <span className="absolute top-1.5 right-1.5 rounded-md bg-black/50 px-1.5 py-0.5 text-xs text-white/90">
                      {scene.durationSeconds.toFixed(1)}s
                    </span>

                    {/* 右上角图片状态（已有图时，显示重试按钮） */}
                    {scene.imageUrl && isEditing && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleGeneratePreview(idx); }}
                        className="absolute bottom-1.5 right-1.5 rounded-md bg-black/50 px-1.5 py-0.5 text-xs text-white/90 hover:bg-black/70"
                      >
                        重新生成
                      </button>
                    )}

                    {scene.imageStatus === 'error' && (
                      <div className="absolute inset-0 flex items-center justify-center bg-destructive/10">
                        <span className="text-xs text-destructive">生成失败</span>
                      </div>
                    )}
                  </div>

                  {/* 文字区域 */}
                  <div className="p-2.5 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate flex-1">{scene.topic}</span>
                      {scene.status === 'Generating' && (
                        <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />
                      )}
                      {scene.status === 'Done' && (
                        <svg className="w-3 h-3 text-primary flex-shrink-0" viewBox="0 0 12 12" fill="none">
                          <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{scene.narration}</p>
                    {scene.status === 'Error' && scene.errorMessage && (
                      <p className="text-xs text-destructive line-clamp-1">{scene.errorMessage}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Sub-components ───

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const config: Record<string, { label: string; className: string }> = {
    Queued: { label: '排队中', className: 'bg-muted text-muted-foreground' },
    Scripting: { label: '生成中', className: 'bg-blue-500/10 text-blue-500' },
    Editing: { label: '编辑中', className: 'bg-amber-500/10 text-amber-500' },
    Rendering: { label: '渲染中', className: 'bg-orange-500/10 text-orange-500' },
    Completed: { label: '已完成', className: 'bg-green-500/10 text-green-500' },
    Failed: { label: '失败', className: 'bg-destructive/10 text-destructive' },
    Cancelled: { label: '已取消', className: 'bg-muted text-muted-foreground' },
  };
  const c = config[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.className}`}>{c.label}</span>;
};

const ProgressBar: React.FC<{
  phase: string;
  progress: number;
  status: string;
  errorMessage?: string;
}> = ({ phase, progress, status, errorMessage }) => {
  const labels: Record<string, string> = {
    scripting: '分析文章 & 生成分镜',
    editing: '编辑分镜',
    rendering: '渲染视频',
    completed: '已完成',
  };

  if (status === 'Failed') {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
        <div className="text-sm font-medium text-destructive">任务失败</div>
        {errorMessage && <div className="text-xs text-muted-foreground">{errorMessage}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{labels[phase] || phase}</span>
        <span>{progress}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
};

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
    } catch { /* ignore */ }
  };

  return (
    <button
      onClick={handleDownload}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/50"
    >
      {label}
    </button>
  );
};
