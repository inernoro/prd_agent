import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { Send, X, Code, Loader2, CheckCircle2, Wand2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { readSseStream } from '@/lib/sse';
import { chatWorkflow, getChatHistory } from '@/services';
import type { WorkflowChatGenerated } from '@/services/contracts/workflowAgent';

// ═══════════════════════════════════════════════════════════════
// WorkflowChatPanel — 右侧 AI 对话面板
// ═══════════════════════════════════════════════════════════════

interface Props {
  workflowId?: string;
  onApplyWorkflow: (generated: WorkflowChatGenerated, workflowId?: string) => void;
  onClose: () => void;
}

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  generated?: WorkflowChatGenerated;
  generatedWorkflowId?: string;
  isStreaming?: boolean;
  timestamp: string;
}

export function WorkflowChatPanel({ workflowId, onApplyWorkflow, onClose }: Props) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [codeSnippet, setCodeSnippet] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 加载对话历史
  useEffect(() => {
    if (!workflowId) return;
    setLoadingHistory(true);
    getChatHistory({ workflowId })
      .then((res) => {
        if (res.success && res.data) {
          setMessages(
            res.data.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              generated: m.generated ?? undefined,
              timestamp: m.createdAt,
            }))
          );
        }
      })
      .finally(() => setLoadingHistory(false));
  }, [workflowId]);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMsg: UiMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text + (codeSnippet ? `\n\n\`\`\`\n${codeSnippet}\n\`\`\`` : ''),
      timestamp: new Date().toISOString(),
    };

    const assistantMsg: UiMessage = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setCodeSnippet('');
    setShowCodeInput(false);
    setIsStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await chatWorkflow({
        workflowId: workflowId || undefined,
        instruction: text,
        codeSnippet: codeSnippet || undefined,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '请求失败');
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: `请求失败: ${errText}`, isStreaming: false }
              : m
          )
        );
        setIsStreaming(false);
        return;
      }

      await readSseStream(
        res,
        (evt) => {
          if (!evt.data) return;
          try {
            const obj = JSON.parse(evt.data);
            if (obj.type === 'delta') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + (obj.content || '') }
                    : m
                )
              );
            } else if (obj.type === 'workflow_created') {
              // 新建 — 自动应用
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? {
                        ...m,
                        generated: obj.workflow,
                        generatedWorkflowId: obj.workflowId,
                      }
                    : m
                )
              );
              onApplyWorkflow(obj.workflow, obj.workflowId);
            } else if (obj.type === 'workflow_generated') {
              // 修改 — 等待用户确认
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, generated: obj.generated }
                    : m
                )
              );
            } else if (obj.type === 'error') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + `\n\n**错误**: ${obj.content}` }
                    : m
                )
              );
            }
          } catch {
            /* ignore parse errors */
          }
        },
        ac.signal
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: m.content || '连接中断', isStreaming: false }
              : m
          )
        );
      }
    } finally {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id ? { ...m, isStreaming: false } : m
        )
      );
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, codeSnippet, workflowId, isStreaming, onApplyWorkflow]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  return (
    <div
      style={{
        width: 420,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(18, 18, 24, 0.6)',
        backdropFilter: 'blur(20px)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wand2 size={16} style={{ color: 'rgba(139,92,246,0.9)' }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}>
            工作流助手
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'rgba(255,255,255,0.4)',
            padding: 4,
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Messages Area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {loadingHistory && (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
            加载对话历史...
          </div>
        )}

        {messages.length === 0 && !loadingHistory && (
          <div
            style={{
              textAlign: 'center',
              color: 'rgba(255,255,255,0.35)',
              fontSize: 13,
              marginTop: 40,
              lineHeight: 1.8,
            }}
          >
            <Wand2 size={32} style={{ margin: '0 auto 12px', display: 'block', opacity: 0.3 }} />
            告诉我你想要什么样的工作流
            <br />
            例如: "帮我创建一个抓取 TAPD 缺陷数据的工作流"
            <br />
            也可以粘贴 Python/JS 代码让我转换
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            onApply={
              msg.generated && !msg.generatedWorkflowId
                ? () => onApplyWorkflow(msg.generated!, workflowId)
                : undefined
            }
          />
        ))}
      </div>

      {/* Code Input Area (collapsible) */}
      {showCodeInput && (
        <div style={{ padding: '0 16px 8px' }}>
          <textarea
            value={codeSnippet}
            onChange={(e) => setCodeSnippet(e.target.value)}
            placeholder="粘贴 Python/JS 代码片段..."
            style={{
              width: '100%',
              height: 100,
              resize: 'vertical',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              fontFamily: 'monospace',
              color: 'rgba(255,255,255,0.8)',
              outline: 'none',
            }}
          />
        </div>
      )}

      {/* Input Area */}
      <div
        style={{
          padding: '8px 16px 12px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button
            onClick={() => setShowCodeInput((v) => !v)}
            title="粘贴代码"
            style={{
              background: showCodeInput ? 'rgba(139,92,246,0.2)' : 'none',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              padding: '6px 8px',
              cursor: 'pointer',
              color: showCodeInput ? 'rgba(139,92,246,0.9)' : 'rgba(255,255,255,0.4)',
              flexShrink: 0,
            }}
          >
            <Code size={16} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="描述你想要的工作流..."
            rows={1}
            style={{
              flex: 1,
              resize: 'none',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 13,
              color: 'rgba(255,255,255,0.85)',
              outline: 'none',
              maxHeight: 100,
              lineHeight: 1.5,
            }}
          />
          {isStreaming ? (
            <button
              onClick={handleStop}
              style={{
                background: 'rgba(239,68,68,0.2)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 8,
                padding: '6px 8px',
                cursor: 'pointer',
                color: 'rgba(239,68,68,0.9)',
                flexShrink: 0,
              }}
            >
              <X size={16} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              style={{
                background: input.trim() ? 'rgba(139,92,246,0.3)' : 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(139,92,246,0.3)',
                borderRadius: 8,
                padding: '6px 8px',
                cursor: input.trim() ? 'pointer' : 'default',
                color: input.trim() ? 'rgba(139,92,246,0.9)' : 'rgba(255,255,255,0.2)',
                flexShrink: 0,
              }}
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Chat Message Bubble ────────────────────────────────────

function ChatMessage({
  message,
  onApply,
}: {
  message: UiMessage;
  onApply?: () => void;
}) {
  const isUser = message.role === 'user';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Role label */}
      <div
        style={{
          fontSize: 11,
          color: isUser ? 'rgba(59,130,246,0.7)' : 'rgba(139,92,246,0.7)',
          fontWeight: 500,
        }}
      >
        {isUser ? '你' : 'AI 助手'}
      </div>

      {/* Bubble */}
      <div
        style={{
          background: isUser ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${isUser ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.06)'}`,
          borderRadius: 10,
          padding: '10px 12px',
          fontSize: 13,
          lineHeight: 1.7,
          color: 'rgba(255,255,255,0.85)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {message.content}
        {message.isStreaming && (
          <span style={{ display: 'inline-block', marginLeft: 4 }}>
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
          </span>
        )}
      </div>

      {/* Generated workflow card */}
      {message.generated && (
        <div
          style={{
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.2)',
            borderRadius: 10,
            padding: '10px 12px',
            fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            {message.generatedWorkflowId ? (
              <CheckCircle2 size={14} style={{ color: 'rgba(34,197,94,0.9)' }} />
            ) : (
              <AlertTriangle size={14} style={{ color: 'rgba(234,179,8,0.9)' }} />
            )}
            <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}>
              {message.generatedWorkflowId ? '已自动创建工作流' : '工作流配置已生成'}
            </span>
          </div>
          <div style={{ color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
            {message.generated.name && <div>名称: {message.generated.name}</div>}
            <div>{message.generated.nodes?.length ?? 0} 个节点</div>
            {(message.generated.variables?.length ?? 0) > 0 && (
              <div>{message.generated.variables!.length} 个变量</div>
            )}
          </div>
          {onApply && (
            <Button
              size="sm"
              onClick={onApply}
              style={{
                background: 'rgba(34,197,94,0.2)',
                border: '1px solid rgba(34,197,94,0.3)',
                color: 'rgba(34,197,94,0.9)',
              }}
            >
              应用到编辑器
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
