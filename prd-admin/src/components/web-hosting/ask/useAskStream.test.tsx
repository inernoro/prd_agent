// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useAskStream } from './useAskStream';

vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: null }) } }));
vi.mock('@/services/api', () => ({ api: { webPages: { askStream: () => '/ask', askStreamByShare: () => '/ask' } } }));
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
