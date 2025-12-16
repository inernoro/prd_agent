import { useState, useRef, KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { Message } from '../../types';

// 演示模式的模拟回复
const DEMO_RESPONSES = [
  '根据PRD文档的描述，这个功能的核心目标是提升用户体验。让我为您详细解读一下相关内容...',
  '从产品角度来看，这个需求的优先级较高。文档中提到的关键点包括：用户场景分析、功能边界定义、以及预期效果...',
  '关于这个问题，PRD中有明确的说明。主要涉及以下几个方面：1) 业务流程设计 2) 数据流转逻辑 3) 异常处理机制...',
  '这是一个很好的问题。根据文档内容，我们需要关注以下技术实现细节和业务约束条件...',
  '让我查阅一下文档中的相关章节。根据PRD的描述，这个模块的设计考虑了可扩展性和易用性两个维度...',
];

export default function ChatInput() {
  const { sessionId, currentRole } = useSessionStore();
  const { addMessage, isStreaming, startStreaming, stopStreaming, appendToStreamingMessage } = useMessageStore();
  const { user } = useAuthStore();
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 检测是否为演示模式
  const isDemoMode = user?.userId === 'demo-user-001';

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
    <div className="p-4 border-t border-border bg-surface-light dark:bg-surface-dark">
      <div className="flex items-end gap-3">
        <button className="p-2 text-text-secondary hover:text-primary-500 transition-colors">
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
            placeholder="输入您的问题... (Enter 发送, Shift+Enter 换行)"
            className="w-full px-4 py-3 bg-background-light dark:bg-background-dark border border-border rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/50"
            rows={1}
            disabled={isStreaming}
          />
        </div>

        <button
          onClick={handleSend}
          disabled={!content.trim() || isStreaming}
          className="p-3 bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? (
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
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
