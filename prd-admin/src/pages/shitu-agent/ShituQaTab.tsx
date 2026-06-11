import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Send, StopCircle, Sparkles, MessageSquarePlus,
  AlertCircle, Loader2,
} from 'lucide-react';
import { connectSse } from '@/lib/useSseStream';
import { SHITU_QA_STREAM_URL } from '@/services';
import type { ShituCategoryKey, ShituQaReferencePayload } from '@/services';
import { Button } from '@/components/design/Button';
import { MarkdownContent } from '@/components/ui/MarkdownContent';

interface Props {
  categoryKey: ShituCategoryKey;
  categoryLabel: string;
  storeId: string;
  exampleQuestions: string[];
  onModelChange?: (model: { name?: string; platform?: string } | null) => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references?: ShituQaReferencePayload['items'];
  model?: { name?: string; platform?: string };
  streaming?: boolean;
  errorMsg?: string;
}

export function ShituQaTab({ categoryKey, categoryLabel, storeId, exampleQuestions, onModelChange }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [phaseHint, setPhaseHint] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string>(`shitu-${categoryKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const isStreaming = useMemo(() => messages.some((m) => m.streaming), [messages]);

  useEffect(() => {
    onModelChange?.(null);
    setMessages([]);
    setInput('');
    setPhaseHint(null);
    sessionIdRef.current = `shitu-${categoryKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }, [categoryKey, onModelChange]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, phaseHint]);

  const startNewSession = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    setPhaseHint(null);
    onModelChange?.(null);
    sessionIdRef.current = `shitu-${categoryKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }, [categoryKey, onModelChange]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setMessages((arr) =>
      arr.map((m) => (m.streaming ? { ...m, streaming: false, content: m.content || '_（已中止）_' } : m))
    );
    setPhaseHint(null);
  }, []);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || isStreaming) return;

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: q };
    const assistantId = `a-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      references: [],
      streaming: true,
    };

    const history = messages
      .filter((m) => !m.streaming && !m.errorMsg && (m.content?.trim() || '').length > 0)
      .map<{ role: 'user' | 'assistant'; content: string }>((m) => ({ role: m.role, content: m.content }));

    setMessages([...messages, userMsg, assistantMsg]);
    setInput('');
    setPhaseHint('正在检索知识库…');

    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;

    const body = {
      categoryKey,
      message: q,
      history,
      referenceStoreIds: [storeId],
      sessionId: sessionIdRef.current,
    };

    const updateAssistant = (mut: (m: ChatMessage) => ChatMessage) => {
      setMessages((arr) => arr.map((m) => (m.id === assistantId ? mut(m) : m)));
    };

    const { success, errorMessage } = await connectSse({
      url: SHITU_QA_STREAM_URL,
      method: 'POST',
      body,
      signal: ac.signal,
      onEvent: (evt) => {
        const data = evt.data ? safeJson(evt.data) : null;
        if (!data) return;
        switch (evt.event) {
          case 'phase':
            if (typeof data.message === 'string') setPhaseHint(data.message);
            break;
          case 'model':
            updateAssistant((m) => ({
              ...m,
              model: {
                name: typeof data.model === 'string' ? data.model : undefined,
                platform: typeof data.platform === 'string' ? data.platform : undefined,
              },
            }));
            onModelChange?.({
              name: typeof data.model === 'string' ? data.model : undefined,
              platform: typeof data.platform === 'string' ? data.platform : undefined,
            });
            break;
          case 'reference': {
            const items = Array.isArray(data.items) ? (data.items as ShituQaReferencePayload['items']) : [];
            updateAssistant((m) => ({ ...m, references: items }));
            break;
          }
          case 'typing':
            if (typeof data.text === 'string') {
              updateAssistant((m) => ({ ...m, content: (m.content || '') + data.text }));
            }
            break;
          case 'done':
            updateAssistant((m) => ({ ...m, streaming: false }));
            setPhaseHint(null);
            break;
          case 'error':
            updateAssistant((m) => ({
              ...m,
              streaming: false,
              errorMsg: typeof data.message === 'string' ? data.message : '生成失败',
            }));
            setPhaseHint(null);
            break;
        }
      },
    });

    if (!success) {
      updateAssistant((m) => ({
        ...m,
        streaming: false,
        errorMsg: m.errorMsg || errorMessage || '连接失败',
      }));
      setPhaseHint(null);
    }
  }, [categoryKey, input, isStreaming, messages, onModelChange, storeId]);

  const onComposerKeydown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-white/10 bg-black/20">
      <div className="shrink-0 px-4 py-2 border-b border-white/10 flex items-center gap-2 text-[11px] text-white/55">
        <Sparkles className="w-3.5 h-3.5 text-sky-300/70" />
        <span>{categoryLabel} · 严格 RAG 问答</span>
        {phaseHint && (
          <>
            <span className="opacity-40">·</span>
            <span className="text-sky-200/75 inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              {phaseHint}
            </span>
          </>
        )}
        <div className="flex-1" />
        <Button variant="ghost" onClick={startNewSession} className="!h-6 !px-2 !text-[11px]" disabled={isStreaming}>
          <MessageSquarePlus className="w-3 h-3 mr-1" /> 新对话
        </Button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 px-4 py-4 flex flex-col gap-4"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {messages.length === 0 ? (
          <Welcome categoryLabel={categoryLabel} exampleQuestions={exampleQuestions} onPick={setInput} />
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 bg-black/30 px-4 py-3">
        <div className="rounded-xl border border-white/15 bg-black/40 focus-within:border-sky-400/50 transition">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeydown}
            rows={3}
            placeholder={`就「${categoryLabel}」提问…（Cmd/Ctrl+Enter 发送）`}
            className="w-full bg-transparent border-0 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none resize-none"
            disabled={isStreaming}
          />
          <div className="flex items-center gap-2 px-2 py-2 border-t border-white/10">
            <span className="text-[10px] text-white/35 flex-1">自动挂载当前分类知识库，知识库无内容时会明确告知</span>
            {isStreaming ? (
              <Button onClick={abort} variant="ghost" className="!h-7 !px-2.5 !text-[11px]">
                <StopCircle className="w-3 h-3 mr-1" />
                中止
              </Button>
            ) : (
              <Button onClick={() => void send()} disabled={!input.trim()} variant="primary" className="!h-7 !px-3 !text-[11px]">
                <Send className="w-3 h-3 mr-1" /> 发送
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome({
  categoryLabel,
  exampleQuestions,
  onPick,
}: {
  categoryLabel: string;
  exampleQuestions: string[];
  onPick: (q: string) => void;
}) {
  const samples = exampleQuestions.length > 0 ? exampleQuestions : [`${categoryLabel}有哪些要点？`];
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center max-w-xl mx-auto px-4 py-8">
      <div className="w-12 h-12 rounded-full bg-sky-500/10 border border-sky-400/25 flex items-center justify-center mb-4">
        <Sparkles className="w-6 h-6 text-sky-300" />
      </div>
      <h2 className="text-lg font-semibold text-white mb-1.5">识途 · {categoryLabel}</h2>
      <p className="text-sm text-white/55 mb-6 leading-relaxed">
        基于当前分类知识库的严格 RAG 问答。只回答资料覆盖到的内容；没有就明说，不杜撰。
      </p>
      <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2">
        {samples.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onPick(q)}
            className="text-left rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 transition px-3 py-2.5"
          >
            <div className="text-[12px] text-white/85 line-clamp-2">{q}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? 'bg-sky-500/15 border border-sky-400/25 text-white/95'
            : 'bg-white/[0.04] border border-white/10 text-white/90'
        }`}
      >
        {isUser ? (
          <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
        ) : (
          <>
            {msg.errorMsg ? (
              <div className="text-sm text-red-300/90 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{msg.errorMsg}</span>
              </div>
            ) : msg.content ? (
              <MarkdownContent content={msg.content} variant="compact" />
            ) : (
              <div className="text-sm text-white/45 inline-flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                正在思考…
              </div>
            )}

            {msg.streaming && msg.content && (
              <div className="mt-1 text-[10px] text-sky-300/70 inline-flex items-center gap-1">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                生成中…
              </div>
            )}

            {!msg.streaming && msg.references && msg.references.length > 0 && (
              <div className="mt-3 pt-2 border-t border-white/10">
                <div className="text-[10px] text-white/40 mb-1">引用脚注（与回答中 [N] 对应）</div>
                <ol className="text-[11px] text-white/70 space-y-0.5 list-decimal list-inside">
                  {msg.references.map((r) => (
                    <li key={r.entryId}>
                      <span className="text-white/85">{r.title}</span>
                      <span className="text-white/35 ml-1">~{Math.round(r.chars / 1000)}k 字</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {!msg.streaming && msg.model?.name && (
              <div className="mt-1.5 text-[10px] text-white/35 font-mono">
                ● {msg.model.name}
                {msg.model.platform ? ` · ${msg.model.platform}` : ''}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
