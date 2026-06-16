import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquarePlus, Send, StopCircle, AlertCircle } from 'lucide-react';
import { connectSse } from '@/lib/useSseStream';
import { CCAS_PRD_REVISE_STREAM_URL } from '@/services';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { SelectedEntrySnapshot } from './CcasKnowledgePickerDrawer';
import { finalizeCcasReviseDocument, type ReviseStreamOutcome } from './ccasPrdReviseUtils';

interface ReviseHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  errorMsg?: string;
  model?: { name?: string; platform?: string };
}

export interface CcasPrdReviseChatProps {
  templateKey: string;
  currentMarkdown: string;
  originalInput: string;
  referenceSelected: SelectedEntrySnapshot[];
  onDocumentChange: (markdown: string) => void;
  enabled: boolean;
  onBusyChange?: (busy: boolean) => void;
}

const EXAMPLE_PROMPTS = [
  '把产线设备清单改成 6 台工业相机，并补充型号占位',
  '在 Part B 补充 NC 剔除异常处理与告警流程',
  '第三章现状背景写得更具体，补充瓶箱垛关联场景',
  '把所有 [待补充] 标成表格，列出需 PM 确认的问题清单',
];

export function CcasPrdReviseChat({
  templateKey,
  currentMarkdown,
  originalInput,
  referenceSelected,
  onDocumentChange,
  enabled,
  onBusyChange,
}: CcasPrdReviseChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef(`prd-revise-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const docBaseRef = useRef(currentMarkdown);
  const activeRunRef = useRef<{ assistantId: string; baseMarkdown: string } | null>(null);

  const isStreaming = useMemo(() => messages.some((m) => m.streaming), [messages]);

  useEffect(() => {
    onBusyChange?.(isStreaming);
  }, [isStreaming, onBusyChange]);

  useEffect(() => {
    if (!isStreaming) {
      docBaseRef.current = currentMarkdown;
    }
  }, [currentMarkdown, isStreaming]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const startNewSession = useCallback(() => {
    abortRef.current?.abort();
    const active = activeRunRef.current;
    if (active) {
      onDocumentChange(finalizeCcasReviseDocument(active.baseMarkdown, '', 'aborted'));
      activeRunRef.current = null;
    }
    setMessages([]);
    setInput('');
    sessionIdRef.current = `prd-revise-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }, [onDocumentChange]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    const active = activeRunRef.current;
    if (active) {
      onDocumentChange(finalizeCcasReviseDocument(active.baseMarkdown, '', 'aborted'));
      activeRunRef.current = null;
    }
    setMessages((arr) =>
      arr.map((m) => (m.streaming ? { ...m, streaming: false, content: m.content || '（已中止）' } : m))
    );
  }, [onDocumentChange]);

  const send = useCallback(
    async (textOverride?: string) => {
      const q = (textOverride ?? input).trim();
      if (!q || isStreaming || !enabled) return;
      if (!currentMarkdown.trim()) {
        toast.error('请先生成 Part A 后再改稿');
        return;
      }

      const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: q };
      const assistantId = `a-${Date.now()}`;
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        streaming: true,
      };

      const history: ReviseHistoryItem[] = messages
        .filter((m) => !m.streaming && !m.errorMsg && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');

      const ac = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ac;
      const baseMarkdown = docBaseRef.current;
      activeRunRef.current = { assistantId, baseMarkdown };

      const referenceEntryIds = referenceSelected
        .filter((s) => s.kind === 'entry' && !!s.entryId)
        .map((s) => s.entryId!);
      const referenceStoreIds = referenceSelected
        .filter((s) => s.kind === 'store')
        .map((s) => s.storeId);

      const body = {
        templateKey,
        currentMarkdown: baseMarkdown,
        message: q,
        history,
        originalInput: originalInput.trim() || undefined,
        referenceEntryIds: referenceEntryIds.length > 0 ? referenceEntryIds : undefined,
        referenceStoreIds: referenceStoreIds.length > 0 ? referenceStoreIds : undefined,
        sessionId: sessionIdRef.current,
      };

      let streamed = '';
      let streamFailed = false;

      const updateAssistant = (mut: (m: ChatMessage) => ChatMessage) => {
        setMessages((arr) => arr.map((m) => (m.id === assistantId ? mut(m) : m)));
      };

      const restoreBase = (outcome: Exclude<ReviseStreamOutcome, 'completed'>) => {
        const active = activeRunRef.current;
        if (active?.assistantId !== assistantId) return;
        onDocumentChange(finalizeCcasReviseDocument(active.baseMarkdown, streamed, outcome));
        activeRunRef.current = null;
      };

      const { success, errorMessage } = await connectSse({
        url: CCAS_PRD_REVISE_STREAM_URL,
        method: 'POST',
        body,
        signal: ac.signal,
        onEvent: (evt) => {
          const data = evt.data ? safeJson(evt.data) : null;
          if (!data) return;
          switch (evt.event) {
            case 'model':
              updateAssistant((m) => ({
                ...m,
                model: {
                  name: typeof data.model === 'string' ? data.model : undefined,
                  platform: typeof data.platform === 'string' ? data.platform : undefined,
                },
              }));
              break;
            case 'typing':
              if (typeof data.text === 'string') {
                if (activeRunRef.current?.assistantId !== assistantId) break;
                streamed += data.text;
                onDocumentChange(streamed);
              }
              break;
            case 'done': {
              if (streamFailed || activeRunRef.current?.assistantId !== assistantId) break;
              const chars = streamed.length;
              const summary =
                chars > 0
                  ? `已按你的要求更新文档（共 ${chars.toLocaleString()} 字）。可在上方预览核对，不满意可继续追问。`
                  : '改稿完成，但未收到正文，请重试或缩短指令。';
              updateAssistant((m) => ({ ...m, streaming: false, content: summary }));
              const finalMarkdown = finalizeCcasReviseDocument(baseMarkdown, streamed, 'completed');
              if (chars > 0) docBaseRef.current = finalMarkdown;
              onDocumentChange(finalMarkdown);
              activeRunRef.current = null;
              break;
            }
            case 'error':
              streamFailed = true;
              restoreBase('failed');
              updateAssistant((m) => ({
                ...m,
                streaming: false,
                errorMsg: typeof data.message === 'string' ? data.message : '改稿失败',
                content: typeof data.message === 'string' ? data.message : '改稿失败',
              }));
              break;
            default:
              break;
          }
        },
      });

      if (!success) {
        restoreBase(ac.signal.aborted ? 'aborted' : 'failed');
        updateAssistant((m) => ({
          ...m,
          streaming: false,
          errorMsg: m.errorMsg || errorMessage || '连接失败',
          content: m.content || errorMessage || '连接失败',
        }));
      }
    },
    [
      input,
      isStreaming,
      enabled,
      currentMarkdown,
      messages,
      templateKey,
      originalInput,
      referenceSelected,
      onDocumentChange,
    ]
  );

  const onComposerKeydown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  if (!enabled) return null;

  return (
    <section className="shrink-0 rounded-lg border border-amber-400/20 bg-amber-500/5 flex flex-col min-h-0 max-h-[42vh]">
      <div className="shrink-0 px-3 py-2 border-b border-amber-400/15 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-amber-100/95">改稿助手</h3>
          <p className="text-[10px] text-white/45 truncate">
            在上方文档基础上多轮调整；Ctrl+Enter 发送
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={startNewSession}
          disabled={isStreaming}
          className="!h-7 !px-2 !text-[10px] shrink-0"
          title="清空改稿对话记录（不撤销文档内容）"
        >
          <MessageSquarePlus className="w-3 h-3 mr-1" />
          新对话
        </Button>
      </div>

      {messages.length > 0 && (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2"
          style={{ overscrollBehavior: 'contain', maxHeight: '160px' }}
        >
          {messages.map((m) => (
            <div
              key={m.id}
              className={`text-[11px] leading-relaxed ${
                m.role === 'user' ? 'text-white/85' : 'text-white/65'
              }`}
            >
              <span className="text-white/40 mr-1.5">{m.role === 'user' ? '你' : '助手'}</span>
              {m.streaming ? (
                <span className="inline-flex items-center gap-1 text-amber-200/80">
                  <MapSpinner size={12} />
                  正在改稿，请看上方案件实时更新…
                </span>
              ) : m.errorMsg ? (
                <span className="text-red-300/90 inline-flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {m.content}
                </span>
              ) : (
                <span className="whitespace-pre-wrap">{m.content}</span>
              )}
              {m.model?.name && !m.streaming && (
                <div className="mt-0.5 text-[9px] font-mono text-white/30">
                  {m.model.name}
                  {m.model.platform ? ` · ${m.model.platform}` : ''}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {messages.length === 0 && (
        <div className="px-3 py-2 flex flex-wrap gap-1.5">
          {EXAMPLE_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void send(p)}
              disabled={isStreaming}
              className="text-[10px] px-2 py-1 rounded-md border border-white/10 bg-white/5 text-white/55 hover:bg-white/10 hover:text-white/75 transition text-left"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="shrink-0 px-3 py-2 border-t border-amber-400/10 flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onComposerKeydown}
          placeholder="例：把第二章设备数量改成 4 台相机；补充垛码校验失败时的告警文案…"
          rows={2}
          disabled={isStreaming}
          className="flex-1 min-h-[52px] rounded-md bg-black/30 border border-white/15 px-2.5 py-2 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/50 resize-none"
        />
        <div className="flex flex-col gap-1 shrink-0">
          {isStreaming ? (
            <Button variant="ghost" onClick={abort} className="!h-8 !px-2 !text-[10px]">
              <StopCircle className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button
              onClick={() => void send()}
              disabled={!input.trim()}
              className="!h-8 !px-2.5 !text-[10px]"
            >
              <Send className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function mergeCcasPrdParts(partA: string, partB: string): string {
  const a = partA.trim();
  const b = partB.trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n---\n\n${b}`;
}

export function splitCcasPrdMerged(
  merged: string,
  hadPartB: boolean
): { partA: string; partB: string } {
  const text = merged.trim();
  if (!hadPartB) return { partA: text, partB: '' };
  const sep = '\n\n---\n\n';
  const idx = text.indexOf(sep);
  if (idx === -1) return { partA: text, partB: '' };
  return {
    partA: text.slice(0, idx).trim(),
    partB: text.slice(idx + sep.length).trim(),
  };
}
