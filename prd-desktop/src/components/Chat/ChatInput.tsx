import { useMemo, useState, useRef, KeyboardEvent } from 'react';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { Message, PromptItem, UserRole } from '../../types';

function roleSuffix(role: UserRole) {
  if (role === 'DEV') return 'dev';
  if (role === 'QA') return 'qa';
  return 'pm';
}

function fallbackPrompts(role: UserRole): PromptItem[] {
  const suf = roleSuffix(role);
  const base =
    role === 'DEV'
      ? [
          { order: 1, title: '技术方案概述' },
          { order: 2, title: '核心数据模型' },
          { order: 3, title: '主流程与状态流转' },
          { order: 4, title: '接口清单与规格' },
          { order: 5, title: '技术约束与依赖' },
          { order: 6, title: '开发工作量要点' },
        ]
      : role === 'QA'
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
    promptKey: `legacy-prompt-${x.order}-${suf}`,
    order: x.order,
    role,
    title: x.title,
  }));
}

// 演示模式的模拟回复
const DEMO_RESPONSES = [
  '根据PRD文档的描述，这个功能的核心目标是提升用户体验。让我为您详细解读一下相关内容...',
  '从产品角度来看，这个需求的优先级较高。文档中提到的关键点包括：用户场景分析、功能边界定义、以及预期效果...',
  '关于这个问题，PRD中有明确的说明。主要涉及以下几个方面：1) 业务流程设计 2) 数据流转逻辑 3) 异常处理机制...',
  '这是一个很好的问题。根据文档内容，我们需要关注以下技术实现细节和业务约束条件...',
  '让我查阅一下文档中的相关章节。根据PRD的描述，这个模块的设计考虑了可扩展性和易用性两个维度...',
];

export default function ChatInput() {
  const { sessionId, currentRole, document, prompts } = useSessionStore();
  const { addMessage, isStreaming, startStreaming, stopStreaming, appendToStreamingMessage } = useMessageStore();
  const { user } = useAuthStore();
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 检测是否为演示模式
  const isDemoMode = user?.userId === 'demo-user-001';
  const canChat = !!sessionId;

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

  const promptsForRole = useMemo(() => {
    const list = Array.isArray(prompts) ? prompts : [];
    const filtered = list
      .filter((p) => p.role === currentRole)
      .sort((a, b) => a.order - b.order);
    return filtered.length ? filtered : fallbackPrompts(currentRole);
  }, [prompts, currentRole]);

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

  const handlePromptExplain = async (p: PromptItem) => {
    if (!sessionId || isStreaming) return;
    try {
      const text = `【讲解】${p.title}`;
      const userMessage = pushSimulatedUserMessage(text);

      // 演示模式：走本地模拟
      if (isDemoMode) {
        await simulateStreamingResponse(userMessage.content);
        return;
      }

      await invoke('send_message', {
        sessionId,
        content: userMessage.content,
        role: currentRole.toLowerCase(),
        promptKey: p.promptKey,
      });
    } catch (err) {
      console.error('Failed to send prompt explain:', err);
    }
  };

  const handleSend = async () => {
    if (!content.trim() || !sessionId || isStreaming) return;

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
    <div className="border-t border-border bg-surface-light dark:bg-surface-dark">
      {/* 提示词栏：按当前角色展示 */}
      {canChat && document?.id && (
        <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
          <div className="text-xs text-text-secondary flex-shrink-0">提示词</div>
          <div className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-none">
            {promptsForRole.map((p) => (
              <button
                key={p.promptKey}
                onClick={() => handlePromptExplain(p)}
                disabled={isStreaming}
                className={`flex-shrink-0 px-2.5 py-1.5 text-xs rounded-md transition-all ${
                  'bg-gray-100 dark:bg-gray-800 text-text-secondary hover:bg-gray-200 dark:hover:bg-gray-700'
                } ${isStreaming ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                title={p.title}
              >
                <span className="hidden sm:inline">{p.title}</span>
                <span className="sm:hidden">{p.order}</span>
              </button>
            ))}
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
