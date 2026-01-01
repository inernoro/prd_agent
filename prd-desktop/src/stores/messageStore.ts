import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '../lib/tauri';
import type { ApiResponse, DocCitation, Message, MessageBlock, MessageBlockKind } from '../types';

export type StreamingPhase = 'requesting' | 'connected' | 'receiving' | 'typing' | null;

interface MessageState {
  boundSessionId: string | null;
  boundGroupId: string | null; // 当前绑定的群组 ID（用于 seq 增量同步）
  isPinnedToBottom: boolean;
  scrollToBottomSeq: number;

  messages: Message[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingPhase: StreamingPhase;
  pendingAssistantId: string | null;
  pendingUserMessageId: string | null;

  // 基于 groupSeq 的分页/增量同步
  isLoadingOlder: boolean;
  hasMoreOlder: boolean;
  localMinSeq: number | null;  // 本地缓存的最小 groupSeq（历史分页游标）
  localMaxSeq: number | null;  // 本地缓存的最大 groupSeq（增量同步游标）
  isSyncing: boolean;          // 是否正在执行增量同步
  
  bindSession: (sessionId: string | null, groupId?: string | null) => void;
  setPinnedToBottom: (pinned: boolean) => void;
  triggerScrollToBottom: () => void;

  addMessage: (message: Message) => void;
  addMessageAndScrollToBottom: (message: Message) => void;
  addUserMessageWithPendingAssistant: (args: { userMessage: Message }) => void;
  clearPendingAssistant: () => void;
  ackPendingUserMessageTimestamp: (args: { receivedAt: Date }) => void;
  setMessages: (messages: Message[]) => void;
  mergeMessages: (messages: Message[]) => number; // 增量合并（不覆盖）
  prependMessages: (messages: Message[]) => number;
  loadOlderMessages: (args: { groupId: string; limit?: number }) => Promise<{ added: number }>;
  syncFromServer: (args: { groupId: string; limit?: number }) => Promise<{ added: number; replaced: boolean }>;
  upsertMessage: (message: Message) => void;
  removeMessageById: (messageId: string) => void;
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
    replyToMessageId: typeof m?.replyToMessageId === 'string' ? m.replyToMessageId : undefined,
    resendOfMessageId: typeof m?.resendOfMessageId === 'string' ? m.resendOfMessageId : undefined,
    isDeleted: typeof m?.isDeleted === 'boolean' ? m.isDeleted : undefined,
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

/** 从消息列表中计算 seq 边界 */
function computeSeqBounds(messages: Message[]): { minSeq: number | null; maxSeq: number | null } {
  let minSeq: number | null = null;
  let maxSeq: number | null = null;
  for (const m of messages) {
    const seq = m.groupSeq;
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) continue;
    if (minSeq === null || seq < minSeq) minSeq = seq;
    if (maxSeq === null || seq > maxSeq) maxSeq = seq;
  }
  return { minSeq, maxSeq };
}

type MessageHistoryItem = {
  id: string;
  groupSeq?: number;
  role: string;
  content: string;
  senderId?: string;
  senderName?: string;
  senderRole?: string;
  viewRole?: string;
  timestamp: string;
};

export const useMessageStore = create<MessageState>()(
  persist(
    (set, get) => ({
      boundSessionId: null,
      boundGroupId: null,
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
      localMinSeq: null,
      localMaxSeq: null,
      isSyncing: false,

  // 绑定"当前消息所属的 sessionId 和 groupId"
  // 切换群组时会清空消息，但同一群组内切换会话不清空
  bindSession: (sessionId, groupId) => set((state) => {
    const nextSessionId = sessionId ? String(sessionId).trim() : null;
    const nextGroupId = groupId ? String(groupId).trim() : null;

    // 完全解绑
    if (!nextSessionId) {
      return {
        boundSessionId: null,
        boundGroupId: null,
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
        localMinSeq: null,
        localMaxSeq: null,
        isSyncing: false,
      };
    }

    // 同一群组：仅更新 sessionId，保留消息
    if (state.boundGroupId === nextGroupId && nextGroupId) {
      if (state.boundSessionId === nextSessionId) return state;
      return { boundSessionId: nextSessionId };
    }

    // 切换群组：清空消息
    return {
      boundSessionId: nextSessionId,
      boundGroupId: nextGroupId,
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
      localMinSeq: null,
      localMaxSeq: null,
      isSyncing: false,
    };
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
    const sorted = maybeSortByGroupSeq(list);
    const { minSeq, maxSeq } = computeSeqBounds(sorted);
    set(() => ({
      messages: sorted,
      localMinSeq: minSeq,
      localMaxSeq: maxSeq,
      hasMoreOlder: sorted.length > 0, // 有消息就认为可能有更多历史
    }));
  },

  // 增量合并消息（不覆盖，用于增量同步）
  mergeMessages: (messages) => {
    let added = 0;
    set((state) => {
      const list = Array.isArray(messages) ? messages : [];
      if (list.length === 0) return state;
      const existing = new Map(state.messages.map((m) => [m.id, m]));
      const toAdd: Message[] = [];
      for (const m of list) {
        if (!m?.id) continue;
        if (existing.has(m.id)) {
          // 已存在：更新（服务端为准）
          existing.set(m.id, { ...existing.get(m.id), ...m });
        } else {
          toAdd.push(m);
        }
      }
      if (toAdd.length === 0 && list.length === state.messages.length) return state;
      added = toAdd.length;
      const merged = [...Array.from(existing.values()), ...toAdd];
      const sorted = maybeSortByGroupSeq(merged);
      const { minSeq, maxSeq } = computeSeqBounds(sorted);
      return {
        messages: sorted,
        localMinSeq: minSeq,
        localMaxSeq: maxSeq,
      };
    });
    return added;
  },

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
      const sorted = maybeSortByGroupSeq(next);
      const { minSeq, maxSeq } = computeSeqBounds(sorted);
      return {
        messages: sorted,
        localMinSeq: minSeq,
        localMaxSeq: maxSeq,
      };
    });
    return added;
  },

  // 向前加载历史（使用 beforeSeq 分页）
  loadOlderMessages: async ({ groupId, limit }) => {
    const gid = String(groupId || '').trim();
    if (!gid) return { added: 0 };

    const state = get();
    if (state.isLoadingOlder) return { added: 0 };
    if (!state.hasMoreOlder) return { added: 0 };

    const take = Math.max(1, Math.min(200, Number(limit) || 50));
    const beforeSeq = state.localMinSeq;

    set({ isLoadingOlder: true });
    try {
      const resp = await invoke<ApiResponse<MessageHistoryItem[]>>('get_group_message_history', {
        groupId: gid,
        limit: take,
        beforeSeq: beforeSeq && beforeSeq > 0 ? beforeSeq : undefined,
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
        senderId: (m as any).senderId ? String((m as any).senderId) : undefined,
        senderName: (m as any).senderName ? String((m as any).senderName) : undefined,
        senderRole: (m as any).senderRole ? ((m as any).senderRole as any) : undefined,
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

  // 增量同步：从服务端拉取 afterSeq > localMaxSeq 的新消息
  syncFromServer: async ({ groupId, limit }) => {
    const gid = String(groupId || '').trim();
    if (!gid) return { added: 0, replaced: false };

    const state = get();
    if (state.isSyncing) return { added: 0, replaced: false };

    const take = Math.max(1, Math.min(200, Number(limit) || 100));
    const afterSeq = state.localMaxSeq;
    const hasLocalMessages = state.messages.length > 0;

    set({ isSyncing: true });
    try {
      // 如果本地有缓存且有 maxSeq，使用增量同步
      // 否则拉取最新 N 条（冷启动）
      const resp = await invoke<ApiResponse<MessageHistoryItem[]>>('get_group_message_history', {
        groupId: gid,
        limit: take,
        afterSeq: hasLocalMessages && afterSeq && afterSeq > 0 ? afterSeq : undefined,
      });

      if (!resp?.success || !Array.isArray(resp.data)) {
        set({ isSyncing: false });
        return { added: 0, replaced: false };
      }

      const mapped: Message[] = resp.data.map((m) => ({
        id: m.id,
        role: (m.role === 'User' ? 'User' : 'Assistant') as any,
        content: m.content,
        timestamp: new Date(m.timestamp),
        viewRole: (m.viewRole as any) || undefined,
        groupSeq: typeof (m as any).groupSeq === 'number' ? (m as any).groupSeq : undefined,
        senderId: (m as any).senderId ? String((m as any).senderId) : undefined,
        senderName: (m as any).senderName ? String((m as any).senderName) : undefined,
        senderRole: (m as any).senderRole ? ((m as any).senderRole as any) : undefined,
      }));

      // 冷启动（本地无缓存）：直接设置
      if (!hasLocalMessages || !afterSeq) {
        get().setMessages(mapped);
        set({ isSyncing: false });
        return { added: mapped.length, replaced: true };
      }

      // 热启动：增量合并
      const added = get().mergeMessages(mapped);
      set({ isSyncing: false });
      return { added, replaced: false };
    } catch {
      set({ isSyncing: false });
      return { added: 0, replaced: false };
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

  removeMessageById: (messageId) => set((state) => {
    const id = String(messageId || '').trim();
    if (!id) return state;
    const next = state.messages.filter((m) => m.id !== id);
    if (next.length === state.messages.length) return state;
    // 若删除的是 streaming message，顺带停止流式状态，避免 UI 残留
    const wasStreaming = state.streamingMessageId === id;
    return {
      messages: next,
      ...(wasStreaming ? { isStreaming: false, streamingMessageId: null, streamingPhase: null } : null),
    } as any;
  }),

  // 群广播消息注入：
  // - 解决"发送者本地 user message id 与服务端落库 id 不一致"导致的重复
  // - 尽量保持按 groupSeq 有序（若缺失 groupSeq 则退化按 timestamp）
  // - 更新 localMaxSeq（实时同步时推进游标）
  ingestGroupBroadcastMessage: ({ message, currentUserId }) => set((state) => {
    const incoming = message;
    if (!incoming?.id) return state;

    // 更新 maxSeq
    const incomingSeq = typeof incoming.groupSeq === 'number' ? incoming.groupSeq : null;
    const newMaxSeq = incomingSeq && (state.localMaxSeq === null || incomingSeq > state.localMaxSeq)
      ? incomingSeq
      : state.localMaxSeq;

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
          m.senderId === currentUserId &&
          (m.content ?? '') === (incoming.content ?? '') &&
          Math.abs((m.timestamp?.getTime?.() ?? 0) - (incoming.timestamp?.getTime?.() ?? 0)) <= 30_000
        );
      if (idxFromEnd !== -1) {
        const idx = state.messages.length - 1 - idxFromEnd;
        const next = [...state.messages];
        next[idx] = { ...next[idx], ...incoming };
        return { messages: maybeSortByGroupSeq(next), localMaxSeq: newMaxSeq };
      }
    }

    // 2) 常规 upsert by id
    const existingIdx = state.messages.findIndex((m) => m.id === incoming.id);
    if (existingIdx !== -1) {
      const next = [...state.messages];
      next[existingIdx] = { ...next[existingIdx], ...incoming };
      return { messages: maybeSortByGroupSeq(next), localMaxSeq: newMaxSeq };
    }

    // 3) 新消息：追加并按需排序
    const next = [...state.messages, incoming];
    return { messages: maybeSortByGroupSeq(next), localMaxSeq: newMaxSeq };
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

  // 清理"当前对话上下文"（但保留 boundSessionId/boundGroupId），用于：
  // - 清空本地消息，不回填服务端历史（否则用户点"清理"会立刻又出现历史消息）
  // - 不影响 session/document（由 sessionStore 管），用户可继续在当前 PRD 上提问
  clearCurrentContext: (sessionId) => set((state) => ({
    boundSessionId: sessionId ? String(sessionId).trim() : null,
    boundGroupId: state.boundGroupId, // 保留群组绑定
    isPinnedToBottom: true,
    scrollToBottomSeq: 0,
    messages: [],
    isStreaming: false,
    streamingMessageId: null,
    streamingPhase: null,
    pendingAssistantId: null,
    isLoadingOlder: false,
    hasMoreOlder: true,
    localMinSeq: null,
    localMaxSeq: null,
    isSyncing: false,
  })),
  
      clearMessages: () => set({
        boundSessionId: null,
        boundGroupId: null,
        isPinnedToBottom: true,
        scrollToBottomSeq: 0,
        messages: [],
        isStreaming: false,
        streamingMessageId: null,
        streamingPhase: null,
        pendingAssistantId: null,
        isLoadingOlder: false,
        hasMoreOlder: true,
        localMinSeq: null,
        localMaxSeq: null,
        isSyncing: false,
      }),
    }),
    {
      name: 'message-storage',
      version: 2, // 版本升级：新增 seq 字段
      partialize: (s) => ({
        boundSessionId: s.boundSessionId,
        boundGroupId: s.boundGroupId,
        isPinnedToBottom: s.isPinnedToBottom,
        messages: s.messages,
        localMinSeq: s.localMinSeq,
        localMaxSeq: s.localMaxSeq,
      }),
      merge: (persisted: any, current) => {
        const p = (persisted as any) || {};
        const next: any = {
          ...current,
          ...p,
        };
        const revived = reviveMessages(p.messages);
        // 刷新/重启后：对持久化消息做一次稳定纠序
        next.messages = maybeSortByGroupSeq(revived);
        // 重建 seq 边界（以实际消息为准，防止脏数据）
        const { minSeq, maxSeq } = computeSeqBounds(revived);
        next.localMinSeq = minSeq;
        next.localMaxSeq = maxSeq;
        // 非持久化字段重置
        next.isLoadingOlder = false;
        next.hasMoreOlder = revived.length > 0;
        next.pendingAssistantId = null;
        next.isSyncing = false;
        return next as MessageState;
      },
    }
  )
);
