// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileAssetsPage from './MobileAssetsPage';

const { getAssets } = vi.hoisted(() => ({ getAssets: vi.fn() }));
vi.mock('@/services', () => ({ getMobileAssets: getAssets }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <span>加载中</span> }));
vi.mock('@/components/SitePreview', () => ({ SitePreview: () => null }));
vi.mock('@/components/assets/AudioAssetPlayer', () => ({ AudioAssetPlayer: ({ url }: { url: string }) => <audio src={url} /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  getAssets.mockResolvedValue({ success: true, data: { items: [{
    id: 'audio-a', type: 'audio', title: '产品介绍', mime: 'audio/mpeg',
    source: '语音生成', summary: '舒缓旁白', url: '/api/mcp-speech/runs/run-a/audio',
    sizeBytes: 1024, width: 0, height: 0, createdAt: '2026-11-06T00:00:00Z',
  }] } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-theme');
});

describe('移动音频资产入口', () => {
  it.each(['dark', 'light'])('%s主题深链直达音频分类并显示播放器、来源与摘要', async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    await act(async () => root.render(<MemoryRouter initialEntries={['/my-assets?tab=audio']}><MobileAssetsPage /></MemoryRouter>));
    expect(getAssets).toHaveBeenCalledWith({ category: 'audio', limit: 50 });
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe('音频');
    expect(host.querySelector('audio')?.getAttribute('src')).toBe('/api/mcp-speech/runs/run-a/audio');
    expect(host.textContent).toContain('语音生成');
    expect(host.textContent).toContain('舒缓旁白');

    const allTab = [...host.querySelectorAll('button')].find((button) => button.textContent === '全部')!;
    await act(async () => allTab.click());
    expect(getAssets).toHaveBeenLastCalledWith({ category: undefined, limit: 50 });
  });

  it('获取失败显示错误与重试入口，不把失败表现为没有资产', async () => {
    getAssets.mockRejectedValueOnce(new Error('network'));
    await act(async () => root.render(<MemoryRouter initialEntries={['/my-assets?tab=audio']}><MobileAssetsPage /></MemoryRouter>));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('资产加载失败');
    expect(host.textContent).not.toContain('暂无内容');
    await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(host.querySelector('audio')).not.toBeNull();
  });
});
