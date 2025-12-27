import { useEffect, useMemo, useState, useRef, KeyboardEvent, useCallback } from 'react';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { Message, PromptStageEnumItem } from '../../types';

const fallbackSteps = [
  { stageKey: 'legacy-step-1', order: 1, step: 1, pmTitle: '项目背景', devTitle: '技术方案概述', qaTitle: '功能模块清单' },
  { stageKey: 'legacy-step-2', order: 2, step: 2, pmTitle: '用户与场景', devTitle: '核心数据模型', qaTitle: '核心业务流程' },
  { stageKey: 'legacy-step-3', order: 3, step: 3, pmTitle: '解决方案', devTitle: '流程与状态', qaTitle: '边界条件' },
  { stageKey: 'legacy-step-4', order: 4, step: 4, pmTitle: '功能清单', devTitle: '接口规格', qaTitle: '异常场景' },
  { stageKey: 'legacy-step-5', order: 5, step: 5, pmTitle: '迭代规划', devTitle: '技术约束', qaTitle: '验收标准' },
  { stageKey: 'legacy-step-6', order: 6, step: 6, pmTitle: '成功指标', devTitle: '工作量要点', qaTitle: '测试风险' },
];

// 演示模式的模拟回复
const DEMO_RESPONSES = [
  '根据PRD文档的描述，这个功能的核心目标是提升用户体验。让我为您详细解读一下相关内容...',
  '从产品角度来看，这个需求的优先级较高。文档中提到的关键点包括：用户场景分析、功能边界定义、以及预期效果...',
  '关于这个问题，PRD中有明确的说明。主要涉及以下几个方面：1) 业务流程设计 2) 数据流转逻辑 3) 异常处理机制...',
  '这是一个很好的问题。根据文档内容，我们需要关注以下技术实现细节和业务约束条件...',
  '让我查阅一下文档中的相关章节。根据PRD的描述，这个模块的设计考虑了可扩展性和易用性两个维度...',
];

