// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSession, ChatStreamEvent, ChatTurnAccepted } from '@/services/real/chatAgentService';
import type { ApiResponse } from '@/types/api';
import { ChatPage } from './ChatPage';

const service = vi.hoisted(() => ({
  listChatSessions: vi.fn(), createChatSession: vi.fn(), renameChatSession: vi.fn(),
  deleteChatSession: vi.fn(), listChatMessages: vi.fn(), sendChatMessage: vi.fn(), streamChatEvents: vi.fn(),
}));
vi.mock('@/services/real/chatAgentService', () => service);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session: ChatSession = {
  id: 'session', title: '本轮合成会话', model: null, effectiveModel: 'default', running: false,
  eventSeq: 7, runningTurnStartSeq: null, createdAt: '', updatedAt: '',
};
function wire<T>(data: T): ApiResponse<T> { return { success: true, data, error: null }; }

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

  it.each(['before-acceptance', 'running', 'runtime-error'] as const)('blocks sending until nonempty history is visible, then preserves history and the new stream: %s', async (phase) => {
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
      expect(input.disabled).toBe(true);
      expect(container.querySelector('[role="status"]')?.textContent).toContain('正在加载历史消息');
      expect(container.querySelector('.chat-dots')).not.toBeNull();
      await act(async () => { enterText(input, '只索引本轮指定文档'); });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        (container.querySelector('[aria-label="发送"]') as HTMLButtonElement).click();
      });
      expect(service.sendChatMessage).not.toHaveBeenCalled();
      expect(streams).toHaveLength(0);
      const stored: ChatMessage[] = [
        { id: 'old-user', turnId: 'old', role: 'user', content: '先前的完整问题', status: 'completed',
          error: null, errorCode: null, inputTokens: null, outputTokens: null, createdAt: '', completedAt: null },
        { id: 'old-assistant', turnId: 'old', role: 'assistant', content: '先前的完整回答', status: 'completed',
          error: null, errorCode: null, inputTokens: null, outputTokens: null, createdAt: '', completedAt: null },
      ];
      await act(async () => { history.resolve(wire({ items: stored })); });
      expect(container.textContent).toContain('先前的完整问题');
      expect(container.textContent).toContain('先前的完整回答');
      expect(input.disabled).toBe(false);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(streams).toHaveLength(1);
      const historyStream = streams[0];
      await act(async () => { (container.querySelector('[aria-label="发送"]') as HTMLButtonElement).click(); });
      expect(service.sendChatMessage).toHaveBeenCalledOnce();
      expect(container.textContent).toContain('只索引本轮指定文档');
      if (phase === 'before-acceptance') {
        expect(streams).toHaveLength(1);
        await act(async () => { acceptance.resolve(wire({ turnId: 'turn', userMessageId: 'u', assistantMessageId: 'a', seq: 8 })); });
      }
      expect(streams).toHaveLength(2);
      expect(historyStream.signal.aborted).toBe(true);
      expect(streams[1].afterSeq).toBe(8);
      if (phase !== 'running') {
        await act(async () => { streams[1].emit({ seq: 9, type: 'error', payload: {
          code: 'sidecar_not_configured', message: '对话运行时还没配置好，管理员需要先启用它。',
        } }); });
        expect(container.textContent).toContain('对话运行时还没配置好');
      }
      expect(container.textContent).toContain('先前的完整问题');
      expect(container.textContent).toContain('先前的完整回答');
      expect(container.textContent).toContain('只索引本轮指定文档');
      expect(container.textContent).not.toContain('在。想聊什么直接说。');
      expect(streams).toHaveLength(2);
      expect(streams[1].signal.aborted).toBe(false);
      expect(input.disabled).toBe(phase === 'running');
      if (phase !== 'running') expect(container.textContent).toContain('对话运行时还没配置好');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });

  it.each(['response', 'transport'] as const)('ends history loading after a %s failure without permanently disabling sending', async (failure) => {
    const history = deferred<ReturnType<typeof wire<{ items: ChatMessage[] }>>>();
    service.listChatMessages.mockReturnValue(history.promise);
    service.streamChatEvents.mockResolvedValue(undefined);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<ChatPage />); });
      const input = container.querySelector('textarea')!;
      expect(input.disabled).toBe(true);
      await act(async () => {
        if (failure === 'transport') history.reject(new Error('connection lost'));
        else history.resolve({ success: false, data: null, error: { code: 'LOAD_FAILED', message: '历史读取失败' } });
      });
      expect(input.disabled).toBe(false);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.textContent).toContain(failure === 'transport' ? '消息加载失败' : '历史读取失败');
      await act(async () => { enterText(input, '加载失败后明确发送'); });
      await act(async () => { (container.querySelector('[aria-label="发送"]') as HTMLButtonElement).click(); });
      expect(service.sendChatMessage).toHaveBeenCalledOnce();
    } finally { await act(async () => { root.unmount(); }); }
  });

  it('keeps loading owned by the selected session when an older session history arrives late', async () => {
    const oldHistory = deferred<ReturnType<typeof wire<{ items: ChatMessage[] }>>>();
    const selectedHistory = deferred<ReturnType<typeof wire<{ items: ChatMessage[] }>>>();
    service.listChatSessions.mockResolvedValue(wire({ items: [session, { ...session, id: 'selected', title: '切换后的会话', eventSeq: 12 }] }));
    service.listChatMessages.mockImplementation((id) => id === 'session' ? oldHistory.promise : selectedHistory.promise);
    service.streamChatEvents.mockResolvedValue(undefined);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<ChatPage />); });
      await act(async () => { (container.querySelectorAll('.chat-session')[1] as HTMLElement).click(); });
      const input = container.querySelector('textarea')!;
      expect(input.disabled).toBe(true);
      await act(async () => { oldHistory.resolve(wire({ items: [] })); });
      expect(input.disabled).toBe(true);
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(service.streamChatEvents).not.toHaveBeenCalled();
      const selected: ChatMessage = {
        id: 'selected-history', turnId: 'old', role: 'user', content: '当前会话的历史问题', status: 'completed',
        error: null, errorCode: null, inputTokens: null, outputTokens: null, createdAt: '', completedAt: null,
      };
      await act(async () => { selectedHistory.resolve(wire({ items: [selected] })); });
      expect(input.disabled).toBe(false);
      expect(container.textContent).toContain('当前会话的历史问题');
      expect(service.streamChatEvents).toHaveBeenCalledOnce();
      expect(service.streamChatEvents).toHaveBeenCalledWith('selected', 12, expect.any(Function), expect.any(AbortSignal));
    } finally { await act(async () => { root.unmount(); }); }
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
