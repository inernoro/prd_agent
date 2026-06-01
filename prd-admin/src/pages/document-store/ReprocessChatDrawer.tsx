import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Wand2, X, Send, Replace, FileDown, FilePlus2, RotateCw, AlertCircle,
  Bot, Plus, Trash2, Sparkles, ChevronDown, Check, FileText, Palette,
  PenTool, Bug, Video, FileBarChart, Brain, Lightbulb, Search, Layers,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
  getActiveReprocessRun,
} from '@/services';
import { streamDirectChat, listToolboxItems } from '@/services/real/aiToolbox';
import type { ToolboxItem } from '@/services/real/aiToolbox';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import type { ReprocessAgent } from '@/services/contracts/documentStore';
import { toast } from '@/lib/toast';

export type ReprocessChatDrawerProps = {
  entryId: string;
  entryTitle: string;
  storeId: string;
  onClose: () => void;
  onApplied?: (mode: 'replace' | 'append' | 'new', entryId: string) => void;
};

// 简易图标 map（lucide name → component）覆盖 BUILTIN_TOOLS 用到的图标
const TOOLBOX_ICON_MAP: Record<string, LucideIcon> = {
  Palette, PenTool, Bug, Video, FileBarChart, Bot, FileText, Sparkles,
  Brain, Lightbulb, Search, Layers,
};

const TOOLBOX_ICON_HUE: Record<string, number> = {
  Palette: 330, PenTool: 45, Bug: 0, Video: 270, FileBarChart: 200,
  Bot: 210, FileText: 220, Sparkles: 280,
};

function ToolboxIcon({ name, size = 14 }: { name?: string; size?: number }) {
  const Comp = (name && TOOLBOX_ICON_MAP[name]) || Bot;
  const hue = (name && TOOLBOX_ICON_HUE[name]) ?? 210;
  return (
    <span
      className="inline-flex items-center justify-center rounded-[6px]"
      style={{
        width: size + 12,
        height: size + 12,
        background: `hsl(${hue} 70% 55% / 0.18)`,
        color: `hsl(${hue} 80% 75%)`,
        border: `1px solid hsl(${hue} 70% 50% / 0.30)`,
      }}
    >
      <Comp size={size} />
    </span>
  );
}

// 输入截断：避免 LLM context 爆
const MAX_DOC_CHARS = 40000;

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  invoker?: { kind: 'toolbox' | 'kbAgent'; label: string; ref: string; icon?: string };
  content: string;
  streaming?: boolean;
  /** 流式阶段：thinking / streaming / done */
  phase?: 'thinking' | 'streaming' | 'done' | 'error';
  applied?: 'replace' | 'append' | 'new';
};

type ActiveAgent =
  | { kind: 'toolbox'; item: ToolboxItem }
  | { kind: 'kbAgent'; agent: ReprocessAgent }
  | null;

const FOCUSED_TOOLBOX_IDS = [
  // 偏文本对话型 builtin agent 排前；视觉/视频/缺陷管理放后面
  'builtin-literary-agent',
  'builtin-report-agent',
  'builtin-pa-agent',
  'builtin-pm-agent',
  'builtin-task-tree',
];

