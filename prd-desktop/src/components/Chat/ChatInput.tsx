import { useCallback, useEffect, useMemo, useState, useRef, KeyboardEvent } from 'react';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useConnectionStore } from '../../stores/connectionStore';
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
  const { addUserMessageWithPendingAssistant, isStreaming, startStreaming, stopStreaming, appendToStreamingMessage } = useMessageStore();
  const { user } = useAuthStore();
  const connectionStatus = useConnectionStore((s) => s.status);
  const isDisconnected = connectionStatus === 'disconnected';
  const [content, setContent] = useState('');
  const [resendTargetMessageId, setResendTargetMessageId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputHeight, setInputHeight] = useState(36);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 检测是否为演示模式
  const isDemoMode = user?.userId === 'demo-user-001';
  const canChat = !!sessionId;
  const canChatNow = canChat && !isDisconnected;

  // 等待 UI 先完成一次/两次绘制，再发起请求（避免 invoke 的同步开销挡住首帧反馈）
  const waitForUiPaint = useCallback(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    // 再等待一帧，确保样式/布局提交（避免使用 setTimeout 人为延迟）
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }, []);

  // 当真正进入流式阶段（start 到达）后，用 isStreaming 接管禁用逻辑
  useEffect(() => {
    if (isStreaming && isSubmitting) setIsSubmitting(false);
  }, [isStreaming, isSubmitting]);

  // 外部触发：预填输入框（用于“重发”）
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const ce = e as CustomEvent<{ content?: string; resendMessageId?: string | null }>;
      const next = String(ce?.detail?.content ?? '').trim();
      const mid = ce?.detail?.resendMessageId ? String(ce.detail.resendMessageId) : null;
      if (!next) return;
      setContent(next);
      setResendTargetMessageId(mid);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        // 光标放末尾
        const ta = textareaRef.current;
        if (ta) {
          const len = ta.value.length;
          try { ta.setSelectionRange(len, len); } catch { /* ignore */ }
        }
      });
    };
    window.addEventListener('prdAgent:prefillChatInput' as any, onPrefill as EventListener);
    return () => window.removeEventListener('prdAgent:prefillChatInput' as any, onPrefill as EventListener);
  }, []);

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
      senderId: user?.userId ?? undefined,
      senderName: user?.displayName ?? undefined,
    };
    // 插入占位 assistant + 滚到底：避免“点了没反应/卡住”的体感
    addUserMessageWithPendingAssistant({ userMessage });
    return userMessage;
  };

  const handlePromptExplain = async (p: PromptItem) => {
    if (!sessionId || isStreaming || isSubmitting || isDisconnected) return;
    try {
      setIsSubmitting(true);
      const text = `【讲解】${p.title}`;
      const userMessage = pushSimulatedUserMessage(text);

      // 演示模式：走本地模拟
      if (isDemoMode) {
        await waitForUiPaint();
        await simulateStreamingResponse(userMessage.content);
        return;
      }

      await waitForUiPaint();
      await invoke('send_message', {
        sessionId,
        content: userMessage.content,
        role: currentRole.toLowerCase(),
        promptKey: p.promptKey,
      });
    } catch (err) {
      console.error('Failed to send prompt explain:', err);
      setIsSubmitting(false);
    }
  };

  const handleSend = async () => {
    if (!content.trim() || !sessionId || isStreaming || isSubmitting || isDisconnected) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'User',
      content: content.trim(),
      timestamp: new Date(),
      viewRole: currentRole,
      senderId: user?.userId ?? undefined,
      senderName: user?.displayName ?? undefined,
    };

    setIsSubmitting(true);
    addUserMessageWithPendingAssistant({ userMessage });
    const questionContent = content.trim();
    setContent('');

    // 演示模式：模拟回复
    if (isDemoMode) {
      await waitForUiPaint();
      await simulateStreamingResponse(questionContent);
      return;
    }

    try {
      // 先让“用户消息 + loading 气泡 + 滚到底”完成渲染，再开始请求
      await waitForUiPaint();
      if (resendTargetMessageId) {
        const target = resendTargetMessageId;
        setResendTargetMessageId(null);
        await invoke('resend_message', {
          sessionId,
          messageId: target,
          content: userMessage.content,
          role: currentRole.toLowerCase(),
        });
      } else {
        await invoke('send_message', {
          sessionId,
          content: userMessage.content,
          role: currentRole.toLowerCase(),
        });
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      setIsSubmitting(false);
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

  // 统一控制高度：按钮与单行输入框永远对齐（避免反复出现“差一点点”）
  const CONTROL_HEIGHT = 36;

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const next = Math.max(CONTROL_HEIGHT, Math.min(textarea.scrollHeight, 200));
      textarea.style.height = next + 'px';
      // 用 textarea 实际高度作为“对齐基准”：按钮容器强制同高，彻底杜绝像素漂移
      setInputHeight(next);
    }
  }, []);

  // 关键：发送后会 setContent('')，但如果不重算高度，textarea 会保留上一次的高，导致和按钮不对齐
  useEffect(() => {
    const raf = requestAnimationFrame(() => adjustTextareaHeight());
    return () => cancelAnimationFrame(raf);
  }, [content, adjustTextareaHeight]);

  return (
    <div className="border-t ui-glass-bar">
      {/* 提示词栏：按当前角色展示 */}
      {canChat && document?.id && (
        <div className="px-3 py-2 flex items-center gap-2 border-b border-black/10 dark:border-white/10 ui-glass-bar">
          <div className="text-xs text-text-secondary flex-shrink-0">提示词</div>
          <div className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-none">
            {promptsForRole.map((p) => (
              <button
                key={p.promptKey}
                onClick={() => handlePromptExplain(p)}
                disabled={isStreaming || isSubmitting || isDisconnected}
                className={`flex-shrink-0 px-2.5 py-1.5 text-xs ui-chip transition-colors ${
                  isStreaming || isSubmitting || isDisconnected ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
                } text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5`}
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
      <div className="px-3 pb-3 pt-2">
        {/* 最简单布局：3列（附件 / 输入 / 发送），高度对齐；textarea 仅向上增长 */}
        <div className="grid grid-cols-[36px,1fr,36px] items-stretch gap-2">
        <div className="flex items-end" style={{ height: `${inputHeight}px` }}>
          <button
            type="button"
            className="h-9 w-9 flex items-center justify-center text-text-secondary hover:text-primary-500 transition-colors rounded-lg hover:bg-black/5 dark:hover:bg-white/5"
            aria-label="附件"
            title="附件"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>
        </div>

        {/* 关键：min-w-0 允许在网格中收缩，避免 placeholder 撑宽导致溢出 */}
        <div className="min-w-0 relative flex items-stretch" style={{ height: `${inputHeight}px` }}>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isDisconnected
                ? "服务器已断开连接，正在重连…"
                : (canChat ? "输入您的问题... (Enter 发送, Shift+Enter 换行)" : "该群组未绑定 PRD，无法提问")
            }
            className="w-full min-w-0 px-3 py-2 ui-control rounded-xl resize-none text-sm overflow-y-hidden"
            rows={1}
            disabled={isStreaming || !canChatNow}
          />
        </div>

        <div className="flex items-end justify-end" style={{ height: `${inputHeight}px` }}>
          <button
            onClick={isStreaming ? handleCancel : handleSend}
            disabled={isStreaming ? false : (isSubmitting || !content.trim() || !canChatNow)}
            className="h-9 w-9 flex items-center justify-center bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={isStreaming ? '停止' : '发送'}
            title={isStreaming ? '停止' : '发送'}
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
      </div>
    </div>
  );
}
