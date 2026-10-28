// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  streamMdToPptConvert,
  streamMdToPptOutline,
  streamMdToPptPatch,
} from '../mdToPptService';

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

describe('md-to-ppt native request URLs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the configured API base path for outline streaming', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/platform/');
    const done = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('done', { pages: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    streamMdToPptOutline({ content: '季度总结', onDone: done });

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/platform/api/md-to-ppt/outline-stream',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses the configured API base path for outline confirmation and conversion', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/platform/');
    const done = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(sseResponse('done', { html: '<html></html>' }));
    vi.stubGlobal('fetch', fetchMock);

    streamMdToPptConvert({
      content: '季度总结',
      parentOutlineRunId: 'outline/run 1',
      outlinePages: [{ title: '封面', bullets: [] }],
      onDone: done,
    });

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/platform/api/md-to-ppt/outline/outline%2Frun%201/confirm',
      'https://api.example.test/platform/api/md-to-ppt/convert',
    ]);
  });

  it('uses the configured API base path for patch streaming', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/platform/');
    const done = vi.fn();
    const expectedEditContext = {
      sourceRunId: 'run-1', sourcePackageHash: 'source-package', baseSiteId: 'site',
      baseRevisionId: 'restored', basePublishedRevisionId: 'restored',
      baseContentVersion: '2026-10-24T14:14:51.421Z', baseHtmlHash: 'entry-hash', baseFilesFingerprint: 'files-hash',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'run-1', html: '<html>never silently substitute this newer body</html>', editContext: expectedEditContext,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(sseResponse('done', { html: '<html></html>' }));
    vi.stubGlobal('fetch', fetchMock);

    streamMdToPptPatch({
      parentRunId: 'run-1',
      currentHtml: '<html></html>',
      manualEditHtml: '<html><body>用户草稿</body></html>',
      slideRequest: '强化标题',
      onDone: done,
    });

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/platform/api/md-to-ppt/patch',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/platform/api/md-to-ppt/runs/run-1',
      'https://api.example.test/platform/api/md-to-ppt/patch',
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).toMatchObject({
      expectedEditContext,
      parentRunId: 'run-1',
      currentHtml: '<html></html>',
      manualEditHtml: '<html><body>用户草稿</body></html>',
      slideRequest: '强化标题',
    });
    expect(body.idempotencyKey.replaceAll('-', '')).toMatch(/^[a-f0-9]{32}$/i);
  });

  it('does not submit when the current source has no safe continuation context', async () => {
    const error = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'run-1', editContextError: '当前恢复关系无法验证，原稿保留',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    streamMdToPptPatch({ parentRunId: 'run-1', currentHtml: '<html></html>', slideRequest: '改标题', onError: error });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('当前恢复关系无法验证，原稿保留'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).not.toBe('POST');
  });
});
