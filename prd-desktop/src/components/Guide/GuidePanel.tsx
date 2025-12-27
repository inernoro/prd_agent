import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';

const fallbackSteps = [
  { stageKey: 'legacy-step-1', order: 1, step: 1, pmTitle: '项目背景', devTitle: '技术方案概述', qaTitle: '功能模块清单' },
  { stageKey: 'legacy-step-2', order: 2, step: 2, pmTitle: '用户与场景', devTitle: '核心数据模型', qaTitle: '核心业务流程' },
  { stageKey: 'legacy-step-3', order: 3, step: 3, pmTitle: '解决方案', devTitle: '流程与状态', qaTitle: '边界条件' },
  { stageKey: 'legacy-step-4', order: 4, step: 4, pmTitle: '功能清单', devTitle: '接口规格', qaTitle: '异常场景' },
  { stageKey: 'legacy-step-5', order: 5, step: 5, pmTitle: '迭代规划', devTitle: '技术约束', qaTitle: '验收标准' },
  { stageKey: 'legacy-step-6', order: 6, step: 6, pmTitle: '成功指标', devTitle: '工作量要点', qaTitle: '测试风险' },
];

export default function GuidePanel() {
  const { currentRole, guideStep, setGuideStep, promptStages, activeStageKey, setActiveStageKey } = useSessionStore();
  const { isStreaming } = useMessageStore();

  const steps = (Array.isArray(promptStages) && promptStages.length > 0)
    ? [...promptStages].sort((a, b) => (a.order ?? a.step) - (b.order ?? b.step))
    : fallbackSteps;

  const getStepTitle = (step: typeof steps[number]) => {
    switch (currentRole) {
      case 'PM': return step.pmTitle;
      case 'DEV': return step.devTitle;
      case 'QA': return step.qaTitle;
      default: return step.pmTitle;
    }
  };

  // 注意：选择阶段/栏目不触发讲解；讲解由输入框上方悬浮栏显式触发
  const selectStep = (step: typeof steps[number]) => {
    if (isStreaming) return;
    setGuideStep(step.order ?? step.step);
    setActiveStageKey(step.stageKey);
  };

  return (
    <div className="px-4 py-3 border-b border-border bg-surface-light dark:bg-surface-dark">
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        {steps.map((step) => (
          <button
            key={step.stageKey}
            onClick={() => selectStep(step)}
            disabled={isStreaming}
            className={`group relative flex-shrink-0 min-w-[100px] py-2 px-3 text-xs rounded-lg transition-all duration-200 ${
              (activeStageKey ? activeStageKey === step.stageKey : guideStep === (step.order ?? step.step))
                ? 'bg-primary-500 text-white shadow-md shadow-primary-500/25'
                : guideStep > (step.order ?? step.step)
                ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 hover:bg-primary-200 dark:hover:bg-primary-900/50'
                : 'bg-gray-100 dark:bg-gray-800 text-text-secondary hover:bg-gray-200 dark:hover:bg-gray-700'
            } ${isStreaming ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <div className="flex items-center gap-1.5">
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded text-[10px] font-bold ${
                (activeStageKey ? activeStageKey === step.stageKey : guideStep === (step.order ?? step.step))
                  ? 'bg-white/20'
                  : guideStep > (step.order ?? step.step)
                  ? 'bg-primary-500/20'
                  : 'bg-gray-300 dark:bg-gray-600'
              }`}>
                {step.order ?? step.step}
              </span>
              <span className="font-medium truncate">{getStepTitle(step)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
