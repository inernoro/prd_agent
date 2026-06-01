import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Wand2, X, Send, Sparkle, Replace, FileDown, FilePlus2, RotateCw, AlertCircle, Bot, Plus, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming';
import { ChatMarkdown } from '@/pages/pa-agent/ChatMarkdown';
import { useSseStream } from '@/lib/useSseStream';
import { api } from '@/services/api';
import {
  listReprocessTemplates,
  listReprocessAgents,
  createReprocessAgent,
  deleteReprocessAgent,
  sendReprocessChat,
  getActiveReprocessRun,
  applyReprocessMessage,
} from '@/services';
import type {
  ReprocessTemplate,
  ReprocessChatMessage,
  ReprocessAgent,
} from '@/services/contracts/documentStore';
import { useReprocessRunStore } from '@/stores/reprocessRunStore';
import { toast } from '@/lib/toast';

export type ReprocessChatDrawerProps = {
  entryId: string;
  entryTitle: string;
  storeId: string;
  onClose: () => void;
  /** 写回成功后回调（mode + entryId）让上层刷新文件树 / 选中新条目 */
  onApplied?: (mode: 'replace' | 'append' | 'new', entryId: string) => void;
};

type LocalMessage = ReprocessChatMessage & {
  /** 仅 assistant 用：当前是否还在流式接收 */
  streaming?: boolean;
  /** 写回状态 */
  applied?: 'replace' | 'append' | 'new';
};

/**
 * 文档再加工 · Chat 抽屉 —— 支持多轮对话 + 三种写回 + 流式输出。
 *
 * 关键点：
 *   1) 多轮：发送 → 后端追加 user 消息到 run.Messages + Status=Queued，worker 跑下一轮
 *   2) 流式：本组件订阅 SSE，按 messageSeq 路由 chunk 到对应 assistant 消息
 *   3) 写回：每条 assistant 消息下方三按钮（替换 / 追加 / 另存为新）
 *   4) 抽屉关掉不取消后端任务（server-authority），但流式订阅会断；
 *      重新打开时通过 getActiveReprocessRun 恢复完整对话
 */
