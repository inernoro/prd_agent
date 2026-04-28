/**
 * 高级创作页：上传/粘贴文章 → LLM 拆分镜 → 编辑每镜 → 单镜调 OpenRouter 渲染
 *
 * 数据流：parent 传 runId（已 Queued/Scripting/Editing 状态的 run）→ 本组件订阅其状态
 * - Queued/Scripting：显示"AI 正在拆分镜..."loading
 * - Editing：显示分镜列表，每镜可编辑/重生成 prompt/触发渲染
 * - 用户点单镜的"渲染"按钮 → 该镜变 Rendering → worker 调 OpenRouter → 完成后 Done
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, RefreshCw, Play, Loader2, AlertCircle, Wand2, Clock } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  getVideoGenRunReal,
  updateVideoSceneReal,
  regenerateVideoSceneReal,
  renderVideoSceneReal,
} from '@/services/real/videoAgent';
import type { VideoGenRun, VideoGenScene } from '@/services/contracts/videoAgent';
import { OPENROUTER_VIDEO_MODELS, VIDEO_MODEL_TIERS } from '@/services/contracts/videoAgent';

export interface VideoStoryboardEditorProps {
  runId: string;
  onBack?: () => void;
}

const DURATIONS = [5, 8, 10, 12, 15];

export const VideoStoryboardEditor: React.FC<VideoStoryboardEditorProps> = ({ runId, onBack }) => {
  const [run, setRun] = useState<VideoGenRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [editingPrompts, setEditingPrompts] = useState<Record<number, string>>({});

  const startPollIfNeeded = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => { void loadRunRef.current?.(); }, 3000);
  }, []);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadRunRef = useRef<(() => Promise<void>) | null>(null);

  const loadRun = useCallback(async () => {
    try {
      const res = await getVideoGenRunReal(runId);
      if (res.success && res.data) {
        setRun(res.data);
        setError(null);
        // 是否需要继续轮询：run 处于活跃态 OR 任意分镜处于过渡态（用户可能在 run 已 Completed
        // 后继续点单镜「渲染」/「重新设计」，scene 在跑 → 必须继续轮询直到所有镜终态）
        const runActive = ['Queued', 'Scripting', 'Editing', 'Rendering'].includes(res.data.status);
        const anySceneTransient = (res.data.scenes ?? []).some(
          s => s.status === 'Generating' || s.status === 'Rendering',
        );
        if (runActive || anySceneTransient) {
          startPollIfNeeded();
        } else {
          stopPoll();
        }
      } else {
        setError((res as { error?: { message?: string } }).error?.message || '加载任务失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误');
    }
  }, [runId, startPollIfNeeded, stopPoll]);

  // 把最新 loadRun 同步到 ref，让 setInterval 回调始终调到最新版本，避免闭包陈旧
  useEffect(() => { loadRunRef.current = loadRun; }, [loadRun]);

  useEffect(() => {
    void loadRun();
    return () => stopPoll();
  }, [loadRun, stopPoll]);

  const handleSavePrompt = useCallback(async (sceneIndex: number) => {
    const newPrompt = editingPrompts[sceneIndex];
    if (newPrompt === undefined || !run) return;
    const scene = run.scenes[sceneIndex];
    if (!scene || newPrompt.trim() === scene.prompt.trim()) return;

    const res = await updateVideoSceneReal(runId, sceneIndex, { prompt: newPrompt.trim() });
    if (!res.success) {
      toast.error('保存失败', (res as { error?: { message?: string } }).error?.message);
      return;
    }
    setEditingPrompts(prev => { const next = { ...prev }; delete next[sceneIndex]; return next; });
    void loadRun();
  }, [editingPrompts, run, runId, loadRun]);

  const handleRegenerate = useCallback(async (sceneIndex: number) => {
    const res = await regenerateVideoSceneReal(runId, sceneIndex);
    if (!res.success) {
      toast.error('重新设计失败', (res as { error?: { message?: string } }).error?.message);
      return;
    }
    startPollIfNeeded(); // 单镜进入 Generating，确保轮询活着
    void loadRun();
  }, [runId, loadRun, startPollIfNeeded]);

  const handleRender = useCallback(async (sceneIndex: number) => {
    const res = await renderVideoSceneReal(runId, sceneIndex);
    if (!res.success) {
      toast.error('渲染失败', (res as { error?: { message?: string } }).error?.message);
      return;
    }
    startPollIfNeeded(); // 单镜进入 Rendering，确保轮询活着
    void loadRun();
  }, [runId, loadRun, startPollIfNeeded]);

  const handleUpdateMeta = useCallback(async (sceneIndex: number, patch: { model?: string; duration?: number }) => {
    const res = await updateVideoSceneReal(runId, sceneIndex, patch);
    if (!res.success) {
      toast.error('保存失败', (res as { error?: { message?: string } }).error?.message);
      return;
    }
    void loadRun();
  }, [runId, loadRun]);

  if (error) {
    return (
      <GlassCard className="p-8 text-center">
        <AlertCircle size={32} style={{ color: 'rgba(239,68,68,0.9)' }} className="mx-auto mb-3" />
        <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{error}</div>
        {onBack && <Button onClick={onBack} className="mt-4">返回</Button>}
      </GlassCard>
    );
  }

  if (!run) {
    return (
      <GlassCard className="p-8 text-center">
        <MapSpinner size={32} />
        <div className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>加载中…</div>
      </GlassCard>
    );
  }

  // Queued / Scripting：显示 LLM 拆分镜进度
  if (run.status === 'Queued' || run.status === 'Scripting') {
    return (
      <GlassCard className="p-8 text-center">
        <Wand2 size={32} style={{ color: '#f472b6' }} className="mx-auto mb-3" />
        <div className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          AI 正在拆分镜
        </div>
        <div className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          {run.articleTitle ? `《${run.articleTitle}》` : ''} · 大约 30 秒
        </div>
        <MapSpinner size={28} />
        <div className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          phase: {run.currentPhase} · progress: {run.phaseProgress}%
        </div>
      </GlassCard>
    );
  }

  // Failed
  if (run.status === 'Failed') {
    return (
      <GlassCard className="p-6">
        <div className="flex items-center gap-2 mb-2">
          <AlertCircle size={20} style={{ color: '#f87171' }} />
          <span className="text-sm font-semibold" style={{ color: '#f87171' }}>任务失败</span>
        </div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {run.errorCode}: {run.errorMessage}
        </div>
        {onBack && <Button onClick={onBack} className="mt-4" variant="secondary">返回</Button>}
      </GlassCard>
    );
  }

  // Editing：分镜编辑列表
  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <GlassCard variant="subtle" className="px-4 py-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {run.articleTitle || '高级创作分镜'}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {run.scenes.length} 个分镜 · 总时长约 {run.totalDurationSeconds}s
            {run.styleDescription ? ` · 风格：${run.styleDescription}` : ''}
          </div>
        </div>
        {onBack && <Button size="sm" variant="secondary" onClick={onBack}>返回</Button>}
      </GlassCard>

      {/* 分镜列表 */}
      <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3 pr-1">
        {run.scenes.map((scene) => (
          <SceneCard
            key={scene.index}
            scene={scene}
            editingPrompt={editingPrompts[scene.index]}
            defaultModel={run.directVideoModel}
            defaultDuration={run.directDuration ?? 5}
            onPromptChange={(v) => setEditingPrompts(prev => ({ ...prev, [scene.index]: v }))}
            onSavePrompt={() => handleSavePrompt(scene.index)}
            onRegenerate={() => handleRegenerate(scene.index)}
            onRender={() => handleRender(scene.index)}
            onModelChange={(m) => handleUpdateMeta(scene.index, { model: m })}
            onDurationChange={(d) => handleUpdateMeta(scene.index, { duration: d })}
          />
        ))}
      </div>
    </div>
  );
};

