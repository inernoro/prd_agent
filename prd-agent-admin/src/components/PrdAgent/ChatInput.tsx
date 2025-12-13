import { useState, useRef, KeyboardEvent } from 'react';
import { IconSend, IconLoading } from '@arco-design/web-react/icon';
import { usePrdSessionStore } from '../../stores/prdSessionStore';
import { usePrdMessageStore } from '../../stores/prdMessageStore';
import { sendMessageWithSSE } from '../../services/api';
import { ChatMessage } from '../../types';

export default function ChatInput() {
  const { sessionId, currentRole } = usePrdSessionStore();
  const { addMessage, isStreaming, startStreaming, appendStreamingContent, finalizeStreaming } = usePrdMessageStore();
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = async () => {
    if (!content.trim() || !sessionId || isStreaming) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'User',
      content: content.trim(),
      timestamp: new Date(),
      viewRole: currentRole,
    };

    addMessage(userMessage);
    const messageContent = content.trim();
    setContent('');
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await sendMessageWithSSE(
        sessionId,
        messageContent,
        currentRole,
        () => startStreaming(),
        (chunk: string) => appendStreamingContent(chunk),
        () => finalizeStreaming(),
        (error: unknown) => {
          console.error('SSE Error:', error);
          finalizeStreaming();
        }
      );
    } catch (err) {
      console.error('Failed to send message:', err);
      finalizeStreaming();
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
    <div 
      className="p-4"
      style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-card)' }}
    >
      <div className="flex items-end gap-3 max-w-4xl mx-auto">
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
            style={{
              width: '100%',
              padding: '12px 16px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-lg)',
              resize: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontSize: 14,
              lineHeight: 1.5,
            }}
            rows={1}
            disabled={isStreaming}
          />
        </div>

        <button
          onClick={handleSend}
          disabled={!content.trim() || isStreaming}
          style={{
            padding: 12,
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            cursor: !content.trim() || isStreaming ? 'not-allowed' : 'pointer',
            opacity: !content.trim() || isStreaming ? 0.4 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isStreaming ? (
            <IconLoading style={{ fontSize: 18 }} spin />
          ) : (
            <IconSend style={{ fontSize: 18 }} />
          )}
        </button>
      </div>
    </div>
  );
}
