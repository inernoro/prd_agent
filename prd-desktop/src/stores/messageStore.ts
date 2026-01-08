import { create } from 'zustand';
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
  /** 切换群组：重置消息/分页/流式状态，但不要求已拿到 sessionId（sessionId 之后再 bindSession 即可） */
  bindGroupContext: (groupId: string | null) => void;
  setPinnedToBottom: (pinned: boolean) => void;
  triggerScrollToBottom: () => void;

  addMessage: (message: Message) => void;
  addMessageAndScrollToBottom: (message: Message) => void;
  addUserMessageWithPendingAssistant: (args: { userMessage: Message }) => void;
  clearPendingAssistant: () => void;
  ackPendingUserMessageTimestamp: (args: { receivedAt: Date }) => void;
  ackPendingUserMessageRunId: (args: { runId: string }) => void;
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
  finishStreaming: () => void;
  clearCurrentContext: (sessionId: string | null) => void;
  clearMessages: () => void;
}

// -------- Streaming 平滑化（避免每个 chunk 都 setState 导致“跳”）--------
// - 流式输出时，后端可能以很碎的 delta 推送；若每个 delta 都触发一次 set，会导致 UI 抖动（尤其 Markdown/布局）。
// - 这里做“帧级缓冲 + 分片 flush”，让输出更丝滑，并带一点“吐字”视觉效果。
let streamingPendingText = '';
const streamingPendingByBlock = new Map<string, string>();
let streamingFlushRaf: number | null = null;
let streamingFlushTimeout: number | null = null;
let streamingStopAfterDrain = false;

const rafSchedule: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => (setTimeout(() => cb(Date.now()), 16) as unknown as number);

