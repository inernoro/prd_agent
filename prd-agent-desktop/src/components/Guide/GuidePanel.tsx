import { invoke } from '@tauri-apps/api/core';
import { useSessionStore } from '../../stores/sessionStore';
import { ApiResponse } from '../../types';

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

  const getStepTitle = (step: typeof steps[0]) => {
    switch (currentRole) {
      case 'PM': return step.pmTitle;
      case 'DEV': return step.devTitle;
      case 'QA': return step.qaTitle;
      default: return step.pmTitle;
    }
  };

  const handleControl = async (action: 'next' | 'prev' | 'goto' | 'stop', targetStep?: number) => {
    if (!sessionId) return;

    try {
      const response = await invoke<ApiResponse<{ currentStep: number; status: string }>>('control_guide', {
        sessionId,
        action,
        step: targetStep,
      });

      if (response.success && response.data) {
        setGuideStep(response.data.currentStep);
        if (response.data.status === 'stopped') {
          setMode('QA');
        }
      }
    } catch (err) {
      console.error('Failed to control guide:', err);
    }
  };

  return (
    <div className="px-4 py-3 border-b border-border bg-surface-light dark:bg-surface-dark">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">引导讲解模式</h3>
        <button
          onClick={() => handleControl('stop')}
          className="text-xs text-text-secondary hover:text-primary-500"
        >
          退出引导
        </button>
      </div>

      <div className="flex items-center gap-2">
        {steps.map((step) => (
          <button
            key={step.step}
            onClick={() => handleControl('goto', step.step)}
            className={`flex-1 py-2 px-3 text-xs rounded-lg transition-colors ${
              guideStep === step.step
                ? 'bg-primary-500 text-white'
                : guideStep > step.step
                ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                : 'bg-gray-100 dark:bg-gray-800 text-text-secondary'
            }`}
          >
            <div className="font-medium">Step {step.step}</div>
            <div className="text-[10px] opacity-80 truncate">{getStepTitle(step)}</div>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mt-3">
        <button
          onClick={() => handleControl('prev')}
          disabled={guideStep <= 1}
          className="px-3 py-1.5 text-sm text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded disabled:opacity-50"
        >
          ← 上一步
        </button>
        <span className="text-sm text-text-secondary">
          {guideStep} / 6
        </span>
        <button
          onClick={() => handleControl('next')}
          disabled={guideStep >= 6}
          className="px-3 py-1.5 text-sm text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded disabled:opacity-50"
        >
          下一步 →
        </button>
      </div>
    </div>
  );
}


