import { useState, useRef, KeyboardEvent } from 'react';
import { SendOutlined, LoadingOutlined } from '@ant-design/icons';
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
    
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await sendMessageWithSSE(
        sessionId,
        messageContent,
        currentRole.toLowerCase(),
        () => startStreaming(),
        (chunk) => appendStreamingContent(chunk),
        () => finalizeStreaming(),
        (error) => {
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
    <div className="p-4 border-t border-white/10 bg-black/20 backdrop-blur-sm">
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
            className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 text-white placeholder-gray-500 transition-all"
            rows={1}
            disabled={isStreaming}
          />
        </div>

        <button
          onClick={handleSend}
          disabled={!content.trim() || isStreaming}
          className="p-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-xl hover:from-blue-500 hover:to-blue-400 transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20"
        >
          {isStreaming ? (
            <LoadingOutlined className="text-lg" spin />
          ) : (
            <SendOutlined className="text-lg" />
          )}
        </button>
      </div>
    </div>
  );
}

