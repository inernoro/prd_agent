import { create } from 'zustand';
import { Message } from '../types';

interface MessageState {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  
  addMessage: (message: Message) => void;
  updateStreamingContent: (content: string) => void;
  appendStreamingContent: (content: string) => void;
  startStreaming: () => void;
  stopStreaming: () => void;
  clearMessages: () => void;
}

export const useMessageStore = create<MessageState>((set) => ({
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
  
  clearMessages: () => set({ messages: [], streamingContent: '' }),
}));