import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadGeneratedImage } from './generatedImageDownload';

const { apiDownloadMock, toastError } = vi.hoisted(() => ({
  apiDownloadMock: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }));
vi.mock('@/services/real/apiClient', () => ({ apiDownload: apiDownloadMock }));

describe('downloadGeneratedImage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    apiDownloadMock.mockReset();
    toastError.mockReset();
    vi.restoreAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:test-image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('通过受权同源端点下载跨域生成图并保留真实格式', async () => {
    apiDownloadMock.mockResolvedValue({
      blob: new Blob(['generated'], { type: 'image/webp' }),
      fileName: '生成图.webp',
      contentType: 'image/webp',
    });
    let downloadedName = '';
    const anchor = {
      href: '',
      download: '',
      rel: '',
      click: () => { downloadedName = anchor.download; },
    };
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    });
    vi.stubGlobal('window', { setTimeout: vi.fn() });

    await downloadGeneratedImage('https://assets.example/generated.webp', '蓝色陶瓷杯');

    expect(apiDownloadMock).toHaveBeenCalledWith(
      '/api/visual-agent/image-gen/download?url=https%3A%2F%2Fassets.example%2Fgenerated.webp',
      '蓝色陶瓷杯.png',
    );
    expect(downloadedName).toBe('蓝色陶瓷杯.webp');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('下载失败时只显示用户可恢复提示', async () => {
    apiDownloadMock.mockRejectedValue(new Error('下载未完成'));

    await downloadGeneratedImage('https://assets.example/missing.png', '图片');

    expect(toastError).toHaveBeenCalledWith('下载图片失败', '请稍后重试；图片仍保留在当前作品中。');
  });
});
