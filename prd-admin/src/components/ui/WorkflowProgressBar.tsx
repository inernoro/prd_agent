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
 * - 已完成：品牌色实心圆 + 对勾，正文色标签
 * - 当前：品牌色描边胶囊 + 品牌色描边圆圈编号，加粗
 * （已完成不再用「成功绿」：浅色档品牌色改成苔绿后，两种绿会在同一条上打架。
 *   改走 Apple 步骤指示的写法——完成 = 实心，当前 = 描边，未开始 = 灰。）
 * - 未开始：灰色编号，弱化标签
 * 颜色全部走主题 token，暗 / 浅双皮肤都成立。
 */
export function WorkflowProgressBar({ steps, currentStep, onStepClick, disabled, allCompleted }: WorkflowProgressBarProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentStep);

  return (
    // 标签不换行、不收缩（逐字竖排读不了），放不下时整条横向滚动，不撑出所在面板
    // （自动化规则的末步标签会拼接全部动作，长度没有上限）。
    <div className="mb-2.5 flex min-w-0 items-center gap-1.5 overflow-x-auto" style={{ overscrollBehaviorX: 'contain' }}>
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
              className={`flex items-center gap-1.5 h-7 pl-1 pr-2.5 rounded-full text-[12px] whitespace-nowrap shrink-0 transition-colors duration-200${isClickable && !isActive ? ' hover-bg-soft' : ''}`}
              style={{
                fontWeight: isActive ? 600 : 500,
                background: isActive ? 'rgba(var(--accent-primary-rgb), 0.14)' : 'transparent',
                border: isActive ? '1px solid var(--accent-primary)' : '1px solid transparent',
                color: isActive || isCompleted ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: isClickable ? 'pointer' : disabled ? 'not-allowed' : 'default',
              }}
              title={isActive ? '当前阶段' : disabled ? '进行中，暂不能切换阶段' : `跳转到：${step.label}`}
            >
              <span
                className="inline-flex items-center justify-center rounded-full text-[10px] shrink-0"
                style={{
                  width: 18,
                  height: 18,
                  fontWeight: 600,
                  // 已完成的实心圆走主按钮那对 token（对比度已被守卫钉住），不拿 accent 当底配浅字；
                  // 当前步骤是描边圆圈 + 品牌色数字（accent 只当前景色用）
                  background: isCompleted ? 'var(--button-primary-bg)' : isActive ? 'transparent' : 'var(--bg-input-hover)',
                  boxShadow: isActive ? 'inset 0 0 0 1.5px var(--accent-primary)' : undefined,
                  color: isCompleted ? 'var(--button-primary-fg)' : isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                }}
              >
                {isCompleted ? <Check size={11} strokeWidth={3} /> : index + 1}
              </span>
              {step.label}
            </button>

            {index < steps.length - 1 && (
              <div
                className="flex-1 h-px transition-colors duration-300"
                style={{
                  minWidth: 12,
                  background: isCompleted ? 'var(--accent-primary)' : 'var(--border-default)',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
