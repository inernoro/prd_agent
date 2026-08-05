/**
 * 通用对话智能体 —— 打开就能聊的多轮对话入口。
 *
 * 这个页面只做三件事：显示会话与消息、把输入发出去、订阅事件流把增量画出来。
 * 对话循环在 agent 运行时的官方 SDK 里，前后端都没有循环代码
 * （见 doc/design.platform.chat-agent.md「写与不写的分界线」）。
 *
 * 断线恢复：事件流按 afterSeq 续订。刷新页面、切走再回来、换设备登录，
 * 都从上次收到的序号接着补，内容不丢。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  MessageSquare, Plus, Trash2, Pencil, Check, X, Send,
  AlertTriangle, RotateCcw, Sparkles, Wrench, ExternalLink,
} from 'lucide-react';
import {
  listChatSessions, createChatSession, renameChatSession, deleteChatSession,
  listChatMessages, sendChatMessage, streamChatEvents,
  type ChatSession, type ChatMessage, type ChatToolCard,
} from '@/services/real/chatAgentService';
import './chat.css';

/** 空会话给三条起手式，免得用户对着空白输入框发呆。 */
const STARTERS = [
  '帮我画一张发布日海报，横版，暖色调',
  '把刚才这段结论记进知识库',
  '我之前存过的配色方案是什么来着',
];

/** 等待期的阶段文案。屏幕上必须一直有变化，静止的加载中超过两秒就是缺陷。 */
const WAIT_PHRASES = ['正在理解你的问题', '正在组织回答', '正在斟酌措辞'];

