import { create } from 'zustand';
import { Message } from '../types';

interface MessageState {
  messages: Message[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  
  addMessage: (message: Message) => void;
  setMessages: (messages: Message[]) => void;
  upsertMessage: (message: Message) => void;
  startStreaming: (message: Message) => void;
  appendToStreamingMessage: (content: string) => void;
  stopStreaming: () => void;
  clearMessages: () => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messages: [],
  isStreaming: false,
  streamingMessageId: null,
  
  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message],
  })),
  
  setMessages: (messages) => set({ messages }),

  upsertMessage: (message) => set((state) => {
    const idx = state.messages.findIndex((m) => m.id === message.id);
    if (idx === -1) {
      return { messages: [...state.messages, message] };
    }
    const next = [...state.messages];
    next[idx] = message;
    return { messages: next };
  }),

  startStreaming: (message) => set((state) => {
    const idx = state.messages.findIndex((m) => m.id === message.id);
    const next = idx === -1
      ? [...state.messages, message]
      : state.messages.map((m) => (m.id === message.id ? message : m));

    return {
      messages: next,
      isStreaming: true,
      streamingMessageId: message.id,
    };
  }),

  appendToStreamingMessage: (content) => set((state) => {
    if (!state.streamingMessageId) return state;
    const next = state.messages.map((m) => {
      if (m.id !== state.streamingMessageId) return m;
      return { ...m, content: (m.content ?? '') + content };
    });
    return { messages: next };
  }),
  
  stopStreaming: () => set({ isStreaming: false, streamingMessageId: null }),
  
  clearMessages: () => set({ messages: [], isStreaming: false, streamingMessageId: null }),
}));
