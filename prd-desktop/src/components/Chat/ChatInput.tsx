import { useEffect, useMemo, useState, useRef, KeyboardEvent } from 'react';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { Message } from '../../types';

const steps = [
  { step: 1, pmTitle: '项目背景', devTitle: '技术方案概述', qaTitle: '功能模块清单' },
  { step: 2, pmTitle: '用户与场景', devTitle: '核心数据模型', qaTitle: '核心业务流程' },
  { step: 3, pmTitle: '解决方案', devTitle: '流程与状态', qaTitle: '边界条件' },
  { step: 4, pmTitle: '功能清单', devTitle: '接口规格', qaTitle: '异常场景' },
  { step: 5, pmTitle: '迭代规划', devTitle: '技术约束', qaTitle: '验收标准' },
  { step: 6, pmTitle: '成功指标', devTitle: '工作量要点', qaTitle: '测试风险' },
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
  const { sessionId, currentRole, mode, guideStep, document } = useSessionStore();
  const { addMessage, isStreaming, startStreaming, stopStreaming, appendToStreamingMessage, qaMessages, guidedThreads } = useMessageStore();
  const { user } = useAuthStore();
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showExplainGlow, setShowExplainGlow] = useState(false);

  // 检测是否为演示模式
  const isDemoMode = user?.userId === 'demo-user-001';
  const canChat = !!sessionId;

  // 旋转发光提示：同一份 PRD 仅一次，且仅在“未发送任何数据前”显示
  useEffect(() => {
    if (mode !== 'Guided') {
      setShowExplainGlow(false);
      return;
    }
    const docId = document?.id;
    if (!docId) {
      setShowExplainGlow(false);
      return;
    }
    const key = `prdAgent:explainHintSeen:doc:${docId}`;
    try {
      const seen = localStorage.getItem(key) === '1';
      // “发送任何数据前”= 本地还没有任何对话内容（问答或各阶段）
      const hasAny = (qaMessages?.length ?? 0) > 0 || Object.values(guidedThreads ?? {}).some((arr) => (arr?.length ?? 0) > 0);
      if (hasAny) {
        // 有内容则视为已提示过（防止历史会话重复出现）
        localStorage.setItem(key, '1');
        setShowExplainGlow(false);
      } else {
        setShowExplainGlow(!seen);
      }
    } catch {
      // localStorage 不可用时：仍提示一次（仅当前内存）
      setShowExplainGlow(true);
    }
  }, [mode, document?.id, qaMessages, guidedThreads]);

  const markExplainHintSeen = () => {
    const docId = document?.id;
    if (!docId) return;
    const key = `prdAgent:explainHintSeen:doc:${docId}`;
    try {
      localStorage.setItem(key, '1');
    } catch {
      // ignore
    }
    setShowExplainGlow(false);
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
    const step = steps.find((s) => s.step === guideStep) ?? steps[0];
    if (currentRole === 'DEV') return step.devTitle;
    if (currentRole === 'QA') return step.qaTitle;
    return step.pmTitle;
  }, [currentRole, guideStep]);

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
      await invoke('get_guide_step_content', { sessionId, step: guideStep });
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
    <div className="p-3 border-t border-border bg-surface-light dark:bg-surface-dark">
      {mode === 'Guided' && (
        <div className="mb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
              <button
                onClick={handleIntro}
                disabled={!sessionId || isStreaming}
                className="px-2.5 py-1 text-sm rounded-lg border border-border text-text-secondary hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                title="替你发送一句话：简要概括该阶段"
              >
                简介
              </button>
              <span className={`relative inline-flex rounded-[10px] ${showExplainGlow ? 'p-[2px]' : ''}`}>
                {showExplainGlow && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-[6px] rounded-[14px] bg-[conic-gradient(from_0deg,rgba(59,130,246,1),rgba(168,85,247,1),rgba(59,130,246,1))] animate-[spin_2.5s_linear_infinite]"
                    style={{ filter: 'blur(10px)', opacity: 0.85 }}
                  />
                )}
                <button
                  onClick={handleExplain}
                  disabled={!sessionId || isStreaming}
                  className="relative px-2.5 py-1 text-sm rounded-[10px] bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="替你发送一句话：开始讲解该阶段"
                >
                  讲解
                </button>
              </span>
            </div>
          </div>
          <div className="mt-1 text-xs text-text-secondary">
            当前阶段：{guideStep} · {getStepTitle}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button className="h-10 w-10 flex items-center justify-center text-text-secondary hover:text-primary-500 transition-colors">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>

        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              adjustTextareaHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder={canChat ? "输入您的问题... (Enter 发送, Shift+Enter 换行)" : "该群组未绑定 PRD，无法提问。请先在左侧上传并绑定 PRD"}
            className="w-full min-h-[40px] px-3 py-2 bg-background-light dark:bg-background-dark border border-border rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/50"
            rows={1}
            disabled={isStreaming || !canChat}
          />
        </div>

        <button
          onClick={isStreaming ? handleCancel : handleSend}
          disabled={isStreaming ? false : (!content.trim() || !canChat)}
          className="h-10 w-10 flex items-center justify-center bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6h12v12H6z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
