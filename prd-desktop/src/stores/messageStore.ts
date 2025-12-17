import { create } from 'zustand';
import { Message, MessageBlock, MessageBlockKind } from '../types';

export type StreamingPhase = 'requesting' | 'connected' | 'receiving' | 'typing' | null;
export type MessageContextMode = 'QA' | 'Guided';

interface MessageState {
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

  addMessage: (message: Message) => void;
  setMessages: (messages: Message[]) => void;
  upsertMessage: (message: Message) => void;
  startStreaming: (message: Message) => void;
  appendToStreamingMessage: (content: string) => void;
  startStreamingBlock: (block: { id: string; kind: MessageBlockKind; language?: string | null }) => void;
  appendToStreamingBlock: (blockId: string, content: string) => void;
  endStreamingBlock: (blockId: string) => void;
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

export const useMessageStore = create<MessageState>((set) => ({
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

  setStreamingPhase: (phase) => set({ streamingPhase: phase }),
  
  stopStreaming: () => set({ isStreaming: false, streamingMessageId: null, streamingPhase: null }),
  
  clearMessages: () => set({
    contextMode: 'QA',
    qaMessages: [],
    guidedThreads: {},
    activeGuidedStep: 1,
    messages: [],
    isStreaming: false,
    streamingMessageId: null,
    streamingPhase: null,
  }),
}));
