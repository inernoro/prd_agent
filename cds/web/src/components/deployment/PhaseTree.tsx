import type { ReactNode } from 'react';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import type { PhaseKey, PhaseState } from '@/lib/deploymentPhases';

/*
 * PhaseTree — Railway 风格的阶段树。
 *
 * 一行 36px：左侧 16px 状态 icon + 阶段中文 label + 右侧 duration（可选）。
 * running 行下方挂当前最后一行 log（line-clamp-1，灰色小字）。
 * deploy / verify 行下方可以挂真实容器日志预览，失败时默认展开。
 *
 * 颜色全走 Tailwind token，禁止硬编码字面量。
 */

export interface PhaseLogState {
  status: 'loading' | 'ok' | 'error';
  logs?: string;
  message?: string;
}

export interface PhaseTreeProps {
  phases: PhaseState[];
  onActionForError?: (key: PhaseKey) => ReactNode;
  /**
   * 阶段下方内联展示的容器日志（按阶段分桶）。一般只 deploy / verify 阶段会带，
   * build 阶段仍通过「查看完整日志」跳转到构建日志面板。
   */
  containerLogsByPhase?: Partial<Record<PhaseKey, PhaseLogState>>;
  /**
   * 内联日志默认显示最后多少行。null = 全部。
   */
  inlineLogTailLines?: number;
  className?: string;
}

function tailLines(text: string, n: number | null | undefined): string {
  if (!text) return '';
  if (!n || n <= 0) return text;
  const lines = text.split('\n');
  if (lines.length <= n) return text;
  return lines.slice(-n).join('\n');
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

function PhaseLogPreview({
  state,
  tail,
}: {
  state: PhaseLogState;
  tail: number | null | undefined;
}): JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在加载容器日志…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="mt-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs text-muted-foreground">
        日志加载失败：{state.message || '未知错误'}
      </div>
    );
  }
  const text = tailLines(state.logs || '', tail);
  if (!text.trim()) {
    return (
      <div className="mt-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs text-muted-foreground">
        容器尚未输出任何日志（多半是进程在监听端口前就退出了）。
      </div>
    );
  }
  return (
    <pre className="mt-2 max-h-[260px] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 font-mono text-[11px] leading-5 text-foreground/85 whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

export function PhaseTree({
  phases,
  onActionForError,
  containerLogsByPhase,
  inlineLogTailLines = 80,
  className,
}: PhaseTreeProps): JSX.Element {
  return (
    <ol className={`space-y-1 ${className || ''}`} role="list">
      {phases.map((phase) => {
        const isError = phase.status === 'error';
        const isRunning = phase.status === 'running';
        const showLastLine = isRunning && phase.lastLine;
        const phaseLogs = containerLogsByPhase?.[phase.key];
        const showErrorBlock = isError && (phase.errorHint || phaseLogs || onActionForError);
        const showLogBlock = !!phaseLogs && !showErrorBlock;
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
                {phaseLogs ? (
                  <PhaseLogPreview state={phaseLogs} tail={inlineLogTailLines} />
                ) : null}
                {onActionForError ? (
                  <div className="mt-2 flex flex-wrap gap-2">{onActionForError(phase.key)}</div>
                ) : null}
              </div>
            ) : null}
            {showLogBlock ? (
              <div className="pb-2 pl-7 pr-2">
                <details
                  className="group rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 px-3 py-2"
                  open={phase.status === 'running'}
                >
                  <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground transition-colors group-open:text-foreground">
                    容器日志
                  </summary>
                  <PhaseLogPreview state={phaseLogs} tail={inlineLogTailLines} />
                </details>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
