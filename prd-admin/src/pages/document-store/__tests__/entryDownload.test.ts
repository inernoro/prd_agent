import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildEntryDownload } from '../entryDownload';

const { authState } = vi.hoisted(() => ({ authState: {} as Record<string, unknown> }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => authState } }));

const entry = { id: 'entry-local', title: '已重命名标题', attachmentId: 'attachment-local' };
const cdnUrl = 'https://cdn.example.test/local-source.docx';
const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const parsed = '这是已解析正文，不是上传原件';
const makeName = (title: string, extension: string) => title + extension;

function contentResponse(contentType: string, fileUrl: string | null = cdnUrl, content = parsed) {
  return new Response(JSON.stringify({ success: true, data: { contentType, fileUrl, content }, error: null }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function originalResponse(bytes: Uint8Array, fileName: string, contentType: string) {
  return new Response(bytes.slice().buffer, { headers: {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="source"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  } });
}

function routeFetch(content: Response, original: Response | Error) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === '/api/document-store/entries/entry-local/content') return content;
    if (input === '/api/document-store/entries/entry-local/download') {
      if (original instanceof Error) throw original;
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer local-test-token' }));
      return original;
    }
    throw new TypeError('模拟原CDN不允许浏览器跨域取原件');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('实际条目下载：上传原件与正文导出不混淆', () => {
  beforeEach(() => {
    Object.assign(authState, { token: 'local-test-token' });
    vi.stubEnv('VITE_API_BASE_URL', '');
    vi.stubGlobal('window', { location: { origin: 'https://admin.example.test', pathname: '/document-store', hash: '' } });
  });
  afterEach(() => {
    for (const key of Object.keys(authState)) delete authState[key];
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  });

  it('TXT 41B走鉴权原件端点，保持UTF-8原名和原字节，不加.md或采用解析正文', async () => {
    const bytes = new TextEncoder().encode('a'.repeat(39) + '\r\n');
    const fetchMock = routeFetch(contentResponse('text/plain'), originalResponse(bytes, '原文件-中文.txt', 'text/plain'));
    const file = await buildEntryDownload(entry, 'original', makeName);
    expect(file?.name).toBe('原文件-中文.txt');
    expect(file?.data).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (file!.data as Blob).arrayBuffer())).toEqual(bytes);
    expect((file!.data as Blob).size).toBe(41);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/document-store/entries/entry-local/content', '/api/document-store/entries/entry-local/download',
    ]);
  });

  it('DOCX二进制1210B与原名保持，不访问CORS CDN或保存解析正文', async () => {
    // 仅测试下载字节保真，不把此二进制样本当真实Word解析验收。
    const bytes = new Uint8Array(1210); bytes.set([0x50, 0x4b, 3, 4, 17]);
    const fetchMock = routeFetch(contentResponse(docxType), originalResponse(bytes, '原件-中文.docx', docxType));
    const file = await buildEntryDownload(entry, 'original', makeName);
    expect(file?.name).toBe('原件-中文.docx');
    expect(new Uint8Array(await (file!.data as Blob).arrayBuffer())).toEqual(bytes);
    expect((file!.data as Blob).type).toBe(docxType);
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('https://'))).toBe(false);
  });

  it('原文件名按现有basename长度限制安全化时仍保留扩展名', async () => {
    routeFetch(contentResponse(docxType), originalResponse(new Uint8Array([1, 2]), '文'.repeat(130) + '.docx', docxType));
    const safeName = (title: string, extension: string) => title.slice(0, 120) + extension;
    expect((await buildEntryDownload(entry, 'original', safeName))?.name).toBe('文'.repeat(120) + '.docx');
  });

  it.each([403, 404, 503])('原件端点%s失败即拒绝，不用非空正文冒充原件', async status => {
    const response = new Response(JSON.stringify({ success: false, data: null, error: { code: 'ASSET_NOT_FOUND', message: '原始文件已不可用，请重新上传该文件后再下载' } }), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = routeFetch(contentResponse(docxType), response);
    await expect(buildEntryDownload(entry, 'original', makeName)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('原件网络失败明确失败，不返回解析正文或静默另试CDN', async () => {
    const fetchMock = routeFetch(contentResponse(docxType), new TypeError('local network failure'));
    await expect(buildEntryDownload(entry, 'original', makeName)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('200 HTML错误页没有附件响应契约，也不能当原件下载', async () => {
    routeFetch(contentResponse(docxType), new Response('<html>not an attachment</html>', { headers: { 'Content-Type': 'text/html' } }));
    await expect(buildEntryDownload(entry, 'original', makeName)).rejects.toThrow();
  });

  it('附件身份仍在但fileUrl缺失也用原件端点，不退正文', async () => {
    const bytes = new TextEncoder().encode('own original');
    routeFetch(contentResponse('text/plain', null), originalResponse(bytes, '本地.txt', 'text/plain'));
    expect((await buildEntryDownload(entry, 'original', makeName))?.name).toBe('本地.txt');
  });

  it('无附件/地址的二进制条目不得输出解析正文作为原件', async () => {
    routeFetch(contentResponse(docxType, null), new Error('不应请求无附件原件'));
    await expect(buildEntryDownload({ id: entry.id, title: 'legacy' }, 'original', makeName)).rejects.toThrow();
  });

  it('在线原生text/plain没有附件时按.txt导出正文', async () => {
    const fetchMock = routeFetch(contentResponse('text/plain', null), new Error('不应请求附件'));
    expect(await buildEntryDownload({ id: entry.id, title: '在线文档' }, 'original', makeName)).toEqual({ name: '在线文档.txt', data: parsed });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('显式选择Markdown或纯文本才导出正文，保持既有格式行为', async () => {
    const fetchMock = routeFetch(contentResponse(docxType, cdnUrl, '# 标题'), new Error('正文导出不取原件'));
    expect(await buildEntryDownload(entry, 'markdown', makeName)).toEqual({ name: '已重命名标题.md', data: '# 标题' });
    fetchMock.mockImplementationOnce(async () => contentResponse(docxType, cdnUrl, '# 标题'));
    expect(await buildEntryDownload(entry, 'text', makeName)).toEqual({ name: '已重命名标题.txt', data: '标题' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('页面单篇与ZIP均接同一被测导出入口，原件失败和部分失败有可见提示', () => {
    // 接线守卫，不把源码断言当真实UI验收；移除实际入口必须红。
    const source = readFileSync(new URL('../DocumentStorePage.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/import\s*\{\s*buildEntryDownload,\s*ORIGINAL_DOWNLOAD_FAILURE_MESSAGE\s*\}\s*from '\.\/entryDownload'/);
    expect(source.match(/await buildEntryDownload\(/g)).toHaveLength(2);
    expect(source.match(/format === 'original' \? ORIGINAL_DOWNLOAD_FAILURE_MESSAGE/g)).toHaveLength(3);
    expect(source).toContain("toast.warning('部分原件未下载'");
  });
});
