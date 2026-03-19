import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import type { SsePhase } from '@/lib/useSseStream';

interface SsePhaseBarProps {
  /** 当前阶段 */
  phase: SsePhase;
  /** 阶段描述文本 */
  message: string;
  /** 右侧附加信息（如"已完成 3 个"） */
  extra?: React.ReactNode;
}

const phaseConfig: Record<SsePhase, { color: string; bg: string; border: string }> = {
  idle: { color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.06)' },
  connecting: { color: 'rgba(120,180,255,0.9)', bg: 'rgba(120,180,255,0.08)', border: 'rgba(120,180,255,0.2)' },
  streaming: { color: 'rgba(120,180,255,0.9)', bg: 'rgba(120,180,255,0.08)', border: 'rgba(120,180,255,0.2)' },
  done: { color: 'rgba(120,220,180,0.9)', bg: 'rgba(120,220,180,0.08)', border: 'rgba(120,220,180,0.2)' },
  error: { color: 'rgba(255,100,100,0.9)', bg: 'rgba(255,100,100,0.08)', border: 'rgba(255,100,100,0.2)' },
};

/**
 * SSE 阶段状态栏 — 展示当前处理阶段（连接中/分析中/完成/失败）
 *
 * 用于所有涉及 LLM 调用的面板顶部，提供持续的状态反馈。
 */
export function SsePhaseBar({ phase, message, extra }: SsePhaseBarProps) {
  const config = phaseConfig[phase];

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-lg"
      style={{ background: config.bg, border: `1px solid ${config.border}` }}
    >
      {phase === 'connecting' || phase === 'streaming' ? (
        <Loader2 size={14} className="animate-spin flex-shrink-0" style={{ color: config.color }} />
      ) : phase === 'done' ? (
        <CheckCircle2 size={14} className="flex-shrink-0" style={{ color: config.color }} />
      ) : phase === 'error' ? (
        <AlertCircle size={14} className="flex-shrink-0" style={{ color: config.color }} />
      ) : null}

      <span className="text-xs font-medium" style={{ color: config.color }}>
        {message || (phase === 'idle' ? '就绪' : '')}
      </span>

      {extra && (
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
          {extra}
        </span>
      )}
    </div>
  );
}
