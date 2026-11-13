import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChatSession, deleteChatSession, listChatMessages, listChatSessions,
  renameChatSession, sendChatMessage,
} from '../chatAgentService';

const { authState } = vi.hoisted(() => ({ authState: {} as Record<string, unknown> }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => authState } }));

// Only replace the transport. chatAgentService and apiRequest both execute for real;
// mocking either service would hide the extra envelope that broke the browser path.
function wire(data: unknown, error: unknown = null, status = 200) {
  return new Response(JSON.stringify({ success: error === null, data, error }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

describe('chatAgentService HTTP envelope contract', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { origin: 'https://preview.example.test', hash: '', pathname: '/chat', href: '/chat' },
    });
    Object.assign(authState, {
      authSessionEpoch: 1, isAuthenticated: true, user: { userId: 'user' },
      token: 'test-session-token', logout: vi.fn(),
    });
  });
  afterEach(() => {
    for (const key of Object.keys(authState)) delete authState[key];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps item/items/accepted at the first data level through real apiRequest', async () => {
    const session = { id: 'session', title: '测试会话' };
    const accepted = { turnId: 'turn', userMessageId: 'user-message', assistantMessageId: 'assistant-message', seq: 3 };
    const fetch = vi.fn()
      .mockResolvedValueOnce(wire({ items: [session] }))
      .mockResolvedValueOnce(wire({ item: session }))
      .mockResolvedValueOnce(wire({ item: { ...session, title: '重命名' } }))
      .mockResolvedValueOnce(wire({ items: [] }))
      .mockResolvedValueOnce(wire(accepted))
      .mockResolvedValueOnce(wire({ deleted: true }));
    vi.stubGlobal('fetch', fetch);

    expect((await listChatSessions()).data?.items[0].id).toBe('session');
    const created = await createChatSession('测试会话');
    expect(created.success).toBe(true);
    expect(created.error).toBeNull();
    expect(created.data?.item.id).toBe('session');
    expect(created.data).not.toHaveProperty('success');
    expect((await renameChatSession('session', '重命名')).data?.item.title).toBe('重命名');
    expect((await listChatMessages('session')).data?.items).toEqual([]);
    expect((await sendChatMessage('session', '请索引指定文档')).data).toEqual(accepted);
    expect((await deleteChatSession('session')).data?.deleted).toBe(true);

    const [url, options] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/chat-agent/sessions');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ title: '测试会话', model: null });
  });

  it.each([
    [404, 'SESSION_NOT_FOUND', '会话不存在', '当前会话不存在或已失效，请返回后重新打开。'],
    [400, 'CHAT_MESSAGE_REJECTED', '这一轮尚未结束', '操作未完成，请检查输入后重试。'],
  ] as const)('preserves structured HTTP %s failures instead of double wrapping', async (status, code, message, expectedUserMessage) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wire(null, { code, message }, status)));
    const response = await sendChatMessage('session', '测试消息');
    expect(response.success).toBe(false);
    expect(response.data).toBeNull();
    expect(response.error?.code).toBe(code);
    expect(response.error?.message).toBe(expectedUserMessage);
  });

  it('exposes why the old anonymous response cannot serve as a contract fixture', async () => {
    const oldWire = { success: true, data: { item: { id: 'session' } } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(oldWire), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const response = await createChatSession();
    // apiClient intentionally accepts plain objects. A controller omitting error is
    // treated as such an object and wrapped a second time, leaving item undefined.
    expect(response.data?.item).toBeUndefined();
    expect(response.data).toEqual(oldWire);
  });
});