export function ReprocessChatDrawer({
  entryId,
  entryTitle,
  storeId,
  onClose,
  onApplied,
}: ReprocessChatDrawerProps) {
  const [templates, setTemplates] = useState<ReprocessTemplate[] | null>(null);
  const [agents, setAgents] = useState<ReprocessAgent[] | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [hasFirstTemplate, setHasFirstTemplate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [streamingSeq, setStreamingSeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null); // `${seq}:${mode}`
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<LocalMessage[]>([]);

  const startRun = useReprocessRunStore((s) => s.startRun);
  const patchRun = useReprocessRunStore((s) => s.patchRun);

  // 保持 messagesRef 同步（给 SSE 回调用，避免闭包陈旧）
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // 滚到底部
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  // ── SSE：订阅当前 run 的 chunk / messageDone / done / error ──
  const sseUrl = useMemo(() => runId
    ? `${api.documentStore.stores.agentRunStream(runId)}?afterSeq=0`
    : '', [runId]);

  const { start: sseStart, abort: sseAbort } = useSseStream({
    url: sseUrl,
    onEvent: {
      userMessage: (data) => {
        const d = data as { messageSeq: number; content: string; templateKey?: string };
        setMessages((prev) => {
          if (prev.some((m) => m.seq === d.messageSeq)) return prev;
          return [...prev, {
            seq: d.messageSeq,
            role: 'user',
            content: d.content,
            templateKey: d.templateKey,
            createdAt: new Date().toISOString(),
          }];
        });
        scrollToBottom();
      },
      chunk: (data) => {
        const d = data as { text?: string; messageSeq?: number };
        if (!d.text || typeof d.messageSeq !== 'number') return;
        setStreamingSeq(d.messageSeq);
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.seq === d.messageSeq);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], content: (next[idx].content || '') + d.text };
            return next;
          }
          return [...prev, {
            seq: d.messageSeq!,
            role: 'assistant',
            content: d.text!,
            streaming: true,
            createdAt: new Date().toISOString(),
          }];
        });
        scrollToBottom();
      },
      progress: (data) => {
        const d = data as { progress?: number; phase?: string };
        if (runId) {
          patchRun(runId, {
            ...(typeof d.progress === 'number' ? { progress: d.progress } : {}),
            ...(d.phase ? { phase: d.phase } : {}),
          });
        }
      },
      messageDone: (data) => {
        const d = data as { messageSeq: number; content: string };
        setMessages((prev) => prev.map((m) => m.seq === d.messageSeq
          ? { ...m, content: d.content, streaming: false }
          : m));
        setStreamingSeq(null);
      },
      done: () => {
        // 一轮结束，标记所有 assistant streaming=false
        setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
        setStreamingSeq(null);
        if (runId) patchRun(runId, { status: 'done', progress: 100, phase: '完成' });
      },
    },
    onError: (msg) => {
      setError(msg || '连接出错');
      setStreamingSeq(null);
      if (runId) patchRun(runId, { status: 'failed', errorMessage: msg });
    },
  });

  // 加载模板 + 恢复活跃会话
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [tplRes, agentRes, runRes] = await Promise.all([
        listReprocessTemplates(),
        listReprocessAgents(),
        getActiveReprocessRun(entryId),
      ]);
      if (cancelled) return;
      if (tplRes.success) setTemplates(tplRes.data.items);
      if (agentRes.success) setAgents(agentRes.data.items);
      if (runRes.success && runRes.data) {
        const r = runRes.data;
        const msgs: LocalMessage[] = (r.messages ?? []).map((m) => ({ ...m }));
        setMessages(msgs);
        setRunId(r.id);
        setHasFirstTemplate(msgs.some((m) => m.role === 'user' && !!m.templateKey));
        if (r.status === 'running' || r.status === 'queued') {
          // 末尾若是 user，意味着 assistant 还没产出 → 标记为 streamingSeq
          const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
          if (lastUser) setStreamingSeq(lastUser.seq + 1);
        }
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [entryId]);

  // runId 变化时启动 SSE
  useEffect(() => {
    if (!runId) return;
    void sseStart();
    return () => sseAbort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const sendMessage = useCallback(async (content: string, templateKey?: string) => {
    if (sending || streamingSeq !== null) return;
    if (!content.trim()) return;
    setError(null);
    setSending(true);
    const res = await sendReprocessChat(entryId, {
      runId: runId ?? undefined,
      content: content.trim(),
      templateKey,
    });
    if (!res.success) {
      setSending(false);
      toast.error('发送失败', res.error?.message);
      return;
    }
    const { runId: newRunId, messageSeq } = res.data;
    // 本地立即追加 user 消息 + 占位 assistant 消息（SSE 还没到时也有占位）
    setMessages((prev) => {
      if (prev.some((m) => m.seq === messageSeq)) return prev;
      return [...prev, {
        seq: messageSeq,
        role: 'user',
        content: content.trim(),
        templateKey,
        createdAt: new Date().toISOString(),
      }];
    });
    setStreamingSeq(messageSeq + 1);
    setInput('');
    if (templateKey) setHasFirstTemplate(true);
    if (!runId) {
      setRunId(newRunId);
      startRun({
        runId: newRunId,
        storeId,
        sourceEntryId: entryId,
        sourceTitle: entryTitle,
      });
    } else {
      patchRun(runId, { status: 'streaming', progress: 0, phase: '排队中' });
      // 已有 runId 时，SSE 已订阅；新一轮会继续推 chunk
    }
    setSending(false);
    scrollToBottom();
  }, [sending, streamingSeq, runId, entryId, entryTitle, storeId, startRun, patchRun, scrollToBottom]);

  const handleSend = useCallback(() => {
    void sendMessage(input);
  }, [input, sendMessage]);

  const handleChip = useCallback((tpl: ReprocessTemplate | { key: 'custom'; label: string }) => {
    if (sending || streamingSeq !== null) return;
    if (tpl.key === 'custom') {
      // 自定义：聚焦输入框，提示用户写自己的指令
      const ta = document.getElementById('reprocess-chat-input') as HTMLTextAreaElement | null;
      ta?.focus();
      return;
    }
    void sendMessage(`请用「${tpl.label}」方式处理这篇文档。`, tpl.key);
  }, [sending, streamingSeq, sendMessage]);

  const handleAgentChip = useCallback((agent: ReprocessAgent) => {
    if (sending || streamingSeq !== null) return;
    void sendMessage(`请用「${agent.label}」智能体处理这篇文档。`, agent.key);
  }, [sending, streamingSeq, sendMessage]);

  const handleCreateAgent = useCallback(async (input: {
    label: string;
    description: string;
    systemPrompt: string;
  }) => {
    const res = await createReprocessAgent(input);
    if (!res.success) {
      toast.error('创建失败', res.error?.message);
      return false;
    }
    setAgents((prev) => [...(prev ?? []), res.data]);
    toast.success('智能体创建成功', '可立即在上方点击调用');
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
    setAgents((prev) => (prev ?? []).filter((a) => a.id !== agent.id));
  }, []);

  const handleApply = useCallback(async (
    seq: number,
    mode: 'replace' | 'append' | 'new',
  ) => {
    if (!runId) return;
    const key = `${seq}:${mode}`;
    if (applying) return;
    setApplying(key);
    const res = await applyReprocessMessage(runId, { messageSeq: seq, mode });
    setApplying(null);
    if (!res.success) {
      toast.error('写回失败', res.error?.message);
      return;
    }
    const target = res.data.outputEntryId || res.data.updatedEntryId;
    setMessages((prev) => prev.map((m) => m.seq === seq ? { ...m, applied: mode } : m));
    const label = mode === 'replace' ? '替换原文' : mode === 'append' ? '追加末尾' : '另存为新文档';
    toast.success(`${label}成功`, mode === 'new' ? '新文档已生成' : '文档已更新');
    if (target && onApplied) onApplied(mode, target);
  }, [runId, applying, onApplied]);

  // ── 渲染 ──
  const isBusy = sending || streamingSeq !== null;
  // chip 行常驻：用户可以在多轮对话过程中随时切换模板或新建智能体
  const showTemplateRow = true;
  void hasFirstTemplate;

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
        style={{ width: 'min(620px, 96vw)', height: '100vh', minHeight: 0 }}
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

        {/* 模板 + 智能体 chip 行（仅首次：尚未选定时显示） */}
        {showTemplateRow && (
          <div className="px-5 pt-3 pb-2 shrink-0 space-y-2 border-b border-token-subtle">
            {/* 模板 */}
            <div>
              <p className="mb-1.5 text-[10px] text-token-muted">一键模板</p>
              <div className="flex flex-wrap gap-1.5">
                {templates?.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => handleChip(t)}
                    disabled={isBusy}
                    className="rounded-full px-3 py-1.5 text-[11px] font-medium text-token-primary hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                    title={t.description}
                  >
                    {t.label}
                  </button>
                ))}
                <button
                  onClick={() => handleChip({ key: 'custom', label: '自定义' })}
                  disabled={isBusy}
                  className="rounded-full px-3 py-1.5 text-[11px] font-medium text-token-primary hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <Sparkle size={10} /> 自定义
                </button>
              </div>
            </div>

            {/* 智能体 */}
            <div>
              <p className="mb-1.5 text-[10px] text-token-muted flex items-center gap-1">
                <Bot size={10} /> 智能体（点击直接调用本系统已注册的智能体）
              </p>
              <div className="flex flex-wrap gap-1.5">
                {agents?.filter((a) => a.visibility === 'system').map((a) => (
                  <AgentChip key={a.id} agent={a} disabled={isBusy} onClick={() => handleAgentChip(a)} />
                ))}
                {agents?.filter((a) => a.visibility === 'personal').map((a) => (
                  <AgentChip
                    key={a.id}
                    agent={a}
                    disabled={isBusy}
                    onClick={() => handleAgentChip(a)}
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
                  title="创建一个新的智能体（自定义 system prompt）"
                >
                  <Plus size={10} /> 新建智能体
                </button>
              </div>
            </div>
          </div>
        )}

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
                <p className="text-[13px] font-semibold text-token-primary mb-1">和这篇文档对话</p>
                <p className="text-[11px] text-token-muted max-w-[320px] leading-relaxed">
                  选一个上方模板快速开始，或直接输入你的指令。AI 会基于「{entryTitle}」的全文回答。
                </p>
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={`${m.seq}`}
                msg={m}
                applying={applying}
                onApply={handleApply}
                streaming={m.streaming || (m.role === 'assistant' && streamingSeq === m.seq)}
              />
            ))
          )}
          {/* assistant 占位（流式开始前 chunk 未到时显示） */}
          {streamingSeq !== null && !messages.some((m) => m.role === 'assistant' && m.seq === streamingSeq) && (
            <div className="rounded-[12px] p-3 surface-row text-[12px] text-token-muted flex items-center gap-2">
              <MapSpinner size={12} /> AI 正在思考…
            </div>
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

        {/* 创建智能体浮层（嵌在抽屉内） */}
        <AnimatePresence>
          {showCreateAgent && (
            <CreateAgentModal
              onClose={() => setShowCreateAgent(false)}
              onSubmit={async (input) => {
                const ok = await handleCreateAgent(input);
                if (ok) setShowCreateAgent(false);
              }}
            />
          )}
        </AnimatePresence>

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
                  handleSend();
                }
              }}
              placeholder={isBusy ? 'AI 正在回复，请稍候…' : '输入你的指令，Enter 发送 / Shift+Enter 换行'}
              disabled={isBusy}
              rows={2}
              className="prd-field flex-1 resize-none rounded-[10px] px-3 py-2 text-[12px] outline-none disabled:opacity-60"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={isBusy || !input.trim()}
              onClick={handleSend}
            >
              {isBusy ? <MapSpinner size={12} /> : <Send size={12} />}
              发送
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-token-muted">
            {streamingSeq !== null
              ? 'AI 回复中…关闭抽屉不会中断任务，重开后可继续查看'
              : '基于本文档全文回答，可多轮追问；满意后用每条回复下方按钮写回'}
          </p>
        </div>
      </motion.div>
    </motion.div>
  );

  return createPortal(modal, document.body);
}

