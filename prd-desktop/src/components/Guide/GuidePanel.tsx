import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';

const steps = [
  { step: 1, pmTitle: '项目背景', devTitle: '技术方案概述', qaTitle: '功能模块清单' },
  { step: 2, pmTitle: '用户与场景', devTitle: '核心数据模型', qaTitle: '核心业务流程' },
  { step: 3, pmTitle: '解决方案', devTitle: '流程与状态', qaTitle: '边界条件' },
  { step: 4, pmTitle: '功能清单', devTitle: '接口规格', qaTitle: '异常场景' },
  { step: 5, pmTitle: '迭代规划', devTitle: '技术约束', qaTitle: '验收标准' },
  { step: 6, pmTitle: '成功指标', devTitle: '工作量要点', qaTitle: '测试风险' },
];

export default function GuidePanel() {
  const { currentRole, guideStep, setGuideStep } = useSessionStore();
  const { isStreaming } = useMessageStore();

  const getStepTitle = (step: typeof steps[0]) => {
    switch (currentRole) {
      case 'PM': return step.pmTitle;
      case 'DEV': return step.devTitle;
      case 'QA': return step.qaTitle;
      default: return step.pmTitle;
    }
  };

  // 注意：选择阶段/栏目不触发讲解；讲解由输入框上方悬浮栏显式触发
  const selectStep = (step: number) => {
    if (isStreaming) return;
    setGuideStep(step);
  };

  return (
    <div className="px-4 py-3 border-b border-border bg-surface-light dark:bg-surface-dark">
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        {steps.map((step) => (
          <button
            key={step.step}
            onClick={() => selectStep(step.step)}
            disabled={isStreaming}
            className={`group relative flex-shrink-0 min-w-[100px] py-2 px-3 text-xs rounded-lg transition-all duration-200 ${
              guideStep === step.step
                ? 'bg-primary-500 text-white shadow-md shadow-primary-500/25'
                : guideStep > step.step
                ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 hover:bg-primary-200 dark:hover:bg-primary-900/50'
                : 'bg-gray-100 dark:bg-gray-800 text-text-secondary hover:bg-gray-200 dark:hover:bg-gray-700'
            } ${isStreaming ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <div className="flex items-center gap-1.5">
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded text-[10px] font-bold ${
                guideStep === step.step
                  ? 'bg-white/20'
                  : guideStep > step.step
                  ? 'bg-primary-500/20'
                  : 'bg-gray-300 dark:bg-gray-600'
              }`}>
                {step.step}
              </span>
              <span className="font-medium truncate">{getStepTitle(step)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
