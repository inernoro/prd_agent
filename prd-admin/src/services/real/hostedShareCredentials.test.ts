import { afterEach, expect, it, vi } from 'vitest';
import { apiDownload, apiRequest } from './apiClient';
import { viewShare, getShareSiteContent, listShareComments, addShareComment, setSiteCommentResolved, downloadHostedPdf, downloadShareOfflineHtml } from './webPages';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn(), apiDownload: vi.fn() }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: null }) } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('exchanges the synthetic password once in POST and never puts it in access URLs or subsequent payloads', async () => {
  const marker = 'KD13-synthetic-marker';
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true, data: {}, error: null })));
  vi.stubGlobal('fetch', fetcher);
  await viewShare('token', marker);
  await getShareSiteContent('token', 'site', marker);
  await listShareComments('token', marker, 'site');
  await addShareComment('token', 'comment', marker);
  await setSiteCommentResolved({ token: 'token', password: marker }, 'comment', true);
  await downloadHostedPdf('site', 'fixture.pdf', { token: 'token', password: marker });
  await downloadShareOfflineHtml('token', 'site', marker, 'fixture.html');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ password: marker }) });
  for (const [url] of fetcher.mock.calls) expect(String(url)).not.toContain(marker);
  for (const [, options] of fetcher.mock.calls.slice(1)) expect(JSON.stringify(options)).not.toContain(marker);
  for (const call of [...vi.mocked(apiRequest).mock.calls, ...vi.mocked(apiDownload).mock.calls])
    expect(JSON.stringify(call)).not.toContain(marker);
});
