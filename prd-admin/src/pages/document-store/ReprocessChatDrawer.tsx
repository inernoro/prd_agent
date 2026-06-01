import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Wand2, X, Send, Replace, FileDown, FilePlus2, RotateCw, AlertCircle, Bot, Plus, Trash2, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming';
import { ChatMarkdown } from '@/pages/pa-agent/ChatMarkdown';
import {
  listReprocessAgents,
  createReprocessAgent,
  deleteReprocessAgent,
  applyReprocessContent,
  getDocumentContent,
} from '@/services';
import { streamDirectChat, listToolboxItems } from '@/services/real/aiToolbox';
import type { ToolboxItem } from '@/services/real/aiToolbox';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import type {
  ReprocessAgent,
} from '@/services/contracts/documentStore';
import { toast } from '@/lib/toast';

export type ReprocessChatDrawerProps = {
  entryId: string;
  entryTitle: string;
  storeId: string;
  onClose: () => void;
  onApplied?: (mode: 'replace' | 'append' | 'new', entryId: string) => void;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  /** 标记来源："templateLabel" / "百宝箱:agentKey" / "我的:agentKey" */
  invoker?: { kind: 'toolbox' | 'kbAgent'; label: string; ref: string };
  content: string;
  streaming?: boolean;
  applied?: 'replace' | 'append' | 'new';
};

const PRIMARY_TOOLBOX_KEYS = [
  // 优先呈现"最适合纯文本输入"的智能体——视觉/视频/缺陷等需要复杂上下文的放到次要分组
  'builtin-literary-agent',
  'builtin-report-agent',
  'builtin-pa-agent',
  'builtin-pm-agent',
  'builtin-task-tree',
];

/**
 * 文档再加工 · Chat 抽屉 v2 —— 直接调用百宝箱智能体 + 用户自建轻量智能体。
 *
 * 设计变更（按用户反馈）：
 *   1. 不再走我自建的 reprocess Worker/Processor。当前文档全文 + 用户消息直接走
 *      `/api/ai-toolbox/direct-chat` 复用百宝箱的 LLM 调度（百宝箱才是系统智能体 SSOT）。
 *   2. 「百宝箱」chip 行从 BUILTIN_TOOLS + 用户自建百宝箱工具拼出。
 *   3. 「我的快捷智能体」chip 行保留：用户能在抽屉里一键创建自己的 system prompt 简化版智能体；
 *      它们在前端展开为 `system prompt + 文档 + 用户消息` 拼一段发给同一个 direct-chat。
 *   4. 三种写回（替换原文 / 追加末尾 / 另存为新文档）调新的 `apply-content` 接口，不依赖 Run。
 */
