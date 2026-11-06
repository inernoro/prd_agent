// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioAssetPlayer } from './AudioAssetPlayer';

const { download, auth } = vi.hoisted(() => ({
  download: vi.fn(),
  auth: { user: { userId: 'user-a' }, authSessionEpoch: 1 },
}));
vi.mock('@/services/real/apiClient', () => ({ apiDownload: download }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (selector: (state: typeof auth) => unknown) => selector(auth) }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>加载中</span> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const path = '/api/mcp-speech/runs/run-a/audio';

const render = (url = path) => act(async () => root.render(<AudioAssetPlayer url={url} title="产品旁白.mp3" />));
const load = () => act(async () => host.querySelector('button')!.click());

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { userId: 'user-a' };
  auth.authSessionEpoch = 1;
  download.mockResolvedValue({ blob: new Blob(['audio']), fileName: '旁白.mp3' });
  createObjectURL.mockReturnValue('blob:private-audio');
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('受控音频资产播放与下载', () => {
  it('点击后才走鉴权下载，播放与下载使用同一blob，换源时释放', async () => {
    await render();
    expect(download).not.toHaveBeenCalled();
    expect(host.querySelector('audio')).toBeNull();

    await load();
    expect(download).toHaveBeenCalledWith(path, '产品旁白.mp3');
    expect(host.querySelector('audio')?.getAttribute('src')).toBe('blob:private-audio');
    expect(host.querySelector('audio')?.getAttribute('preload')).toBe('none');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('blob:private-audio');
    expect(host.querySelector('a')?.getAttribute('download')).toBe('旁白.mp3');

    await render('/api/mcp-speech/runs/run-b/audio');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private-audio');
    expect(host.querySelector('audio')).toBeNull();
  });

  it.each(['user-b', 'user-a'])('进入新会话（%s）后移除旧音频并释放blob', async (userId) => {
    await render();
    await load();
    auth.user = { userId };
    auth.authSessionEpoch = 2;
    await render();
    expect(host.querySelector('audio')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private-audio');
  });

  it('旧请求在切换源后才返回，不把旧音频放到新资产', async () => {
    let resolveDownload!: (file: { blob: Blob; fileName: string }) => void;
    download.mockReturnValue(new Promise((resolve) => { resolveDownload = resolve; }));
    await render();
    await load();
    await render('/api/mcp-speech/runs/run-b/audio');
    await act(async () => resolveDownload({ blob: new Blob(['old']), fileName: 'old.mp3' }));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(host.querySelector('audio')).toBeNull();
  });

  it('下载失败可见且可重试，不把受控API直接交给audio', async () => {
    download.mockRejectedValueOnce(new Error('当前没有访问权限。'));
    await render();
    await load();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('当前没有访问权限');
    expect(host.querySelector('audio')).toBeNull();
    await load();
    expect(host.querySelector('audio')?.getAttribute('src')).toBe('blob:private-audio');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('外部已签名地址保持原生媒体访问，不经过携带Bearer的下载通道', async () => {
    const signed = 'https://storage.example.test/audio.mp3?signature=example';
    await render(signed);
    expect(download).not.toHaveBeenCalled();
    expect(host.querySelector('audio')?.getAttribute('src')).toBe(signed);
  });

  it('浏览器解码失败时说明原因并保留下载入口', async () => {
    await render();
    await load();
    await act(async () => host.querySelector('audio')!.dispatchEvent(new Event('error')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('当前浏览器未能播放音频');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('blob:private-audio');
  });
});
