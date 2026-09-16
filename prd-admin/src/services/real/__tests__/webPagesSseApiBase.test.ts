import { afterEach, describe, expect, it, vi } from 'vitest';

import { streamDesignArtifactRun, streamHostedSiteEditRun } from '../webPages';

const { authState } = vi.hoisted(() => ({
  authState: { token: 'test-token' } as { token?: string },
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => authState },
}));

function sseResponse(event: string, payload: Record<string, unknown>): Response {
  return new Response(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * SSE 走的是 connectSse 里的裸 fetch，绕开了 apiRequest，所以 API 基址得调用方自己拼。
 * 不拼的后果不是报错而是说谎：前后端分开部署时相对路径打到前端自己身上，拿回一坨 HTML，
 * 前端立刻显示「进度连接中断」，而服务端那边任务照跑——用户看到一次并不存在的失败。
 */
describe('网页托管 SSE 的 API 基址', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('生成进度流打到配置的 API 源', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/platform/');
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('done', {}));
    vi.stubGlobal('fetch', fetchMock);

    await streamDesignArtifactRun({
      runId: 'run-1',
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/platform/api/design-artifacts/runs/run-1/stream',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('修改进度流打到配置的 API 源，并带上续传游标', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/platform/');
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('done', {}));
    vi.stubGlobal('fetch', fetchMock);

    await streamHostedSiteEditRun({
      siteId: 'site-1',
      runId: 'run-2',
      afterSeq: 7,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/platform/api/web-pages/site-1/edits/runs/run-2/stream?afterSeq=7',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('不配 API 基址时仍是同源相对路径', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('done', {}));
    vi.stubGlobal('fetch', fetchMock);

    await streamDesignArtifactRun({
      runId: 'run-3',
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/design-artifacts/runs/run-3/stream',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
