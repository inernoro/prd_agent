import React from 'react';

const PHASE_LABELS: Record<string, string> = {
  scripting: '内容分析与脚本规划',
  producing: 'Remotion 代码生成',
  rendering: '视频渲染中',
  packaging: '打包交付',
  completed: '已完成',
};

interface RenderProgressProps {
  currentPhase: string;
  phaseProgress: number;
  status: string;
  errorMessage?: string;
}

export const RenderProgress: React.FC<RenderProgressProps> = ({
  currentPhase,
  phaseProgress,
  status,
  errorMessage,
}) => {
  const phases = ['scripting', 'producing', 'rendering', 'packaging'];
  const currentIdx = phases.indexOf(currentPhase);

  if (status === 'Failed') {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-2">
        <div className="text-sm font-medium text-destructive">任务失败</div>
        {errorMessage && (
          <div className="text-xs text-muted-foreground">{errorMessage}</div>
        )}
      </div>
    );
  }

  if (status === 'Cancelled') {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/50 p-4">
        <div className="text-sm text-muted-foreground">任务已取消</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 阶段指示器 */}
      <div className="flex items-center gap-1">
        {phases.map((phase, idx) => {
          const isComplete = idx < currentIdx || status === 'Completed';
          const isCurrent = idx === currentIdx && status !== 'Completed';

          return (
            <React.Fragment key={phase}>
              <div
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  isComplete
                    ? 'bg-primary/15 text-primary'
                    : isCurrent
                    ? 'bg-primary/10 text-primary animate-pulse'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {isComplete ? (
                  <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : isCurrent ? (
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                ) : null}
                {PHASE_LABELS[phase] || phase}
              </div>
              {idx < phases.length - 1 && (
                <div className={`w-4 h-px ${isComplete ? 'bg-primary/30' : 'bg-border'}`} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* 进度条 */}
      {status !== 'Completed' && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{PHASE_LABELS[currentPhase] || currentPhase}</span>
            <span>{phaseProgress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${phaseProgress}%` }}
            />
          </div>
        </div>
      )}

      {status === 'Completed' && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
          视频生成完成!
        </div>
      )}
    </div>
  );
};
