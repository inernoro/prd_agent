import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { getToolboxSharedConversation } from '@/services/real/aiToolbox';
import { Bot, User, AlertCircle } from 'lucide-react';

interface SharedMessage {
  role: string;
  content: string;
  createdAt: string;
}

interface SharedData {
  title: string;
  messages: SharedMessage[];
  createdAt: string;
}

export function SharedConversation() {
  const { shareId } = useParams<{ shareId: string }>();
  const [data, setData] = useState<SharedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!shareId) return;
    (async () => {
      try {
        const res = await getToolboxSharedConversation(shareId);
        if (res.success && res.data) {
          setData(res.data);
        } else {
          setError(res.error?.message || '对话已过期或不存在');
        }
      } catch {
        setError('加载失败，请稍后重试');
      } finally {
        setLoading(false);
      }
    })();
  }, [shareId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-base, #0a0a0f)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted, #888)' }}>加载中...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-base, #0a0a0f)' }}>
        <div className="text-center max-w-md px-6">
          <AlertCircle size={48} className="mx-auto mb-4" style={{ color: 'var(--status-error, #ef4444)' }} />
          <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary, #fff)' }}>
            {error || '对话已过期'}
          </h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted, #888)' }}>
            该分享链接可能已过期或已被删除
          </p>
          <Link
            to="/home"
            className="inline-block px-4 py-2 rounded-lg text-sm transition-colors"
            style={{
              background: 'var(--bg-elevated, #1a1a2e)',
              color: 'var(--text-primary, #fff)',
              border: '1px solid var(--border-default, #333)',
            }}
          >
            返回首页
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base, #0a0a0f)' }}>
      {/* Header */}
      <div
        className="sticky top-0 z-10 px-6 py-4 border-b"
        style={{
          background: 'var(--bg-base, #0a0a0f)',
          borderColor: 'var(--border-default, #333)',
        }}
      >
        <div className="max-w-3xl mx-auto">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary, #fff)' }}>
            {data.title}
          </h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted, #888)' }}>
            分享于 {new Date(data.createdAt).toLocaleString('zh-CN')}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {data.messages.map((msg, idx) => {
          const isUser = msg.role === 'user';
          return (
            <div key={idx} className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
              {/* Avatar */}
              <div
                className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center"
                style={{
                  background: isUser
                    ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(99, 102, 241, 0.1))'
                    : 'linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(16, 185, 129, 0.1))',
                }}
              >
                {isUser
                  ? <User size={16} style={{ color: 'rgba(99, 102, 241, 0.8)' }} />
                  : <Bot size={16} style={{ color: 'rgba(16, 185, 129, 0.8)' }} />
                }
              </div>

              {/* Bubble */}
              <div
                className={`max-w-[80%] px-4 py-3 rounded-xl text-sm leading-relaxed ${
                  isUser ? 'rounded-tr-sm' : 'rounded-tl-sm'
                }`}
                style={{
                  background: isUser
                    ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(99, 102, 241, 0.08) 100%)'
                    : 'rgba(255, 255, 255, 0.03)',
                  color: 'var(--text-primary, #fff)',
                  border: isUser ? 'none' : '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
                }}
              >
                {isUser ? (
                  msg.content
                ) : (
                  <div className="prose prose-invert prose-sm max-w-none [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ol]:my-1">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                )}
                <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted, #888)' }}>
                  {new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="text-center py-8">
        <p className="text-xs" style={{ color: 'var(--text-muted, #888)' }}>
          -- 对话结束 --
        </p>
      </div>
    </div>
  );
}