export default function ChatInput() {
  const { sessionId, currentRole, mode, guideStep, setGuideStep, document, promptStages, activeStageKey, setActiveStageKey } = useSessionStore();
  const { addMessage, isStreaming, startStreaming, stopStreaming, appendToStreamingMessage } = useMessageStore();
  const { user } = useAuthStore();
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showExplainGlow, setShowExplainGlow] = useState(false);

  // 检测是否为演示模式
  const isDemoMode = user?.userId === 'demo-user-001';
  const canChat = !!sessionId;

  type StageItem = PromptStageEnumItem | typeof fallbackSteps[number];

  // 阶段选择
  const selectStep = useCallback((step: StageItem) => {
    if (isStreaming) return;
    setGuideStep(step.order ?? step.step);
    setActiveStageKey(step.stageKey);
  }, [isStreaming, setGuideStep, setActiveStageKey]);

  // 旋转发光提示：强制常驻（便于调效果）
  useEffect(() => {
    setShowExplainGlow(mode === 'Guided' && !!document?.id);
  }, [mode, document?.id]);

  const markExplainHintSeen = () => {
    // 强制常驻时不关闭动效
  };

  // 演示模式下的模拟流式回复
  const simulateStreamingResponse = async (question: string) => {
    const streamingId = `demo-assistant-${Date.now()}`;
    startStreaming({
      id: streamingId,
      role: 'Assistant',
      content: '',
      timestamp: new Date(),
      viewRole: currentRole,
    });
    
    // 随机选择一个回复模板
    const baseResponse = DEMO_RESPONSES[Math.floor(Math.random() * DEMO_RESPONSES.length)];
    const fullResponse = `${baseResponse}\n\n针对您的问题"${question.slice(0, 50)}${question.length > 50 ? '...' : ''}"，我的建议是结合实际业务场景进行分析，确保理解准确。如有疑问，可以继续提问。`;
    
    // 模拟流式输出
    for (let i = 0; i < fullResponse.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 30));
      appendToStreamingMessage(fullResponse[i]);
    }
    stopStreaming();
  };

  const getStepTitle = useMemo(() => {
    const steps = (Array.isArray(promptStages) && promptStages.length > 0)
      ? [...promptStages].sort((a, b) => (a.order ?? a.step) - (b.order ?? b.step))
      : fallbackSteps;
    const step = (activeStageKey
      ? steps.find((s) => s.stageKey === activeStageKey)
      : steps.find((s) => (s.order ?? s.step) === guideStep)
    ) ?? steps[0];
    if (currentRole === 'DEV') return step.devTitle;
    if (currentRole === 'QA') return step.qaTitle;
    return step.pmTitle;
  }, [currentRole, guideStep, promptStages, activeStageKey]);

  const pushSimulatedUserMessage = (text: string) => {
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'User',
      content: text,
      timestamp: new Date(),
      viewRole: currentRole,
    };
    addMessage(userMessage);
    return userMessage;
  };

  const handleIntro = async () => {
    if (!sessionId || isStreaming) return;
    // 任何发送都视为“已开始使用该 PRD”，关闭一次性提示
    if (showExplainGlow) markExplainHintSeen();
    // “简介”按钮只是替用户发送一句话
    const text = `简介：请用 5 个要点简要概括阶段 ${guideStep}「${getStepTitle}」，并列出该阶段最重要的验收/风险（如有）。`;
    const userMessage = pushSimulatedUserMessage(text);

    // 演示模式：走本地模拟
    if (isDemoMode) {
      await simulateStreamingResponse(userMessage.content);
      return;
    }

    try {
      await invoke('send_message', {
        sessionId,
        content: userMessage.content,
        role: currentRole.toLowerCase(),
        stageKey: activeStageKey ?? undefined,
        stageStep: guideStep, // 兼容字段（后端优先 stageKey）
      });
    } catch (err) {
      console.error('Failed to send intro:', err);
    }
  };

  const handleExplain = async () => {
    if (!sessionId || isStreaming) return;
    // 任何发送都视为“已开始使用该 PRD”，关闭一次性提示
    if (showExplainGlow) markExplainHintSeen();
    // “讲解”按钮：用户显式触发（不自动）
    pushSimulatedUserMessage(`讲解：请开始讲解阶段 ${guideStep}「${getStepTitle}」。`);

    try {
      // 先将后端当前阶段对齐（不直接拉内容）
      await invoke('control_guide', { sessionId, action: 'goto', step: guideStep });
      // 再拉取该阶段的讲解内容（SSE -> guide-chunk）
      if (activeStageKey) {
        await invoke('get_guide_stage_content', { sessionId, stageKey: activeStageKey });
      } else {
        await invoke('get_guide_step_content', { sessionId, step: guideStep });
      }
    } catch (err) {
      console.error('Failed to start explain:', err);
    }
  };

  const handleSend = async () => {
    if (!content.trim() || !sessionId || isStreaming) return;
    if (showExplainGlow) markExplainHintSeen();

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'User',
      content: content.trim(),
      timestamp: new Date(),
      viewRole: currentRole,
    };

    addMessage(userMessage);
    const questionContent = content.trim();
    setContent('');

    // 演示模式：模拟回复
    if (isDemoMode) {
      await simulateStreamingResponse(questionContent);
      return;
    }

    try {
      await invoke('send_message', {
        sessionId,
        content: userMessage.content,
        role: currentRole.toLowerCase(),
        stageKey: activeStageKey ?? undefined,
        stageStep: guideStep, // 兼容字段（后端优先 stageKey）
      });
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  };

  const handleCancel = async () => {
    if (!isStreaming) return;
    try {
      await invoke('cancel_stream', { kind: 'all' });
    } catch (err) {
      console.error('Failed to cancel stream:', err);
    } finally {
      stopStreaming();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  };

  return (
    <div className="border-t border-border bg-surface-light dark:bg-surface-dark">
      {/* 讲解模式阶段选择栏 */}
      {mode === 'Guided' && (
        <div className="px-3 py-2 flex items-center gap-2">
          {/* 阶段选择按钮 */}
          <div className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-none">
            {((Array.isArray(promptStages) && promptStages.length > 0)
              ? [...promptStages].sort((a, b) => (a.order ?? a.step) - (b.order ?? b.step))
              : fallbackSteps
            ).map((step) => (
              <button
                key={step.stageKey}
                onClick={() => selectStep(step)}
                disabled={isStreaming}
                className={`flex-shrink-0 px-2.5 py-1.5 text-xs rounded-md transition-all ${
                  (activeStageKey ? activeStageKey === step.stageKey : guideStep === (step.order ?? step.step))
                    ? 'bg-primary-500 text-white shadow-sm'
                    : 'bg-gray-100 dark:bg-gray-800 text-text-secondary hover:bg-gray-200 dark:hover:bg-gray-700'
                } ${isStreaming ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <span className="font-medium">{step.order ?? step.step}</span>
                <span className="ml-1 hidden sm:inline">{currentRole === 'DEV' ? step.devTitle : currentRole === 'QA' ? step.qaTitle : step.pmTitle}</span>
              </button>
            ))}
          </div>

          {/* 简介/讲解按钮 */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={handleIntro}
              disabled={!sessionId || isStreaming}
              className="min-w-[3.25rem] px-2.5 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-primary-500 hover:border-primary-500/50 hover:bg-primary-50 dark:hover:bg-primary-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="简要概括该阶段"
            >
              简介
            </button>
            {showExplainGlow ? (
              <button
                onClick={handleExplain}
                disabled={!sessionId || isStreaming}
                className="min-w-[3.25rem] px-2.5 py-1.5 text-xs rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="开始讲解该阶段"
              >
                讲解
              </button>
            ) : (
              <button
                onClick={handleExplain}
                disabled={!sessionId || isStreaming}
                className="min-w-[3.25rem] px-2.5 py-1.5 text-xs rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="开始讲解该阶段"
              >
                讲解
              </button>
            )}
          </div>
        </div>
      )}

      {/* 输入区域 */}
      <div className="px-3 pb-3 pt-2 flex items-end gap-2">
        <button className="h-9 w-9 flex-shrink-0 flex items-center justify-center text-text-secondary hover:text-primary-500 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>

        {/* 关键：min-w-0 允许在 flex 行内收缩，避免 placeholder 撑宽导致“没对齐/溢出” */}
        <div className="flex-1 min-w-0 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              adjustTextareaHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder={canChat ? "输入您的问题... (Enter 发送, Shift+Enter 换行)" : "该群组未绑定 PRD，无法提问"}
            className="w-full min-w-0 min-h-[36px] px-3 py-2 bg-background-light dark:bg-background-dark border border-border rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/50 text-sm"
            rows={1}
            disabled={isStreaming || !canChat}
          />
        </div>

        <button
          onClick={isStreaming ? handleCancel : handleSend}
          disabled={isStreaming ? false : (!content.trim() || !canChat)}
          className="h-9 w-9 flex-shrink-0 flex items-center justify-center bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6h12v12H6z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
