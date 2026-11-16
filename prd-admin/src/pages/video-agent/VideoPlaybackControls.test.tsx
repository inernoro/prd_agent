// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoPlaybackControls } from './VideoPlaybackControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let frame: HTMLDivElement;
let host: HTMLDivElement;
let video: HTMLVideoElement;
let root: Root;
const onToggle = vi.fn();
const onSeek = vi.fn();
const onError = vi.fn();
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const render = (overrides = {}) => act(async () => root.render(<VideoPlaybackControls
  videoRef={{ current: video }} frameRef={{ current: frame }} playing={false} currentTime={1} duration={15}
  disabled={false} onToggle={onToggle} onSeek={onSeek} onError={onError} {...overrides} />));
beforeEach(() => {
  vi.clearAllMocks();
  frame = document.createElement('div'); video = document.createElement('video'); host = document.createElement('div');
  frame.append(video, host); document.body.append(frame); root = createRoot(host);
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
});
afterEach(async () => { await act(async () => root.unmount()); frame.remove(); });

describe('成片自定义播放控制', () => {
  it('播放、时间跳转和静音均可操作，进度提供可读时间', async () => {
    await render(); await act(async () => button('播放').click()); expect(onToggle).toHaveBeenCalledOnce();
    const seek = host.querySelector<HTMLInputElement>('[aria-label="播放进度"]')!;
    expect(seek.getAttribute('aria-valuetext')).toBe('00:01 / 00:15');
    await act(async () => { seek.value = '6'; Simulate.change(seek); });
    expect(onSeek).toHaveBeenCalledWith(6);
    await act(async () => button('静音').click()); expect(video.muted).toBe(true);
    expect(button('取消静音').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('取消静音').click()); expect(video.muted).toBe(false);
  });
  it('未就绪时不允许跳转，比较模式禁用单片控制', async () => {
    await render({ duration: Number.NaN });
    expect(host.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
    await render({ disabled: true });
    for (const control of host.querySelectorAll<HTMLButtonElement>('button')) expect(control.disabled).toBe(true);
  });
  it('全屏包含播放器和控制区，并能退出全屏', async () => {
    frame.requestFullscreen = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: frame });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    document.exitFullscreen = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    await render(); await act(async () => button('全屏').click());
    expect(frame.requestFullscreen).toHaveBeenCalledOnce();
    await act(async () => button('退出全屏').click()); expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(button('全屏')).toBeTruthy();
  });
  it('全屏被浏览器拒绝时提供明确反馈，不改变播放或发送生成任务', async () => {
    frame.requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'));
    await render(); await act(async () => button('全屏').click());
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('全屏'));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
