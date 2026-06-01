import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Send, StopCircle, Globe, BookOpen, Sparkles, MessageSquarePlus,
  AlertCircle, Loader2, X, ChevronUp, ChevronDown,
} from 'lucide-react';
import { connectSse } from '@/lib/useSseStream';
import { CCAS_QA_STREAM_URL } from '@/services';
import type { CcasMeta, CcasQaReferencePayload } from '@/services';
import { Button } from '@/components/design/Button';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { toast } from '@/lib/toast';
import { CcasKnowledgePickerDrawer, type SelectedEntrySnapshot } from './CcasKnowledgePickerDrawer';

interface Props {
  meta: CcasMeta;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 助手消息的引用快照（生成时 reference 事件返回的命中条目） */
  references?: CcasQaReferencePayload['items'];
  /** 助手消息所用模型（流式过程中由 model 事件填充） */
  model?: { name?: string; platform?: string };
  /** 助手消息生成时联网开关状态（用于显示标识） */
  webSearchOn?: boolean;
  /** 是否仍在流式中 */
  streaming?: boolean;
  /** 错误信息 */
  errorMsg?: string;
}

const EXAMPLE_PROMPTS = [
  { label: '什么是瓶箱垛关联模式？', q: '什么是瓶箱垛关联模式？请结合知识库中的实际案例说明。' },
  { label: '裹包机如何与赋码工位联动？', q: '裹包机如何与赋码工位联动？需要哪些通信接口？' },
  { label: '产线 NC 剔除如何配置？', q: '产线 NC 剔除如何配置？知识库里有没有标准操作步骤？' },
  { label: '工业相机选型注意事项', q: '工业相机用于产线赋码采集时，选型有哪些注意事项？' },
];

/**
 * CCAS 智能客服 Tab —— 基于知识库的严格 RAG 问答（DeepSeek 风格对话）
 *
 * 核心约束：
 *   - 默认严格 RAG：只能答知识库覆盖到的内容，否则明说"知识库中没有"
 *   - 联网开关：放宽到"知识库优先 + 模型公开知识补充"，UI 上明确标注
 *   - 引用脚注：助手回复下方显示本次回答用到的知识库条目（[N] 与系统提示对应）
 *   - 模型可见性：每条助手回复底下显示 "● 模型 · 平台"
 */