interface SceneCardProps {
  scene: VideoGenScene;
  editingPrompt?: string;
  defaultModel?: string;
  defaultDuration: number;
  onPromptChange: (v: string) => void;
  onSavePrompt: () => void;
  onRegenerate: () => void;
  onRender: () => void;
  onModelChange: (m: string) => void;
  onDurationChange: (d: number) => void;
}

const SceneCard: React.FC<SceneCardProps> = ({
  scene, editingPrompt, defaultModel, defaultDuration,
  onPromptChange, onSavePrompt, onRegenerate, onRender, onModelChange, onDurationChange,
}) => {
  const promptValue = editingPrompt ?? scene.prompt;
  const effectiveModel = scene.model ?? defaultModel ?? '';
  const effectiveDuration = scene.duration ?? defaultDuration;
  const isWorking = scene.status === 'Generating' || scene.status === 'Rendering';

  return (
    <div
      className="rounded-[14px] p-3 flex flex-col gap-2"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(167,139,250,0.14)', color: '#a78bfa' }}
          >
            镜头 {scene.index + 1}
          </span>
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {scene.topic}
          </span>
        </div>
        <SceneStatusBadge status={scene.status} />
      </div>

      {scene.errorMessage && (
        <div className="text-[11px]" style={{ color: 'rgba(239,68,68,0.92)' }}>
          {scene.errorMessage}
        </div>
      )}

      <textarea
        value={promptValue}
        onChange={(e) => onPromptChange(e.target.value)}
        onBlur={onSavePrompt}
        disabled={isWorking}
        className="w-full text-xs rounded-md px-2 py-1.5 outline-none resize-none"
        style={{
          background: 'var(--bg-base)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          minHeight: 60,
          fontFamily: 'monospace',
        }}
        placeholder="英文 prompt（喂给视频大模型）"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={effectiveModel}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={isWorking}
          className="text-[10px] rounded px-2 py-1"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
        >
          <option value="">默认（跟随任务）</option>
          {VIDEO_MODEL_TIERS.map(t => (
            <option key={t.tier} value={t.modelId}>{t.label} · {t.modelId.split('/')[1]}</option>
          ))}
          {OPENROUTER_VIDEO_MODELS
            .filter(m => !VIDEO_MODEL_TIERS.some(t => t.modelId === m.id))
            .map(m => <option key={`f-${m.id}`} value={m.id}>{m.label}</option>)}
        </select>

        <div className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded" style={{
          background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)',
        }}>
          <Clock size={11} style={{ color: 'var(--text-muted)' }} />
          <select
            value={String(effectiveDuration)}
            onChange={(e) => onDurationChange(Number(e.target.value))}
            disabled={isWorking}
            className="bg-transparent outline-none"
            style={{ color: 'var(--text-primary)' }}
          >
            {DURATIONS.map(d => <option key={d} value={d}>{d}s</option>)}
          </select>
        </div>

        <div className="flex-1" />

        <Button size="sm" variant="secondary" disabled={isWorking} onClick={onRegenerate} title="LLM 重新生成 prompt">
          <RefreshCw size={13} />
          重新设计
        </Button>
        <Button size="sm" variant="primary" disabled={isWorking} onClick={onRender} title="调 OpenRouter 渲染本镜视频">
          {scene.status === 'Rendering' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {scene.videoUrl ? '重新渲染' : '渲染'}
        </Button>
      </div>

      {/* 视频预览 */}
      {scene.videoUrl && (
        <video
          src={scene.videoUrl}
          controls
          preload="metadata"
          className="w-full rounded-md mt-2"
          style={{ aspectRatio: '16/9', background: 'rgba(0,0,0,0.18)' }}
        />
      )}
      {scene.status === 'Rendering' && !scene.videoUrl && (
        <div className="rounded-md mt-2 flex items-center justify-center gap-2" style={{
          aspectRatio: '16/9', background: 'rgba(0,0,0,0.12)', border: '1px dashed var(--border-default)',
        }}>
          <MapSpinner size={20} />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>OpenRouter 正在生成…</span>
        </div>
      )}
    </div>
  );
};

const SceneStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    Draft: { label: '待渲染', color: 'rgba(148,163,184,0.95)', bg: 'rgba(148,163,184,0.12)' },
    Generating: { label: '重新设计中', color: '#a78bfa', bg: 'rgba(167,139,250,0.14)' },
    Rendering: { label: '渲染中', color: '#f472b6', bg: 'rgba(236,72,153,0.14)' },
    Done: { label: '已完成', color: '#4ade80', bg: 'rgba(34,197,94,0.14)' },
    Error: { label: '失败', color: '#f87171', bg: 'rgba(239,68,68,0.14)' },
  };
  const m = map[status] || map.Draft;
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-medium"
      style={{ background: m.bg, color: m.color }}
    >
      {status === 'Rendering' && <Play size={9} className="inline mr-1" />}
      {m.label}
    </span>
  );
};

export default VideoStoryboardEditor;
