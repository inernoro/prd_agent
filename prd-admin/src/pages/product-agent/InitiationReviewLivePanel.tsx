import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { SseTypingBlock } from '@/components/sse/SseTypingBlock';
import type { SsePhase } from '@/lib/useSseStream';
import type { ReviewDimensionScore } from '@/services/real/reviewAgent';

export type InitiationReviewStage = 'idle' | 'uploading' | 'submitting' | 'streaming' | 'syncing';

export type ProcessLogEntry = { id: string; at: string; text: string };

interface InitiationReviewLivePanelProps {
  stage: InitiationReviewStage;
  ssePhase: SsePhase;
  phaseMessage: string;
  progressPercent: number;
  logs: ProcessLogEntry[];
  typing: string;
  dimensionScores: ReviewDimensionScore[];
  totalScore: number | null;
  isPassed: boolean | null;
  adjustmentLog: string[];
  expectedDimCount: number;
}

function stageBarMessage(stage: InitiationReviewStage, sseMessage: string): string {
  if (stage === 'uploading') return '正在上传方案文件…';
  if (stage === 'submitting') return '正在创建评审任务…';
  if (stage === 'syncing') return '正在同步评审结果到立项记录…';
  return sseMessage || 'Agent 评审中…';
}

function stageBarPhase(stage: InitiationReviewStage, ssePhase: SsePhase): SsePhase {
  if (stage === 'syncing') return 'streaming';
  if (stage === 'uploading' || stage === 'submitting') return 'connecting';
  return ssePhase;
}

function scoreTone(score: number, max: number): string {
  const pct = max > 0 ? (score / max) * 100 : 0;
  if (pct >= 90) return 'text-emerald-400';
  if (pct >= 75) return 'text-cyan-400';
  if (pct >= 60) return 'text-amber-400';
  return 'text-rose-400';
}

export function InitiationReviewLivePanel({
  stage,
  ssePhase,
  phaseMessage,
  progressPercent,
  logs,
  typing,
  dimensionScores,
  totalScore,
  isPassed,
  adjustmentLog,
  expectedDimCount,
}: InitiationReviewLivePanelProps) {
  const dimExtra = expectedDimCount > 0
    ? `已评 ${dimensionScores.length}/${expectedDimCount} 项`
    : dimensionScores.length > 0
      ? `已评 ${dimensionScores.length} 项`
      : null;

  return (
    <div className="space-y-4 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-white/50">
          <span>评审进度</span>
          <span className="tabular-nums">{progressPercent}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-cyan-400 transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <SsePhaseBar
        phase={stageBarPhase(stage, ssePhase)}
        message={stageBarMessage(stage, phaseMessage)}
        extra={stage === 'streaming' ? dimExtra : undefined}
      />

      {typing && (
        <SseTypingBlock text={typing} label="AI 分析输出" maxHeight={120} tailChars={500} />
      )}

      {dimensionScores.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-white/50">分项评分（实时）</p>
          {dimensionScores.map((dim) => (
            <div
              key={dim.key}
              className="flex items-center justify-between rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2"
            >
              <span className="text-sm text-white/75">{dim.name}</span>
              <span className={`text-sm font-semibold tabular-nums ${scoreTone(dim.score, dim.maxScore)}`}>
                {dim.score}/{dim.maxScore}
              </span>
            </div>
          ))}
        </div>
      )}

      {totalScore != null && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${isPassed ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-red-400/30 bg-red-400/10 text-red-200'}`}>
          总分 {totalScore}/100 · {isPassed ? '通过' : '未通过'}
        </div>
      )}

      {adjustmentLog.length > 0 && (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2">
          <p className="mb-1 text-xs font-medium text-amber-200/90">系统兜底调整</p>
          <ul className="space-y-0.5 text-xs text-amber-100/70">
            {adjustmentLog.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="mb-2 text-xs font-medium text-white/50">过程日志</p>
        <div
          className="max-h-44 overflow-y-auto rounded-lg border border-white/8 bg-black/20 px-3 py-2 font-mono text-[11px] leading-relaxed text-white/60"
        >
          {logs.length === 0 ? (
            <span className="text-white/35">等待开始…</span>
          ) : (
            logs.map((entry) => (
              <div key={entry.id} className="flex gap-2 py-0.5">
                <span className="shrink-0 text-white/30">{entry.at}</span>
                <span>{entry.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function computeInitiationReviewProgress(
  stage: InitiationReviewStage,
  dimCount: number,
  expectedDims: number,
): number {
  switch (stage) {
    case 'uploading':
      return 12;
    case 'submitting':
      return 22;
    case 'streaming': {
      const base = 28;
      const dimPart = expectedDims > 0
        ? (dimCount / expectedDims) * 58
        : Math.min(dimCount * 10, 58);
      return Math.min(88, Math.round(base + dimPart));
    }
    case 'syncing':
      return 95;
    default:
      return 0;
  }
}
