/**
 * 直出模式面板：跳过分镜，直接把 prompt 交给 OpenRouter 视频大模型
 * 设计风格参考：Sora / Pika —— 黑色沉浸、单焦点画布、prompt 前置
 *
 * 交互流程：
 *   1. 用户输入 prompt + 选模型 + 选时长/比例
 *   2. 点"生成"→ 后端 VideoGenRun (renderMode=videogen) 异步跑
 *   3. 前端每 3 秒轮询 getVideoGenRun，展示 phase.progress
 *   4. status === 'Completed' 时 videoAssetUrl 就位，内嵌播放器直接播放
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Play, Download, RefreshCw, Wand2, Clock, Maximize2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  createVideoGenRunReal,
  getVideoGenRunReal,
} from '@/services/real/videoAgent';
import {
  OPENROUTER_VIDEO_MODELS,
  type VideoGenRun,
} from '@/services/contracts/videoAgent';

type AspectRatio = '16:9' | '9:16' | '1:1';
type Resolution = '480p' | '720p' | '1080p';

const DURATION_OPTIONS = [5, 8, 10, 12, 15] as const;
const ASPECT_OPTIONS: { value: AspectRatio; label: string; emoji: string }[] = [
  { value: '16:9', label: '横屏 16:9', emoji: '🖥️' },
  { value: '9:16', label: '竖屏 9:16', emoji: '📱' },
  { value: '1:1', label: '方形 1:1', emoji: '⬛' },
];
const RESOLUTION_OPTIONS: Resolution[] = ['480p', '720p', '1080p'];

const AUTO_MODEL = ''; // 空字符串 = 交由后端模型池自动选择

export const VideoGenDirectPanel: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>(AUTO_MODEL);
  const [duration, setDuration] = useState<number>(5);
  const [aspect, setAspect] = useState<AspectRatio>('16:9');
  const [resolution, setResolution] = useState<Resolution>('720p');

  const [currentRun, setCurrentRun] = useState<VideoGenRun | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const isActive = currentRun && ['Queued', 'Rendering'].includes(currentRun.status);
  const isCompleted = currentRun?.status === 'Completed' && !!currentRun.videoAssetUrl;
  const isFailed = currentRun?.status === 'Failed' || currentRun?.status === 'Cancelled';

  const startPolling = useCallback((runId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const res = await getVideoGenRunReal(runId);
      if (res.success && res.data) {
        setCurrentRun(res.data);
        if (['Completed', 'Failed', 'Cancelled'].includes(res.data.status)) {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      }
    }, 3000);
  }, []);

  const handleGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      toast.error('请先输入描述 prompt');
      return;
    }
    if (isSubmitting || isActive) return;

    setIsSubmitting(true);
    try {
      const res = await createVideoGenRunReal({
        renderMode: 'videogen',
        directPrompt: trimmed,
        directVideoModel: model || undefined, // 空 → 交由后端模型池决定
        directAspectRatio: aspect,
        directResolution: resolution,
        directDuration: duration,
      });

      if (!res.success || !res.data) {
        toast.error(res.error?.message || '创建任务失败');
        setIsSubmitting(false);
        return;
      }

      const runId = res.data.runId;
      const initial = await getVideoGenRunReal(runId);
      if (initial.success && initial.data) {
        setCurrentRun(initial.data);
        startPolling(runId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误';
      toast.error(`提交失败：${msg}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [prompt, model, aspect, resolution, duration, isSubmitting, isActive, startPolling]);

  const handleReset = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setCurrentRun(null);
  }, []);

  const progressText = (() => {
    if (!currentRun) return '';
    if (currentRun.status === 'Queued') return '排队中…';
    if (currentRun.currentPhase === 'videogen-submitting') return '正在提交到 OpenRouter…';
    if (currentRun.currentPhase === 'videogen-polling') return 'AI 正在生成视频…';
    if (currentRun.status === 'Completed') return '生成完成';
    if (currentRun.status === 'Failed') return '生成失败';
    return currentRun.currentPhase || currentRun.status;
  })();

  return (
    <div className="flex-1 min-h-0 flex flex-col items-center overflow-y-auto px-4 py-6" style={{ background: 'var(--bg-base)' }}>
      <div className="w-full max-w-[960px] flex flex-col gap-4">
        {/* ═══ 沉浸式画布 ═══ */}
        <div
          className="relative w-full aspect-video rounded-[20px] overflow-hidden flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, #0a0c12 0%, #141823 50%, #0a0c12 100%)',
            border: '1px solid rgba(236, 72, 153, 0.18)',
            boxShadow: '0 10px 60px -10px rgba(236, 72, 153, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
          }}
        >
          {isCompleted && currentRun?.videoAssetUrl ? (
            <video
              src={currentRun.videoAssetUrl}
              controls
              autoPlay
              loop
              className="w-full h-full object-contain"
              style={{ background: '#000' }}
            />
          ) : isActive ? (
            <div className="flex flex-col items-center gap-4 text-white/80 px-6 text-center">
              <MapSpinner size={32} />
              <div className="text-base font-medium">{progressText}</div>
              <div className="w-64 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div
                  className="h-full transition-all duration-500"
                  style={{
                    width: `${currentRun?.phaseProgress ?? 0}%`,
                    background: 'linear-gradient(90deg, #ec4899 0%, #a855f7 100%)',
                  }}
                />
              </div>
              <div className="text-xs text-white/40">
                任务 ID：{currentRun?.id.slice(0, 12)}…
                {currentRun?.directVideoJobId && <> · OpenRouter：{currentRun.directVideoJobId.slice(0, 10)}…</>}
              </div>
            </div>
          ) : isFailed ? (
            <div className="flex flex-col items-center gap-3 text-white/70 px-6 text-center max-w-[640px]">
              <AlertCircle size={32} className="text-rose-400" />
              <div className="text-base font-medium">生成失败</div>
              <div className="text-xs text-white/50 whitespace-pre-wrap">
                {currentRun?.errorMessage || '未知错误'}
              </div>
              {currentRun?.errorCode === 'OPENROUTER_NOT_CONFIGURED' && (
                <div className="mt-2 text-[11px] text-amber-300/80 bg-amber-500/10 rounded-lg px-3 py-2 border border-amber-500/30">
                  提示：管理员需在容器环境变量中注入 <code className="font-mono">OPENROUTER_API_KEY</code>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-white/50 px-6 text-center">
              <Wand2 size={36} />
              <div className="text-base font-medium text-white/80">AI 视频直出</div>
              <div className="text-xs max-w-[420px]">
                描述你想要的画面，Seedance / Wan / Veo / Sora 等视频大模型会在几分钟内生成 MP4 片段。
              </div>
            </div>
          )}

          {/* 角标 */}
          <div className="absolute top-3 left-3 flex items-center gap-1.5 text-[10px] text-white/40 font-mono px-2 py-1 rounded-md" style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(8px)' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: isActive ? '#ec4899' : (isCompleted ? '#22c55e' : '#64748b') }} />
            {isActive ? '生成中' : isCompleted ? '已完成' : isFailed ? '失败' : '待机'}
          </div>
        </div>

        {/* ═══ Prompt 输入 ═══ */}
        <div
          className="rounded-[16px] p-4 flex flex-col gap-3"
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例：一只金毛犬在落日的海滩上奔跑追逐海浪，电影级光影，慢动作镜头……"
            rows={3}
            disabled={isActive || isSubmitting}
            className="w-full resize-none rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500/40"
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
            }}
          />

          {/* 参数栏 */}
          <div className="flex flex-wrap items-center gap-2">
            {/* 模型（可选：空 = 由模型池自动选择最优） */}
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isActive || isSubmitting}
              className="text-xs rounded-lg px-2 py-1.5 max-w-[280px] truncate"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              title="留空让模型池自动选择，或指定偏好模型"
            >
              <option value={AUTO_MODEL}>自动（由模型池决定）</option>
              {OPENROUTER_VIDEO_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>

            {/* 时长 */}
            <div className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}>
              <Clock size={11} style={{ color: 'var(--text-muted)' }} />
              <select
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                disabled={isActive || isSubmitting}
                className="bg-transparent outline-none"
                style={{ color: 'var(--text-primary)' }}
              >
                {DURATION_OPTIONS.map((d) => <option key={d} value={d}>{d}s</option>)}
              </select>
            </div>

            {/* 宽高比 */}
            <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-default)' }}>
              {ASPECT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setAspect(opt.value)}
                  disabled={isActive || isSubmitting}
                  className={cn('px-2 py-1 text-xs transition-colors')}
                  style={{
                    background: aspect === opt.value ? 'rgba(236,72,153,0.18)' : 'var(--bg-base)',
                    color: aspect === opt.value ? '#f472b6' : 'var(--text-muted)',
                  }}
                  title={opt.label}
                >
                  {opt.emoji} {opt.value}
                </button>
              ))}
            </div>

            {/* 分辨率 */}
            <div className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}>
              <Maximize2 size={11} style={{ color: 'var(--text-muted)' }} />
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as Resolution)}
                disabled={isActive || isSubmitting}
                className="bg-transparent outline-none"
                style={{ color: 'var(--text-primary)' }}
              >
                {RESOLUTION_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>

            <div className="flex-1" />

            {/* 完成后的动作 */}
            {(isCompleted || isFailed) && (
              <Button size="sm" variant="ghost" onClick={handleReset}>
                <RefreshCw size={12} /> 再来一条
              </Button>
            )}
            {isCompleted && currentRun?.videoAssetUrl && (
              <a
                href={currentRun.videoAssetUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg"
                style={{ background: 'rgba(34,197,94,0.14)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.3)' }}
              >
                <Download size={12} /> 下载 MP4
              </a>
            )}

            {/* 主按钮 */}
            {!isCompleted && !isFailed && (
              <Button
                size="sm"
                variant="primary"
                onClick={handleGenerate}
                disabled={isActive || isSubmitting || !prompt.trim()}
              >
                {isSubmitting || isActive ? (
                  <><MapSpinner size={12} /> 生成中…</>
                ) : (
                  <><Sparkles size={12} /> 立即生成</>
                )}
              </Button>
            )}
          </div>

          {/* 费用 + 提示 */}
          <div className="text-[11px] text-white/40 flex items-center gap-3 flex-wrap">
            <span>💡 视频生成通常需要 1-3 分钟，页面保持打开即可</span>
            {currentRun?.directVideoCost != null && (
              <span>本次费用：${currentRun.directVideoCost.toFixed(3)}</span>
            )}
          </div>
        </div>

        {/* 完成后的播放器信息 */}
        {isCompleted && currentRun?.videoAssetUrl && (
          <div className="text-[11px] text-white/40 text-center flex items-center justify-center gap-2">
            <Play size={12} /> 视频链接 7 天内有效，建议尽快下载到本地
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoGenDirectPanel;
