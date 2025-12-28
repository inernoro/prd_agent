import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';

function roleSuffix(role: string) {
  if (role === 'DEV') return 'dev';
  if (role === 'QA') return 'qa';
  return 'pm';
}

function fallbackStages(role: string) {
  const safeRole = role === 'DEV' || role === 'QA' ? role : 'PM';
  const suf = roleSuffix(safeRole);
  const base =
    safeRole === 'DEV'
      ? [
          { order: 1, title: '技术方案概述' },
          { order: 2, title: '核心数据模型' },
          { order: 3, title: '主流程与状态流转' },
          { order: 4, title: '接口清单与规格' },
          { order: 5, title: '技术约束与依赖' },
          { order: 6, title: '开发工作量要点' },
        ]
      : safeRole === 'QA'
        ? [
            { order: 1, title: '功能模块清单' },
            { order: 2, title: '核心业务流程' },
            { order: 3, title: '边界条件与约束' },
            { order: 4, title: '异常场景汇总' },
            { order: 5, title: '验收标准明细' },
            { order: 6, title: '测试重点与风险' },
          ]
        : [
            { order: 1, title: '项目背景与问题定义' },
            { order: 2, title: '核心用户与使用场景' },
            { order: 3, title: '解决方案概述' },
            { order: 4, title: '核心功能清单' },
            { order: 5, title: '优先级与迭代规划' },
            { order: 6, title: '成功指标与验收标准' },
          ];
  return base.map((x) => ({
    stageKey: `legacy-step-${x.order}-${suf}`,
    order: x.order,
    role: safeRole,
    title: x.title,
  }));
}

export default function GuidePanel() {
  const { currentRole, guideStep, setGuideStep, promptStages, activeStageKey, setActiveStageKey } = useSessionStore();
  const { isStreaming } = useMessageStore();

  const steps = (Array.isArray(promptStages) && promptStages.length > 0)
    ? promptStages.filter((s) => s.role === currentRole).sort((a, b) => a.order - b.order)
    : fallbackStages(currentRole);

  // 注意：选择阶段/栏目不触发讲解；讲解由输入框上方悬浮栏显式触发
  const selectStep = (step: typeof steps[number]) => {
    if (isStreaming) return;
    setGuideStep(step.order);
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
              (activeStageKey ? activeStageKey === step.stageKey : guideStep === step.order)
                ? 'bg-primary-500 text-white shadow-md shadow-primary-500/25'
              : guideStep > step.order
                ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 hover:bg-primary-200 dark:hover:bg-primary-900/50'
                : 'bg-gray-100 dark:bg-gray-800 text-text-secondary hover:bg-gray-200 dark:hover:bg-gray-700'
            } ${isStreaming ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <div className="flex items-center gap-1.5">
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded text-[10px] font-bold ${
                (activeStageKey ? activeStageKey === step.stageKey : guideStep === step.order)
                  ? 'bg-white/20'
                : guideStep > step.order
                  ? 'bg-primary-500/20'
                  : 'bg-gray-300 dark:bg-gray-600'
              }`}>
                {step.order}
              </span>
              <span className="font-medium truncate">{step.title}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