export function ReprocessChatDrawer({
  entryId,
  entryTitle,
  storeId: _storeId,
  onClose,
  onApplied,
}: ReprocessChatDrawerProps) {
  const [toolboxItems, setToolboxItems] = useState<ToolboxItem[]>([]);
  const [kbAgents, setKbAgents] = useState<ReprocessAgent[]>([]);
  const [docContent, setDocContent] = useState<string>('');
  const [docTruncated, setDocTruncated] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [docLoadError, setDocLoadError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [active, setActive] = useState<ActiveAgent>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const cancelStreamRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pickerBtnRef = useRef<HTMLButtonElement>(null);
  // 同步发送锁：state 是异步的，React 还没提交 setStreamingId 之前
  // 第二次点击/双击可能溜过 isBusy 检查同时跑两条流（Bugbot #2 二轮 Medium）。
  // 用 ref 立刻翻转，发送入口先抢这把 ref 锁，再触发任何 state 变更。
  const sendLockRef = useRef(false);
  // 当前 entry id 锁：异步任务（fetch / apply）返回时校验 entry 没变才能写 state
  // 否则 apply 在 doc A 上跑，返回时 doc 已切到 B，错把"成功"绑到 B（Bugbot #3 二轮 Medium）。
  const entryIdRef = useRef(entryId);
  // 「实际发给 LLM 的 message」镜像：用户 / assistant 气泡里渲染的是简短 bubble text，
  // 但当时发出去的 message 包了 [参考文档] / [智能体角色设定] 等上下文。
  // 多轮 history 必须与模型当时收到的一致，否则前几轮的 doc 上下文就丢了（Bugbot #2 三轮 Medium）。
  const sentForLlmRef = useRef<Map<string, string>>(new Map());

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  // 中止当前 stream 的统一入口：除了 abort fetch，还要清 streamingId 和 sendLockRef，
  // 否则 chip / 输入框会一直 disabled（Bugbot #2）
  const abortCurrentStream = useCallback(() => {
    cancelStreamRef.current?.();
    cancelStreamRef.current = null;
    sendLockRef.current = false;
    setStreamingId(null);
  }, []);

  // 加载：文档全文 + 百宝箱 + KB 智能体（并行）
  //
  // entryId 切换时必须把上一篇文档的对话 / 选中 / 错误 / 缓存正文全部清掉
  // 否则会出现"显示新文档但写回上一篇"的串数据（Bugbot #1，High）
  useEffect(() => {
    let cancelled = false;
    entryIdRef.current = entryId;
    sendLockRef.current = false;
    sentForLlmRef.current = new Map();
    abortCurrentStream();
    setMessages([]);
    setActive(null);
    setError(null);
    setApplying(null);
    setInput('');
    setDocContent('');
    setDocTruncated(false);
    setDocLoadError(null);
    setLoadingDoc(true);
    setLoadingAgents(true);

    (async () => {
      try {
        const docRes = await getDocumentContent(entryId);
        if (cancelled || entryIdRef.current !== entryId) return;
        if (docRes.success) {
          const raw = docRes.data.content ?? '';
          if (!raw || raw.trim().length === 0) {
            // 文档本来就空（无 DocumentId 且无 ContentIndex）—— 这是合法状态
            // 但禁止把"空文档"喂给 LLM，否则智能体回的内容跟当前文档无关，写回还会污染数据
            setDocLoadError('文档没有可读正文，无法作为输入喂给智能体');
          }
          setDocContent(raw);
          setDocTruncated(raw.length > MAX_DOC_CHARS);
          if (raw.length > MAX_DOC_CHARS) setDocContent(raw.slice(0, MAX_DOC_CHARS));
        } else {
          setDocLoadError(docRes.error?.message || '读取文档失败');
        }
      } catch (e) {
        if (cancelled || entryIdRef.current !== entryId) return;
        setDocLoadError(e instanceof Error ? e.message : '读取文档异常');
      } finally {
        if (!cancelled && entryIdRef.current === entryId) setLoadingDoc(false);
      }
    })();

    (async () => {
      const [agentRes, toolboxRes, activeRunRes] = await Promise.all([
        listReprocessAgents(),
        listToolboxItems(),
        getActiveReprocessRun(entryId),
      ]);
      if (cancelled || entryIdRef.current !== entryId) return;

      const builtinAgents = BUILTIN_TOOLS.filter((t) => t.kind === 'agent' && !t.wip);
      const userOwnedToolbox = toolboxRes.success
        ? (toolboxRes.data.items as ToolboxItem[]).filter((t) => !!t.systemPrompt)
        : [];
      const ordered = builtinAgents.sort((a, b) => {
        const ia = FOCUSED_TOOLBOX_IDS.indexOf(a.id);
        const ib = FOCUSED_TOOLBOX_IDS.indexOf(b.id);
        if (ia < 0 && ib < 0) return 0;
        if (ia < 0) return 1;
        if (ib < 0) return -1;
        return ia - ib;
      });
      setToolboxItems([...ordered, ...userOwnedToolbox]);

      const loadedKbAgents = agentRes.success ? agentRes.data.items : [];
      if (agentRes.success) setKbAgents(loadedKbAgents);
      setLoadingAgents(false);

      // 恢复后端持久化的对话：旧 /reprocess/chat 路径会把 messages 存到 run 里。
      // 重开抽屉时把它还原成 ChatMessage，让用户能看见上一次没读完的对话（Bugbot #4 五轮 Medium）
      const activeRun = activeRunRes.success ? activeRunRes.data : null;
      if (activeRun && activeRun.messages && activeRun.messages.length > 0) {
        const restored: ChatMessage[] = activeRun.messages.map((m, idx) => {
          // 反查 user 消息的 templateKey 对应的 agent 名字，让气泡能显示徽章
          let invoker: ChatMessage['invoker'] | undefined;
          if (m.role === 'user' && m.templateKey) {
            const tb = ordered.find((t) => t.agentKey === m.templateKey)
              ?? userOwnedToolbox.find((t) => t.id === m.templateKey);
            const kb = loadedKbAgents.find((a) => a.key === m.templateKey);
            if (tb) {
              invoker = { kind: 'toolbox', label: tb.name, ref: tb.id, icon: tb.icon };
            } else if (kb) {
              invoker = { kind: 'kbAgent', label: kb.label, ref: kb.key };
            }
          }
          return {
            id: `restored-${activeRun.id}-${idx}`,
            role: m.role,
            content: m.content,
            invoker,
            phase: 'done',
          };
        });
        setMessages(restored);
        // 选中最近一次 user 消息对应的 agent，方便用户直接追问
        const lastUserMsg = [...activeRun.messages].reverse().find((m) => m.role === 'user');
        if (lastUserMsg?.templateKey) {
          const tb = ordered.find((t) => t.agentKey === lastUserMsg.templateKey)
            ?? userOwnedToolbox.find((t) => t.id === lastUserMsg.templateKey);
          const kb = loadedKbAgents.find((a) => a.key === lastUserMsg.templateKey);
          if (tb) setActive({ kind: 'toolbox', item: tb });
          else if (kb) setActive({ kind: 'kbAgent', agent: kb });
        }
      }
    })();

    return () => {
      cancelled = true;
      abortCurrentStream();
    };
    // abortCurrentStream 是 stable useCallback，不会触发 effect 抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId]);

  // 关闭浮层时也走统一 abort，确保 streamingId 被清掉
  useEffect(() => () => abortCurrentStream(), [abortCurrentStream]);

  // 点击外面关闭 picker
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (!pickerBtnRef.current?.contains(e.target as Node)) {
        const dropdown = document.getElementById('reprocess-agent-picker-dropdown');
        if (dropdown && !dropdown.contains(e.target as Node)) setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  // ── 发送消息 ──
  const sendMessage = useCallback(async (
    userText: string,
    invoker: ChatMessage['invoker'],
    agent: ActiveAgent,
  ) => {
    // ⚠ 用 ref 同步锁，杜绝 React state 还没提交时双击/快速回车跑两条流（Bugbot #2 二轮）
    if (sendLockRef.current) return;
    if (!userText.trim()) return;
    if (loadingDoc) {
      toast.warning('请稍候', '文档还在加载');
      return;
    }
    if (docLoadError) {
      toast.warning('无法调用', docLoadError);
      return;
    }
    if (!docContent || docContent.trim().length === 0) {
      // 防御：文档为空时不让发送（Bugbot #1 二轮 Medium）
      toast.warning('文档无正文', '没有可读正文喂给智能体');
      return;
    }
    sendLockRef.current = true;

    let agentKey: string | undefined;
    let itemId: string | undefined;
    let kbSystemPrompt: string | undefined;

    if (agent?.kind === 'toolbox') {
      if (agent.item.type === 'builtin' && agent.item.agentKey) {
        agentKey = agent.item.agentKey;
      } else {
        itemId = agent.item.id;
      }
    } else if (agent?.kind === 'kbAgent') {
      kbSystemPrompt = agent.agent.systemPrompt;
    }

    setError(null);

    const userMsgId = 'u-' + Date.now();
    const asstMsgId = 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const userMsg: ChatMessage = {
      id: userMsgId, role: 'user', content: userText.trim(), invoker,
    };
    const asstMsg: ChatMessage = {
      id: asstMsgId, role: 'assistant', content: '', streaming: true, phase: 'thinking', invoker,
    };

    // 组装本轮发给 LLM 的 message：[智能体角色设定]?[参考文档][用户指令]
    let composed = '';
    if (kbSystemPrompt) {
      composed += `[智能体角色设定]\n${kbSystemPrompt}\n\n`;
    }
    composed += `[参考文档${docTruncated ? '（已截取前 4 万字）' : ''}]\n${docContent}\n\n[用户指令]\n${userText.trim()}`;

    // 多轮 history 用「当时实际发出去的 message」而不是 bubble text，让前几轮的 doc
    // 上下文不丢；assistant 历史用原内容（就是 LLM 实际产出的）。
    const history = messages
      .map((m) => {
        if (m.role === 'user') {
          const sent = sentForLlmRef.current.get(m.id);
          return { role: m.role, content: sent ?? m.content };
        }
        return { role: m.role, content: m.content };
      })
      .filter((m) => m.content);

    // 记录本轮发出去的 message 内容，给后续轮的 history 用
    sentForLlmRef.current.set(userMsgId, composed);

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setStreamingId(asstMsgId);
    setInput('');
    scrollToBottom();

    // 锁定本次 stream 关联的 entry id：异步回调到来时如果用户已经切到别的文档，
    // 不能再写当前 drawer 的 state（错把上一篇的错误/完成态绑到新文档上），也不能
    // 释放 sendLockRef（新文档可能已经在 streaming）（Bugbot #3 五轮 Medium）
    const streamOwnerEntryId = entryId;
    const isOwnedByCurrentEntry = () => entryIdRef.current === streamOwnerEntryId;

    let hasFirstChunk = false;
    const stop = streamDirectChat({
      message: composed,
      agentKey,
      itemId,
      history: history.length > 0 ? history : undefined,
      onText: (chunk) => {
        if (!isOwnedByCurrentEntry()) return;
        if (!hasFirstChunk) {
          hasFirstChunk = true;
        }
        setMessages((prev) => prev.map((m) =>
          m.id === asstMsgId
            ? { ...m, content: m.content + chunk, phase: 'streaming' }
            : m));
        scrollToBottom();
      },
      onError: (msg) => {
        if (!isOwnedByCurrentEntry()) return; // 来自上一篇文档的 stream，丢弃
        setError(msg || '调用失败');
        setMessages((prev) => prev.map((m) =>
          m.id === asstMsgId
            ? { ...m, streaming: false, phase: 'error',
                content: m.content || `（调用失败：${msg || '未知错误'}）` }
            : m));
        setStreamingId(null);
        sendLockRef.current = false;
      },
      onDone: () => {
        if (!isOwnedByCurrentEntry()) return;
        setMessages((prev) => prev.map((m) =>
          m.id === asstMsgId ? { ...m, streaming: false, phase: 'done' } : m));
        setStreamingId(null);
        sendLockRef.current = false;
      },
    });
    cancelStreamRef.current = stop;
  }, [loadingDoc, docLoadError, messages, docContent, docTruncated, scrollToBottom]);

  const handleSendInput = useCallback(() => {
    if (!input.trim()) return;
    if (!active) {
      toast.warning('请先选择智能体', '点上方选择器挑一个');
      setPickerOpen(true);
      return;
    }
    const invoker: ChatMessage['invoker'] =
      active.kind === 'toolbox'
        ? { kind: 'toolbox', label: active.item.name, ref: active.item.id, icon: active.item.icon }
        : { kind: 'kbAgent', label: active.agent.label, ref: active.agent.key };
    void sendMessage(input, invoker, active);
  }, [input, active, sendMessage]);

  const pickToolbox = useCallback((item: ToolboxItem) => {
    setActive({ kind: 'toolbox', item });
    setPickerOpen(false);
    setError(null);
    // 选完立即跑一轮，文档全文+默认指令
    const invoker: ChatMessage['invoker'] = {
      kind: 'toolbox', label: item.name, ref: item.id, icon: item.icon,
    };
    void sendMessage(`请用「${item.name}」处理这篇文档。`, invoker, { kind: 'toolbox', item });
  }, [sendMessage]);

  const pickKbAgent = useCallback((agent: ReprocessAgent) => {
    setActive({ kind: 'kbAgent', agent });
    setPickerOpen(false);
    setError(null);
    const invoker: ChatMessage['invoker'] = {
      kind: 'kbAgent', label: agent.label, ref: agent.key,
    };
    void sendMessage(`请用「${agent.label}」智能体处理这篇文档。`, invoker, { kind: 'kbAgent', agent });
  }, [sendMessage]);

  const handleCreateAgent = useCallback(async (in_: {
    label: string; description: string; systemPrompt: string;
  }) => {
    const res = await createReprocessAgent(in_);
    if (!res.success) {
      toast.error('创建失败', res.error?.message);
      return false;
    }
    setKbAgents((prev) => [...prev, res.data]);
    toast.success('智能体创建成功', '已选中，可立即使用');
    setActive({ kind: 'kbAgent', agent: res.data });
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
    if (active?.kind === 'kbAgent' && active.agent.id === agent.id) setActive(null);
  }, [active]);

  const handleApply = useCallback(async (
    msgId: string, mode: 'replace' | 'append' | 'new',
  ) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'assistant' || !msg.content) return;
    const key = `${msgId}:${mode}`;
    if (applying) return;
    // 锁定调用瞬间的 entryId；若 await 期间用户切到了别的文档，绝对不能把 success/error
    // 状态再写到当前抽屉里，也不能给 onApplied 回调（会让外层选中错的 entry）。
    // Bugbot #3（二轮 Medium）。
    const requestedEntryId = entryId;
    setApplying(key);
    let res;
    try {
      res = await applyReprocessContent(requestedEntryId, { mode, content: msg.content });
    } catch (e) {
      // 即使 entry 切走也得清 applying，不然新 doc 的写回按钮永远 disabled（Bugbot #3 三轮 Low）
      setApplying(null);
      if (entryIdRef.current !== requestedEntryId) return; // 切走了，静默丢弃错误 toast
      toast.error('写回失败', e instanceof Error ? e.message : '网络异常');
      return;
    }
    setApplying(null);
    if (entryIdRef.current !== requestedEntryId) {
      // entry 在 await 期间被切换：丢弃这次结果，避免错认归属
      return;
    }
    if (!res.success) {
      toast.error('写回失败', res.error?.message);
      return;
    }
    const target = res.data.outputEntryId || res.data.updatedEntryId;
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, applied: mode } : m));
    const label = mode === 'replace' ? '替换原文' : mode === 'append' ? '追加末尾' : '另存为新文档';
    toast.success(`${label}成功`, mode === 'new' ? '新文档已生成' : '文档已更新');

    // replace/append 改了源文档正文；后续轮的 prompt 还引用旧 docContent 会让模型读到
    // 过期的"参考文档"，写回也基于陈旧上下文。重新拉一次 entry content 拿到服务器的
    // 最新版本（Bugbot #2 五轮 High）。
    //
    // 同时清空 sentForLlmRef：里面缓存的是历史轮"当时发出去的 message"，每条 user 都
    // 包了那个版本的 [参考文档]。文档已经变了，这些缓存就过期了——再用它们填 history
    // 会把过期 doc 重新喂给模型（Bugbot 六轮 High）。清掉后，下一轮 history 自动 fall
    // back 到 bubble text（短文本，没有 doc 包装），模型只从本轮 message 的新 [参考文档]
    // 看最新版，多轮历史的 doc fidelity 在覆写后本来就难以保留，这是合理 trade-off。
    if (mode === 'replace' || mode === 'append') {
      try {
        const refreshed = await getDocumentContent(requestedEntryId);
        if (entryIdRef.current === requestedEntryId && refreshed.success) {
          const raw = refreshed.data.content ?? '';
          if (raw.length > MAX_DOC_CHARS) {
            setDocContent(raw.slice(0, MAX_DOC_CHARS));
            setDocTruncated(true);
          } else {
            setDocContent(raw);
            setDocTruncated(false);
          }
          sentForLlmRef.current = new Map();
        }
      } catch { /* 拉取失败保留旧 docContent，下一轮 toast 提示已能让用户感知 */ }
    }

    if (target && onApplied) onApplied(mode, target);
  }, [messages, applying, entryId, onApplied]);

  const isBusy = streamingId !== null;

  const activeLabel = useMemo(() => {
    if (!active) return null;
    if (active.kind === 'toolbox') {
      return { icon: active.item.icon, name: active.item.name, kind: 'toolbox' as const, sub: active.item.description };
    }
    return { icon: undefined, name: active.agent.label, kind: 'kbAgent' as const, sub: active.agent.description };
  }, [active]);

  const modal = (
    <motion.div
      className="surface-backdrop fixed inset-0 z-[100] flex justify-end"
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
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
        <div className="surface-panel-header flex items-center justify-between px-5 py-4 shrink-0 border-b border-token-subtle">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px]">
              <Wand2 size={16} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">AI 文档对话</p>
              <p className="truncate text-[10px] text-token-muted mt-0.5">
                {entryTitle}
                {docTruncated && (
                  <span className="ml-2 text-[9.5px]" style={{ color: 'rgba(251,191,36,0.95)' }}>
                    · 已截取前 4 万字喂给 AI
                  </span>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-token-muted hover:bg-white/8 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 智能体选择器（精简版 - 顶部下拉） */}
        <div className="px-5 pt-3 pb-3 shrink-0 relative">
          <button
            ref={pickerBtnRef}
            onClick={() => setPickerOpen((v) => !v)}
            disabled={loadingAgents || !!docLoadError}
            className="w-full flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 transition-all disabled:opacity-60"
            style={{
              background: active
                ? 'rgba(168,85,247,0.12)'
                : 'rgba(255,255,255,0.04)',
              border: active
                ? '1px solid rgba(168,85,247,0.4)'
                : '1px dashed rgba(255,255,255,0.18)',
            }}
          >
            {activeLabel ? (
              activeLabel.kind === 'toolbox' ? (
                <ToolboxIcon name={activeLabel.icon} size={13} />
              ) : (
                <span
                  className="inline-flex items-center justify-center rounded-[6px]"
                  style={{
                    width: 25, height: 25,
                    background: 'rgba(34,197,94,0.18)',
                    color: 'rgba(110,231,158,0.95)',
                    border: '1px solid rgba(34,197,94,0.30)',
                  }}
                >
                  <Bot size={13} />
                </span>
              )
            ) : (
              <span className="inline-flex items-center justify-center rounded-[6px]"
                style={{
                  width: 25, height: 25,
                  background: 'rgba(255,255,255,0.06)',
                  color: 'rgba(255,255,255,0.4)',
                  border: '1px dashed rgba(255,255,255,0.18)',
                }}
              >
                <Bot size={13} />
              </span>
            )}
            <div className="flex-1 min-w-0 text-left">
              {activeLabel ? (
                <>
                  <p className="text-[12px] font-semibold text-token-primary truncate">{activeLabel.name}</p>
                  {activeLabel.sub && (
                    <p className="text-[10px] text-token-muted truncate mt-0.5">{activeLabel.sub}</p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-[12px] font-semibold text-token-primary">选择智能体</p>
                  <p className="text-[10px] text-token-muted mt-0.5">百宝箱 / 我的快捷智能体 / 新建</p>
                </>
              )}
            </div>
            <ChevronDown
              size={14}
              className="text-token-muted shrink-0 transition-transform"
              style={{ transform: pickerOpen ? 'rotate(180deg)' : undefined }}
            />
          </button>

          <AnimatePresence>
            {pickerOpen && (
              <motion.div
                id="reprocess-agent-picker-dropdown"
                className="absolute left-5 right-5 mt-1.5 rounded-[12px] shadow-2xl overflow-hidden"
                style={{
                  background: 'rgba(20, 18, 26, 0.98)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  backdropFilter: 'blur(20px)',
                  zIndex: 50,
                  maxHeight: '60vh',
                }}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <div className="overflow-y-auto" style={{ maxHeight: '60vh' }}>
                  {/* 百宝箱 section */}
                  <DropdownSection
                    title="百宝箱智能体"
                    subtitle="系统已注册的通用智能体，文档作为输入直接调用"
                  >
                    {toolboxItems.length === 0 && loadingAgents ? (
                      <div className="px-3 py-3 text-[10px] text-token-muted">
                        <MapSpinner size={10} /> 加载中…
                      </div>
                    ) : toolboxItems.map((item) => (
                      <DropdownRow
                        key={item.id}
                        icon={<ToolboxIcon name={item.icon} size={14} />}
                        title={item.name}
                        subtitle={item.description}
                        badge={item.type !== 'builtin' ? '我的工具' : undefined}
                        active={active?.kind === 'toolbox' && active.item.id === item.id}
                        disabled={isBusy}
                        onClick={() => pickToolbox(item)}
                      />
                    ))}
                  </DropdownSection>

                  {/* 我的快捷智能体 section */}
                  <DropdownSection
                    title="我的快捷智能体"
                    subtitle="一键 system prompt，叠加到百宝箱通用 chat 链路"
                  >
                    {kbAgents.map((agent) => (
                      <DropdownRow
                        key={agent.id}
                        icon={
                          <span
                            className="inline-flex items-center justify-center rounded-[6px]"
                            style={{
                              width: 26, height: 26,
                              background: 'rgba(34,197,94,0.18)',
                              color: 'rgba(110,231,158,0.95)',
                              border: '1px solid rgba(34,197,94,0.30)',
                            }}
                          >
                            <Bot size={14} />
                          </span>
                        }
                        title={agent.label}
                        subtitle={agent.description}
                        badge={agent.visibility === 'system' ? '系统' : '我的'}
                        badgeColor={agent.visibility === 'system' ? 'rgba(168,85,247,0.20)' : 'rgba(34,197,94,0.20)'}
                        active={active?.kind === 'kbAgent' && active.agent.id === agent.id}
                        disabled={isBusy}
                        onClick={() => pickKbAgent(agent)}
                        onDelete={agent.isOwn ? () => handleDeleteAgent(agent) : undefined}
                      />
                    ))}

                    <button
                      onClick={() => { setShowCreateAgent(true); setPickerOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/4 transition-colors text-left"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
                    >
                      <span
                        className="inline-flex items-center justify-center rounded-[6px]"
                        style={{
                          width: 26, height: 26,
                          background: 'rgba(96,165,250,0.18)',
                          color: 'rgba(147,197,253,0.95)',
                          border: '1px dashed rgba(96,165,250,0.40)',
                        }}
                      >
                        <Plus size={14} />
                      </span>
                      <span className="text-[12px] font-medium" style={{ color: 'rgba(147,197,253,0.95)' }}>
                        新建快捷智能体
                      </span>
                    </button>
                  </DropdownSection>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 创建浮层 */}
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
          className="flex-1 overflow-y-auto px-5 py-4 space-y-3.5"
          style={{ minHeight: 0, overscrollBehavior: 'contain' }}
        >
          {messages.length === 0 ? (
            <EmptyState
              loadingDoc={loadingDoc}
              entryTitle={entryTitle}
              hasAgent={!!active}
              docLoadError={docLoadError}
            />
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
                background: 'rgba(239,68,68,0.10)',
                border: '1px solid rgba(239,68,68,0.25)',
                color: 'rgba(252,165,165,0.95)',
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
                docLoadError
                  ? '文档未加载，无法对话'
                  : isBusy
                    ? 'AI 正在回复，请稍候…'
                    : active
                      ? `继续追问「${active.kind === 'toolbox' ? active.item.name : active.agent.label}」，Enter 发送`
                      : '先选个智能体，然后输入指令'
              }
              disabled={isBusy || !!docLoadError}
              rows={2}
              className="prd-field flex-1 resize-none rounded-[10px] px-3 py-2 text-[12px] outline-none disabled:opacity-60"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={isBusy || !input.trim() || !!docLoadError}
              onClick={handleSendInput}
            >
              {isBusy ? <MapSpinner size={12} /> : <Send size={12} />}
              发送
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-token-muted">
            {isBusy
              ? '调用百宝箱通用 chat 链路；文档全文已作为输入发送'
              : '点击上方下拉选智能体一键跑一轮；或直接输入指令配合当前智能体使用'}
          </p>
        </div>
      </motion.div>
    </motion.div>
  );

  return createPortal(modal, document.body);
}

// ── 子组件：dropdown section ──
function DropdownSection({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div className="px-3 pt-2 pb-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.55)' }}>
          {title}
        </p>
        {subtitle && (
          <p className="text-[9.5px] text-token-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function DropdownRow({
  icon, title, subtitle, badge, badgeColor, active, disabled, onClick, onDelete,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-2.5 px-3 py-2 transition-colors"
      style={{
        background: active ? 'rgba(168,85,247,0.10)' : undefined,
        borderLeft: active ? '2px solid rgba(168,85,247,0.6)' : '2px solid transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
      onClick={() => { if (!disabled) onClick(); }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLDivElement).style.background = active
          ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.05)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = active
          ? 'rgba(168,85,247,0.10)' : 'transparent';
      }}
    >
      {icon}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-[12px] font-semibold text-token-primary truncate">{title}</p>
          {badge && (
            <span className="text-[9px] font-semibold px-1.5 rounded shrink-0"
              style={{ background: badgeColor ?? 'rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.85)' }}
            >{badge}</span>
          )}
        </div>
        {subtitle && (
          <p className="text-[10px] text-token-muted truncate mt-0.5">{subtitle}</p>
        )}
      </div>
      {active && <Check size={12} className="text-token-primary shrink-0" />}
      {onDelete && (
        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity text-token-muted hover:text-red-300 shrink-0"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

// ── 空状态（含加载分阶段反馈，满足 2 秒原则） ──
function EmptyState({ loadingDoc, entryTitle, hasAgent, docLoadError }: {
  loadingDoc: boolean;
  entryTitle: string;
  hasAgent: boolean;
  docLoadError?: string | null;
}) {
  if (loadingDoc) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
        <div className="surface-action-accent flex h-12 w-12 items-center justify-center rounded-[14px] animate-pulse">
          <FileText size={20} />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-token-primary mb-1">
            <MapSpinner size={10} /> 正在读取文档…
          </p>
          <p className="text-[11px] text-token-muted">
            「{entryTitle}」
          </p>
        </div>
      </div>
    );
  }
  if (docLoadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
        <div className="flex h-12 w-12 items-center justify-center rounded-[14px]"
          style={{
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: 'rgba(252,165,165,0.95)',
          }}>
          <AlertCircle size={20} />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-token-primary mb-1">无法加载文档</p>
          <p className="text-[11px] max-w-[340px] leading-relaxed" style={{ color: 'rgba(252,165,165,0.85)' }}>
            {docLoadError}
          </p>
          <p className="text-[10px] text-token-muted mt-2 max-w-[340px] leading-relaxed">
            智能体调用 / 写回均已禁用，避免误把空内容当成文档喂给 LLM。
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
      <div className="surface-action-accent flex h-12 w-12 items-center justify-center rounded-[14px]">
        <Wand2 size={20} />
      </div>
      <div>
        <p className="text-[13px] font-semibold text-token-primary mb-1">和这篇文档对话</p>
        <p className="text-[11px] text-token-muted max-w-[340px] leading-relaxed">
          {hasAgent
            ? '已选择智能体，在下方输入指令开始对话；或重新打开上方下拉换个智能体一键跑一轮。'
            : '点击上方下拉选择一个智能体（百宝箱内置 / 我的快捷智能体 / 新建）后即可开始。'}
        </p>
      </div>
    </div>
  );
}

// ── 消息气泡 ──
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
          className="rounded-[14px] px-3.5 py-2 text-[12px] max-w-[80%] break-words whitespace-pre-wrap"
          style={{
            background: 'linear-gradient(135deg, rgba(96,165,250,0.18), rgba(168,85,247,0.14))',
            border: '1px solid rgba(96,165,250,0.25)',
            color: 'rgba(241,245,255,0.96)',
          }}
        >
          {msg.invoker && (
            <span className="inline-flex items-center gap-1 mr-2 mb-1 px-1.5 py-0.5 rounded-[5px] text-[9.5px] font-semibold"
              style={{ background: 'rgba(255,255,255,0.10)' }}
            >
              {msg.invoker.kind === 'toolbox' ? <Sparkles size={9} /> : <Bot size={9} />}
              {msg.invoker.label}
            </span>
          )}
          <div>{msg.content}</div>
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
        className="rounded-[14px] p-3 text-[12px] max-w-[88%] w-full"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="text-[10px] text-token-muted mb-1.5 flex items-center gap-1.5">
          {msg.invoker?.kind === 'toolbox'
            ? <Sparkles size={10} className="text-purple-300" />
            : <Bot size={10} className="text-green-300" />}
          {msg.invoker?.label ?? 'AI'} 回复
          {msg.phase === 'thinking' && (
            <span className="inline-flex items-center gap-1 ml-1">
              <ThinkingDots />
              <span style={{ color: 'rgba(96,165,250,0.85)' }}>正在思考…</span>
            </span>
          )}
          {msg.phase === 'streaming' && (
            <span className="inline-flex items-center gap-1 ml-1" style={{ color: 'rgba(110,231,158,0.85)' }}>
              <MapSpinner size={8} /> 流式回复中
            </span>
          )}
        </div>
        {msg.streaming && msg.content ? (
          <StreamingText text={msg.content} streaming mode="blur" />
        ) : msg.content ? (
          <ChatMarkdown content={msg.content} />
        ) : (
          <ThinkingDots />
        )}

        {canApply && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-2.5 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <ApplyBtn icon={<Replace size={10} />} label="替换原文"
              busy={busyMode === 'replace'} applied={msg.applied === 'replace'}
              disabled={!!applying} onClick={() => onApply(msg.id, 'replace')} />
            <ApplyBtn icon={<FileDown size={10} />} label="追加末尾"
              busy={busyMode === 'append'} applied={msg.applied === 'append'}
              disabled={!!applying} onClick={() => onApply(msg.id, 'append')} />
            <ApplyBtn icon={<FilePlus2 size={10} />} label="另存为新文档"
              busy={busyMode === 'new'} applied={msg.applied === 'new'}
              disabled={!!applying} onClick={() => onApply(msg.id, 'new')} />
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-1 h-1 rounded-full"
          style={{
            background: 'rgba(147,197,253,0.85)',
            animation: `pulse-dot 1.2s ease-in-out infinite`,
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes pulse-dot {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
      `}</style>
    </span>
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
      className="inline-flex items-center gap-1 rounded-[7px] px-2.5 py-1.5 text-[10px] font-medium hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      style={{
        background: applied ? 'rgba(74,222,128,0.14)' : 'rgba(255,255,255,0.04)',
        color: applied ? 'rgba(110,231,158,0.95)' : 'rgba(255,255,255,0.80)',
        border: applied ? '1px solid rgba(74,222,128,0.30)' : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {busy ? <RotateCw size={10} className="animate-spin" /> : icon}
      {applied ? `${label}（已写回）` : label}
    </button>
  );
}

// ── 创建快捷智能体浮层（保留旧版） ──
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
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-token-muted hover:bg-white/8"
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
            创建并立即选用
          </Button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

void AnimatePresence;
void MapSectionLoader;
