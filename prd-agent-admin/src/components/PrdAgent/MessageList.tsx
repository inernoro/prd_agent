import { useRef, useEffect } from 'react';
import { usePrdMessageStore } from '../../stores/prdMessageStore';
import ReactMarkdown from 'react-markdown';
import { IconUser, IconRobot } from '@arco-design/web-react/icon';

export default function MessageList() {
  const { messages, streamingContent, isStreaming } = usePrdMessageStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  return (
    <div className="h-full overflow-y-auto p-6" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {messages.map((message) => (
        <div
          key={message.id}
          className="flex gap-3"
          style={{ flexDirection: message.role === 'User' ? 'row-reverse' : 'row' }}
        >
          <div 
            style={{
              width: 32,
              height: 32,
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              background: message.role === 'User' ? 'var(--accent)' : 'linear-gradient(135deg, #8b5cf6, #ec4899)',
            }}
          >
            {message.role === 'User' ? (
              <IconUser style={{ color: '#fff', fontSize: 14 }} />
            ) : (
              <IconRobot style={{ color: '#fff', fontSize: 14 }} />
            )}
          </div>
          
          <div
            style={{
              maxWidth: '75%',
              padding: 'var(--space-4)',
              borderRadius: 'var(--radius-lg)',
              background: message.role === 'User' ? 'var(--accent)' : 'var(--bg-card)',
              border: message.role === 'User' ? 'none' : '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              borderTopRightRadius: message.role === 'User' ? 'var(--radius-sm)' : 'var(--radius-lg)',
              borderTopLeftRadius: message.role === 'User' ? 'var(--radius-lg)' : 'var(--radius-sm)',
            }}
          >
            {message.role === 'User' ? (
              <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{message.content}</p>
            ) : (
              <div className="prose prose-sm prose-invert max-w-none">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            )}
            
            {message.viewRole && (
              <p style={{ fontSize: 11, opacity: 0.6, marginTop: 'var(--space-2)' }}>
                以 {message.viewRole} 视角
              </p>
            )}
          </div>
        </div>
      ))}

      {isStreaming && (
        <div className="flex gap-3">
          <div 
            style={{
              width: 32,
              height: 32,
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
            }}
          >
            <IconRobot style={{ color: '#fff', fontSize: 14 }} />
          </div>
          <div 
            style={{
              maxWidth: '75%',
              padding: 'var(--space-4)',
              borderRadius: 'var(--radius-lg)',
              borderTopLeftRadius: 'var(--radius-sm)',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
            }}
          >
            <div className="prose prose-sm prose-invert max-w-none">
              <ReactMarkdown>{streamingContent || '思考中...'}</ReactMarkdown>
            </div>
            <span 
              style={{
                display: 'inline-block',
                width: 8,
                height: 16,
                background: 'var(--accent)',
                marginLeft: 4,
                borderRadius: 2,
                animation: 'pulse 1s infinite',
              }}
            />
          </div>
        </div>
      )}

      {messages.length === 0 && !isStreaming && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div 
              style={{
                width: 72,
                height: 72,
                margin: '0 auto var(--space-6)',
                background: 'var(--accent-muted)',
                borderRadius: 'var(--radius-lg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconRobot style={{ fontSize: 32, color: 'var(--accent)' }} />
            </div>
            <p style={{ fontSize: 18, color: 'var(--text-primary)', marginBottom: 'var(--space-2)' }}>你好!</p>
            <p style={{ color: 'var(--text-muted)' }}>有什么关于这份 PRD 的问题，尽管问我</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 'var(--space-2)' }}>
              我可以从 PM、DEV、QA 不同视角为你解答
            </p>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