const rafCancel: (id: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (id) => cancelAnimationFrame(id)
    : (id) => clearTimeout(id as unknown as any);

function takeSmoothChunk(buf: string): string {
  const s = String(buf || '');
  if (s.length <= 32) return s;
  // buffer 越大，每帧吐字越多，避免明显落后；buffer 越小则更细腻
  const n = Math.max(24, Math.min(180, Math.ceil(s.length / 6)));
  return s.slice(0, n);
}

function clearStreamingBuffers() {
  streamingPendingText = '';
  streamingPendingByBlock.clear();
  if (streamingFlushRaf != null) {
    rafCancel(streamingFlushRaf);
    streamingFlushRaf = null;
  }
  if (streamingFlushTimeout != null) {
    clearTimeout(streamingFlushTimeout as any);
    streamingFlushTimeout = null;
  }
}


function maybeSortByGroupSeq(list: Message[]): Message[] {
  const hasSeq = list.some((m) => typeof (m as any)?.groupSeq === 'number');
  if (!hasSeq) return list;
  // groupSeq 优先，其次 timestamp；
  // 注意：缺失 groupSeq 的消息如果放到最前，会导致 streaming assistant（尚未落库/尚未回填 groupSeq）
  // 被挪到列表顶部，从而在“锁底视图”下看起来像“没有流式输出，结束才出现”。
  // 这里改为：缺失 groupSeq 的消息放到最后，保证实时对话体验。
  return [...list].sort((a, b) => {
    const sa = typeof a.groupSeq === 'number' ? a.groupSeq : null;
    const sb = typeof b.groupSeq === 'number' ? b.groupSeq : null;
    if (sa == null && sb == null) return a.timestamp.getTime() - b.timestamp.getTime();
    if (sa == null) return 1;
    if (sb == null) return -1;
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

export const useMessageStore = create<MessageState>()((set, get) => ({
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
      // 未拉取任何历史前：先置为 false，避免 UI 错误展示“仅加载最近3轮…”
      hasMoreOlder: false,
      localMinSeq: null,
      localMaxSeq: null,
      isSyncing: false,
    };
  }),

  // 仅切换群组上下文（无 sessionId）：
  // - 立刻清空旧群消息，避免串话/旧 range 残留导致“显示最旧消息”
  // - 分页状态重置：等待后续 syncFromServer 冷启动后再计算 hasMoreOlder
  bindGroupContext: (groupId) => set(() => {
    const gid = groupId ? String(groupId).trim() : null;
    if (!gid) {
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
        hasMoreOlder: false,
        localMinSeq: null,
        localMaxSeq: null,
        isSyncing: false,
      };
    }
    return {
      boundSessionId: null,
      boundGroupId: gid,
      isPinnedToBottom: true,
      scrollToBottomSeq: 0,
      messages: [],
      isStreaming: false,
      streamingMessageId: null,
      streamingPhase: null,
      pendingAssistantId: null,
      pendingUserMessageId: null,
      isLoadingOlder: false,
      hasMoreOlder: false,
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

      // 发送消息：只添加用户消息，不创建本地 AI 占位（由后端创建并广播）
      addUserMessageWithPendingAssistant: ({ userMessage }) => {
        set((state) => {
        const next = [...state.messages, userMessage];
        return {
          messages: next,
          pendingAssistantId: null,
          pendingUserMessageId: userMessage?.id ?? null,
          isPinnedToBottom: true,
          scrollToBottomSeq: (state.scrollToBottomSeq ?? 0) + 1,
        };
        });
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

      // Run 回填：把“本地插入的 userMessage”补上 runId（用于显式 stop）
      ackPendingUserMessageRunId: ({ runId }) => set((state) => {
        const id = state.pendingUserMessageId;
        const rid = String(runId || '').trim();
        if (!id || !rid) return state;
        const next = state.messages.map((m) => (m.id === id ? { ...m, runId: rid } : m));
        return { messages: next };
      }),
  
  setMessages: (messages) => {
    const list = Array.isArray(messages) ? messages : [];
    const sorted = maybeSortByGroupSeq(list);
    const { minSeq, maxSeq } = computeSeqBounds(sorted);
    set(() => ({
      messages: sorted,
      localMinSeq: minSeq,
      localMaxSeq: maxSeq,
      // 注意：是否还有更早历史应由调用方（基于 limit 命中情况）决定，这里仅做兜底
      hasMoreOlder: sorted.length > 0,
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
        runId: (m as any).runId ? String((m as any).runId) : undefined,
        senderId: (m as any).senderId ? String((m as any).senderId) : undefined,
        senderName: (m as any).senderName ? String((m as any).senderName) : undefined,
        senderRole: (m as any).senderRole ? ((m as any).senderRole as any) : undefined,
        senderAvatarUrl: (m as any).senderAvatarUrl ? String((m as any).senderAvatarUrl) : undefined,
        senderTags: Array.isArray((m as any).senderTags) ? (m as any).senderTags : undefined,
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
        runId: (m as any).runId ? String((m as any).runId) : undefined,
        senderId: (m as any).senderId ? String((m as any).senderId) : undefined,
        senderName: (m as any).senderName ? String((m as any).senderName) : undefined,
        senderRole: (m as any).senderRole ? ((m as any).senderRole as any) : undefined,
        senderAvatarUrl: (m as any).senderAvatarUrl ? String((m as any).senderAvatarUrl) : undefined,
        senderTags: Array.isArray((m as any).senderTags) ? (m as any).senderTags : undefined,
      }));

      // 冷启动（本地无缓存）：直接设置
      if (!hasLocalMessages || !afterSeq) {
        get().setMessages(mapped);
        // 冷启动：以“是否命中一页”判断是否还有更早历史
        set({ isSyncing: false, hasMoreOlder: resp.data.length >= take });
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

  appendToStreamingMessage: (content) => {
    const txt = String(content ?? '');
    if (txt) streamingPendingText += txt;

    const schedule = () => {
      if (streamingFlushRaf != null) return;
      streamingFlushRaf = rafSchedule(() => {
        streamingFlushRaf = null;
        const state = get();
        if (!state.streamingMessageId) {
          clearStreamingBuffers();
          streamingStopAfterDrain = false;
          return;
        }

        const msgChunk = takeSmoothChunk(streamingPendingText);
        streamingPendingText = streamingPendingText.slice(msgChunk.length);

        const blockChunks: Array<{ id: string; chunk: string }> = [];
        for (const [bid, buf] of streamingPendingByBlock.entries()) {
          const c = takeSmoothChunk(buf);
          if (!c) continue;
          blockChunks.push({ id: bid, chunk: c });
          const rest = buf.slice(c.length);
          if (rest) streamingPendingByBlock.set(bid, rest);
          else streamingPendingByBlock.delete(bid);
        }

        if (msgChunk || blockChunks.length > 0) {
          set((s) => {
            if (!s.streamingMessageId) return s as any;
            const next = s.messages.map((m) => {
              if (m.id !== s.streamingMessageId) return m;
              let nextContent = (m.content ?? '') + (msgChunk ?? '');
              if (blockChunks.length > 0) {
                const blocks = (m.blocks ?? []) as MessageBlock[];
                const nextBlocks = [...blocks];
                for (const bc of blockChunks) {
                  const idx = nextBlocks.findIndex((b) => b.id === bc.id);
                  if (idx === -1) {
                    // 容错：没收到 blockStart 也能显示
                    const inferred: MessageBlock = { id: bc.id, kind: 'paragraph', content: bc.chunk, isComplete: false };
                    nextBlocks.push(inferred);
                  } else {
                    nextBlocks[idx] = { ...nextBlocks[idx], content: (nextBlocks[idx].content ?? '') + bc.chunk };
                  }
                  nextContent += bc.chunk;
                }
                return { ...m, content: nextContent, blocks: nextBlocks };
              }
              return { ...m, content: nextContent };
            });
            return { messages: next, streamingPhase: s.streamingPhase === 'typing' ? s.streamingPhase : 'typing' } as any;
          });
        }

        // 若收到 done 后要求“优雅结束”：等缓冲吐完再 stop（避免最后一大坨瞬间刷出来）
        if (streamingStopAfterDrain && !streamingPendingText && streamingPendingByBlock.size === 0) {
          streamingStopAfterDrain = false;
          clearStreamingBuffers();
          set({ isStreaming: false, streamingMessageId: null, streamingPhase: null });
          return;
        }

        if (streamingPendingText || streamingPendingByBlock.size > 0) schedule();
      });
    };

    // 即便 txt 为空（例如 block delta 调度），也允许 schedule 触发 flush
    if (txt || streamingPendingByBlock.size > 0) {
      schedule();
      // 双保险：极端情况下 rAF 可能被 WebView 节流，这里再挂一个 50ms 的兜底 tick
      if (streamingFlushTimeout == null) {
        streamingFlushTimeout = setTimeout(() => {
          streamingFlushTimeout = null;
          if (streamingPendingText || streamingPendingByBlock.size > 0) schedule();
        }, 50) as any;
      }
    }
  },

  startStreamingBlock: (block) => set((state) => {
    if (!state.streamingMessageId) {
      console.warn('[messageStore] startStreamingBlock 调用时没有 streamingMessageId');
      return state;
    }
    const next = state.messages.map((m) => {
      if (m.id !== state.streamingMessageId) return m;
      const blocks = (m.blocks ?? []) as MessageBlock[];
      // 避免重复 start
      if (blocks.some((b) => b.id === block.id)) {
        return m;
      }
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

  appendToStreamingBlock: (blockId, content) => {
    const bid = String(blockId || '').trim();
    const txt2 = String(content ?? '');
    if (!bid || !txt2) return;
    const prev = streamingPendingByBlock.get(bid) ?? '';
    streamingPendingByBlock.set(bid, prev + txt2);
    // 触发一次 flush（复用 appendToStreamingMessage 的调度器）
    get().appendToStreamingMessage('');
  },

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
  
  stopStreaming: () => {
    streamingStopAfterDrain = false;
    // 停止前把缓冲尽量写完（避免尾巴丢字）
    const st = get();
    if (st.streamingMessageId && (streamingPendingText || streamingPendingByBlock.size > 0)) {
      const msgChunk = streamingPendingText;
      const blockChunks: Array<{ id: string; chunk: string }> = [];
      for (const [bid, buf] of streamingPendingByBlock.entries()) {
        if (buf) blockChunks.push({ id: bid, chunk: buf });
      }
      clearStreamingBuffers();
      if (msgChunk || blockChunks.length > 0) {
        set((s) => {
          if (!s.streamingMessageId) return s as any;
          const next = s.messages.map((m) => {
            if (m.id !== s.streamingMessageId) return m;
            let nextContent = (m.content ?? '') + (msgChunk ?? '');
            if (blockChunks.length > 0) {
              const blocks = (m.blocks ?? []) as MessageBlock[];
              const nextBlocks = [...blocks];
              for (const bc of blockChunks) {
                const idx = nextBlocks.findIndex((b) => b.id === bc.id);
                if (idx === -1) {
                  nextBlocks.push({ id: bc.id, kind: 'paragraph', content: bc.chunk, isComplete: false });
                } else {
                  nextBlocks[idx] = { ...nextBlocks[idx], content: (nextBlocks[idx].content ?? '') + bc.chunk };
                }
                nextContent += bc.chunk;
              }
              return { ...m, content: nextContent, blocks: nextBlocks };
            }
            return { ...m, content: nextContent };
          });
          return { messages: next } as any;
        });
      }
    } else {
      clearStreamingBuffers();
    }
    set({ isStreaming: false, streamingMessageId: null, streamingPhase: null });
  },

  // done 场景：让“吐字动画”把最后一段缓冲吐完后再结束，避免瞬间刷屏
  finishStreaming: () => {
    const st = get();
    if (!st.streamingMessageId) {
      streamingStopAfterDrain = false;
      clearStreamingBuffers();
      set({ isStreaming: false, streamingMessageId: null, streamingPhase: null });
      return;
    }
    streamingStopAfterDrain = true;
    // 触发 flush 调度（若当前无 pending，也会在下一次 delta 前保持 isStreaming=true）
    get().appendToStreamingMessage('');
    // 安全兜底：万一卡住（例如后端不再发 delta，但这里仍在 stopAfterDrain=true），最多 2s 后强制结束
    setTimeout(() => {
      const s2 = get();
      if (!streamingStopAfterDrain) return;
      if (!s2.isStreaming || !s2.streamingMessageId) {
        streamingStopAfterDrain = false;
        return;
      }
      if (!streamingPendingText && streamingPendingByBlock.size === 0) {
        streamingStopAfterDrain = false;
        clearStreamingBuffers();
        set({ isStreaming: false, streamingMessageId: null, streamingPhase: null });
      }
    }, 2000);
  },

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
  
      clearMessages: () => {
        clearStreamingBuffers();
        set({
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
        });
      },
    }));
