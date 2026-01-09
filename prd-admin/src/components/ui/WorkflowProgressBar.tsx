interface WorkflowStep {
  key: number;
  label: string;
}

interface WorkflowProgressBarProps {
  steps: WorkflowStep[];
  currentStep: number;
  onStepClick?: (stepKey: number) => void;
  disabled?: boolean;
  allCompleted?: boolean; // 所有任务完成时，所有步骤都标亮
}

export function WorkflowProgressBar({ steps, currentStep, onStepClick, disabled, allCompleted }: WorkflowProgressBarProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentStep);

  return (
    <div className="mb-3 flex items-center justify-center gap-2">
      {steps.map((step, index) => {
        const isActive = !allCompleted && index === currentIndex;
        const isCompleted = allCompleted || index < currentIndex;
        const isClickable = !disabled && onStepClick;

        return (
          <div key={step.key} className="flex items-center gap-2">
            {/* Step button */}
            <button
              type="button"
              onClick={() => isClickable && onStepClick(step.key)}
              disabled={!isClickable}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-300"
              style={{
                background: isActive
                  ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.25) 0%, rgba(245, 158, 11, 0.15) 100%)'
                  : isCompleted
                  ? 'rgba(34, 197, 94, 0.15)'
                  : 'rgba(255, 255, 255, 0.05)',
                border: isActive
                  ? '1px solid rgba(245, 158, 11, 0.4)'
                  : isCompleted
                  ? '1px solid rgba(34, 197, 94, 0.3)'
                  : '1px solid rgba(255, 255, 255, 0.1)',
                color: isActive
                  ? 'rgba(245, 158, 11, 0.95)'
                  : isCompleted
                  ? 'rgba(34, 197, 94, 0.9)'
                  : 'rgba(255, 255, 255, 0.4)',
                cursor: isClickable ? 'pointer' : 'default',
                opacity: disabled ? 0.5 : 1,
              }}
              title={isActive ? '当前阶段' : `跳转到：${step.label}`}
            >
              {step.label}
            </button>

            {/* Arrow connector */}
            {index < steps.length - 1 && (
              <div
                className="w-6 h-0.5 transition-all duration-300"
                style={{
                  background: isCompleted
                    ? 'rgba(34, 197, 94, 0.4)'
                    : 'rgba(255, 255, 255, 0.1)',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