export function ReprocessChatDrawer({
  entryId,
  entryTitle,
  storeId: _storeId,
  onClose,
  onApplied,
}: ReprocessChatDrawerProps) {
  // 数据
  const [toolboxItems, setToolboxItems] = useState<ToolboxItem[]>([]); // 百宝箱（内置 + 用户自建）
  const [kbAgents, setKbAgents] = useState<ReprocessAgent[]>([]);      // 知识库轻量智能体
  const [docContent, setDocContent] = useState<string>('');             // 文档全文
  const [loading, setLoading] = useState(true);

  // 会话
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const cancelStreamRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 当前选定的智能体（影响"如果只输入而不点 chip，按谁的语境跑"）
  const [activeInvoker, setActiveInvoker] = useState<ChatMessage['invoker']>();

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  // 加载：文档全文 + 百宝箱（内置 + 用户自建）+ 我的轻量智能体
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [docRes, agentRes, customToolboxRes] = await Promise.all([
        getDocumentContent(entryId),
        listReprocessAgents(),
        listToolboxItems(),
      ]);
      if (cancelled) return;

      if (docRes.success) setDocContent(docRes.data.content ?? '');

      const userOwnedToolbox = customToolboxRes.success
        ? (customToolboxRes.data.items as ToolboxItem[]).filter((t) => t.kind !== 'tool' || t.systemPrompt)
        : [];
      // 把"最适合文本对话"的内置智能体排前
      const builtinAgents = BUILTIN_TOOLS.filter((t) => t.kind === 'agent' && !t.wip);
      const ordered = builtinAgents.sort((a, b) => {
        const ia = PRIMARY_TOOLBOX_KEYS.indexOf(a.id);
        const ib = PRIMARY_TOOLBOX_KEYS.indexOf(b.id);
        if (ia < 0 && ib < 0) return 0;
        if (ia < 0) return 1;
        if (ib < 0) return -1;
        return ia - ib;
      });
      setToolboxItems([...ordered, ...userOwnedToolbox]);

      if (agentRes.success) setKbAgents(agentRes.data.items);

      setLoading(false);
    })();
    return () => {
      cancelled = true;
      cancelStreamRef.current?.();
    };
  }, [entryId]);

  // 取消上一次流（切换智能体或关闭）
  useEffect(() => () => { cancelStreamRef.current?.(); }, []);

  // ── 发送消息（核心：组装 message 并调 direct-chat） ──
  const sendMessage = useCallback(async (
    userText: string,
    invoker: ChatMessage['invoker'],
  ) => {
    if (streamingId) return;
    if (!userText.trim()) return;

    // 找智能体定义
    let agentKey: string | undefined;
    let itemId: string | undefined;
    let kbSystemPrompt: string | undefined;

    if (invoker?.kind === 'toolbox') {
      const tb = toolboxItems.find((t) => t.id === invoker.ref);
      if (tb?.type === 'builtin' && tb.agentKey) {
        agentKey = tb.agentKey;
      } else {
        itemId = invoker.ref;
      }
    } else if (invoker?.kind === 'kbAgent') {
      const agent = kbAgents.find((a) => a.key === invoker.ref);
      kbSystemPrompt = agent?.systemPrompt;
      // 没有匹配 agentKey 时，让 direct-chat 走默认 chat 调度（不传 agentKey/itemId）
    }

    setError(null);

    const userMsgId = 'u-' + Date.now();
    const asstMsgId = 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: userText.trim(),
      invoker,
    };
    const asstMsg: ChatMessage = {
      id: asstMsgId,
      role: 'assistant',
      content: '',
      streaming: true,
      invoker,
    };
    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setStreamingId(asstMsgId);
    setInput('');
    scrollToBottom();

    // 组装 message：把文档全文 + 用户指令拼起来。若是 kbAgent，叠加 system prompt 段。
    let composed = '';
    if (kbSystemPrompt) {
      composed += `[智能体角色设定]\n${kbSystemPrompt}\n\n`;
    }
    composed += `[参考文档]\n${docContent}\n\n[用户指令]\n${userText.trim()}`;

    const stop = streamDirectChat({
      message: composed,
      agentKey,
      itemId,
      onText: (chunk) => {
        setMessages((prev) => prev.map((m) =>
          m.id === asstMsgId ? { ...m, content: m.content + chunk } : m));
        scrollToBottom();
      },
      onError: (msg) => {
        setError(msg || '调用失败');
        setMessages((prev) => prev.map((m) =>
          m.id === asstMsgId ? { ...m, streaming: false, content: m.content || '（调用失败：' + (msg || '未知错误') + '）' } : m));
        setStreamingId(null);
      },
      onDone: () => {
        setMessages((prev) => prev.map((m) =>
          m.id === asstMsgId ? { ...m, streaming: false } : m));
        setStreamingId(null);
      },
    });
    cancelStreamRef.current = stop;
  }, [streamingId, toolboxItems, kbAgents, docContent, scrollToBottom]);

  const handleSendInput = useCallback(() => {
    if (!input.trim()) return;
    // 默认调用激活的智能体；未选时走通用 chat
    void sendMessage(input, activeInvoker);
  }, [input, activeInvoker, sendMessage]);

  const handleToolboxChip = useCallback((item: ToolboxItem) => {
    if (streamingId) return;
    const invoker: ChatMessage['invoker'] = { kind: 'toolbox', label: item.name, ref: item.id };
    setActiveInvoker(invoker);
    void sendMessage(`请用「${item.name}」处理这篇文档。`, invoker);
  }, [streamingId, sendMessage]);

  const handleKbAgentChip = useCallback((agent: ReprocessAgent) => {
    if (streamingId) return;
    const invoker: ChatMessage['invoker'] = { kind: 'kbAgent', label: agent.label, ref: agent.key };
    setActiveInvoker(invoker);
    void sendMessage(`请用「${agent.label}」智能体处理这篇文档。`, invoker);
  }, [streamingId, sendMessage]);

  const handleCreateAgent = useCallback(async (in_: {
    label: string;
    description: string;
    systemPrompt: string;
  }) => {
    const res = await createReprocessAgent(in_);
    if (!res.success) {
      toast.error('创建失败', res.error?.message);
      return false;
    }
    setKbAgents((prev) => [...prev, res.data]);
    toast.success('智能体创建成功', '可立即点击调用');
    return true;
  }, []);

  const handleDeleteAgent = useCallback(async (agent: ReprocessAgent) => {
    if (!agent.isOwn) return;
    if (!window.confirm(`删除「${agent.label}」？此操作不可撤销。`)) return;
    const res = await deleteReprocessAgent(agent.id);
    if (!res.success) {
      toast.error('删除失败', res.error?.message);
      return;
    }
    setKbAgents((prev) => prev.filter((a) => a.id !== agent.id));
  }, []);

  const handleApply = useCallback(async (
    msgId: string,
    mode: 'replace' | 'append' | 'new',
  ) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'assistant' || !msg.content) return;
    const key = `${msgId}:${mode}`;
    if (applying) return;
    setApplying(key);
    const res = await applyReprocessContent(entryId, { mode, content: msg.content });
    setApplying(null);
    if (!res.success) {
      toast.error('写回失败', res.error?.message);
      return;
    }
    const target = res.data.outputEntryId || res.data.updatedEntryId;
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, applied: mode } : m));
    const label = mode === 'replace' ? '替换原文' : mode === 'append' ? '追加末尾' : '另存为新文档';
    toast.success(`${label}成功`, mode === 'new' ? '新文档已生成' : '文档已更新');
    if (target && onApplied) onApplied(mode, target);
  }, [messages, applying, entryId, onApplied]);

  const isBusy = streamingId !== null;

  // ── 渲染 ──
  const modal = (
    <motion.div
      className="surface-backdrop fixed inset-0 z-[100] flex justify-end"
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.2 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="surface-popover flex flex-col border-l border-token-subtle"
        style={{ width: 'min(640px, 96vw)', height: '100vh', minHeight: 0 }}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      >
        {/* Header */}
        <div className="surface-panel-header flex items-center justify-between px-5 py-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
              <Wand2 size={15} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">AI 文档对话</p>
              <p className="truncate text-[10px] text-token-muted">{entryTitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6"
          >
            <X size={15} />
          </button>
        </div>

        {/* 智能体选区（常驻） */}
        <div className="px-5 pt-3 pb-2 shrink-0 space-y-2 border-b border-token-subtle">
          {/* 百宝箱智能体 */}
          <div>
            <p className="mb-1.5 text-[10px] text-token-muted flex items-center gap-1">
              <Sparkles size={10} /> 百宝箱智能体（系统注册的通用智能体，文档作为输入直接调用）
            </p>
            <div className="flex flex-wrap gap-1.5">
              {toolboxItems.length === 0 && !loading ? (
                <span className="text-[10px] text-token-muted">加载中…</span>
              ) : (
                toolboxItems.map((item) => (
                  <ToolboxChip
                    key={item.id}
                    item={item}
                    active={activeInvoker?.kind === 'toolbox' && activeInvoker.ref === item.id}
                    disabled={isBusy}
                    onClick={() => handleToolboxChip(item)}
                  />
                ))
              )}
            </div>
          </div>

          {/* 我的快捷智能体（轻量 system prompt） */}
          <div>
            <p className="mb-1.5 text-[10px] text-token-muted flex items-center gap-1">
              <Bot size={10} /> 我的快捷智能体（一键 system prompt，调用时叠加到百宝箱通用链路）
            </p>
            <div className="flex flex-wrap gap-1.5">
              {kbAgents.filter((a) => a.visibility === 'system').map((a) => (
                <KbAgentChip
                  key={a.id}
                  agent={a}
                  active={activeInvoker?.kind === 'kbAgent' && activeInvoker.ref === a.key}
                  disabled={isBusy}
                  onClick={() => handleKbAgentChip(a)}
                />
              ))}
              {kbAgents.filter((a) => a.visibility === 'personal').map((a) => (
                <KbAgentChip
                  key={a.id}
                  agent={a}
                  active={activeInvoker?.kind === 'kbAgent' && activeInvoker.ref === a.key}
                  disabled={isBusy}
                  onClick={() => handleKbAgentChip(a)}
                  onDelete={() => handleDeleteAgent(a)}
                />
              ))}
              <button
                onClick={() => setShowCreateAgent(true)}
                className="rounded-full px-3 py-1.5 text-[11px] font-medium hover:bg-white/8 transition-colors flex items-center gap-1"
                style={{
                  background: 'rgba(96,165,250,0.10)',
                  border: '1px dashed rgba(96,165,250,0.4)',
                  color: 'rgba(96,165,250,0.95)',
                }}
                title="创建一个新的快捷智能体（自定义 system prompt）"
              >
                <Plus size={10} /> 新建智能体
              </button>
            </div>
          </div>
        </div>

        {/* 创建智能体浮层 */}
        <AnimatePresence>
          {showCreateAgent && (
            <CreateAgentModal
              onClose={() => setShowCreateAgent(false)}
              onSubmit={async (in_) => {
                const ok = await handleCreateAgent(in_);
                if (ok) setShowCreateAgent(false);
              }}
            />
          )}
        </AnimatePresence>

        {/* 消息流 */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-5 py-4 space-y-4"
          style={{ minHeight: 0, overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <MapSectionLoader text="加载会话…" />
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
              <div className="surface-action-accent flex h-12 w-12 items-center justify-center rounded-[14px]">
                <Wand2 size={20} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-token-primary mb-1">选个智能体开始处理这篇文档</p>
                <p className="text-[11px] text-token-muted max-w-[340px] leading-relaxed">
                  上方任选一个百宝箱智能体（或自建快捷智能体）点击调用；也可以在下方输入框写指令配合任一智能体使用。文档全文会作为输入自动传给智能体。
                </p>
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                applying={applying}
                onApply={handleApply}
              />
            ))
          )}
          {error && (
            <div className="rounded-[10px] p-3 text-[11px] flex items-start gap-2"
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                color: 'rgba(248,113,113,0.95)',
              }}
            >
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div className="surface-panel-footer px-5 py-3 shrink-0 border-t border-token-subtle">
          <div className="flex gap-2 items-end">
            <textarea
              id="reprocess-chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendInput();
                }
              }}
              placeholder={
                isBusy
                  ? 'AI 正在回复，请稍候…'
                  : activeInvoker
                    ? `继续向「${activeInvoker.label}」追问，Enter 发送`
                    : '直接输入指令，Enter 发送（不选智能体时走通用 chat）'
              }
              disabled={isBusy}
              rows={2}
              className="prd-field flex-1 resize-none rounded-[10px] px-3 py-2 text-[12px] outline-none disabled:opacity-60"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={isBusy || !input.trim()}
              onClick={handleSendInput}
            >
              {isBusy ? <MapSpinner size={12} /> : <Send size={12} />}
              发送
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-token-muted">
            {isBusy
              ? '正在调用百宝箱智能体…文档全文已经作为输入发送'
              : '点击上方智能体 chip 立即跑一轮；或在这里写指令配合当前激活的智能体使用'}
          </p>
        </div>
      </motion.div>
    </motion.div>
  );

  return createPortal(modal, document.body);
}

