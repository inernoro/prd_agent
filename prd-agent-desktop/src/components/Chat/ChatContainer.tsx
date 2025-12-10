import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import GuidePanel from '../Guide/GuidePanel';

export default function ChatContainer() {
  const { mode } = useSessionStore();
  const { addMessage, appendStreamingContent, startStreaming, stopStreaming } = useMessageStore();

  useEffect(() => {
    // 监听消息流事件
    const unlistenMessage = listen<{ type: string; content?: string; messageId?: string }>('message-chunk', (event) => {
      const { type, content, messageId } = event.payload;
      
      if (type === 'start') {
        startStreaming();
      } else if (type === 'delta' && content) {
        appendStreamingContent(content);
      } else if (type === 'done') {
        stopStreaming();
      }
    });

    return () => {
      unlistenMessage.then(fn => fn());
    };
  }, []);

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

