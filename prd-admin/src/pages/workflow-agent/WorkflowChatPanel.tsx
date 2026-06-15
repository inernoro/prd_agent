import { useState, useRef, useEffect, useCallback, useMemo, type KeyboardEvent, type CSSProperties } from 'react';
import { Send, X, Code, CheckCircle2, Wand2, AlertTriangle, GitBranch, KeyRound, ListChecks } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { StreamingText } from '@/components/streaming';
import { getChatHistory } from '@/services';
import { api } from '@/services/api';
import type { WorkflowChatGenerated, WorkflowValidationResult, WorkflowRequiredInput } from '@/services/contracts/workflowAgent';

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
  /** 为 true 时 initialInput 注入后自动发送一次（用于"列表页一句话起步"） */
  autoSend?: boolean;
}

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  generated?: WorkflowChatGenerated;
  generatedWorkflowId?: string;
  validation?: WorkflowValidationResult;
  isStreaming?: boolean;
  timestamp: string;
}

export function WorkflowChatPanel({ workflowId, onApplyWorkflow, onClose, initialInput, onInitialInputConsumed, autoSend }: Props) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [codeSnippet, setCodeSnippet] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 当前正在流式输出的 assistant 消息 ID */
  const assistantMsgIdRef = useRef<string>('');
  /** 已自动发送过初始输入（防重复 + 防历史加载覆盖 auto-send 的消息） */
  const autoSentRef = useRef(false);
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
      workflow_validation: (data: unknown) => {
        const obj = data as WorkflowValidationResult;
        const id = assistantMsgIdRef.current;
        if (!id) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, validation: obj } : m,
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
        // 「一句话起步」会在 mount 时 auto-send，若历史晚于 doSend 返回会覆盖刚追加的消息
        // （新建工作流历史为空 → 直接清空流式消息）。auto-send 已发起则跳过历史回填。
        if (res.success && res.data && !autoSentRef.current) {
          setMessages(
            res.data.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              generated: m.generated ?? undefined,
              validation: m.validation ?? undefined,
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

  const doSend = useCallback(async (rawText: string, code: string) => {
    const text = rawText.trim();
    if (!text || isStreaming) return;

    const userMsg: UiMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text + (code ? `\n\n\`\`\`\n${code}\n\`\`\`` : ''),
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
        codeSnippet: code || undefined,
      },
    });
  }, [workflowId, isStreaming, start]);

  const handleSend = useCallback(() => doSend(input, codeSnippet), [doSend, input, codeSnippet]);

  // 外部注入初始输入（如"AI 填写"预填 / 列表页一句话起步）
  useEffect(() => {
    if (!initialInput) return;
    onInitialInputConsumed?.();
    // 只有「确实能发出去」才置 autoSent 并发送，否则退回预填——避免空文本/正在流式时
    // 既没发消息又把历史加载挡掉，留下空面板无可重试
    if (autoSend && !autoSentRef.current && initialInput.trim() && !isStreaming) {
      autoSentRef.current = true;
      void doSend(initialInput, '');
    } else {
      setInput(initialInput);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [initialInput, autoSend, isStreaming, onInitialInputConsumed, doSend]);

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
                ? (override?: WorkflowChatGenerated) => onApplyWorkflow(override ?? msg.generated!, workflowId)
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
  onApply?: (override?: WorkflowChatGenerated) => void;
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
        {isUser ? (
          message.content
        ) : (
          <StreamingText text={message.content} streaming={!!message.isStreaming} />
        )}
        {message.isStreaming && !message.content && (
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
          {/* 仅在「校验通过且无缺项」时显示直接应用；有缺项走下方补齐卡，结构无效则不允许应用 */}
          {onApply
            && (!message.validation || (message.validation.valid && message.validation.requiredInputs.length === 0))
            && (
            <Button
              size="sm"
              onClick={() => onApply()}
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

      {/* 自动校验 / 接线 / 待补项（可就地补齐） */}
      {message.validation && (
        <ValidationCard
          validation={message.validation}
          generated={message.generated}
          onApply={onApply}
        />
      )}
    </div>
  );
}

// ─── 自动校验结果卡片 ───────────────────────────────────────

function reqKey(inp: WorkflowRequiredInput) {
  return `${inp.scope}:${inp.nodeId ?? ''}:${inp.key}`;
}

/** 把用户填的值烘焙进生成的工作流（config 字段 / 变量默认值），返回新对象。 */
function bakeFilledValues(
  generated: WorkflowChatGenerated,
  requiredInputs: WorkflowRequiredInput[],
  values: Record<string, string>,
): WorkflowChatGenerated {
  const g: WorkflowChatGenerated = structuredClone(generated);
  for (const inp of requiredInputs) {
    const v = values[reqKey(inp)];
    if (!v || !v.trim()) continue;
    if (inp.scope === 'config' && inp.nodeId) {
      const node = g.nodes?.find((n) => n.nodeId === inp.nodeId);
      if (node) node.config = { ...node.config, [inp.key]: v };
    } else if (inp.scope === 'variable') {
      g.variables = g.variables ?? [];
      const variable = g.variables.find((x) => x.key === inp.key);
      if (variable) variable.defaultValue = v;
      else
        g.variables.push({
          key: inp.key,
          label: inp.label || inp.key,
          type: inp.isSecret ? 'string' : inp.type || 'string',
          required: true,
          isSecret: inp.isSecret,
          defaultValue: v,
        });
    }
  }
  return g;
}

function ValidationCard({
  validation,
  generated,
  onApply,
}: {
  validation: WorkflowValidationResult;
  generated?: WorkflowChatGenerated;
  onApply?: (override?: WorkflowChatGenerated) => void;
}) {
  const { valid, issues, wireNotes, requiredInputs } = validation;
  const hasNotes = wireNotes.length > 0;
  const hasMissing = requiredInputs.length > 0;
  // 仅在「待应用的提案 + 有缺项」时支持就地补齐
  const canFill = hasMissing && !!generated && !!onApply;
  const [values, setValues] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState(false);
  const allFilled = requiredInputs.every((inp) => (values[reqKey(inp)] ?? '').trim() !== '');
  const canApply = allFilled && valid; // 结构无效（环/重复/停用舱补不掉）时不允许应用

  function handleFillApply() {
    if (!generated || !onApply || !canApply) return;
    onApply(bakeFilledValues(generated, requiredInputs, values));
    setApplied(true);
  }

  return (
    <div
      style={{
        background: valid ? 'rgba(59,130,246,0.06)' : 'rgba(234,179,8,0.08)',
        border: `1px solid ${valid ? 'rgba(59,130,246,0.18)' : 'rgba(234,179,8,0.25)'}`,
        borderRadius: 10,
        padding: '10px 12px',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* 校验状态 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {valid ? (
          <CheckCircle2 size={14} style={{ color: 'rgba(59,130,246,0.9)' }} />
        ) : (
          <AlertTriangle size={14} style={{ color: 'rgba(234,179,8,0.95)' }} />
        )}
        <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}>
          {valid ? '已自动校验 · 结构可执行' : '已自动校验 · 仍有需修正项'}
        </span>
      </div>

      {/* 残留结构问题 */}
      {issues.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, color: 'rgba(234,179,8,0.95)', lineHeight: 1.6 }}>
          {issues.map((it, i) => (
            <li key={i}>{it.message}</li>
          ))}
        </ul>
      )}

      {/* 自动接线说明 */}
      {hasNotes && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'rgba(255,255,255,0.55)', marginBottom: 3 }}>
            <GitBranch size={12} />
            <span>自动接线</span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'rgba(255,255,255,0.6)', lineHeight: 1.6 }}>
            {wireNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 待补齐项（可就地填写 → 一键应用） */}
      {hasMissing && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'rgba(255,255,255,0.7)', marginBottom: 5 }}>
            <ListChecks size={12} />
            <span style={{ fontWeight: 600 }}>补齐这 {requiredInputs.length} 项即可运行</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {requiredInputs.map((inp) => {
              const k = reqKey(inp);
              return (
                <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {inp.isSecret && <KeyRound size={11} style={{ color: 'rgba(234,179,8,0.9)', flexShrink: 0 }} />}
                    <span style={{ color: 'rgba(255,255,255,0.85)' }}>{inp.label}</span>
                    {inp.nodeName && (
                      <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>· {inp.nodeName}</span>
                    )}
                    {inp.scope === 'variable' && (
                      <span style={{ color: 'rgba(139,92,246,0.8)', fontSize: 11 }}>变量</span>
                    )}
                  </div>
                  {canFill ? (
                    inp.type === 'textarea' ? (
                      <textarea
                        value={values[k] ?? ''}
                        onChange={(e) => { setValues((p) => ({ ...p, [k]: e.target.value })); setApplied(false); }}
                        placeholder={inp.placeholder || inp.helpTip || `请输入${inp.label}`}
                        rows={2}
                        style={fillFieldStyle}
                      />
                    ) : (
                      <input
                        type={inp.isSecret || inp.type === 'password' ? 'password' : 'text'}
                        value={values[k] ?? ''}
                        onChange={(e) => { setValues((p) => ({ ...p, [k]: e.target.value })); setApplied(false); }}
                        placeholder={inp.placeholder || inp.helpTip || `请输入${inp.label}`}
                        style={fillFieldStyle}
                      />
                    )
                  ) : null}
                </div>
              );
            })}
          </div>

          {canFill ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <Button
                size="sm"
                onClick={handleFillApply}
                disabled={!canApply}
                style={{
                  background: canApply ? 'rgba(139,92,246,0.25)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${canApply ? 'rgba(139,92,246,0.35)' : 'rgba(255,255,255,0.12)'}`,
                  color: canApply ? 'rgba(196,181,253,0.95)' : 'rgba(255,255,255,0.4)',
                }}
              >
                {applied ? '已补齐并应用' : !valid ? '请先解决上方结构问题' : allFilled ? '补齐并应用到编辑器' : `请先填写全部 ${requiredInputs.length} 项`}
              </Button>
              {applied && (
                <span style={{ color: 'rgba(34,197,94,0.85)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle2 size={12} /> 记得点右上「保存」
                </span>
              )}
            </div>
          ) : (
            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, marginTop: 4 }}>
              打开对应节点配置填写；密钥项请填到工作流变量。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const fillFieldStyle: CSSProperties = {
  width: '100%',
  background: 'rgba(0,0,0,0.25)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  color: 'rgba(255,255,255,0.9)',
  outline: 'none',
  resize: 'vertical',
};