// ── 百宝箱智能体 chip ──
function ToolboxChip({
  item, active, disabled, onClick,
}: {
  item: ToolboxItem;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const isBuiltin = item.type === 'builtin';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={item.description || item.name}
      className="rounded-full px-3 py-1.5 text-[11px] font-medium hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
      style={{
        background: active
          ? 'rgba(168,85,247,0.22)'
          : isBuiltin ? 'rgba(168,85,247,0.10)' : 'rgba(96,165,250,0.10)',
        border: active
          ? '1px solid rgba(168,85,247,0.55)'
          : isBuiltin ? '1px solid rgba(168,85,247,0.28)' : '1px solid rgba(96,165,250,0.28)',
        color: isBuiltin ? 'rgba(196,166,255,0.95)' : 'rgba(147,197,253,0.95)',
      }}
    >
      <Sparkles size={10} />
      {item.name}
      {!isBuiltin && (
        <span className="ml-1 px-1 rounded text-[9px] font-semibold"
          style={{ background: 'rgba(255,255,255,0.10)' }}
        >我的工具</span>
      )}
    </button>
  );
}

// ── 我的快捷智能体 chip ──
function KbAgentChip({
  agent, active, disabled, onClick, onDelete,
}: {
  agent: ReprocessAgent;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  const isSystem = agent.visibility === 'system';
  return (
    <div
      className="inline-flex items-center gap-1 rounded-full text-[11px] font-medium transition-colors group"
      style={{
        background: active
          ? (isSystem ? 'rgba(34,197,94,0.25)' : 'rgba(34,197,94,0.2)')
          : 'rgba(34,197,94,0.10)',
        border: active ? '1px solid rgba(34,197,94,0.55)' : '1px solid rgba(34,197,94,0.28)',
        color: 'rgba(110,231,158,0.95)',
      }}
    >
      <button
        onClick={onClick}
        disabled={disabled}
        title={agent.description || agent.label}
        className="pl-3 pr-2 py-1.5 hover:bg-white/8 rounded-l-full disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
      >
        <Bot size={10} />
        {agent.label}
        {!isSystem && (
          <span className="ml-1 px-1 rounded text-[9px] font-semibold"
            style={{ background: 'rgba(255,255,255,0.10)' }}
          >我的</span>
        )}
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          disabled={disabled}
          className="pr-2 py-1.5 hover:opacity-100 opacity-40 transition-opacity"
          title="删除"
        >
          <Trash2 size={10} />
        </button>
      )}
    </div>
  );
}

