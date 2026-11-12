// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/services/real/apiClient';
vi.mock('@/services/real/apiClient', () => ({ apiRequest: vi.fn() }));
import { useAskStream } from './useAskStream';
import AskThread from './AskThread';

vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: null }) } }));
vi.mock('@/services/api', () => ({ api: { webPages: { askRating: (id: string) => `/rating/${id}`, askStream: () => '/ask', askStreamByShare: () => '/ask' } } }));
vi.mock('@/services/real/webPages', () => ({ buildApiUrl: (path: string) => path }));

describe('故障后可继续提问', () => {
  it.each(['site', 'share'] as const)('错误事件、半截断流和网络错误均停止等待，并可继续完成：%s', async (mode) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let clock = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
    const response = (frames: string) => new Response(frames, { headers: { 'Content-Type': 'text/event-stream' } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response('event: error\ndata: {"code":"MODEL_POOL_ALL_UNAVAILABLE","message":"模型暂时不可用，请稍后再试。"}\n\n'))
      .mockResolvedValueOnce(response('event: typing\ndata: {"text":"已经收到的半截答案"}\n\n'))
      .mockRejectedValueOnce(new Error('网络连接失败，请稍后重试。'))
      .mockResolvedValueOnce(response('event: done\ndata: {"text":"恢复后的完整答案"}\n\n'));
    vi.stubGlobal('fetch', fetcher);
    let hook: ReturnType<typeof useAskStream>;
    function Harness() {
      hook = useAskStream(mode === 'site' ? { mode, siteId: 'site' } : { mode, token: 'share' });
      return <AskThread messages={hook.messages} title="测试页面" openingQuestions={[]}
        onPick={(question) => { void hook.ask(question); }} refusal={null} onLogin={() => {}}
        onRetry={() => { void hook.ask('继续提问'); }} isBusy={hook.isBusy}
        phaseMessage={hook.phaseMessage} elapsedSeconds={hook.elapsedSeconds} onCancel={hook.cancel} />;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<Harness />));
      for (const [question, expected] of [
        ['第一次提问', '模型暂时不可用，请稍后再试。'],
        ['断流提问', '回答被中断，内容可能不完整，可以再问一次。'],
        ['网络错误提问', '网络连接失败，请稍后重试。'],
      ]) {
        await act(async () => { await hook.ask(question); });
        expect(hook!.status).toBe('error');
        expect(hook!.isBusy).toBe(false);
        expect(hook!.messages.at(-1)?.streaming).toBe(false);
        expect(hook!.messages.at(-1)?.error).toBe(expected);
        expect(container.textContent).toContain(expected);
        expect(container.querySelector('[role="status"]')).toBeNull();
        expect(container.querySelector('.ask-answer-footer')).toBeNull();
      }
      expect(container.textContent).toContain('已经收到的半截答案');
      await act(async () => { await hook.ask('再次提问'); });
      expect(hook!.status).toBe('done');
      expect(hook!.isBusy).toBe(false);
      expect(hook!.messages.at(-1)?.error).toBeUndefined();
      expect(container.textContent).toContain('恢复后的完整答案');
      expect(container.querySelector('.ask-answer-footer')?.textContent).toContain('回答完成');
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(hook!.messages.filter(message => message.role === 'assistant')).toHaveLength(4);
    } finally {
      act(() => root.unmount()); now.mockRestore(); vi.unstubAllGlobals();
    }
  });
});

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

it('选库清空旧上下文，引用事件与完成文本进入同一条回答，分享请求不携带知识库', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const references = [{ entryId: 'entry', title: '原文', url: '/document-store?store=store&entry=entry', hash: 'hash' }];
  const fetcher = vi.fn().mockImplementation(async () => new Response(
    `event: reference\ndata: ${JSON.stringify({ references })}\n\nevent: done\ndata: {"text":"可核查的原文"}\n\n`));
  vi.stubGlobal('fetch', fetcher);
  let hook: ReturnType<typeof useAskStream>;
  function Harness() { hook = useAskStream({ mode: 'site', siteId: 'site' }); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    act(() => root.render(<Harness />));
    await act(async () => { await hook.ask('网页问题'); });
    act(() => hook.setKnowledgeStoreId('store'));
    expect(hook!.messages).toHaveLength(0);
    await act(async () => { await hook.ask('知识库问题'); });
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.knowledgeStoreId).toBe('store');
    expect(body.history).toEqual([]);
    expect(hook!.messages.at(-1)?.references).toEqual(references);
    expect(hook!.messages.at(-1)?.content).toBe('可核查的原文');
    act(() => hook.setKnowledgeStoreId(''));
    expect(hook!.messages).toHaveLength(0);
    await act(async () => { await hook.ask('回到网页'); });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).history).toEqual([]);
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
