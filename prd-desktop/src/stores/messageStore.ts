import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DocCitation, Message, MessageBlock, MessageBlockKind } from '../types';

export type StreamingPhase = 'requesting' | 'connected' | 'receiving' | 'typing' | null;
export type MessageContextMode = 'QA' | 'Guided';

interface MessageState {
  boundSessionId: string | null;
  isPinnedToBottom: boolean;
  contextMode: MessageContextMode;
  qaMessages: Message[];
  guidedThreads: Record<number, Message[]>;
  activeGuidedStep: number;

  messages: Message[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingPhase: StreamingPhase;
  
  setContext: (mode: MessageContextMode, guidedStep?: number) => void;
  setGuidedStep: (step: number) => void;
  bindSession: (sessionId: string | null) => void;
  setPinnedToBottom: (pinned: boolean) => void;

  addMessage: (message: Message) => void;
  setMessages: (messages: Message[]) => void;
  upsertMessage: (message: Message) => void;
  startStreaming: (message: Message) => void;
  appendToStreamingMessage: (content: string) => void;
  startStreamingBlock: (block: { id: string; kind: MessageBlockKind; language?: string | null }) => void;
  appendToStreamingBlock: (blockId: string, content: string) => void;
  endStreamingBlock: (blockId: string) => void;
  setMessageCitations: (messageId: string, citations: DocCitation[]) => void;
  setStreamingMessageCitations: (citations: DocCitation[]) => void;
  setStreamingPhase: (phase: StreamingPhase) => void;
  stopStreaming: () => void;
  clearMessages: () => void;
}

function writeBack(state: Pick<MessageState, 'contextMode' | 'qaMessages' | 'guidedThreads' | 'activeGuidedStep'>, nextMessages: Message[]) {
  if (state.contextMode === 'Guided') {
    return {
      qaMessages: state.qaMessages,
      guidedThreads: {
        ...state.guidedThreads,
        [state.activeGuidedStep]: nextMessages,
      },
    };
  }
  return {
    qaMessages: nextMessages,
    guidedThreads: state.guidedThreads,
  };
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
    senderId: m?.senderId ?? undefined,
    senderName: m?.senderName ?? undefined,
  };
}

function reviveMessages(list: any): Message[] {
  if (!Array.isArray(list)) return [];
  return list.map(reviveMessage).filter((x) => x.id);
}

