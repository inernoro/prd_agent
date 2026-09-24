import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/real/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/real/apiClient')>()),
  apiRequest: vi.fn(),
  apiDownload: vi.fn(),
}));

import { apiDownload, apiRequest } from '@/services/real/apiClient';
import {
  designSystemSamplePath,
  designSystemSampleUrl,
  listDesignSystems,
  loadDesignSystemSample,
  resetDesignSystemSampleCache,
} from './designSystems';

const mockedDownload = vi.mocked(apiDownload);
const mockedRequest = vi.mocked(apiRequest);

function htmlFile(html: string) {
  return { blob: new Blob([html], { type: 'text/html' }), fileName: 'sample.html', contentType: 'text/html' };
}

describe('样张地址：唯一拼接口径', () => {
  it('编号与标题都做 URL 编码，默认格式 page 不带参数', () => {
    expect(designSystemSamplePath('editorial')).toBe('/api/design-artifacts/design-systems/editorial/sample');
    expect(designSystemSamplePath('a/b?c', { title: '  码安全 & <性能>  ' }))
      .toBe('/api/design-artifacts/design-systems/a%2Fb%3Fc/sample?title=%E7%A0%81%E5%AE%89%E5%85%A8+%26+%3C%E6%80%A7%E8%83%BD%3E');
    expect(designSystemSamplePath('kami', { title: '   ', format: 'page' })).toBe('/api/design-artifacts/design-systems/kami/sample');
    expect(designSystemSamplePath('kami', { format: 'slides' })).toBe('/api/design-artifacts/design-systems/kami/sample?format=slides');
  });

  it('完整地址与 buildApiUrl 同一套基址：分开部署时指向后端域', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/');
    try {
      expect(designSystemSampleUrl('editorial', { title: '标题' }))
        .toBe('https://api.example.test/api/design-artifacts/design-systems/editorial/sample?title=%E6%A0%87%E9%A2%98');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(designSystemSampleUrl('editorial')).toBe('/api/design-artifacts/design-systems/editorial/sample');
  });
});

describe('风格目录与样张的取数', () => {
  beforeEach(() => {
    resetDesignSystemSampleCache();
    mockedDownload.mockReset();
    mockedRequest.mockReset();
  });
  afterEach(() => resetDesignSystemSampleCache());

  it('目录走 apiRequest 的 GET，路径不带多余参数', async () => {
    mockedRequest.mockResolvedValue({ success: true, data: { count: 0 } } as never);
    await listDesignSystems();
    expect(mockedRequest).toHaveBeenCalledWith('/api/design-artifacts/design-systems');
  });

  it('样张走带鉴权的 apiDownload，同一地址并发只取一次', async () => {
    mockedDownload.mockResolvedValue(htmlFile('<!doctype html><title>x</title>'));
    const [a, b] = await Promise.all([
      loadDesignSystemSample('editorial', { title: '标题' }),
      loadDesignSystemSample('editorial', { title: '标题' }),
    ]);
    expect(a).toBe('<!doctype html><title>x</title>');
    expect(b).toBe(a);
    expect(mockedDownload).toHaveBeenCalledTimes(1);
    expect(mockedDownload).toHaveBeenCalledWith(designSystemSamplePath('editorial', { title: '标题' }), 'sample.html');
  });

  it('失败时把人话原因原样抛出，且不缓存失败：重试会真的重新请求', async () => {
    mockedDownload.mockRejectedValueOnce(new Error('目标内容不存在或已被删除，请返回后刷新列表。'));
    await expect(loadDesignSystemSample('nope')).rejects.toThrow('目标内容不存在或已被删除');
    mockedDownload.mockResolvedValueOnce(htmlFile('<p>ok</p>'));
    await expect(loadDesignSystemSample('nope')).resolves.toBe('<p>ok</p>');
    expect(mockedDownload).toHaveBeenCalledTimes(2);
  });
});
