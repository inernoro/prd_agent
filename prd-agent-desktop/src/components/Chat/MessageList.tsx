import { useRef, useEffect } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import ReactMarkdown from 'react-markdown';

export default function MessageList() {
  const { messages, streamingContent, isStreaming } = useMessageStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.role === 'User' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[80%] p-4 rounded-2xl ${
              message.role === 'User'
                ? 'bg-primary-500 text-white rounded-br-md'
                : 'bg-surface-light dark:bg-surface-dark border border-border rounded-bl-md'
            }`}
          >
            {message.role === 'User' ? (
              <p className="whitespace-pre-wrap">{message.content}</p>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            )}
            
            {message.senderName && (
              <p className="text-xs opacity-70 mt-2">
                {message.senderName} · {message.viewRole}
              </p>
            )}
          </div>
        </div>
      ))}

      {isStreaming && streamingContent && (
        <div className="flex justify-start">
          <div className="max-w-[80%] p-4 rounded-2xl rounded-bl-md bg-surface-light dark:bg-surface-dark border border-border">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{streamingContent}</ReactMarkdown>
            </div>
            <span className="inline-block w-2 h-4 bg-primary-500 animate-pulse ml-1" />
          </div>
        </div>
      )}

      {messages.length === 0 && !isStreaming && (
        <div className="h-full flex items-center justify-center text-text-secondary">
          <div className="text-center">
            <p className="text-lg mb-2">👋 你好！</p>
            <p className="text-sm">有什么关于这份PRD的问题，尽管问我</p>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}


