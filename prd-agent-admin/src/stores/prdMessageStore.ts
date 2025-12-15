import { create } from 'zustand';
import { ChatMessage } from '../types';

interface PrdMessageState {
  messages: ChatMessage[];
  streamingContent: string;
  isStreaming: boolean;
  
  addMessage: (message: ChatMessage) => void;
  updateStreamingContent: (content: string) => void;
  appendStreamingContent: (content: string) => void;
  startStreaming: () => void;
  stopStreaming: () => void;
  finalizeStreaming: () => void;
  clearMessages: () => void;
}

export const usePrdMessageStore = create<PrdMessageState>((set, get) => ({
  messages: [],
  streamingContent: '',
  isStreaming: false,
  
  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message],
  })),
  
  updateStreamingContent: (content) => set({ streamingContent: content }),
  
  appendStreamingContent: (content) => set((state) => ({
    streamingContent: state.streamingContent + content,
  })),
  
  startStreaming: () => set({ isStreaming: true, streamingContent: '' }),
  
  stopStreaming: () => set({ isStreaming: false }),
  
  finalizeStreaming: () => {
    const { streamingContent, messages } = get();
    if (streamingContent) {
      const assistantMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'Assistant',
        content: streamingContent,
        timestamp: new Date(),
      };
      set({
        messages: [...messages, assistantMessage],
        streamingContent: '',
        isStreaming: false,
      });
    } else {
      set({ isStreaming: false });
    }
  },
  
  clearMessages: () => set({ messages: [], streamingContent: '' }),
}));


