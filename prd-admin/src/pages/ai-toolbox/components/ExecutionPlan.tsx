import type { ToolboxRunStep } from '@/services';
import { Check, Loader2, AlertCircle, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ExecutionPlanProps {
  steps: ToolboxRunStep[];
  streamingContent: Record<string, string>;
}

const AGENT_ICONS: Record<string, string> = {
  'prd-agent': '📋',
  'visual-agent': '🎨',
  'literary-agent': '✍️',
  'defect-agent': '🐛',
};

export function ExecutionPlan({ steps, streamingContent }: ExecutionPlanProps) {
  return (
    <div className="space-y-4">
      <h3
        className="text-sm font-medium flex items-center gap-2"
        style={{ color: 'var(--text-primary)' }}
      >
        执行计划
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
        >
          {steps.length} 步
        </span>
      </h3>

      <div className="relative">
        {/* Progress line */}
        <div
          className="absolute left-[15px] top-0 bottom-0 w-0.5"
          style={{ background: 'var(--border-default)' }}
        />

        {/* Steps */}
        <div className="space-y-4">
          {steps.map((step, index) => (
            <StepItem
              key={step.stepId}
              step={step}
              index={index}
              isLast={index === steps.length - 1}
              streamingContent={streamingContent[step.stepId]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface StepItemProps {
  step: ToolboxRunStep;
  index: number;
  isLast: boolean;
  streamingContent?: string;
}

function StepItem({ step, index, streamingContent }: StepItemProps) {
  const status = step.status;
  const isRunning = status === 'Running';
  const isCompleted = status === 'Completed';
  const isFailed = status === 'Failed';
  const isPending = status === 'Pending';

  const icon = AGENT_ICONS[step.agentKey] || '🤖';

  return (
    <div className="relative pl-10">
      {/* Status icon */}
      <div
        className={cn(
          'absolute left-0 w-8 h-8 rounded-full flex items-center justify-center border-2',
          isCompleted && 'border-[var(--status-success)] bg-[var(--status-success)]/10',
          isFailed && 'border-[var(--status-error)] bg-[var(--status-error)]/10',
          isRunning && 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10',
          isPending && 'border-[var(--border-default)] bg-[var(--bg-base)]'
        )}
      >
        {isCompleted && <Check size={14} style={{ color: 'var(--status-success)' }} />}
        {isFailed && <AlertCircle size={14} style={{ color: 'var(--status-error)' }} />}
        {isRunning && <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent-primary)' }} />}
        {isPending && <Circle size={14} style={{ color: 'var(--text-muted)' }} />}
      </div>

      {/* Content */}
      <div
        className={cn(
          'p-3 rounded-lg border transition-all',
          isRunning && 'border-[var(--accent-primary)]/50 bg-[var(--accent-primary)]/5',
          isCompleted && 'border-[var(--status-success)]/30',
          isFailed && 'border-[var(--status-error)]/30',
          isPending && 'border-[var(--border-default)] opacity-60'
        )}
        style={{ background: 'var(--bg-elevated)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-base">{icon}</span>
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {step.agentDisplayName}
          </span>
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}
          >
            步骤 {index + 1}
          </span>
          {isRunning && (
            <span
              className="text-xs px-1.5 py-0.5 rounded animate-pulse"
              style={{ background: 'var(--accent-primary)/20', color: 'var(--accent-primary)' }}
            >
              执行中
            </span>
          )}
        </div>

        {/* Action */}
        <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
          {step.action}
        </div>

        {/* Streaming content */}
        {isRunning && streamingContent && (
          <div
            className="mt-2 p-2 rounded text-xs whitespace-pre-wrap max-h-40 overflow-auto"
            style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}
          >
            {streamingContent}
            <span className="inline-block w-1 h-3 ml-0.5 animate-pulse" style={{ background: 'var(--accent-primary)' }} />
          </div>
        )}

        {/* Completed output */}
        {isCompleted && step.output && (
          <div
            className="mt-2 p-2 rounded text-xs whitespace-pre-wrap max-h-40 overflow-auto"
            style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}
          >
            {step.output.length > 500 ? `${step.output.slice(0, 500)}...` : step.output}
          </div>
        )}

        {/* Error */}
        {isFailed && step.errorMessage && (
          <div
            className="mt-2 p-2 rounded text-xs"
            style={{ background: 'var(--status-error)/10', color: 'var(--status-error)' }}
          >
            {step.errorMessage}
          </div>
        )}
      </div>
    </div>
  );
}
