import { useState, useRef, useEffect, useCallback, useMemo, type KeyboardEvent } from 'react';
import { Send, X, Code, CheckCircle2, Wand2, AlertTriangle } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { getChatHistory } from '@/services';
import { api } from '@/services/api';
import type { WorkflowChatGenerated } from '@/services/contracts/workflowAgent';

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

// ═══════════════════════════════════════════════════════════════
// WorkflowChatPanel — 右侧 AI 对话面板
// ═══════════════════════════════════════════════════════════════

interface Props {
  workflowId?: string;
  onApplyWorkflow: (generated: WorkflowChatGenerated, workflowId?: string) => void;
  onClose: () => void;
  /** 外部注入的初始输入（如"AI 填写"按钮预填的提示文字），设置后自动填入输入框并聚焦 */
  initialInput?: string;
  /** initialInput 被消费后通知外部清空，避免重复填入 */
  onInitialInputConsumed?: () => void;
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

export function WorkflowChatPanel({ workflowId, onApplyWorkflow, onClose, initialInput, onInitialInputConsumed }: Props) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [codeSnippet, setCodeSnippet] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 当前正在流式输出的 assistant 消息 ID */
  const assistantMsgIdRef = useRef<string>('');
  /** 缓存 onApplyWorkflow 最新引用 */
  const onApplyRef = useRef(onApplyWorkflow);
  onApplyRef.current = onApplyWorkflow;

  const sseUrl = useMemo(
    () => joinUrl(getApiBaseUrl(), api.workflowAgent.chat.fromChat()),
    [],
  );

  const { phase, phaseMessage, isStreaming, start, abort } = useSseStream({
    url: sseUrl,
    method: 'POST',
    onTyping: (text) => {
      const id = assistantMsgIdRef.current;
      if (!id) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, content: m.content + text } : m,
        ),
      );
    },
    onEvent: {
      workflow_created: (data: unknown) => {
        const obj = data as { workflow: WorkflowChatGenerated; workflowId: string };
        const id = assistantMsgIdRef.current;
        if (!id) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? { ...m, generated: obj.workflow, generatedWorkflowId: obj.workflowId }
              : m,
          ),
        );
        onApplyRef.current(obj.workflow, obj.workflowId);
      },
      workflow_generated: (data: unknown) => {
        const obj = data as { generated: WorkflowChatGenerated };
        const id = assistantMsgIdRef.current;
        if (!id) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, generated: obj.generated } : m,
          ),
        );
      },
    },
    onError: (msg) => {
      const id = assistantMsgIdRef.current;
      if (!id) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, content: m.content + `\n\n**错误**: ${msg}`, isStreaming: false }
            : m,
        ),
      );
    },
    onDone: () => {
      const id = assistantMsgIdRef.current;
      if (!id) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, isStreaming: false } : m,
        ),
      );
      assistantMsgIdRef.current = '';
    },
  });

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

  // 外部注入初始输入（如"AI 填写"预填）
  useEffect(() => {
    if (initialInput) {
      setInput(initialInput);
      onInitialInputConsumed?.();
      // 延迟聚焦，等 DOM 渲染完
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [initialInput, onInitialInputConsumed]);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // stream 结束后确保 isStreaming 标记清除
  useEffect(() => {
    if (phase === 'done' || phase === 'error' || phase === 'idle') {
      const id = assistantMsgIdRef.current;
      if (id) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, isStreaming: false } : m,
          ),
        );
        assistantMsgIdRef.current = '';
      }
    }
  }, [phase]);

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

    assistantMsgIdRef.current = assistantMsg.id;
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setCodeSnippet('');
    setShowCodeInput(false);

    await start({
      body: {
        workflowId: workflowId || undefined,
        instruction: text,
        codeSnippet: codeSnippet || undefined,
      },
    });
  }, [input, codeSnippet, workflowId, isStreaming, start]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = () => {
    abort();
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
        WebkitBackdropFilter: 'blur(20px)',
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

      {/* SSE Phase Bar */}
      {isStreaming && (
        <div style={{ padding: '8px 16px 0' }}>
          <SsePhaseBar phase={phase} message={phaseMessage} />
        </div>
      )}

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
            <MapSpinner size={12} />
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
