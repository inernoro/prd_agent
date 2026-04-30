import type { ReactNode } from 'react';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import type { PhaseKey, PhaseState } from '@/lib/deploymentPhases';

/*
 * PhaseTree — Railway 风格的阶段树。
 *
 * 一行 36px：左侧 16px 状态 icon + 阶段中文 label + 右侧 duration（可选）。
 * running 行下方挂当前最后一行 log（line-clamp-1，灰色小字）。
 * error 行下方挂 errorHint，并把调用方传入的 CTA 区渲染在 hint 之后。
 *
 * 颜色全走 Tailwind token，禁止硬编码字面量。
 */

export interface PhaseTreeProps {
  phases: PhaseState[];
  onActionForError?: (key: PhaseKey) => ReactNode;
  className?: string;
}

function PhaseIcon({ status }: { status: PhaseState['status'] }): JSX.Element {
  if (status === 'running') {
    return <Loader2 className="h-4 w-4 animate-spin text-sky-500" aria-label="进行中" />;
  }
  if (status === 'success') {
    return <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="已完成" />;
  }
  if (status === 'error') {
    return <XCircle className="h-4 w-4 text-destructive" aria-label="失败" />;
  }
  return <Circle className="h-4 w-4 text-muted-foreground/50" aria-label="待执行" />;
}

function phaseLabelColor(status: PhaseState['status']): string {
  if (status === 'success') return 'text-foreground';
  if (status === 'running') return 'text-foreground';
  if (status === 'error') return 'text-destructive';
  return 'text-muted-foreground';
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function PhaseTree({ phases, onActionForError, className }: PhaseTreeProps): JSX.Element {
  return (
    <ol className={`space-y-1 ${className || ''}`} role="list">
      {phases.map((phase) => {
        const isError = phase.status === 'error';
        const isRunning = phase.status === 'running';
        const showLastLine = isRunning && phase.lastLine;
        const showErrorBlock = isError && (phase.errorHint || onActionForError);
        const duration = formatDuration(phase.durationMs);
        return (
          <li key={phase.key} className="rounded-md">
            <div className="flex h-9 items-center gap-2 px-1">
              <PhaseIcon status={phase.status} />
              <span className={`text-sm font-medium ${phaseLabelColor(phase.status)}`}>{phase.label}</span>
              {duration ? (
                <span className="ml-auto font-mono text-xs text-muted-foreground">{duration}</span>
              ) : null}
            </div>
            {showLastLine ? (
              <div className="pb-2 pl-7 pr-2">
                <div className="line-clamp-1 font-mono text-xs text-muted-foreground" title={phase.lastLine}>
                  {phase.lastLine}
                </div>
              </div>
            ) : null}
            {showErrorBlock ? (
              <div className="pb-2 pl-7 pr-2">
                {phase.errorHint ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                    {phase.errorHint}
                  </div>
                ) : null}
                {onActionForError ? (
                  <div className="mt-2 flex flex-wrap gap-2">{onActionForError(phase.key)}</div>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
