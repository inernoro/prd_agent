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
  const { sessionId, currentRole } = useSessionStore();
  const {
    messages,
    startStreaming,
    appendToStreamingMessage,
    startStreamingBlock,
    appendToStreamingBlock,
    endStreamingBlock,
    setMessageCitations,
    stopStreaming,
    setMessages,
    addMessage,
    isStreaming,
    streamingMessageId,
    streamingPhase,
    setStreamingPhase,
    bindSession,
  } = useMessageStore();

  const showTopPhaseBanner =
    isStreaming &&
    !!streamingPhase &&
    streamingPhase !== 'typing' &&
    // 如果当前已经有“流式气泡”，阶段提示应在气泡内展示，避免重复
    (!streamingMessageId || !messages?.some((m) => m.id === streamingMessageId));

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
  }, [currentRole, startStreaming, appendToStreamingMessage, startStreamingBlock, appendToStreamingBlock, endStreamingBlock, stopStreaming, addMessage, setStreamingPhase, setMessageCitations]);

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

