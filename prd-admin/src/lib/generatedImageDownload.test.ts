import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadGeneratedImage } from './generatedImageDownload';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => ({ token: 'test-token' }) },
}));

describe('downloadGeneratedImage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['generated'], { type: 'image/webp' }),
    });
    vi.stubGlobal('fetch', fetchMock);
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

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/visual-agent/image-gen/download?url=https%3A%2F%2Fassets.example%2Fgenerated.webp',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
    expect(downloadedName).toBe('蓝色陶瓷杯.webp');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('下载失败时只显示用户可恢复提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await downloadGeneratedImage('https://assets.example/missing.png', '图片');

    expect(toastError).toHaveBeenCalledWith('下载图片失败', '请稍后重试；图片仍保留在当前作品中。');
  });
});
