import type { ReactNode } from 'react';
import { CheckCircle2, Circle, Loader2, Maximize2, XCircle } from 'lucide-react';
import type { PhaseKey, PhaseState } from '@/lib/deploymentPhases';

/**
 * 2026-05-14: 内联容器日志支持多容器 tab 切换 + 一键最大化。
 * 用户反馈:"图5 容器日志里面有2个容器应该把真正的容器日志复刻过来" —— 之前 PhaseTree
 * 的内联日志只展示自动挑选的一个 service。
 */
export interface InlineContainerLogControls {
  /** 全部 service，按显示顺序排好。少于 2 个时不渲染 tab 条。 */
  services: Array<{ profileId: string; status: string; hostPort?: number }>;
  /** 当前选中的 profileId。无选中视为不渲染 tab 条。 */
  selected: string | null;
  onSelect: (profileId: string) => void;
  /** "最大化"按钮——跳到 Logs tab 容器模式查看完整日志。 */
  onMaximize?: () => void;
}

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
   * 2026-05-14: 多容器 tab 切换 + 最大化控制。给定后，内联日志会渲染 tab strip。
   * 缺省 = 沿用旧行为（单容器，仅自动挑选的那个）。
   */
  containerLogControls?: InlineContainerLogControls;
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

function PhaseLogDetails({
  phase,
  state,
  tail,
  controls,
}: {
  phase: PhaseState;
  state: PhaseLogState;
  tail: number | null | undefined;
  controls?: InlineContainerLogControls;
}): JSX.Element {
  const hasTabs = !!(controls && controls.services.length > 1);
  return (
    <details
      className="group rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 px-3 py-2"
      open={phase.status === 'running' || phase.status === 'error'}
    >
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 text-xs font-medium text-muted-foreground transition-colors group-open:text-foreground">
        <span>容器日志</span>
        {controls?.onMaximize ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2 py-0.5 text-[11px] hover:border-[hsl(var(--hairline-strong))]"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              controls.onMaximize?.();
            }}
            title="跳转到「日志 → 容器日志」查看完整内容"
          >
            <Maximize2 className="h-3 w-3" />
            最大化
          </button>
        ) : null}
      </summary>
      {hasTabs ? (
        <div className="mt-2 flex flex-wrap gap-1.5 border-b border-[hsl(var(--hairline))] pb-2">
          {controls!.services.map((svc) => {
            const active = svc.profileId === controls!.selected;
            const dot = svc.status === 'running'
              ? 'bg-emerald-500'
              : svc.status === 'error'
                ? 'bg-destructive'
                : 'bg-muted-foreground/40';
            return (
              <button
                key={svc.profileId}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  controls!.onSelect(svc.profileId);
                }}
                className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] transition-colors ${
                  active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                <span className="font-mono">{svc.profileId}</span>
                {svc.hostPort ? <span className="font-mono opacity-70">:{svc.hostPort}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <PhaseLogPreview state={state} tail={tail} />
    </details>
  );
}

export function PhaseTree({
  phases,
  onActionForError,
  containerLogsByPhase,
  containerLogControls,
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
                  <div className={phase.errorHint ? 'mt-2' : ''}>
                    <PhaseLogDetails
                      phase={phase}
                      state={phaseLogs}
                      tail={inlineLogTailLines}
                      controls={containerLogControls}
                    />
                  </div>
                ) : null}
                {onActionForError ? (
                  <div className="mt-2 flex flex-wrap gap-2">{onActionForError(phase.key)}</div>
                ) : null}
              </div>
            ) : null}
            {showLogBlock ? (
              <div className="pb-2 pl-7 pr-2">
                <PhaseLogDetails phase={phase} state={phaseLogs} tail={inlineLogTailLines} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
