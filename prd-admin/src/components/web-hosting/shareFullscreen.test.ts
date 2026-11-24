import { describe, expect, it, vi } from 'vitest';
import {
  getNativeFullscreenElement,
  subscribeNativeFullscreen,
  tryEnterNativeFullscreen,
  tryExitNativeFullscreen,
} from './shareFullscreen';

describe('分享页全屏兼容', () => {
  it('标准 API 可用时进入和退出原生全屏', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const fakeDocument = { exitFullscreen } as unknown as Document;
    const element = { requestFullscreen, ownerDocument: fakeDocument } as unknown as HTMLElement;

    await expect(tryEnterNativeFullscreen(element)).resolves.toBe(true);
    await expect(tryExitNativeFullscreen(fakeDocument)).resolves.toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it('iPhone WebKit 没有普通元素全屏 API 时明确返回 false', async () => {
    const element = { ownerDocument: {} as Document } as HTMLElement;
    await expect(tryEnterNativeFullscreen(element)).resolves.toBe(false);
  });

  it('兼容 WebKit 的全屏元素与事件', () => {
    const fakeElement = {} as Element;
    const fakeDocument = {
      fullscreenElement: null,
      webkitFullscreenElement: fakeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document;

    expect(getNativeFullscreenElement(fakeDocument)).toBe(fakeElement);
    const unsubscribe = subscribeNativeFullscreen(() => {}, fakeDocument);
    expect(fakeDocument.addEventListener).toHaveBeenCalledWith('webkitfullscreenchange', expect.any(Function));
    unsubscribe();
    expect(fakeDocument.removeEventListener).toHaveBeenCalledWith('webkitfullscreenchange', expect.any(Function));
  });
});
