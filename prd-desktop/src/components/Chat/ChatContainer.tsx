import { useEffect } from 'react';
import { invoke, listen } from '../../lib/tauri';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import MessageList from './MessageList';
import ChatInput from './ChatInput';

const phaseText: Record<string, string> = {
  requesting: '正在请求大模型…',
  connected: '已连接，等待首包…',
  receiving: '正在接收信息…',
  typing: '开始输出…',
};

export default function ChatContainer() {
  const { mode, sessionId, currentRole, guideStep } = useSessionStore();
  const {
    messages,
    startStreaming,
    appendToStreamingMessage,
    startStreamingBlock,
    appendToStreamingBlock,
    endStreamingBlock,
    setMessageCitations,
    setStreamingMessageCitations,
    stopStreaming,
    clearMessages,
    setMessages,
    addMessage,
    isStreaming,
    streamingMessageId,
    streamingPhase,
    setStreamingPhase,
    upsertMessage,
    setContext,
    setGuidedStep,
    bindSession,
  } = useMessageStore();

  const showTopPhaseBanner =
    isStreaming &&
    !!streamingPhase &&
    streamingPhase !== 'typing' &&
    // 如果当前已经有“流式气泡”，阶段提示应在气泡内展示，避免重复
    (!streamingMessageId || !messages?.some((m) => m.id === streamingMessageId));

  // 讲解页按阶段切换对话线程（不影响问答页）
  useEffect(() => {
    setContext(mode === 'Guided' ? 'Guided' : 'QA', guideStep);
  }, [mode, guideStep, setContext]);

  useEffect(() => {
    if (mode === 'Guided') {
      setGuidedStep(guideStep);
    }
  }, [mode, guideStep, setGuidedStep]);

  useEffect(() => {
    // 监听消息流事件
    const unlistenMessage = listen<any>('message-chunk', (event) => {
      const { type, content, messageId, errorMessage, phase, blockId, blockKind, blockLanguage, citations } = event.payload || {};
      
      if (type === 'start') {
        startStreaming({
          id: messageId || `assistant-${Date.now()}`,
          role: 'Assistant',
          content: '',
          timestamp: new Date(),
          viewRole: currentRole,
          blocks: [],
        });
        setStreamingPhase('typing');
      } else if (type === 'blockStart' && blockId && blockKind) {
        startStreamingBlock({ id: blockId, kind: blockKind, language: blockLanguage ?? null });
      } else if (type === 'blockDelta' && blockId && content) {
        appendToStreamingBlock(blockId, content);
      } else if (type === 'blockEnd' && blockId) {
        endStreamingBlock(blockId);
      } else if (type === 'delta' && content) {
        // 兼容旧协议
        appendToStreamingMessage(content);
      } else if (type === 'citations' && messageId && Array.isArray(citations)) {
        setMessageCitations(messageId, citations);
      } else if (type === 'done') {
        stopStreaming();
      } else if (type === 'phase' && phase) {
        setStreamingPhase((phase as any) || null);
      } else if (type === 'error') {
        stopStreaming();
        if (errorMessage) {
          addMessage({
            id: `error-${Date.now()}`,
            role: 'Assistant',
            content: `请求失败：${errorMessage}`,
            timestamp: new Date(),
            viewRole: currentRole,
          });
        }
      }
    }).catch((err) => {
      console.error('Failed to listen to message-chunk event:', err);
      return () => {};
    });

    return () => {
      unlistenMessage.then(fn => fn()).catch((err) => {
        console.error('Failed to unlisten message-chunk event:', err);
      });
    };
  }, [currentRole, startStreaming, appendToStreamingMessage, stopStreaming, addMessage, setStreamingPhase, setMessageCitations]);

  useEffect(() => {
    // 监听引导讲解流事件
    const unlistenGuide = listen<any>(
      'guide-chunk',
      (event) => {
        const { type, content, step, title, errorMessage, phase, blockId, blockKind, blockLanguage, citations } = event.payload as any;

        if (type === 'step') {
          const header = `### 阶段 ${step ?? ''}${title ? `：${title}` : ''}\n\n`;

          // 如果已经有占位的流式气泡，则只补全 header；否则新建
          if (isStreaming && streamingMessageId) {
            const existingHeaderOk = (() => {
              // 只要以 ### 开头就认为已经有 header
              const msg = (useMessageStore.getState().messages || []).find((m) => m.id === streamingMessageId);
              return msg?.content?.trimStart().startsWith('###');
            })();
            if (!existingHeaderOk) {
              const existing = (useMessageStore.getState().messages || []).find((m) => m.id === streamingMessageId);
              const headerBlock = { id: `header-${streamingMessageId}`, kind: 'heading' as const, content: header, isComplete: true as const };
              upsertMessage({
                id: streamingMessageId,
                role: 'Assistant',
                content: header + (existing?.content ?? ''),
                timestamp: new Date(),
                viewRole: currentRole,
                blocks: existing?.blocks?.length ? [headerBlock, ...existing.blocks] : [headerBlock],
              });
            }
          } else {
            const id = `guide-${step ?? guideStep}-${Date.now()}`;
            startStreaming({
              id,
              role: 'Assistant',
              content: header,
              timestamp: new Date(),
              viewRole: currentRole,
              blocks: [{ id: `header-${id}`, kind: 'heading', content: header, isComplete: true }],
            });
          }
        } else if (type === 'blockStart' && blockId && blockKind) {
          startStreamingBlock({ id: blockId, kind: blockKind, language: blockLanguage ?? null });
        } else if (type === 'blockDelta' && blockId && content) {
          appendToStreamingBlock(blockId, content);
          setStreamingPhase('typing');
        } else if (type === 'blockEnd' && blockId) {
          endStreamingBlock(blockId);
        } else if (type === 'delta' && content) {
          // 兼容旧协议（引导）
          appendToStreamingMessage(content);
          setStreamingPhase('typing');
        } else if (type === 'citations' && Array.isArray(citations)) {
          setStreamingMessageCitations(citations);
        } else if (type === 'stepDone') {
          stopStreaming();
        } else if (type === 'phase' && phase) {
          // 在尚未产生 step/delta 之前也要展示友好状态
          setStreamingPhase((phase as any) || null);
          if (phase === 'requesting' && !isStreaming) {
            // 创建占位气泡，避免页面只剩空光标/无反馈
            const id = `guide-pending-${guideStep}-${Date.now()}`;
            startStreaming({
              id,
              role: 'Assistant',
              content: '',
              timestamp: new Date(),
              viewRole: currentRole,
            });
          }
        } else if (type === 'error') {
          stopStreaming();
          addMessage({
            id: `guide-error-${Date.now()}`,
            role: 'Assistant',
            content: `阶段讲解失败：${errorMessage || '未知错误'}`,
            timestamp: new Date(),
            viewRole: currentRole,
          });
        }
      }
    ).catch((err) => {
      console.error('Failed to listen to guide-chunk event:', err);
      return () => {};
    });

    return () => {
      unlistenGuide.then((fn) => fn()).catch((err) => {
        console.error('Failed to unlisten guide-chunk event:', err);
      });
    };
  }, [currentRole, startStreaming, appendToStreamingMessage, stopStreaming, addMessage, isStreaming, streamingMessageId, guideStep, setStreamingPhase, upsertMessage, setStreamingMessageCitations]);

  // 会话切换时加载历史消息
  useEffect(() => {
    if (!sessionId) {
      bindSession(null);
      return;
    }

    const prevBound = useMessageStore.getState().boundSessionId;
    bindSession(sessionId);
    // 同一 session：不要重复加载/清空（包括“切到预览页再返回”的重挂载场景）
    if (prevBound === sessionId) return;

    invoke<{ success: boolean; data?: Array<{ id: string; role: string; content: string; viewRole?: string; timestamp: string }>; error?: { message: string } }>(
      'get_message_history',
      { sessionId, limit: 50 }
    )
      .then((resp) => {
        if (resp.success && resp.data) {
          const mapped = resp.data.map((m) => ({
            id: m.id,
            role: (m.role === 'User' ? 'User' : 'Assistant') as 'User' | 'Assistant',
            content: m.content,
            timestamp: new Date(m.timestamp),
            viewRole: (m.viewRole as any) || undefined,
          }));
          setMessages(mapped);
        }
      })
      .catch((err) => {
        console.error('Failed to load message history:', err);
      });
  }, [sessionId, bindSession, setMessages]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-hidden">
        {showTopPhaseBanner && (
          <div className="px-4 py-2 border-b border-border bg-surface-light dark:bg-surface-dark">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-primary-500 animate-pulse" />
              <span>{phaseText[streamingPhase] || '处理中...'}</span>
            </div>
          </div>
        )}
        <MessageList />
      </div>
      
      <ChatInput />
    </div>
  );
}

