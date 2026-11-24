// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listHostedReviewVersions, previewHostedReviewVersion, listShareComments, setSiteCommentResolved } from './webPages';
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: 'session' }) } }));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: [], error: null }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const source = { mode: 'share' as const, token: 'collection', siteId: 'document-b', password: 'a&b' };
function requestedUrl() { return new URL(fetchMock.mock.calls[0][0], 'https://example.test'); }
describe('分享合集内的文档范围', () => {
  it.each([true, false])('讨论状态变更携带当前文档和密码，resolved=%s', async resolved => {
    await setSiteCommentResolved(source, 'thread-b', resolved);
    expect(requestedUrl().pathname).toBe('/api/web-pages/shares/view/collection/comments/thread-b/resolved');
    expect(requestedUrl().searchParams.get('siteId')).toBe('document-b');
    expect(requestedUrl().searchParams.get('password')).toBe('a&b');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ resolved });
  });
  it('旧单页和直接文档的讨论状态接口保持兼容', async () => {
    await setSiteCommentResolved({ token: 'single' }, 'thread', true);
    expect(requestedUrl().search).toBe('');
    fetchMock.mockClear();
    await setSiteCommentResolved({ siteId: 'document-b' }, 'thread', false);
    expect(requestedUrl().pathname).toBe('/api/web-pages/document-b/comments/thread/resolved');
    expect(requestedUrl().search).toBe('');
  });
  it('版本列表携带当前文档，保留分享密码边界', async () => {
    await listHostedReviewVersions(source);
    expect(requestedUrl().searchParams.get('siteId')).toBe('document-b');
    expect(requestedUrl().searchParams.get('password')).toBe('a&b');
  });
  it('历史预览不会丢失所选文档范围', async () => {
    await previewHostedReviewVersion(source, 'revision-b');
    expect(requestedUrl().pathname).toContain('/revisions/revision-b/preview');
    expect(requestedUrl().searchParams.get('siteId')).toBe('document-b');
  });
  it('评论读取按当前文档过滤，旧单页调用仍不指定目标', async () => {
    await listShareComments('collection', undefined, 'document-b');
    expect(requestedUrl().searchParams.get('siteId')).toBe('document-b');
    fetchMock.mockClear();
    await listShareComments('single');
    expect(requestedUrl().searchParams.has('siteId')).toBe(false);
  });
});
