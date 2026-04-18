import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Plus, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PaMessage, PaTask } from '@/services/real/paAgentService';
import {
  getPaMessages,
  streamPaChat,
  createPaTask,
} from '@/services/real/paAgentService';

const EXAMPLE_PROMPTS = [
  '帮我拆解本周工作目标，按四象限排序',
  '我需要准备一个述职报告，帮我规划步骤',
  '梳理一下我今天该优先做哪些事',
];

interface SaveTaskPayload {
  action: 'save_task';
  title: string;
  quadrant: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  reasoning?: string;
  subTasks?: string[];
}

function extractTaskPayload(content: string): SaveTaskPayload | null {
  const match = content.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>).action === 'save_task'
    ) {
      return parsed as SaveTaskPayload;
    }
  } catch {
    // ignore
  }
  return null;
}

interface ChatMessageProps {
  msg: PaMessage;
  sessionId: string;
  onTaskSaved: (task: PaTask) => void;
}

function ChatMessage({ msg, sessionId, onTaskSaved }: ChatMessageProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const payload = msg.role === 'assistant' ? extractTaskPayload(msg.content) : null;
  const displayContent = payload
    ? msg.content.replace(/```json\s*[\s\S]*?```/, '').trim()
    : msg.content;

  const handleSave = useCallback(async () => {
    if (!payload || saving || saved) return;
    setSaving(true);
    const res = await createPaTask({
      title: payload.title,
      quadrant: payload.quadrant,
      sessionId,
      reasoning: payload.reasoning,
      subTasks: payload.subTasks,
      contentHash: btoa(encodeURIComponent(payload.title + payload.quadrant)).slice(0, 32),
    });
    setSaving(false);
    if (res.success && res.data) {
      setSaved(true);
      onTaskSaved(res.data);
    }
  }, [payload, saving, saved, sessionId, onTaskSaved]);

  const isUser = msg.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm"
        style={
          isUser
            ? {
                background: 'var(--color-blue-600, #2563eb)',
                color: '#fff',
                borderBottomRightRadius: 4,
              }
            : {
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-default)',
                borderBottomLeftRadius: 4,
              }
        }
      >
        {isUser ? (
          <span>{msg.content}</span>
        ) : (
          <>
            <div className="prose prose-sm max-w-none" style={{ color: 'inherit' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
            </div>
            {payload && (
              <div
                className="mt-2 pt-2 flex items-center gap-2"
                style={{ borderTop: '1px solid var(--border-default)' }}
              >
                <button
                  onClick={() => void handleSave()}
                  disabled={saving || saved}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full transition-colors whitespace-nowrap"
                  style={
                    saved
                      ? { background: 'var(--color-green-500, #22c55e)', color: '#fff' }
                      : {
                          background: 'var(--color-blue-500, #3b82f6)',
                          color: '#fff',
                          opacity: saving ? 0.7 : 1,
                        }
                  }
                >
                  {saving ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Plus size={12} />
                  )}
                  {saved ? '已加入任务清单' : `加入任务清单 (${payload.quadrant})`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface PaAssistantChatProps {
  sessionId: string;
  onTaskSaved?: (task: PaTask) => void;
}

export function PaAssistantChat({ sessionId, onTaskSaved }: PaAssistantChatProps) {
  const [messages, setMessages] = useState<PaMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [input, setInput] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      setLoadingHistory(true);
      const res = await getPaMessages(sessionId);
      if (res.success && res.data) {
        setMessages(res.data);
      }
      setLoadingHistory(false);
    })();
  }, [sessionId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;
      const userMsg: PaMessage = {
        id: `temp-${Date.now()}`,
        userId: '',
        sessionId,
        role: 'user',
        content: text.trim(),
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, userMsg]);
      setInput('');
      setIsStreaming(true);
      setStreamingContent('');

      let fullContent = '';

      abortRef.current = await streamPaChat({
        sessionId,
        message: text.trim(),
        onChunk: chunk => {
          if (chunk.content) {
            fullContent += chunk.content;
            setStreamingContent(fullContent);
          }
        },
        onDone: () => {
          setIsStreaming(false);
          setStreamingContent('');
          const assistantMsg: PaMessage = {
            id: `temp-a-${Date.now()}`,
            userId: '',
            sessionId,
            role: 'assistant',
            content: fullContent,
            createdAt: new Date().toISOString(),
          };
          setMessages(prev => [...prev, assistantMsg]);
          abortRef.current = null;
        },
        onError: err => {
          setIsStreaming(false);
          setStreamingContent('');
          const errMsg: PaMessage = {
            id: `temp-err-${Date.now()}`,
            userId: '',
            sessionId,
            role: 'assistant',
            content: `抱歉，出现了错误：${err}`,
            createdAt: new Date().toISOString(),
          };
          setMessages(prev => [...prev, errMsg]);
          abortRef.current = null;
        },
      });
    },
    [isStreaming, sessionId],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend(input);
      }
    },
    [handleSend, input],
  );

  const handleTaskSaved = useCallback(
    (task: PaTask) => {
      onTaskSaved?.(task);
    },
    [onTaskSaved],
  );

  const isEmpty = messages.length === 0 && !loadingHistory;

  return (
    <div className="h-full flex flex-col" style={{ color: 'var(--text-primary)' }}>
      {/* Message area */}
      <div className="flex-1 overflow-auto px-4 py-4">
        {loadingHistory ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="text-center">
              <div className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                你好，我是你的私人助理
              </div>
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                MBB 级执行助理，帮你拆解任务、四象限排序、高效执行
              </div>
            </div>
            <div className="flex flex-col gap-2 w-full max-w-sm">
              {EXAMPLE_PROMPTS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => void handleSend(p)}
                  className="text-sm px-4 py-2.5 rounded-xl text-left transition-colors"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--bg-hover)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'var(--bg-elevated)';
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map(msg => (
              <ChatMessage
                key={msg.id}
                msg={msg}
                sessionId={sessionId}
                onTaskSaved={handleTaskSaved}
              />
            ))}
            {isStreaming && streamingContent && (
              <div className="flex justify-start mb-3">
                <div
                  className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm"
                  style={{
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-default)',
                    borderBottomLeftRadius: 4,
                  }}
                >
                  <div className="prose prose-sm max-w-none" style={{ color: 'inherit' }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
                  </div>
                  <span
                    className="inline-block w-0.5 h-4 align-middle animate-pulse ml-0.5"
                    style={{ background: 'var(--text-primary)' }}
                  />
                </div>
              </div>
            )}
            {isStreaming && !streamingContent && (
              <div className="flex justify-start mb-3">
                <div
                  className="rounded-2xl px-4 py-2.5"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  <Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                </div>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div
        className="shrink-0 px-4 pb-4"
        style={{ borderTop: '1px solid var(--border-default)', paddingTop: 12 }}
      >
        <div
          className="flex items-end gap-2 rounded-xl px-3 py-2"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行..."
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm outline-none"
            style={{
              color: 'var(--text-primary)',
              minHeight: 22,
              maxHeight: 120,
              overflow: 'auto',
            }}
          />
          <button
            onClick={() => void handleSend(input)}
            disabled={!input.trim() || isStreaming}
            className="shrink-0 p-1.5 rounded-lg transition-colors"
            style={{
              background: input.trim() && !isStreaming ? 'var(--color-blue-500, #3b82f6)' : 'var(--bg-hover)',
              color: input.trim() && !isStreaming ? '#fff' : 'var(--text-muted)',
            }}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
