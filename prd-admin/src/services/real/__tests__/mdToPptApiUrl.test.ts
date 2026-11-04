// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  streamMdToPptConvert,
  streamMdToPptOutline,
  streamMdToPptPatch,
  retainMdToPptManualSaveIntent,
  type MdToPptManualSaveIntent,
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

  it('sends visual override only for the explicit style intent, never from the global theme', async () => {
    const context = { sourceRunId: 'd2', sourcePackageHash: 'package', baseSiteId: 'site', baseRevisionId: 'd2',
      basePublishedRevisionId: 'online', baseContentVersion: 'version', baseHtmlHash: 'entry', baseFilesFingerprint: 'files' };
    for (const mode of ['ordinary', 'manual', 'style']) {
      const done = vi.fn();
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(sseResponse('done', { html: '<html>done</html>' })));
      vi.stubGlobal('fetch', fetchMock);
      streamMdToPptPatch({ parentRunId: 'd2', currentHtml: '<html>original</html>', expectedEditContext: context,
        slideRequest: '修改', theme: 'editorial-ink', manualEditHtml: mode === 'manual' ? '<html>proposal</html>' : undefined,
        styleOverride: mode === 'style', onDone: done });
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body.theme).toBe('editorial-ink');
      expect(body.styleOverride).toBe(mode === 'style' ? true : undefined);
    }
  });

  it('recovers the admitted manual save after a lost stream when the user clicks save again', async () => {
    const context = {
      sourceRunId: 'parent-draft', sourcePackageHash: 'package', baseSiteId: 'site', baseRevisionId: 'draft-d3',
      basePublishedRevisionId: 'restored', baseContentVersion: '2026-10-28T14:00:00Z',
      baseHtmlHash: 'entry', baseFilesFingerprint: 'files',
    };
    const request = {
      parentRunId: 'parent-draft', currentHtml: '<html><body>原稿</body></html>',
      manualEditHtml: '<html><body>交接有据可查</body></html>', slideRequest: '保存手动编辑', theme: 'editorial',
    };
    const posts: Array<Record<string, unknown>> = [];
    let acceptedKey: unknown;
    let admissions = 0;
    let reads = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        reads++;
        return new Response(JSON.stringify({ id: request.parentRunId, editContext: context }), { status: 200 });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      if (acceptedKey == null) {
        acceptedKey = body.idempotencyKey;
        admissions++;
        return sseResponse('run', { runId: 'accepted-manual-run' }); // 接纳后断流，没有 done/error。
      }
      if (body.idempotencyKey !== acceptedKey) {
        return new Response(JSON.stringify({ code: 'ppt_manual_contract_busy', error: '人工保存已由另一操作接管' }), { status: 409 });
      }
      return new Response('event: run\ndata: {"runId":"accepted-manual-run"}\n\nevent: done\ndata: {"html":"<html>已保存</html>","revisionId":"manual-draft"}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const errors = vi.fn();
    const done = vi.fn();
    const runs = vi.fn();
    let pending: MdToPptManualSaveIntent | null = null;
    const userClicksSave = () => {
      pending = retainMdToPptManualSaveIntent(pending, request);
      streamMdToPptPatch({ ...request, manualSaveIntent: pending, onError: errors, onDone: done, onRun: runs });
      return pending;
    };
    const first = userClicksSave();
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('连接意外断开，请重试'));
    expect(first.settled).toBe(false);
    expect(posts).toHaveLength(1); // 没有自动重试。
    const retry = userClicksSave();
    await vi.waitFor(() => expect(errors.mock.calls.length + done.mock.calls.length).toBe(2));
    expect(posts).toHaveLength(2);
    expect(posts[1].idempotencyKey === posts[0].idempotencyKey).toBe(true);
    expect(posts[1]).toEqual(posts[0]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(admissions).toBe(1);
    expect(reads).toBe(1);
    expect(runs.mock.calls).toEqual([['accepted-manual-run'], ['accepted-manual-run']]);
    expect(retry).toBe(first);
    expect(retry.settled).toBe(true);
    expect(retainMdToPptManualSaveIntent(retry, request).idempotencyKey === retry.idempotencyKey).toBe(false);
    expect(posts).toHaveLength(2); // 确定结果后仅释放本地身份，没有第三次发送。
  });
});
