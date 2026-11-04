// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/services/real/apiClient';
vi.mock('@/services/real/apiClient', () => ({ apiRequest: vi.fn() }));
import { useAskStream } from './useAskStream';

vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: null }) } }));
vi.mock('@/services/api', () => ({ api: { webPages: { askRating: (id: string) => `/rating/${id}`, askStream: () => '/ask', askStreamByShare: () => '/ask' } } }));
vi.mock('@/services/real/webPages', () => ({ buildApiUrl: (path: string) => path }));

describe('问答完成事件', () => {
  it.each([true, false])('服务端最终脚注替换临时内容，兼容旧事件：%s', async (hasFinalText) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const finalText = '结论[^1]。\n\n[^1]: 原文内容。';
    const frames = [
      'event: typing\ndata: {"text":"临时结论[引用:1]"}\n\n',
      `event: done\ndata: ${JSON.stringify(hasFinalText ? { text: finalText } : {})}\n\n`,
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(frames.join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    let hook: ReturnType<typeof useAskStream>;
    function Harness() {
      hook = useAskStream({ mode: 'site', siteId: 'site' });
      return <div>{hook.messages.at(-1)?.content}</div>;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<Harness />));
      await act(async () => { await hook.ask('问题'); });
      expect(container.textContent).toBe(hasFinalText ? finalText : '临时结论[引用:1]');
      expect(hook!.status).toBe('done');
      expect(hook!.messages.at(-1)?.streaming).toBe(false);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});

it('成功 done 的回执用于真实评分，失败不修改分值；回执不会混入下一轮历史', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetcher = vi.fn().mockImplementation(async () => new Response('event: done\ndata: {"text":"答案", "messageId":"db-id", "ratingToken":"private-receipt"}\n\n'));
  vi.stubGlobal('fetch', fetcher);
  let hook: ReturnType<typeof useAskStream>;
  function Harness() { hook = useAskStream({ mode: 'site', siteId: 'site' }); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    act(() => root.render(<Harness />));
    await act(async () => { await hook.ask('问题'); });
    const id = hook!.messages.at(-1)!.id;
    vi.mocked(apiRequest).mockResolvedValueOnce({ success: false, data: null, error: { code: 'FAIL', message: '未保存' } });
    await act(async () => { await expect(hook.rate(id, 4)).rejects.toThrow('未保存'); });
    expect(hook!.messages.at(-1)?.rating).toBeUndefined();
    vi.mocked(apiRequest).mockResolvedValueOnce({ success: true, data: { rating: 4 }, error: null });
    await act(async () => { await hook.rate(id, 4); });
    expect(apiRequest).toHaveBeenCalledWith('/rating/db-id', expect.objectContaining({ method: 'PUT', auth: false, body: { rating: 4, token: 'private-receipt' } }));
    expect(hook!.messages.at(-1)?.rating).toBe(4);
    await act(async () => { await hook.ask('续问'); });
    expect(fetcher.mock.calls.at(-1)?.[1].body).not.toContain('private-receipt');
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});

it.each(['site', 'share'] as const)('大量原文引用下连续追问保持正文、重新引用且请求不超过 64 KiB：%s', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const finalText = '当前答案[^1]。' + Array.from({ length: 30 }, (_, i) => `\n\n[^${i + 1}]: ${'原'.repeat(800)}`).join('');
  const fetcher = vi.fn().mockImplementation(async () => new Response(`event: done\ndata: ${JSON.stringify({ text: finalText })}\n\n`));
  vi.stubGlobal('fetch', fetcher);
  let hook: ReturnType<typeof useAskStream>;
  function Harness() { hook = useAskStream(mode === 'site' ? { mode, siteId: 'site' } : { mode, token: 'share' }); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    act(() => root.render(<Harness />));
    for (let i = 0; i < 12; i++) await act(async () => { await hook.ask('继续解释'.repeat(100)); });
    for (const [, options] of fetcher.mock.calls) {
      expect(new TextEncoder().encode(options.body).byteLength).toBeLessThan(64 * 1024);
      const { history } = JSON.parse(options.body);
      expect(history.length).toBeLessThanOrEqual(8);
      expect(history.reduce((sum: number, item: { content: string }) => sum + item.content.length, 0)).toBeLessThanOrEqual(6000);
      for (const item of history.filter((h: { role: string }) => h.role === 'assistant')) expect(item.content).toBe('当前答案。');
    }
    expect(hook!.messages.filter(message => message.role === 'assistant')).toHaveLength(12);
    expect(hook!.messages.at(-1)?.content).toBe(finalText);
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
