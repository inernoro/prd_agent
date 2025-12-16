import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import GuidePanel from '../Guide/GuidePanel';

export default function ChatContainer() {
  const { mode, sessionId, currentRole } = useSessionStore();
  const { startStreaming, appendToStreamingMessage, stopStreaming, clearMessages, setMessages, addMessage } = useMessageStore();

  useEffect(() => {
    // 监听消息流事件
    const unlistenMessage = listen<{ type: string; content?: string; messageId?: string; errorMessage?: string }>('message-chunk', (event) => {
      const { type, content, messageId, errorMessage } = event.payload;
      
      if (type === 'start') {
        startStreaming({
          id: messageId || `assistant-${Date.now()}`,
          role: 'Assistant',
          content: '',
          timestamp: new Date(),
          viewRole: currentRole,
        });
      } else if (type === 'delta' && content) {
        appendToStreamingMessage(content);
      } else if (type === 'done') {
        stopStreaming();
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
    });

    return () => {
      unlistenMessage.then(fn => fn());
    };
  }, [currentRole, startStreaming, appendToStreamingMessage, stopStreaming, addMessage]);

  useEffect(() => {
    // 监听引导讲解流事件
    const unlistenGuide = listen<{ type: string; content?: string; step?: number; title?: string; errorMessage?: string }>(
      'guide-chunk',
      (event) => {
        const { type, content, step, title, errorMessage } = event.payload;

        if (type === 'step') {
          const id = `guide-${step ?? 0}-${Date.now()}`;
          const header = `### Step ${step ?? ''}${title ? `：${title}` : ''}\n\n`;
          startStreaming({
            id,
            role: 'Assistant',
            content: header,
            timestamp: new Date(),
            viewRole: currentRole,
          });
        } else if (type === 'delta' && content) {
          appendToStreamingMessage(content);
        } else if (type === 'stepDone') {
          stopStreaming();
        } else if (type === 'error') {
          stopStreaming();
          addMessage({
            id: `guide-error-${Date.now()}`,
            role: 'Assistant',
            content: `引导讲解失败：${errorMessage || '未知错误'}`,
            timestamp: new Date(),
            viewRole: currentRole,
          });
        }
      }
    );

    return () => {
      unlistenGuide.then((fn) => fn());
    };
  }, [currentRole, startStreaming, appendToStreamingMessage, stopStreaming, addMessage]);

  // 会话切换时加载历史消息
  useEffect(() => {
    if (!sessionId) {
      clearMessages();
      return;
    }

    clearMessages();
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
  }, [sessionId, clearMessages, setMessages]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {mode === 'Guided' && <GuidePanel />}
      
      <div className="flex-1 overflow-hidden">
        <MessageList />
      </div>
      
      <ChatInput />
    </div>
  );
}

