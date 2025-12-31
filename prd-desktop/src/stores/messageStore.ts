import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '../lib/tauri';
import type { ApiResponse, DocCitation, Message, MessageBlock, MessageBlockKind } from '../types';

export type StreamingPhase = 'requesting' | 'connected' | 'receiving' | 'typing' | null;

interface MessageState {
  boundSessionId: string | null;
  // 本次运行是否已完成该 session 的“初次历史加载”（不持久化）。
  // 用于解决：刷新/重启后 boundSessionId 持久化导致 ChatContainer 跳过历史加载，从而无法纠正顺序/补齐字段。
  historyLoadedSessionId: string | null;
  isPinnedToBottom: boolean;
  scrollToBottomSeq: number;

  messages: Message[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingPhase: StreamingPhase;
  pendingAssistantId: string | null;
  pendingUserMessageId: string | null;

  // 上拉加载历史（向前分页）
  isLoadingOlder: boolean;
  hasMoreOlder: boolean;
  oldestTimestamp: string | null; // ISO string
  
  bindSession: (sessionId: string | null) => void;
  markHistoryLoaded: (sessionId: string | null) => void;
  setPinnedToBottom: (pinned: boolean) => void;
  triggerScrollToBottom: () => void;

  addMessage: (message: Message) => void;
  addMessageAndScrollToBottom: (message: Message) => void;
  addUserMessageWithPendingAssistant: (args: { userMessage: Message }) => void;
  clearPendingAssistant: () => void;
  ackPendingUserMessageTimestamp: (args: { receivedAt: Date }) => void;
  setMessages: (messages: Message[]) => void;
  initHistoryPaging: (pageSize: number) => void;
  prependMessages: (messages: Message[]) => number;
  loadOlderMessages: (args: { groupId: string; limit?: number }) => Promise<{ added: number }>;
  upsertMessage: (message: Message) => void;
  ingestGroupBroadcastMessage: (args: { message: Message; currentUserId?: string | null }) => void;
  startStreaming: (message: Message) => void;
  appendToStreamingMessage: (content: string) => void;
  startStreamingBlock: (block: { id: string; kind: MessageBlockKind; language?: string | null }) => void;
  appendToStreamingBlock: (blockId: string, content: string) => void;
  endStreamingBlock: (blockId: string) => void;
  setMessageCitations: (messageId: string, citations: DocCitation[]) => void;
  setStreamingMessageCitations: (citations: DocCitation[]) => void;
  setStreamingPhase: (phase: StreamingPhase) => void;
  stopStreaming: () => void;
  clearCurrentContext: (sessionId: string | null) => void;
  clearMessages: () => void;
}

function reviveMessage(m: any): Message {
  const ts = m?.timestamp;
  const t = ts instanceof Date ? ts : new Date(ts || Date.now());
  const blocks = Array.isArray(m?.blocks) ? m.blocks : undefined;
  const citations = Array.isArray(m?.citations) ? m.citations : undefined;
  return {
    id: String(m?.id ?? ''),
    role: (m?.role === 'User' ? 'User' : 'Assistant'),
    content: String(m?.content ?? ''),
    blocks,
    citations,
    viewRole: m?.viewRole ?? undefined,
    timestamp: t,
    groupSeq: typeof m?.groupSeq === 'number' ? m.groupSeq : undefined,
    senderId: m?.senderId ?? undefined,
    senderName: m?.senderName ?? undefined,
  };
}

function reviveMessages(list: any): Message[] {
  if (!Array.isArray(list)) return [];
  return list.map(reviveMessage).filter((x) => x.id);
}

function maybeSortByGroupSeq(list: Message[]): Message[] {
  const hasSeq = list.some((m) => typeof (m as any)?.groupSeq === 'number');
  if (!hasSeq) return list;
  // groupSeq 优先，其次 timestamp；缺失 groupSeq 的消息放到最前（历史兼容）
  return [...list].sort((a, b) => {
    const sa = typeof a.groupSeq === 'number' ? a.groupSeq : null;
    const sb = typeof b.groupSeq === 'number' ? b.groupSeq : null;
    if (sa == null && sb == null) return a.timestamp.getTime() - b.timestamp.getTime();
    if (sa == null) return -1;
    if (sb == null) return 1;
    if (sa !== sb) return sa - sb;
    return a.timestamp.getTime() - b.timestamp.getTime();
  });
}

type MessageHistoryItem = {
  id: string;
  groupSeq?: number;
  role: string;
  content: string;
  viewRole?: string;
  timestamp: string;
};

export const useMessageStore = create<MessageState>()(
  persist(
    (set, get) => ({
      boundSessionId: null,
      historyLoadedSessionId: null,
      isPinnedToBottom: true,
      scrollToBottomSeq: 0,

      messages: [],
      isStreaming: false,
      streamingMessageId: null,
      streamingPhase: null,
      pendingAssistantId: null,
      pendingUserMessageId: null,

      isLoadingOlder: false,
      hasMoreOlder: true,
      oldestTimestamp: null,

  // 绑定“当前消息所属的 sessionId”，用于：
  // - 避免 ChatContainer 因卸载/重挂载而误清空同一会话的对话（看起来像“不持久化”）
  // - 在切换群组/会话时，确保不会把旧会话消息串到新会话
  bindSession: (sessionId) => set((state) => {
    const next = sessionId ? String(sessionId).trim() : null;
    if (state.boundSessionId === next) return state;
    if (!next) {
      return {
        boundSessionId: null,
        historyLoadedSessionId: null,
        isPinnedToBottom: true,
        scrollToBottomSeq: 0,
        messages: [],
        isStreaming: false,
        streamingMessageId: null,
        streamingPhase: null,
        pendingAssistantId: null,
        pendingUserMessageId: null,
        isLoadingOlder: false,
        hasMoreOlder: true,
        oldestTimestamp: null,
      };
    }
    return {
      boundSessionId: next,
      historyLoadedSessionId: null,
      isPinnedToBottom: true,
      scrollToBottomSeq: 0,
      messages: [],
      isStreaming: false,
      streamingMessageId: null,
      streamingPhase: null,
      pendingAssistantId: null,
      pendingUserMessageId: null,
      isLoadingOlder: false,
      hasMoreOlder: true,
      oldestTimestamp: null,
    };
  }),

  markHistoryLoaded: (sessionId) => set((state) => {
    const next = sessionId ? String(sessionId).trim() : null;
    if (!next) return { historyLoadedSessionId: null } as any;
    if (state.historyLoadedSessionId === next) return state;
    return { historyLoadedSessionId: next } as any;
  }),

  setPinnedToBottom: (pinned) => set((state) => {
    const next = !!pinned;
    if (state.isPinnedToBottom === next) return state;
    return { isPinnedToBottom: next };
  }),

  // 用户主动触发“跳到最新一页”（例如发送消息/点击提示词）
  // 仅作为轻量信号：由 MessageList 监听并执行 scrollIntoView
  triggerScrollToBottom: () => set((state) => ({
    isPinnedToBottom: true,
    scrollToBottomSeq: (state.scrollToBottomSeq ?? 0) + 1,
  })),
  
  addMessage: (message) => set((state) => {
    const next = [...state.messages, message];
    return { messages: next };
  }),

      // 合并更新：减少一次渲染/布局抖动（点击提示词/发送更丝滑）
      addMessageAndScrollToBottom: (message) => set((state) => {
        const next = [...state.messages, message];
        return {
          messages: next,
          isPinnedToBottom: true,
          scrollToBottomSeq: (state.scrollToBottomSeq ?? 0) + 1,
        };
      }),

      // 提示词/发送：先插入一个“请求中”的占位 assistant 气泡，再滚到底
      // 这样用户不会觉得“点了没反应/页面卡住”，并且可与后续真实 start 事件无缝衔接
      addUserMessageWithPendingAssistant: ({ userMessage }) => {
        const t0 = (globalThis as any).performance?.now?.() ?? Date.now();
        set((state) => {
        const pendingId = `pending-assistant-${Date.now()}`;
        const pending: Message = {
          id: pendingId,
          role: 'Assistant',
          content: '',
          timestamp: new Date(),
          viewRole: userMessage.viewRole,
        };
        const next = [...state.messages, userMessage, pending];
        return {
          messages: next,
          pendingAssistantId: pendingId,
          pendingUserMessageId: userMessage?.id ?? null,
          isPinnedToBottom: true,
          scrollToBottomSeq: (state.scrollToBottomSeq ?? 0) + 1,
        };
        });
        const t1 = (globalThis as any).performance?.now?.() ?? Date.now();
        void t0;
        void t1;
      },

      clearPendingAssistant: () => set((state) => {
        if (!state.pendingAssistantId) return state;
        const pid = state.pendingAssistantId;
        return {
          pendingAssistantId: null,
          pendingUserMessageId: state.pendingUserMessageId ?? null,
          messages: state.messages.filter((m) => m.id !== pid),
        };
      }),

      // 服务端回填：把“用户发送时间”对齐到 DB（requestReceivedAtUtc）
      // 注意：DB 不会返回 userMessageId，因此这里用“刚插入的那条 userMessage（pendingUserMessageId）”回填 timestamp
      ackPendingUserMessageTimestamp: ({ receivedAt }) => set((state) => {
        const id = state.pendingUserMessageId;
        if (!id) return state;
        const d = receivedAt instanceof Date ? receivedAt : new Date(receivedAt as any);
        if (Number.isNaN(d.getTime())) return { pendingUserMessageId: null } as any;
        const next = state.messages.map((m) => (m.id === id ? { ...m, timestamp: d } : m));
        return { messages: next, pendingUserMessageId: null };
      }),
  
  setMessages: (messages) => {
    const list = Array.isArray(messages) ? messages : [];
    set(() => ({ messages: maybeSortByGroupSeq(list) }));
  },

  // 初次加载/切换会话后：用当前已加载的 messages 初始化游标
  initHistoryPaging: (pageSize) => set((state) => {
    const ps = Math.max(1, Math.min(200, Number(pageSize) || 50));
    const list = Array.isArray(state.messages) ? state.messages : [];
    const oldest = list.length > 0 ? list[0].timestamp : null;
    return {
      oldestTimestamp: oldest ? oldest.toISOString() : null,
      hasMoreOlder: list.length >= ps,
      isLoadingOlder: false,
    };
  }),

  prependMessages: (messages) => {
    let added = 0;
    set((state) => {
      const list = Array.isArray(messages) ? messages : [];
      if (list.length === 0) return state;
      const existing = new Set(state.messages.map((m) => m.id));
      const toAdd = list.filter((m) => m?.id && !existing.has(m.id));
      if (toAdd.length === 0) return state;
      added = toAdd.length;
      const next = [...toAdd, ...state.messages];
      const oldest = next.length > 0 ? next[0].timestamp : null;
      return {
        messages: next,
        oldestTimestamp: oldest ? oldest.toISOString() : null,
      };
    });
    return added;
  },

  loadOlderMessages: async ({ groupId, limit }) => {
    const gid = String(groupId || '').trim();
    if (!gid) return { added: 0 };

    const state = get();
    if (state.isLoadingOlder) return { added: 0 };
    if (!state.hasMoreOlder) return { added: 0 };

    const take = Math.max(1, Math.min(200, Number(limit) || 50));
    const before = state.oldestTimestamp ? new Date(state.oldestTimestamp).toISOString() : null;

    set({ isLoadingOlder: true });
    try {
      const resp = await invoke<ApiResponse<MessageHistoryItem[]>>('get_group_message_history', {
        groupId: gid,
        limit: take,
        before,
      });
      if (!resp?.success || !Array.isArray(resp.data)) {
        set({ isLoadingOlder: false });
        return { added: 0 };
      }

      const mapped: Message[] = resp.data.map((m) => ({
        id: m.id,
        role: (m.role === 'User' ? 'User' : 'Assistant') as any,
        content: m.content,
        timestamp: new Date(m.timestamp),
        viewRole: (m.viewRole as any) || undefined,
        groupSeq: typeof (m as any).groupSeq === 'number' ? (m as any).groupSeq : undefined,
      }));

      const added = get().prependMessages(mapped);
      // 当返回不足一页时，认为没有更多
      const hasMoreOlder = resp.data.length >= take;
      set({ isLoadingOlder: false, hasMoreOlder });
      return { added };
    } catch {
      set({ isLoadingOlder: false });
      return { added: 0 };
    }
  },

  upsertMessage: (message) => set((state) => {
    const idx = state.messages.findIndex((m) => m.id === message.id);
    if (idx === -1) {
      const next = [...state.messages, message];
      return { messages: next };
    }
    const next = [...state.messages];
    next[idx] = message;
    return { messages: next };
  }),

  // 群广播消息注入：
  // - 解决“发送者本地 user message id 与服务端落库 id 不一致”导致的重复
  // - 尽量保持按 groupSeq 有序（若缺失 groupSeq 则退化按 timestamp）
  ingestGroupBroadcastMessage: ({ message, currentUserId }) => set((state) => {
    const incoming = message;
    if (!incoming?.id) return state;

    // 1) 发送者 user message 去重：用 (senderId + content) 在尾部做一次轻量 reconcile
    if (
      incoming.role === 'User' &&
      currentUserId &&
      incoming.senderId &&
      incoming.senderId === currentUserId
    ) {
      const idxFromEnd = [...state.messages]
        .reverse()
        .findIndex((m) =>
          m.role === 'User' &&
          (m.senderId ? m.senderId === currentUserId : true) &&
          (m.content ?? '') === (incoming.content ?? '') &&
          Math.abs((m.timestamp?.getTime?.() ?? 0) - (incoming.timestamp?.getTime?.() ?? 0)) <= 30_000
        );
      if (idxFromEnd !== -1) {
        const idx = state.messages.length - 1 - idxFromEnd;
        const next = [...state.messages];
        next[idx] = { ...next[idx], ...incoming };
        return { messages: maybeSortByGroupSeq(next) };
      }
    }

    // 2) 常规 upsert by id
    const existingIdx = state.messages.findIndex((m) => m.id === incoming.id);
    if (existingIdx !== -1) {
      const next = [...state.messages];
      next[existingIdx] = { ...next[existingIdx], ...incoming };
      return { messages: maybeSortByGroupSeq(next) };
    }

    // 3) 新消息：追加并按需排序
    const next = [...state.messages, incoming];
    return { messages: maybeSortByGroupSeq(next) };
  }),

  startStreaming: (message) => set((state) => {
    const idx = state.messages.findIndex((m) => m.id === message.id);
    const msgWithBlocks: Message = { ...message, blocks: message.blocks ?? [] };
    const next = idx === -1
      ? [...state.messages, msgWithBlocks]
      : state.messages.map((m) => (m.id === message.id ? msgWithBlocks : m));

    return {
      messages: next,
      isStreaming: true,
      streamingMessageId: message.id,
      streamingPhase: state.streamingPhase ?? 'requesting',
    };
  }),

  appendToStreamingMessage: (content) => set((state) => {
    if (!state.streamingMessageId) return state;
    const next = state.messages.map((m) => {
      if (m.id !== state.streamingMessageId) return m;
      return { ...m, content: (m.content ?? '') + content };
    });
    return { messages: next, streamingPhase: state.streamingPhase === 'typing' ? state.streamingPhase : 'typing' };
  }),

  startStreamingBlock: (block) => set((state) => {
    if (!state.streamingMessageId) return state;
    const next = state.messages.map((m) => {
      if (m.id !== state.streamingMessageId) return m;
      const blocks = (m.blocks ?? []) as MessageBlock[];
      // 避免重复 start
      if (blocks.some((b) => b.id === block.id)) return m;
      const nextContent =
        block.kind === 'codeBlock'
          ? (m.content ?? '') + `\`\`\`${block.language ? block.language : ''}\n`
          : (m.content ?? '');
      return {
        ...m,
        content: nextContent,
        blocks: [
          ...blocks,
          { id: block.id, kind: block.kind, language: block.language ?? null, content: '', isComplete: false },
        ],
      };
    });
    return { messages: next };
  }),

  appendToStreamingBlock: (blockId, content) => set((state) => {
    if (!state.streamingMessageId) return state;
    const next = state.messages.map((m) => {
      if (m.id !== state.streamingMessageId) return m;
      const blocks = (m.blocks ?? []) as MessageBlock[];
      const idx = blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) {
        // 容错：没收到 blockStart 也能显示
        const inferred: MessageBlock = { id: blockId, kind: 'paragraph', content: content ?? '', isComplete: false };
        return { ...m, content: (m.content ?? '') + (content ?? ''), blocks: [...blocks, inferred] };
      }
      const nextBlocks = [...blocks];
      nextBlocks[idx] = { ...nextBlocks[idx], content: (nextBlocks[idx].content ?? '') + (content ?? '') };
      return { ...m, content: (m.content ?? '') + (content ?? ''), blocks: nextBlocks };
    });
    return { messages: next, streamingPhase: state.streamingPhase === 'typing' ? state.streamingPhase : 'typing' };
  }),

  endStreamingBlock: (blockId) => set((state) => {
    if (!state.streamingMessageId) return state;
    const next = state.messages.map((m) => {
      if (m.id !== state.streamingMessageId) return m;
      const blocks = (m.blocks ?? []) as MessageBlock[];
      const idx = blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return m;
      const nextBlocks = [...blocks];
      nextBlocks[idx] = { ...nextBlocks[idx], isComplete: true };
      const isCode = nextBlocks[idx].kind === 'codeBlock';
      return { ...m, blocks: nextBlocks, content: isCode ? (m.content ?? '') + '```\n' : (m.content ?? '') };
    });
    return { messages: next };
  }),

  setMessageCitations: (messageId, citations) => set((state) => {
    const next = state.messages.map((m) => {
      if (m.id !== messageId) return m;
      return { ...m, citations: Array.isArray(citations) ? citations : [] };
    });
    return { messages: next };
  }),

  setStreamingMessageCitations: (citations) => set((state) => {
    if (!state.streamingMessageId) return state;
    const next = state.messages.map((m) => {
      if (m.id !== state.streamingMessageId) return m;
      return { ...m, citations: Array.isArray(citations) ? citations : [] };
    });
    return { messages: next };
  }),

  setStreamingPhase: (phase) => set((state) => {
    // 一旦进入 typing（收到首包输出），不要再被 phase 事件覆盖，否则会出现“AI 已在输出，但 UI 仍长期显示请求/接收阶段”的错觉
    if (state.streamingPhase === 'typing' && phase && phase !== 'typing') return state;
    return { streamingPhase: phase };
  }),
  
  stopStreaming: () => set({ isStreaming: false, streamingMessageId: null, streamingPhase: null }),

  // 清理“当前对话上下文”（但保留 boundSessionId=sessionId），用于：
  // - 清空本地消息，不回填服务端历史（否则用户点“清理”会立刻又出现历史消息）
  // - 不影响 session/document（由 sessionStore 管），用户可继续在当前 PRD 上提问
  clearCurrentContext: (sessionId) => set(() => ({
    boundSessionId: sessionId ? String(sessionId).trim() : null,
    isPinnedToBottom: true,
    scrollToBottomSeq: 0,
    messages: [],
    isStreaming: false,
    streamingMessageId: null,
    streamingPhase: null,
    pendingAssistantId: null,
    isLoadingOlder: false,
    hasMoreOlder: true,
    oldestTimestamp: null,
  })),
  
      clearMessages: () => set({
        boundSessionId: null,
        isPinnedToBottom: true,
        scrollToBottomSeq: 0,
        messages: [],
        isStreaming: false,
        streamingMessageId: null,
        streamingPhase: null,
        pendingAssistantId: null,
        isLoadingOlder: false,
        hasMoreOlder: true,
        oldestTimestamp: null,
      }),
    }),
    {
      name: 'message-storage',
      version: 1,
      partialize: (s) => ({
        boundSessionId: s.boundSessionId,
        isPinnedToBottom: s.isPinnedToBottom,
        messages: s.messages,
      }),
      merge: (persisted: any, current) => {
        const p = (persisted as any) || {};
        const next: any = {
          ...current,
          ...p,
        };
        const revived = reviveMessages(p.messages);
        // 刷新/重启后：对持久化消息做一次稳定纠序（若含 groupSeq 则按 groupSeq，其次 timestamp）
        next.messages = maybeSortByGroupSeq(revived);
        // 非持久化字段：基于已持久化的 messages 进行重建
        next.isLoadingOlder = false;
        next.hasMoreOlder = true;
        next.oldestTimestamp = revived.length > 0 ? revived[0].timestamp.toISOString() : null;
        next.pendingAssistantId = null;
        next.historyLoadedSessionId = null;
        return next as MessageState;
      },
    }
  )
);
