// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSession, ChatStreamEvent, ChatTurnAccepted } from '@/services/real/chatAgentService';
import { ChatPage } from './ChatPage';

const service = vi.hoisted(() => ({
  listChatSessions: vi.fn(), createChatSession: vi.fn(), renameChatSession: vi.fn(),
  deleteChatSession: vi.fn(), listChatMessages: vi.fn(), sendChatMessage: vi.fn(), streamChatEvents: vi.fn(),
}));
vi.mock('@/services/real/chatAgentService', () => service);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const session: ChatSession = {
  id: 'session', title: '本轮合成会话', model: null, effectiveModel: 'default', running: false,
  eventSeq: 7, runningTurnStartSeq: null, createdAt: '', updatedAt: '',
};
function wire<T>(data: T) { return { success: true as const, data, error: null }; }

function enterText(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ChatPage pending history response ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
    service.listChatSessions.mockResolvedValue(wire({ items: [session] }));
    service.sendChatMessage.mockResolvedValue(wire({ turnId: 'turn', userMessageId: 'u', assistantMessageId: 'a', seq: 8 }));
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it.each(['before-acceptance', 'running', 'runtime-error'] as const)('a late empty history cannot erase the new turn or replace its stream: %s', async (phase) => {
    const history = deferred<ReturnType<typeof wire<{ items: ChatMessage[] }>>>();
    service.listChatMessages.mockReturnValue(history.promise);
    const acceptance = deferred<ReturnType<typeof wire<ChatTurnAccepted>>>();
    if (phase === 'before-acceptance') service.sendChatMessage.mockReturnValue(acceptance.promise);
    const streams: { afterSeq: number; signal: AbortSignal; emit: (event: ChatStreamEvent) => void }[] = [];
    service.streamChatEvents.mockImplementation((_id, afterSeq, emit, signal) => {
      streams.push({ afterSeq, emit, signal });
      return new Promise<void>(() => {});
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<ChatPage />); });
      expect(service.listChatMessages).toHaveBeenCalledWith('session');
      const input = container.querySelector('textarea')!;
      await act(async () => { enterText(input, '只索引本轮指定文档'); });
      await act(async () => { (container.querySelector('[aria-label="发送"]') as HTMLButtonElement).click(); });
      expect(service.sendChatMessage).toHaveBeenCalledOnce();
      expect(container.textContent).toContain('只索引本轮指定文档');
      if (phase === 'before-acceptance') {
        expect(streams).toHaveLength(0);
        await act(async () => { history.resolve(wire({ items: [] })); });
        expect(container.textContent).toContain('只索引本轮指定文档');
        expect(streams).toHaveLength(0);
        await act(async () => { acceptance.resolve(wire({ turnId: 'turn', userMessageId: 'u', assistantMessageId: 'a', seq: 8 })); });
      }
      expect(streams).toHaveLength(1);
      expect(streams[0].afterSeq).toBe(8);
      if (phase !== 'running') {
        await act(async () => { streams[0].emit({ seq: 9, type: 'error', payload: {
          code: 'sidecar_not_configured', message: '对话运行时还没配置好，管理员需要先启用它。',
        } }); });
        expect(container.textContent).toContain('对话运行时还没配置好');
      }
      // The initial GET began before POST/messages, but its old empty body arrives
      // after the optimistic turn / SSE error, as permitted by the deployed requests.
      await act(async () => { history.resolve(wire({ items: [] })); });
      expect(container.textContent).toContain('只索引本轮指定文档');
      expect(container.textContent).not.toContain('在。想聊什么直接说。');
      expect(streams).toHaveLength(1);
      expect(streams[0].signal.aborted).toBe(false);
      expect(input.disabled).toBe(phase === 'running');
      if (phase !== 'running') expect(container.textContent).toContain('对话运行时还没配置好');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it('still loads stored history and opens the idle stream when no new turn supersedes it', async () => {
    const message: ChatMessage = {
      id: 'stored', turnId: 'old', role: 'user', content: '已保存的历史问题', status: 'completed',
      error: null, errorCode: null, inputTokens: null, outputTokens: null, createdAt: '', completedAt: null,
    };
    service.listChatMessages.mockResolvedValue(wire({ items: [message] }));
    service.streamChatEvents.mockResolvedValue(undefined);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<ChatPage />); });
      expect(container.textContent).toContain('已保存的历史问题');
      expect(service.streamChatEvents).toHaveBeenCalledWith('session', 7, expect.any(Function), expect.any(AbortSignal));
      expect(service.sendChatMessage).not.toHaveBeenCalled();
    } finally { await act(async () => { root.unmount(); }); }
  });
});
