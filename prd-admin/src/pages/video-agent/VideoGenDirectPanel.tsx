/**
 * 直出模式面板（双模式）
 *
 * 模式 A（输入模式）：走 props.externalRunId === undefined
 *   用户输入 prompt + 选参数 → 提交 → 内嵌轮询。独立使用时可直接挂在页面里。
 *
 * 模式 B（纯输出模式）：走 props.externalRunId !== undefined
 *   由外层（如统一入口页）已经创建好 run，panel 只负责展示 canvas + 进度 +
 *   完成后的 videoAssetUrl。输入区隐藏。
 *
 * 设计风格参考：Sora / Pika —— 黑色沉浸、单焦点画布、prompt 前置
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Play, Download, RefreshCw, Wand2, Clock, Maximize2, AlertCircle, ChevronDown, ChevronUp, Zap, Scale, Crown } from 'lucide-react';
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
  VIDEO_MODEL_TIERS,
  type VideoGenRun,
} from '@/services/contracts/videoAgent';

const TIER_ICONS = { economy: Zap, balanced: Scale, premium: Crown } as const;

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

export interface VideoGenDirectPanelProps {
  /** 外部已创建的 runId（纯输出模式），不传则启用完整输入模式 */
  externalRunId?: string;
  /** 外部传入后，点"再来一条"回调，通常外层用来回到输入 Hero */
  onReset?: () => void;
  /** 内部输入模式提交成功后回调，外层据此刷新历史列表 / 切换到查看新 run */
  onRunCreated?: (runId: string) => void;
}

export const VideoGenDirectPanel: React.FC<VideoGenDirectPanelProps> = ({ externalRunId, onReset, onRunCreated }) => {
  const isOutputOnly = !!externalRunId;

  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>(AUTO_MODEL);
  const [showAdvanced, setShowAdvanced] = useState(false);
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

  // 外部 runId 同步：传入 → 拉详情 + 轮询；externalRunId 变 undefined（如父级"新任务"）
  // → 清 currentRun，回到输入模式（避免显示前一个 run 的播放器和进度，Bugbot R3-2）
  useEffect(() => {
    if (!externalRunId) {
      // 父级清空了 selectedRunId，本组件回到纯输入态
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setCurrentRun(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await getVideoGenRunReal(externalRunId);
      if (!cancelled && res.success && res.data) {
        setCurrentRun(res.data);
        if (!['Completed', 'Failed', 'Cancelled'].includes(res.data.status)) {
          startPolling(externalRunId);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [externalRunId, startPolling]);

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
      // 通知外层：刷新历史列表 + 跳转到查看新 run（让 selectedRunId 持久化生效）
      if (onRunCreated) onRunCreated(runId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误';
      toast.error(`提交失败：${msg}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [prompt, model, aspect, resolution, duration, isSubmitting, isActive, startPolling, onRunCreated]);

  const handleReset = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setCurrentRun(null);
    // 纯输出模式下交给外层回调（通常是"回到输入 Hero"）
    if (isOutputOnly && onReset) {
      onReset();
    }
  }, [isOutputOnly, onReset]);

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

        {/* ═══ Prompt 输入（纯输出模式下整个隐藏） ═══ */}
        {!isOutputOnly && (
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

          {/* ─── 模型档位（3 张卡片，默认推荐；展开"高级"才露出全量 7 个 OpenRouter 模型） ─── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              {/* 自动档 */}
              <button
                onClick={() => setModel(AUTO_MODEL)}
                disabled={isActive || isSubmitting}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors',
                  model === AUTO_MODEL && 'ring-1'
                )}
                style={{
                  background: model === AUTO_MODEL ? 'rgba(236,72,153,0.14)' : 'var(--bg-base)',
                  border: '1px solid ' + (model === AUTO_MODEL ? 'rgba(236,72,153,0.4)' : 'var(--border-default)'),
                  color: model === AUTO_MODEL ? '#f472b6' : 'var(--text-primary)',
                }}
                title="由后端模型池按负载 / 健康度自动选择"
              >
                <Sparkles size={11} /> 自动
              </button>

              {/* 三档推荐 */}
              {VIDEO_MODEL_TIERS.map((t) => {
                const Icon = TIER_ICONS[t.tier];
                const active = model === t.modelId;
                return (
                  <button
                    key={t.tier}
                    onClick={() => setModel(t.modelId)}
                    disabled={isActive || isSubmitting}
                    className={cn(
                      'flex flex-col items-start gap-0.5 px-3 py-1.5 rounded-lg text-left transition-colors min-w-[120px]',
                      active && 'ring-1'
                    )}
                    style={{
                      background: active ? 'rgba(236,72,153,0.14)' : 'var(--bg-base)',
                      border: '1px solid ' + (active ? 'rgba(236,72,153,0.4)' : 'var(--border-default)'),
                      color: active ? '#f472b6' : 'var(--text-primary)',
                    }}
                    title={t.desc}
                  >
                    <span className="inline-flex items-center gap-1 text-xs font-medium">
                      <Icon size={11} />
                      {t.label}
                      <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {t.tagline}
                      </span>
                    </span>
                    <span className="text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                      {t.desc}
                    </span>
                  </button>
                );
              })}

              {/* 高级展开 */}
              <button
                onClick={() => setShowAdvanced((s) => !s)}
                disabled={isActive || isSubmitting}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px]"
                style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
                title="展开 OpenRouter 全量视频模型（含 Wan 2.7 / Seedance / Sora）"
              >
                高级 {showAdvanced ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
            </div>

            {showAdvanced && (
              <div
                className="flex flex-col gap-1 rounded-lg p-2"
                style={{ background: 'var(--bg-base)', border: '1px dashed var(--border-default)' }}
              >
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  不知道选什么？保持"自动"即可；需要指定型号时从下面挑选：
                </div>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={isActive || isSubmitting}
                  className="text-xs rounded-md px-2 py-1.5"
                  style={{ background: 'var(--panel)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                >
                  <option value={AUTO_MODEL}>自动（由模型池决定）</option>
                  {OPENROUTER_VIDEO_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 参数栏 */}
          <div className="flex flex-wrap items-center gap-2">
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
        )}

        {/* 纯输出模式的紧凑信息栏（没有输入区时，把关键信息展示在画布下方） */}
        {isOutputOnly && (
          <div
            className="rounded-[14px] p-3 flex items-center gap-3 flex-wrap text-xs"
            style={{ background: 'var(--panel)', border: '1px solid var(--border-default)' }}
          >
            <span style={{ color: 'var(--text-muted)' }}>{progressText || '—'}</span>
            <div className="flex-1" />
            {currentRun?.directVideoCost != null && (
              <span style={{ color: 'var(--text-muted)' }}>
                费用 ${currentRun.directVideoCost.toFixed(3)}
              </span>
            )}
            {(isCompleted || isFailed) && (
              <Button size="sm" variant="ghost" onClick={handleReset}>
                <RefreshCw size={12} /> 新任务
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
          </div>
        )}

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