// ── 单条消息 + 写回按钮 ──
function MessageBubble({
  msg, applying, onApply,
}: {
  msg: ChatMessage;
  applying: string | null;
  onApply: (msgId: string, mode: 'replace' | 'append' | 'new') => void;
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className="rounded-[12px] px-3 py-2 text-[12px] text-token-primary max-w-[88%] break-words whitespace-pre-wrap"
          style={{ background: 'rgba(96,165,250,0.14)', border: '1px solid rgba(96,165,250,0.22)' }}
        >
          {msg.invoker && (
            <span className="inline-flex items-center gap-1 mr-2 px-1.5 py-0.5 rounded text-[10px] font-semibold"
              style={{ background: 'rgba(96,165,250,0.22)' }}
            >
              {msg.invoker.label}
            </span>
          )}
          {msg.content}
        </div>
      </div>
    );
  }

  const canApply = !msg.streaming && !!msg.content;
  const busyMode = applying && applying.startsWith(`${msg.id}:`)
    ? applying.split(':')[1]
    : null;

  return (
    <div className="flex">
      <div
        className="rounded-[12px] p-3 text-[12px] surface-row max-w-[92%] w-full"
        style={{ border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="text-[10px] text-token-muted mb-1 flex items-center gap-1.5">
          <Wand2 size={10} /> {msg.invoker?.label ?? 'AI'} 回复
          {msg.streaming && <MapSpinner size={9} />}
        </div>
        {msg.streaming && msg.content ? (
          <StreamingText text={msg.content} streaming mode="blur" />
        ) : msg.content ? (
          <ChatMarkdown content={msg.content} />
        ) : (
          <span className="text-token-muted">AI 正在思考…</span>
        )}

        {canApply && (
          <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2 border-t border-token-subtle">
            <ApplyBtn
              icon={<Replace size={10} />}
              label="替换原文"
              busy={busyMode === 'replace'}
              applied={msg.applied === 'replace'}
              disabled={!!applying}
              onClick={() => onApply(msg.id, 'replace')}
            />
            <ApplyBtn
              icon={<FileDown size={10} />}
              label="追加末尾"
              busy={busyMode === 'append'}
              applied={msg.applied === 'append'}
              disabled={!!applying}
              onClick={() => onApply(msg.id, 'append')}
            />
            <ApplyBtn
              icon={<FilePlus2 size={10} />}
              label="另存为新文档"
              busy={busyMode === 'new'}
              applied={msg.applied === 'new'}
              disabled={!!applying}
              onClick={() => onApply(msg.id, 'new')}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ApplyBtn({
  icon, label, busy, applied, disabled, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  busy: boolean;
  applied: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[10px] font-medium hover:bg-white/6 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      style={{
        background: applied ? 'rgba(74,222,128,0.12)' : 'rgba(255,255,255,0.04)',
        color: applied ? 'rgba(74,222,128,0.95)' : 'inherit',
        border: applied ? '1px solid rgba(74,222,128,0.25)' : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {busy ? <RotateCw size={10} className="animate-spin" /> : icon}
      {applied ? `${label}（已写回）` : label}
    </button>
  );
}

// ── 创建快捷智能体浮层 ──
function CreateAgentModal({
  onClose, onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { label: string; description: string; systemPrompt: string }) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (submitting || !label.trim() || !systemPrompt.trim()) return;
    setSubmitting(true);
    await onSubmit({
      label: label.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
    });
    setSubmitting(false);
  };

  return createPortal(
    <motion.div
      className="surface-backdrop fixed inset-0 z-[110] flex items-center justify-center px-4"
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.18 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="surface-popover flex flex-col rounded-[14px] border border-token-subtle"
        style={{ width: 'min(560px, 96vw)', maxHeight: '85vh', minHeight: 0 }}
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-token-subtle shrink-0">
          <div className="flex items-center gap-2">
            <div className="surface-action-accent flex h-7 w-7 items-center justify-center rounded-[8px]">
              <Bot size={14} />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-token-primary">新建快捷智能体</p>
              <p className="text-[10px] text-token-muted">
                轻量定义；调用时其 system prompt 会叠加到百宝箱通用 chat 链路
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3" style={{ minHeight: 0 }}>
          <div>
            <label className="block mb-1 text-[11px] font-semibold text-token-muted">
              名称 <span className="text-[10px] font-normal" style={{ color: 'rgba(248,113,113,0.85)' }}>必填</span>
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={30}
              placeholder="例如：高级摘要 / 故事改写 / 风险扫描"
              className="prd-field w-full rounded-[8px] px-3 py-2 text-[12px] outline-none"
            />
          </div>
          <div>
            <label className="block mb-1 text-[11px] font-semibold text-token-muted">描述（可选）</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              placeholder="一句话说明这个智能体擅长什么"
              className="prd-field w-full rounded-[8px] px-3 py-2 text-[12px] outline-none"
            />
          </div>
          <div>
            <label className="block mb-1 text-[11px] font-semibold text-token-muted">
              System Prompt <span className="text-[10px] font-normal" style={{ color: 'rgba(248,113,113,0.85)' }}>必填</span>
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              maxLength={8000}
              rows={10}
              placeholder={'例：你是文档质量审计员。任务：把用户给的文档输出 Markdown 报告 ...'}
              className="prd-field w-full resize-y rounded-[8px] px-3 py-2 text-[12px] outline-none font-mono leading-relaxed"
              style={{ minHeight: 200 }}
            />
            <p className="mt-1 text-[10px] text-token-muted">
              {systemPrompt.length}/8000 字 · 调用时文档全文 + 用户指令会一起进入百宝箱通用 chat 链路
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-token-subtle shrink-0">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>取消</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submitting || !label.trim() || !systemPrompt.trim()}
            onClick={handleSubmit}
          >
            {submitting ? <MapSpinner size={12} /> : <Plus size={12} />}
            创建并可立即调用
          </Button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

void AnimatePresence;
