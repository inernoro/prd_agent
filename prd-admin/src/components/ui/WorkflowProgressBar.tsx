import { Check } from 'lucide-react';

interface WorkflowStep {
  key: number;
  label: string;
}

interface WorkflowProgressBarProps {
  steps: WorkflowStep[];
  currentStep: number;
  onStepClick?: (stepKey: number) => void;
  /** 暂时不可点（如生成中）。只禁点击，不整条变淡——变淡会让用户读不出自己在哪一步。 */
  disabled?: boolean;
  allCompleted?: boolean; // 所有任务完成时，所有步骤都标亮
}

/**
 * 工作流步骤条。三态各有独立的形状，不只靠颜色区分（浅色主题下同色调淡底浅字读不出来）：
 * - 已完成：绿色实心圆 + 对勾，正文色标签
 * - 当前：主色描边胶囊 + 主色实心编号，加粗
 * - 未开始：灰色编号，弱化标签
 * 颜色全部走主题 token，暗 / 浅双皮肤都成立。
 */
export function WorkflowProgressBar({ steps, currentStep, onStepClick, disabled, allCompleted }: WorkflowProgressBarProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentStep);

  return (
    <div className="mb-3 flex items-center gap-1.5">
      {steps.map((step, index) => {
        const isActive = !allCompleted && index === currentIndex;
        const isCompleted = allCompleted || index < currentIndex;
        const isClickable = !disabled && !!onStepClick;

        return (
          <div key={step.key} className="contents">
            <button
              type="button"
              onClick={() => isClickable && onStepClick(step.key)}
              aria-disabled={!isClickable}
              aria-current={isActive ? 'step' : undefined}
              data-step-state={isActive ? 'active' : isCompleted ? 'done' : 'todo'}
              className={`flex items-center gap-1.5 h-8 pl-1 pr-3 rounded-full text-[13px] whitespace-nowrap shrink-0 transition-colors duration-200${isClickable && !isActive ? ' hover-bg-soft' : ''}`}
              style={{
                fontWeight: isActive ? 700 : 600,
                background: isActive ? 'rgba(var(--accent-primary-rgb), 0.14)' : 'transparent',
                border: isActive ? '1.5px solid var(--accent-primary)' : '1.5px solid transparent',
                color: isActive || isCompleted ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: isClickable ? 'pointer' : disabled ? 'not-allowed' : 'default',
              }}
              title={isActive ? '当前阶段' : disabled ? '进行中，暂不能切换阶段' : `跳转到：${step.label}`}
            >
              <span
                className="inline-flex items-center justify-center rounded-full text-[11px] shrink-0"
                style={{
                  width: 22,
                  height: 22,
                  fontWeight: 700,
                  // 当前步骤的实心编号走主按钮那对 token（对比度已被守卫钉住），不拿 accent 当底配浅字
                  background: isCompleted
                    ? 'var(--accent-fg-success)'
                    : isActive
                      ? 'var(--button-primary-bg)'
                      : 'var(--bg-input-hover)',
                  color: isCompleted ? 'var(--bg-base)' : isActive ? 'var(--button-primary-fg)' : 'var(--text-secondary)',
                }}
              >
                {isCompleted ? <Check size={13} strokeWidth={3} /> : index + 1}
              </span>
              {step.label}
            </button>

            {index < steps.length - 1 && (
              <div
                className="flex-1 h-[2px] rounded-full transition-colors duration-300"
                style={{
                  minWidth: 12,
                  background: isCompleted ? 'var(--accent-fg-success)' : 'var(--border-default)',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
