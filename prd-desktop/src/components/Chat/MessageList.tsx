import { useRef, useEffect } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { MessageBlock } from '../../types';
import MarkdownRenderer from '../Markdown/MarkdownRenderer';

const phaseText: Record<string, string> = {
  requesting: '正在请求大模型…',
  connected: '已连接，等待首包…',
  receiving: '正在接收信息…',
  typing: '开始输出…',
};

function ThinkingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-secondary">
      <span className="inline-flex items-center gap-1" aria-label={label || '处理中'}>
        <span className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-bounce" style={{ animationDelay: '120ms' }} />
        <span className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-bounce" style={{ animationDelay: '240ms' }} />
      </span>
      {label ? <span>{label}</span> : null}
    </div>
  );
}

function unwrapMarkdownFences(text: string) {
  if (!text) return text;
  // 兼容：LLM 常用 ```markdown / ```md 包裹“本来就想渲染的 Markdown”，会被当作代码块显示
  // 这里仅解包 markdown/md 语言标记，其它代码块保持不动
  return text.replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/g, '$1');
}

export default function MessageList() {
  const { messages, isStreaming, streamingMessageId, streamingPhase } = useMessageStore();
  const { sessionId, activeGroupId } = useSessionStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // 仅当用户已经在底部附近时才自动滚动，避免打断用户阅读历史消息
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceToBottom < 140;
    if (!isNearBottom) return;

    // 流式期间使用 auto，避免高频 smooth scroll 导致主线程卡顿
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
  }, [messages, isStreaming, streamingMessageId]);

  return (
    <div ref={containerRef} className="h-full overflow-y-auto p-4 space-y-4">
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
              <div>
                {isStreaming &&
                streamingMessageId === message.id &&
                streamingPhase &&
                streamingPhase !== 'typing' ? (
                  <div className="mb-2">
                    <ThinkingIndicator label={phaseText[streamingPhase] || '处理中…'} />
                  </div>
                ) : null}
                {/* Block Protocol：按块渲染，流式期间也能稳定 Markdown 排版 */}
                {Array.isArray(message.blocks) && message.blocks.length > 0 ? (
                  // 非流式阶段：用整段 message.content 统一渲染，避免分块导致“列表/编号/段落上下文”丢失
                  !(isStreaming && streamingMessageId === message.id) ? (
                    <MarkdownRenderer
                      className="prose prose-sm dark:prose-invert max-w-none"
                      content={unwrapMarkdownFences(message.content)}
                    />
                  ) : (
                    <div className="space-y-2">
                      {message.blocks.map((b: MessageBlock) => (
                        <div key={b.id} className="prose prose-sm dark:prose-invert max-w-none">
                          {b.kind === 'codeBlock' ? (
                            // 如果后端/模型标记为 markdown 代码块，用户通常期望“按 Markdown 渲染”而不是当代码展示
                            (b.language === 'markdown' || b.language === 'md') ? (
                              <MarkdownRenderer content={unwrapMarkdownFences(b.content)} />
                            ) : (
                              <pre className="overflow-x-auto rounded-md border border-border bg-gray-50 dark:bg-gray-900 p-3">
                                <code className="whitespace-pre">{b.content}</code>
                              </pre>
                            )
                          ) : (
                            // 流式过程中 markdown 语法常常未闭合（列表/表格/引用等），会导致样式“缺一截”
                            // 因此：未完成的 block 先纯文本展示，blockEnd 后再用 ReactMarkdown 渲染
                            b.isComplete === false ? (
                              <p className="whitespace-pre-wrap break-words">{b.content}</p>
                            ) : (
                              <MarkdownRenderer content={unwrapMarkdownFences(b.content)} />
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  )
                ) : (
                  // 兼容旧协议：无 blocks 时沿用原逻辑（流式阶段先纯文本，done 后 markdown）
                  isStreaming && streamingMessageId === message.id ? (
                    <div>
                      <p className="whitespace-pre-wrap break-words">{message.content}</p>
                    </div>
                  ) : (
                    <MarkdownRenderer
                      className="prose prose-sm dark:prose-invert max-w-none"
                      content={unwrapMarkdownFences(message.content)}
                    />
                  )
                )}
              </div>
            )}

            {isStreaming && streamingMessageId === message.id && (
              <span className="inline-block w-2 h-4 bg-primary-500 animate-pulse ml-1" />
            )}
            
            {message.senderName && (
              <p className="text-xs opacity-70 mt-2">
                {message.senderName} · {message.viewRole}
              </p>
            )}
          </div>
        </div>
      ))}

      {messages.length === 0 && !isStreaming && (
        <div className="h-full flex items-center justify-center text-text-secondary">
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 bg-primary-100 dark:bg-primary-900/30 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </div>
            {!sessionId && activeGroupId ? (
              <>
                <p className="text-lg mb-2">待上传</p>
                <p className="text-sm">该群组未绑定 PRD，无法进行对话。</p>
                <p className="text-xs mt-2 text-text-secondary">
                  请在左侧选择/上传 PRD，并点击{' '}
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('prdAgent:openBindPrdPicker'))}
                    className="underline hover:text-primary-500"
                    title="上传并绑定 PRD"
                  >
                    上传 PRD 并绑定到当前群组
                  </button>
                </p>
              </>
            ) : (
              <>
                <p className="text-lg mb-2">你好!</p>
                <p className="text-sm">有什么关于这份PRD的问题，尽管问我</p>
              </>
            )}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