export const useMessageStore = create<MessageState>()(
  persist(
    (set) => ({
      boundSessionId: null,
      isPinnedToBottom: true,
      contextMode: 'QA',
      qaMessages: [],
      guidedThreads: {},
      activeGuidedStep: 1,

      messages: [],
      isStreaming: false,
      streamingMessageId: null,
      streamingPhase: null,

  setContext: (mode, guidedStep) => set((state) => {
    const back = writeBack(state, state.messages);
    const nextMode: MessageContextMode = mode;
    const nextStep = guidedStep ?? state.activeGuidedStep ?? 1;

    if (nextMode === 'Guided') {
      const nextMessages = state.guidedThreads[nextStep] ?? [];
      return {
        ...back,
        contextMode: 'Guided',
        activeGuidedStep: nextStep,
        messages: nextMessages,
      };
    }

    return {
      ...back,
      contextMode: 'QA',
      messages: state.qaMessages,
    };
  }),

  setGuidedStep: (step) => set((state) => {
    if (state.contextMode !== 'Guided') return state;
    const back = writeBack(state, state.messages);
    const nextStep = step || 1;
    const nextMessages = state.guidedThreads[nextStep] ?? [];
    return {
      ...back,
      activeGuidedStep: nextStep,
      messages: nextMessages,
    };
  }),

  // 绑定“当前消息所属的 sessionId”，用于：
  // - 避免 ChatContainer 因卸载/重挂载而误清空同一会话的对话（看起来像“不持久化”）
  // - 在切换群组/会话时，确保不会把旧会话消息串到新会话
  bindSession: (sessionId) => set((state) => {
    const next = sessionId ? String(sessionId).trim() : null;
    if (state.boundSessionId === next) return state;
    if (!next) {
      return {
        boundSessionId: null,
        isPinnedToBottom: true,
        contextMode: 'QA',
        qaMessages: [],
        guidedThreads: {},
        activeGuidedStep: 1,
        messages: [],
        isStreaming: false,
        streamingMessageId: null,
        streamingPhase: null,
      };
    }
    return {
      boundSessionId: next,
      isPinnedToBottom: true,
      contextMode: 'QA',
      qaMessages: [],
      guidedThreads: {},
      activeGuidedStep: 1,
      messages: [],
      isStreaming: false,
      streamingMessageId: null,
      streamingPhase: null,
    };
  }),

  setPinnedToBottom: (pinned) => set((state) => {
    const next = !!pinned;
    if (state.isPinnedToBottom === next) return state;
    return { isPinnedToBottom: next };
  }),
  
  addMessage: (message) => set((state) => {
    const next = [...state.messages, message];
    return { messages: next, ...writeBack(state, next) };
  }),
  
  setMessages: (messages) => set((state) => ({ messages, ...writeBack(state, messages) })),

  upsertMessage: (message) => set((state) => {
    const idx = state.messages.findIndex((m) => m.id === message.id);
    if (idx === -1) {
      const next = [...state.messages, message];
      return { messages: next, ...writeBack(state, next) };
    }
    const next = [...state.messages];
    next[idx] = message;
    return { messages: next, ...writeBack(state, next) };
  }),

  startStreaming: (message) => set((state) => {
    const idx = state.messages.findIndex((m) => m.id === message.id);
    const msgWithBlocks: Message = { ...message, blocks: message.blocks ?? [] };
    const next = idx === -1
      ? [...state.messages, msgWithBlocks]
      : state.messages.map((m) => (m.id === message.id ? msgWithBlocks : m));

    return {
      messages: next,
      ...writeBack(state, next),
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
    return { messages: next, ...writeBack(state, next), streamingPhase: state.streamingPhase === 'typing' ? state.streamingPhase : 'typing' };
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
    return { messages: next, ...writeBack(state, next) };
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
    return { messages: next, ...writeBack(state, next), streamingPhase: state.streamingPhase === 'typing' ? state.streamingPhase : 'typing' };
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
    return { messages: next, ...writeBack(state, next) };
  }),

  setMessageCitations: (messageId, citations) => set((state) => {
    const next = state.messages.map((m) => {
      if (m.id !== messageId) return m;
      return { ...m, citations: Array.isArray(citations) ? citations : [] };
    });
    return { messages: next, ...writeBack(state, next) };
  }),

  setStreamingMessageCitations: (citations) => set((state) => {
    if (!state.streamingMessageId) return state;
    const next = state.messages.map((m) => {
      if (m.id !== state.streamingMessageId) return m;
      return { ...m, citations: Array.isArray(citations) ? citations : [] };
    });
    return { messages: next, ...writeBack(state, next) };
  }),

  setStreamingPhase: (phase) => set({ streamingPhase: phase }),
  
  stopStreaming: () => set({ isStreaming: false, streamingMessageId: null, streamingPhase: null }),
  
      clearMessages: () => set({
        boundSessionId: null,
        isPinnedToBottom: true,
        contextMode: 'QA',
        qaMessages: [],
        guidedThreads: {},
        activeGuidedStep: 1,
        messages: [],
        isStreaming: false,
        streamingMessageId: null,
        streamingPhase: null,
      }),
    }),
    {
      name: 'message-storage',
      version: 1,
      partialize: (s) => ({
        boundSessionId: s.boundSessionId,
        isPinnedToBottom: s.isPinnedToBottom,
        contextMode: s.contextMode,
        qaMessages: s.qaMessages,
        guidedThreads: s.guidedThreads,
        activeGuidedStep: s.activeGuidedStep,
        messages: s.messages,
      }),
      merge: (persisted: any, current) => {
        const p = (persisted as any) || {};
        const next: any = {
          ...current,
          ...p,
        };
        next.qaMessages = reviveMessages(p.qaMessages);
        next.messages = reviveMessages(p.messages);
        const gt: Record<string, any> = (p.guidedThreads && typeof p.guidedThreads === 'object') ? p.guidedThreads : {};
        const revivedThreads: Record<number, Message[]> = {};
        Object.keys(gt).forEach((k) => {
          const n = Number(k);
          if (!Number.isFinite(n)) return;
          revivedThreads[n] = reviveMessages(gt[k]);
        });
        next.guidedThreads = revivedThreads;
        return next as MessageState;
      },
    }
  )
);
