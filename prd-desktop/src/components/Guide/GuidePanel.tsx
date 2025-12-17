import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { ApiResponse } from '../../types';
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
  const { sessionId, currentRole, guideStep, setGuideStep, setMode } = useSessionStore();
  const { isStreaming } = useMessageStore();

  const getStepTitle = (step: typeof steps[0]) => {
    switch (currentRole) {
      case 'PM': return step.pmTitle;
      case 'DEV': return step.devTitle;
      case 'QA': return step.qaTitle;
      default: return step.pmTitle;
    }
  };

  const handleExit = async () => {
    if (!sessionId) {
      setMode('QA');
      return;
    }
    try {
      const response = await invoke<ApiResponse<{ currentStep: number; status: string }>>('control_guide', {
        sessionId,
        action: 'stop',
      });
      if (response.success) setMode('QA');
    } catch (err) {
      console.error('Failed to stop guide:', err);
      setMode('QA');
    }
  };

  // 注意：选择阶段/栏目不触发讲解；讲解由输入框上方悬浮栏显式触发
  const selectStep = (step: number) => {
    if (isStreaming) return;
    setGuideStep(step);
  };

  return (
    <div className="px-4 py-3 border-b border-border bg-surface-light dark:bg-surface-dark">
      {/* <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium">阶段讲解</h3>
          <div className="mt-0.5 text-xs text-text-secondary">
            先选择阶段，再点击输入框上方的“简介/讲解”开始生成内容
          </div>
        </div>
        <button
          onClick={handleExit}
          className="text-xs text-text-secondary hover:text-primary-500"
        >
          返回问答
        </button>
      </div> */}

      <div className="flex items-center gap-2">
        {steps.map((step) => (
          <button
            key={step.step}
            onClick={() => selectStep(step.step)}
            disabled={isStreaming}
            className={`flex-1 py-2 px-3 text-xs rounded-lg transition-colors ${
              guideStep === step.step
                ? 'bg-primary-500 text-white'
                : guideStep > step.step
                ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                : 'bg-gray-100 dark:bg-gray-800 text-text-secondary'
            } ${isStreaming ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <div className="font-medium">阶段 {step.step}</div>
            <div className="text-[10px] opacity-80 truncate">{getStepTitle(step)}</div>
          </button>
        ))}
      </div>

      {/* <div className="flex items-center justify-between mt-3">
        <button
          onClick={() => selectStep(Math.max(1, guideStep - 1))}
          disabled={guideStep <= 1}
          className="px-3 py-1.5 text-sm text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded disabled:opacity-50"
        >
          ← 上一步
        </button>
        <span className="text-sm text-text-secondary">
          {guideStep} / 6
        </span>
        <button
          onClick={() => selectStep(Math.min(6, guideStep + 1))}
          disabled={guideStep >= 6}
          className="px-3 py-1.5 text-sm text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded disabled:opacity-50"
        >
          下一步 →
        </button>
      </div> */}
    </div>
  );
}