export function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  /** 当前会话是否有轮次在跑。决定输入框禁用与等待动画。 */
  const [running, setRunning] = useState(false);
  /** 本轮已等待秒数。给用户「还要多久」的量感，而不是一个转圈图标。 */
  const [waited, setWaited] = useState(0);

  /** 本轮的工具卡。按 toolUseId 收敛，开始时进来，结束时更新为产物或失败。 */
  const [toolCards, setToolCards] = useState<ChatToolCard[]>([]);

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef<string | null>(null);

  activeIdRef.current = activeId;

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  // ── 会话列表 ────────────────────────────────────────────
  const loadSessions = useCallback(async (selectFirst: boolean) => {
    const res = await listChatSessions();
    if (!res.success) {
      setNotice(res.error?.message ?? '会话列表加载失败');
      setLoading(false);
      return;
    }
    const items = res.data?.items ?? [];
    setSessions(items);
    if (selectFirst && items.length > 0 && !activeIdRef.current) setActiveId(items[0].id);
    setLoading(false);
  }, []);

  useEffect(() => { void loadSessions(true); }, [loadSessions]);

  // ── 切换会话：拉历史 + 接事件流 ──────────────────────────
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setToolCards([]);
    setRunning(false);
    seqRef.current = 0;
    if (!activeId) return;

    let cancelled = false;

    void (async () => {
      const res = await listChatMessages(activeId);
      if (cancelled || activeIdRef.current !== activeId) return;
      if (!res.success) {
        setNotice(res.error?.message ?? '消息加载失败');
        return;
      }
      setMessages(res.data?.items ?? []);
      const session = sessions.find((s) => s.id === activeId);
      const isRunning = session?.running ?? false;
      setRunning(isRunning);
      // 历史正文已经由消息接口给全了，事件流只需要补「还没落进消息里的增量」。
      // 在跑：从本轮起始序号起订，正好补齐这一轮（不漏长回答的前半段，
      // 也不会把上一轮的增量灌进来）。空闲：从当前水位起订，立刻收到 idle 收流。
      seqRef.current = isRunning
        ? (session?.runningTurnStartSeq ?? session?.eventSeq ?? 0)
        : (session?.eventSeq ?? 0);
      openStream(activeId);
    })();

    return () => { cancelled = true; abortRef.current?.abort(); };
    // sessions 变化不该重连流，只有会话切换才重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ── 事件流 ──────────────────────────────────────────────
  const openStream = useCallback((sessionId: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    void streamChatEvents(sessionId, seqRef.current, (evt) => {
      if (activeIdRef.current !== sessionId) return;
      if (evt.seq > seqRef.current) seqRef.current = evt.seq;

      switch (evt.type) {
        case 'turn_started': {
          setRunning(true);
          setWaited(0);
          setToolCards([]);
          break;
        }
        case 'tool_started': {
          const card: ChatToolCard = {
            toolUseId: String(evt.payload.toolUseId ?? `t${evt.seq}`),
            tool: String(evt.payload.tool ?? ''),
            label: String(evt.payload.label ?? '工具'),
            steps: Array.isArray(evt.payload.steps) ? (evt.payload.steps as string[]) : ['执行'],
            status: 'running',
          };
          setToolCards((prev) => (prev.some((c) => c.toolUseId === card.toolUseId) ? prev : [...prev, card]));
          break;
        }
        case 'tool_finished': {
          const id = String(evt.payload.toolUseId ?? '');
          const ok = evt.payload.ok !== false;
          setToolCards((prev) => prev.map((c) => (c.toolUseId !== id ? c : {
            ...c,
            status: ok ? 'done' : 'failed',
            message: (evt.payload.message as string) ?? null,
            imageUrl: (evt.payload.imageUrl as string) ?? null,
            entryId: (evt.payload.entryId as string) ?? null,
            storeName: (evt.payload.storeName as string) ?? null,
            title: (evt.payload.title as string) ?? null,
            openPath: (evt.payload.openPath as string) ?? null,
          })));
          break;
        }
        case 'text_delta': {
          const text = String(evt.payload.text ?? '');
          if (!text) break;
          setMessages((prev) => appendDelta(prev, text));
          break;
        }
        case 'done': {
          const text = String(evt.payload.text ?? '');
          setMessages((prev) => finishAssistant(prev, text));
          setRunning(false);
          break;
        }
        case 'error': {
          const message = String(evt.payload.message ?? '这一轮失败了，可以重新发一次。');
          setMessages((prev) => failAssistant(prev, message));
          setRunning(false);
          break;
        }
        case 'idle': {
          setRunning(false);
          break;
        }
        default:
          break;
      }
    }, ctrl.signal).catch((err: unknown) => {
      if (ctrl.signal.aborted) return;
      // 流断了要说话，不能装作还在跑让用户干等
      setRunning(false);
      setNotice(err instanceof Error ? err.message : '事件流已断开，重新发一条消息可继续。');
    });
  }, []);

  // 等待计时：给「还要多久」一个量感
  useEffect(() => {
    if (!running) { setWaited(0); return; }
    const t = window.setInterval(() => setWaited((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, running]);

  // ── 动作 ────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    const res = await createChatSession();
    if (!res.success || !res.data?.item) {
      setNotice(res.error?.message ?? '新建会话失败');
      return;
    }
    const item = res.data.item;
    setSessions((prev) => [item, ...prev]);
    setActiveId(item.id);
  }, []);

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content || sending || running) return;

    let sessionId = activeId;
    if (!sessionId) {
      const created = await createChatSession();
      if (!created.success || !created.data?.item) {
        setNotice(created.error?.message ?? '新建会话失败');
        return;
      }
      sessionId = created.data.item.id;
      setSessions((prev) => [created.data!.item, ...prev]);
      setActiveId(sessionId);
    }

    setSending(true);
    setInput('');
    // 先把这两条画上去，用户立刻看到反馈；服务端事件到了再覆盖助手那条。
    const now = new Date().toISOString();
    setMessages((prev) => [
      ...prev,
      makeLocal('user', content, now),
      makeLocal('assistant', '', now),
    ]);
    setRunning(true);
    setWaited(0);
    setToolCards([]);

    const res = await sendChatMessage(sessionId, content);
    setSending(false);
    if (!res.success) {
      setMessages((prev) => failAssistant(prev, res.error?.message ?? '发送失败'));
      setRunning(false);
      return;
    }

    // 空闲时服务端会推 idle 并收流，所以此刻没有任何流在听。
    // 必须用本轮的起始序号重新起订，否则增量到不了页面（只有刷新才看得见）。
    seqRef.current = res.data?.seq ?? seqRef.current;
    openStream(sessionId);

    // 会话标题可能被首条消息改写，顺手刷新一下列表
    void loadSessions(false);
  }, [input, sending, running, activeId, loadSessions, openStream]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await deleteChatSession(id);
    if (!res.success) {
      setNotice(res.error?.message ?? '删除失败');
      return;
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeIdRef.current === id) setActiveId(null);
  }, []);

  const commitRename = useCallback(async (id: string) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title) return;
    const res = await renameChatSession(id, title);
    if (!res.success) {
      setNotice(res.error?.message ?? '改名失败');
      return;
    }
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  }, [renameDraft]);

  // ── 渲染 ────────────────────────────────────────────────
  return (
    <div className="chat-page">
      <aside className="chat-sidebar">
        <button type="button" className="chat-new" onClick={() => void handleCreate()}>
          <Plus size={14} /> 新建会话
        </button>

        <div className="chat-session-list">
          {loading && <div className="chat-hint">正在加载会话…</div>}
          {!loading && sessions.length === 0 && (
            <div className="chat-hint">还没有会话。直接在右边说话就会自动建一个。</div>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`chat-session${s.id === activeId ? ' is-active' : ''}`}
              onClick={() => setActiveId(s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setActiveId(s.id); }}
            >
              {renamingId === s.id ? (
                <div className="chat-session-rename" onClick={(e) => e.stopPropagation()}>
                  <input
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(s.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                  <button type="button" aria-label="确定" onClick={() => void commitRename(s.id)}>
                    <Check size={13} />
                  </button>
                  <button type="button" aria-label="取消" onClick={() => setRenamingId(null)}>
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <>
                  <div className="chat-session-main">
                    <b>{s.title}</b>
                    <span>{formatTime(s.updatedAt)}{s.running ? ' · 进行中' : ''}</span>
                  </div>
                  <div className="chat-session-ops" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      aria-label="改名"
                      onClick={() => { setRenamingId(s.id); setRenameDraft(s.title); }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button type="button" aria-label="删除" onClick={() => void handleDelete(s.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <MessageSquare size={16} />
          <span className="chat-title">{activeSession?.title ?? '通用对话'}</span>
          <span className="chat-model">模型：{activeSession?.effectiveModel ?? '跟随平台默认'}</span>
        </header>

        {notice && (
          <div className="chat-notice">
            <AlertTriangle size={14} />
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="关闭"><X size={13} /></button>
          </div>
        )}

        <div className="chat-stream">
          {messages.length === 0 && !running && (
            <div className="chat-empty">
              <Sparkles size={22} />
              <b>在。想聊什么直接说。</b>
              <p>能多轮对话、在对话里出图、把结论存进知识库、也能翻你存过的东西。说到一半刷新页面不会丢。目前还不会上网、不会读你上传的文件。</p>
              <div className="chat-starters">
                {STARTERS.map((s) => (
                  <button key={s} type="button" onClick={() => setInput(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={m.id || `${m.role}-${i}`} className={`chat-msg is-${m.role}`}>
              <div className="chat-avatar">{m.role === 'user' ? '我' : 'AI'}</div>
              <div className="chat-body">
                {m.status === 'failed' ? (
                  <div className="chat-bubble is-failed">
                    <div className="chat-fail-head"><AlertTriangle size={14} /> 这一轮没成功</div>
                    <p>{m.error ?? '未知原因'}</p>
                    <button
                      type="button"
                      className="chat-retry"
                      onClick={() => setInput(previousUserContent(messages, i))}
                    >
                      <RotateCcw size={12} /> 把上一句填回输入框
                    </button>
                  </div>
                ) : m.content ? (
                  <div className="chat-bubble">
                    {m.role === 'assistant' ? (
                      <div className="chat-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      m.content
                    )}
                    {m.status === 'running' && <span className="chat-caret" />}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {toolCards.length > 0 && (
            <div className="chat-msg is-assistant">
              <div className="chat-avatar">AI</div>
              <div className="chat-body">
                {toolCards.map((c) => (
                  <div key={c.toolUseId} className={`chat-tool is-${c.status}`}>
                    <div className="chat-tool-head">
                      <Wrench size={13} />
                      <b>{c.label}</b>
                      <span className="chat-tool-state">
                        {c.status === 'running' ? '执行中' : c.status === 'done' ? '完成' : '失败'}
                      </span>
                    </div>
                    <div className="chat-tool-steps">
                      {c.steps.map((st, i) => (
                        <s key={st} className={c.status === 'running' ? (i === 0 ? 'on' : '') : 'ok'}>{st}</s>
                      ))}
                    </div>
                    {c.status === 'running' && <div className="chat-tool-bar"><i /></div>}
                    {c.status === 'done' && c.imageUrl && (
                      <img className="chat-tool-image" src={c.imageUrl} alt={c.title ?? '生成的图片'} />
                    )}
                    {c.status === 'done' && c.openPath && (
                      <div className="chat-tool-link">
                        <span>已写入{c.storeName ? ` ${c.storeName}` : ''}{c.title ? ` / ${c.title}` : ''}</span>
                        <a href={c.openPath} target="_blank" rel="noreferrer">
                          打开这篇 <ExternalLink size={11} />
                        </a>
                      </div>
                    )}
                    {c.status === 'done' && !c.imageUrl && !c.openPath && c.message && (
                      <div className="chat-tool-note">{c.message}</div>
                    )}
                    {c.status === 'failed' && (
                      <div className="chat-tool-note is-bad">{c.message ?? '这一步没成功'}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {running && lastAssistantIsEmpty(messages) && toolCards.length === 0 && (
            <div className="chat-msg is-assistant">
              <div className="chat-avatar">AI</div>
              <div className="chat-body">
                <div className="chat-waiting">
                  <span className="chat-dots"><i /><i /><i /></span>
                  {WAIT_PHRASES[Math.min(WAIT_PHRASES.length - 1, Math.floor(waited / 4))]}
                  <span className="chat-waited">已等待 {waited}s</span>
                </div>
              </div>
            </div>
          )}

          <div ref={streamEndRef} />
        </div>

        <div className="chat-composer">
          <textarea
            value={input}
            placeholder={running ? '这一轮还没跑完，等它说完再发' : '说点什么，回车发送，Shift 加回车换行'}
            rows={1}
            disabled={running}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <button
            type="button"
            className="chat-send"
            aria-label="发送"
            disabled={running || sending || input.trim().length === 0}
            onClick={() => void handleSend()}
          >
            <Send size={15} />
          </button>
        </div>
      </section>
    </div>
  );
}

// ── 纯函数：消息列表的局部更新 ─────────────────────────────

function makeLocal(role: 'user' | 'assistant', content: string, now: string): ChatMessage {
  return {
    id: `local-${role}-${now}-${Math.round(performance.now())}`,
    turnId: 'local',
    role,
    content,
    status: role === 'user' ? 'completed' : 'running',
    error: null,
    errorCode: null,
    inputTokens: null,
    outputTokens: null,
    createdAt: now,
    completedAt: null,
  };
}

/** 增量只往最后一条助手消息上追加；没有在跑的助手消息就补一条。 */
function appendDelta(prev: ChatMessage[], text: string): ChatMessage[] {
  const idx = lastAssistantIndex(prev);
  if (idx < 0 || prev[idx].status !== 'running') {
    return [...prev, { ...makeLocal('assistant', text, new Date().toISOString()) }];
  }
  const next = [...prev];
  next[idx] = { ...next[idx], content: next[idx].content + text };
  return next;
}

function finishAssistant(prev: ChatMessage[], text: string): ChatMessage[] {
  const idx = lastAssistantIndex(prev);
  if (idx < 0) return prev;
  const next = [...prev];
  next[idx] = {
    ...next[idx],
    // 服务端给了定稿就以定稿为准，避免增量丢包导致正文残缺
    content: text || next[idx].content,
    status: 'completed',
    completedAt: new Date().toISOString(),
  };
  return next;
}

function failAssistant(prev: ChatMessage[], message: string): ChatMessage[] {
  const idx = lastAssistantIndex(prev);
  if (idx < 0) return prev;
  const next = [...prev];
  next[idx] = { ...next[idx], status: 'failed', error: message };
  return next;
}

function lastAssistantIndex(list: ChatMessage[]): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'assistant') return i;
  return -1;
}

function lastAssistantIsEmpty(list: ChatMessage[]): boolean {
  const idx = lastAssistantIndex(list);
  return idx < 0 || list[idx].content.length === 0;
}

function previousUserContent(list: ChatMessage[], fromIndex: number): string {
  for (let i = fromIndex; i >= 0; i--) if (list[i].role === 'user') return list[i].content;
  return '';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export default ChatPage;