// ── 单条消息气泡 + 写回按钮 ──
function MessageBubble({
  msg,
  applying,
  onApply,
  streaming,
}: {
  msg: LocalMessage;
  applying: string | null;
  onApply: (seq: number, mode: 'replace' | 'append' | 'new') => void;
  streaming: boolean;
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className="rounded-[12px] px-3 py-2 text-[12px] text-token-primary max-w-[88%] break-words whitespace-pre-wrap"
          style={{ background: 'rgba(96,165,250,0.14)', border: '1px solid rgba(96,165,250,0.22)' }}
        >
          {msg.templateKey && (
            <span className="inline-flex items-center gap-1 mr-2 px-1.5 py-0.5 rounded text-[10px] font-semibold"
              style={{ background: 'rgba(96,165,250,0.22)' }}
            >
              {msg.templateKey === 'custom' ? '自定义' : msg.templateKey}
            </span>
          )}
          {msg.content}
        </div>
      </div>
    );
  }

  // assistant
  const canApply = !streaming && !!msg.content;
  const busyMode = applying && applying.startsWith(`${msg.seq}:`)
    ? applying.split(':')[1]
    : null;

  return (
    <div className="flex">
      <div
        className="rounded-[12px] p-3 text-[12px] surface-row max-w-[92%] w-full"
        style={{ border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="text-[10px] text-token-muted mb-1 flex items-center gap-1.5">
          <Wand2 size={10} /> AI 回复
          {streaming && <MapSpinner size={9} />}
        </div>
        {streaming && msg.content ? (
          <StreamingText text={msg.content} streaming mode="blur" />
        ) : msg.content ? (
          <ChatMarkdown content={msg.content} />
        ) : (
          <span className="text-token-muted">…</span>
        )}

        {canApply && (
          <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2 border-t border-token-subtle">
            <ApplyBtn
              icon={<Replace size={10} />}
              label="替换原文"
              busy={busyMode === 'replace'}
              applied={msg.applied === 'replace'}
              disabled={!!applying}
              onClick={() => onApply(msg.seq, 'replace')}
            />
            <ApplyBtn
              icon={<FileDown size={10} />}
              label="追加末尾"
              busy={busyMode === 'append'}
              applied={msg.applied === 'append'}
              disabled={!!applying}
              onClick={() => onApply(msg.seq, 'append')}
            />
            <ApplyBtn
              icon={<FilePlus2 size={10} />}
              label="另存为新文档"
              busy={busyMode === 'new'}
              applied={msg.applied === 'new'}
              disabled={!!applying}
              onClick={() => onApply(msg.seq, 'new')}
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

// ── 智能体 chip（带可选删除按钮） ──
function AgentChip({
  agent, disabled, onClick, onDelete,
}: {
  agent: ReprocessAgent;
  disabled: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  const isSystem = agent.visibility === 'system';
  return (
    <div
      className="inline-flex items-center gap-1 rounded-full text-[11px] font-medium transition-colors group"
      style={{
        background: isSystem ? 'rgba(168,85,247,0.10)' : 'rgba(34,197,94,0.10)',
        border: isSystem ? '1px solid rgba(168,85,247,0.28)' : '1px solid rgba(34,197,94,0.28)',
        color: isSystem ? 'rgba(196,166,255,0.95)' : 'rgba(110,231,158,0.95)',
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

// ── 创建智能体浮层 ──
function CreateAgentModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { label: string; description: string; systemPrompt: string }) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (submitting) return;
    if (!label.trim() || !systemPrompt.trim()) return;
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
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-token-subtle shrink-0">
          <div className="flex items-center gap-2">
            <div className="surface-action-accent flex h-7 w-7 items-center justify-center rounded-[8px]">
              <Bot size={14} />
            </div>
            <p className="text-[13px] font-semibold text-token-primary">新建智能体</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
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
              placeholder={'例：你是产品文档质量审计员。任务：对用户给的文档输出 Markdown 报告，包含：\n## 整体观感\n## 结构问题（最多5条）\n## 表达问题（最多5条）\n## 修改建议\n严格基于原文事实。'}
              className="prd-field w-full resize-y rounded-[8px] px-3 py-2 text-[12px] outline-none font-mono leading-relaxed"
              style={{ minHeight: 200 }}
            />
            <p className="mt-1 text-[10px] text-token-muted">
              {systemPrompt.length}/8000 字 · 调用时会把当前文档全文自动拼到 system 之后，无需在 prompt 里说明"用户会给文档"
            </p>
          </div>
        </div>

        {/* Footer */}
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

// 静默 lint
void AnimatePresence;
