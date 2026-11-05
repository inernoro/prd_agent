// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listHostedReviewVersions, previewHostedReviewVersion, listShareComments } from './webPages';
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: null }) } }));
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockResolvedValue({ json: async () => ({ success: true, data: [] }) }); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const source = { mode: 'share' as const, token: 'collection', siteId: 'document-b', password: 'a&b' };
function requestedUrl() { return new URL(fetchMock.mock.calls[0][0], 'https://example.test'); }
describe('分享合集内的文档范围', () => {
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