export function CcasQaTab({ meta: _meta }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [referenceSelected, setReferenceSelected] = useState<SelectedEntrySnapshot[]>([]);
  const [showRefList, setShowRefList] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string>(`qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const isStreaming = useMemo(() => messages.some((m) => m.streaming), [messages]);

  // 自动滚到底部（流式更新时）
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const startNewSession = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    sessionIdRef.current = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setMessages((arr) =>
      arr.map((m) => (m.streaming ? { ...m, streaming: false, content: m.content || '_（已中止）_' } : m))
    );
  }, []);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || isStreaming) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: q,
    };
    const assistantId = `a-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      references: [],
      streaming: true,
      webSearchOn: webSearch,
    };

    // 将历史（含本轮用户输入）切片为后端 history 格式 —— 包含历史轮次但不含当前用户问题
    const history = messages
      .filter((m) => !m.streaming && !m.errorMsg && (m.content?.trim() || '').length > 0)
      .map<{ role: 'user' | 'assistant'; content: string }>((m) => ({ role: m.role, content: m.content }));

    setMessages([...messages, userMsg, assistantMsg]);
    setInput('');

    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;

    const referenceEntryIds = referenceSelected
      .filter((s) => s.kind === 'entry' && !!s.entryId)
      .map((s) => s.entryId!);
    const referenceStoreIds = referenceSelected
      .filter((s) => s.kind === 'store')
      .map((s) => s.storeId);
    const body = {
      message: q,
      history,
      referenceEntryIds: referenceEntryIds.length > 0 ? referenceEntryIds : undefined,
      referenceStoreIds: referenceStoreIds.length > 0 ? referenceStoreIds : undefined,
      webSearch,
      sessionId: sessionIdRef.current,
    };

    const updateAssistant = (mut: (m: ChatMessage) => ChatMessage) => {
      setMessages((arr) => arr.map((m) => (m.id === assistantId ? mut(m) : m)));
    };

    const { success, errorMessage } = await connectSse({
      url: CCAS_QA_STREAM_URL,
      method: 'POST',
      body,
      signal: ac.signal,
      onEvent: (evt) => {
        const data = evt.data ? safeJson(evt.data) : null;
        if (!data) return;
        switch (evt.event) {
          case 'phase':
            // phase 事件用于早期反馈，但不阻塞 UI；在助手气泡里显示一条短状态
            if (typeof data.message === 'string') {
              updateAssistant((m) => ({ ...m, content: m.content || '' }));
            }
            break;
          case 'model':
            updateAssistant((m) => ({
              ...m,
              model: {
                name: typeof data.model === 'string' ? data.model : undefined,
                platform: typeof data.platform === 'string' ? data.platform : undefined,
              },
            }));
            break;
          case 'reference': {
            const items = Array.isArray(data.items) ? (data.items as CcasQaReferencePayload['items']) : [];
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
            break;
          case 'error':
            updateAssistant((m) => ({
              ...m,
              streaming: false,
              errorMsg: typeof data.message === 'string' ? data.message : '生成失败',
            }));
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
    }
  }, [input, isStreaming, messages, referenceSelected, webSearch]);

  const onComposerKeydown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter 发送，单 Enter 换行（与 DeepSeek 一致）
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  const totalRefChars = referenceSelected.reduce((s, x) => s + x.approxChars, 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-white/10 bg-black/20">
      {/* 顶部状态栏 */}
      <div className="shrink-0 px-4 py-2 border-b border-white/10 flex items-center gap-2 text-[11px] text-white/55">
        <Sparkles className="w-3.5 h-3.5 text-amber-300/70" />
        <span>智能客服（基于知识库的严格 RAG）</span>
        <span className="opacity-40">·</span>
        <span>{webSearch ? '联网检索：开（含模型公开知识）' : '联网检索：关（仅知识库）'}</span>
        <span className="opacity-40">·</span>
        <span>已选 {referenceSelected.length} 个知识来源</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          onClick={startNewSession}
          className="!h-6 !px-2 !text-[11px]"
          disabled={isStreaming}
        >
          <MessageSquarePlus className="w-3 h-3 mr-1" /> 新会话
        </Button>
      </div>

      {/* 已挂载知识库条目折叠面板 */}
      {referenceSelected.length > 0 && (
        <div className="shrink-0 px-4 py-2 border-b border-white/10 bg-amber-500/[0.04]">
          <button
            type="button"
            onClick={() => setShowRefList((v) => !v)}
            className="w-full flex items-center justify-between text-[11px] text-amber-200/85"
          >
            <span className="flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5" />
              已挂载 {referenceSelected.length} 个知识来源 · 约 {totalRefChars.toLocaleString()} 字符
            </span>
            {showRefList ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showRefList && (
            <div className="mt-2 flex flex-col gap-1" style={{ maxHeight: 120, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              {referenceSelected.map((s) => (
                <div
                  key={referenceKey(s)}
                  className="flex items-center gap-2 text-[11px] bg-amber-500/8 border border-amber-400/15 rounded px-2 py-1"
                >
                  <span className="text-amber-200/85 flex-1 min-w-0 truncate">
                    <span className="opacity-60">{s.storeName}</span>
                    <span className="opacity-40 mx-1">/</span>
                    {s.kind === 'store' ? `整库：${s.title}` : s.title}
                  </span>
                  <span className="text-white/45 shrink-0">~{Math.round(s.approxChars / 1000)}k 字</span>
                  <button
                    type="button"
                    onClick={() => setReferenceSelected((arr) => arr.filter((x) => referenceKey(x) !== referenceKey(s)))}
                    className="text-white/35 hover:text-white/70"
                    disabled={isStreaming}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 消息流 */}
      <div
        ref={scrollRef}
        className="flex-1 px-4 py-4 flex flex-col gap-4"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {messages.length === 0 ? (
          <Welcome
            onPick={(q) => setInput(q)}
            hasReference={referenceSelected.length > 0}
            onPickRef={() => setPickerOpen(true)}
          />
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-white/10 bg-black/30 px-4 py-3">
        <div className="rounded-xl border border-white/15 bg-black/40 focus-within:border-amber-400/50 transition">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeydown}
            rows={3}
            placeholder={
              referenceSelected.length === 0
                ? '请先点下方「引用知识库」挂载参考资料，再输入问题…（Cmd/Ctrl+Enter 发送）'
                : '基于已挂载的知识库提问…（Cmd/Ctrl+Enter 发送）'
            }
            className="w-full bg-transparent border-0 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none resize-none"
            disabled={isStreaming}
          />
          <div className="flex items-center gap-2 px-2 py-2 border-t border-white/10">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={isStreaming}
              className="h-7 px-2 rounded-md border border-white/15 bg-white/5 hover:bg-white/10 text-[11px] text-white/80 inline-flex items-center gap-1 disabled:opacity-50"
              title="从知识库挑选参考条目"
            >
              <BookOpen className="w-3 h-3" />
              {referenceSelected.length > 0 ? `已选 ${referenceSelected.length}` : '引用知识库'}
            </button>

            <button
              type="button"
              onClick={() => setWebSearch((v) => !v)}
              disabled={isStreaming}
              className={`h-7 px-2 rounded-md border text-[11px] inline-flex items-center gap-1 transition disabled:opacity-50 ${
                webSearch
                  ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-white/15 bg-white/5 text-white/65 hover:bg-white/10'
              }`}
              title={
                webSearch
                  ? '联网检索已开：允许 AI 引用模型公开知识（非实时联网）'
                  : '联网检索已关：严格只用知识库回答'
              }
            >
              <Globe className="w-3 h-3" />
              {webSearch ? '联网开' : '联网'}
            </button>

            <div className="flex-1" />

            <span className="text-[10px] text-white/35">
              {webSearch ? '允许引用模型公开知识' : '严格知识库模式'}
            </span>

            {isStreaming ? (
              <Button onClick={abort} variant="ghost" className="!h-7 !px-2.5 !text-[11px]">
                <StopCircle className="w-3 h-3 mr-1" />
                中止
              </Button>
            ) : (
              <Button
                onClick={() => void send()}
                disabled={!input.trim()}
                variant="primary"
                className="!h-7 !px-3 !text-[11px]"
              >
                <Send className="w-3 h-3 mr-1" /> 发送
              </Button>
            )}
          </div>
        </div>
      </div>

      <CcasKnowledgePickerDrawer
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedSnapshot={referenceSelected}
        onConfirm={(arr) => {
          setReferenceSelected(arr);
          if (arr.length > 0 && referenceSelected.length === 0) {
            toast.success(`已挂载 ${arr.length} 个知识来源`);
          }
        }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────
// 子组件
// ──────────────────────────────────────────────

function Welcome({
  onPick,
  hasReference,
  onPickRef,
}: {
  onPick: (q: string) => void;
  hasReference: boolean;
  onPickRef: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center max-w-xl mx-auto px-4 py-8">
      <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-400/25 flex items-center justify-center mb-4">
        <Sparkles className="w-6 h-6 text-amber-300" />
      </div>
      <h2 className="text-lg font-semibold text-white mb-1.5">CCAS 智能客服</h2>
      <p className="text-sm text-white/55 mb-1">
        基于<span className="text-amber-300/85">米多内部知识库</span>的严格 RAG 问答。
      </p>
      <p className="text-[12px] text-white/40 mb-6 leading-relaxed">
        默认只回答知识库覆盖到的内容；若想让 AI 在知识库不足时补充模型公开知识，请打开下方「联网」开关（不接入实时网页爬虫）。
      </p>

      {!hasReference && (
        <div className="mb-5 w-full rounded-lg border border-amber-400/20 bg-amber-500/8 px-4 py-3 text-[12px] text-amber-200/85">
          <div className="flex items-center gap-2 mb-1.5">
            <BookOpen className="w-3.5 h-3.5" />
            <span className="font-medium">先挂载知识库</span>
          </div>
          <p className="text-white/55">
            请到「左侧导航 → 知识库」上传或选择资料，回到此处点击下方「引用知识库」挂载到对话上下文。
          </p>
          <Button onClick={onPickRef} variant="primary" className="!h-7 !px-3 !text-[11px] mt-2">
            <BookOpen className="w-3 h-3 mr-1" /> 挂载知识库
          </Button>
        </div>
      )}

      <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onPick(p.q)}
            className="text-left rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 transition px-3 py-2.5"
          >
            <div className="text-[12px] text-white/85">{p.label}</div>
            <div className="text-[10px] text-white/40 mt-0.5 truncate">{p.q}</div>
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
            ? 'bg-amber-500/15 border border-amber-400/25 text-white/95'
            : 'bg-white/[0.04] border border-white/10 text-white/90'
        }`}
      >
        {isUser ? (
          <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
        ) : (
          <>
            {msg.errorMsg ? (
              <div className="text-sm text-red-300/90 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> <span>{msg.errorMsg}</span>
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
              <div className="mt-1 text-[10px] text-amber-300/70 inline-flex items-center gap-1">
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

            {!msg.streaming && (msg.model?.name || msg.webSearchOn) && (
              <div className="mt-1.5 text-[10px] text-white/35 font-mono flex items-center gap-2">
                {msg.model?.name && (
                  <span>
                    ● {msg.model.name}
                    {msg.model.platform ? ` · ${msg.model.platform}` : ''}
                  </span>
                )}
                {msg.webSearchOn && <span className="text-emerald-300/70">· 联网模式</span>}
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

function referenceKey(ref: SelectedEntrySnapshot) {
  return ref.kind === 'store' ? `store:${ref.storeId}` : `entry:${ref.entryId ?? ref.storeId}`;
}
