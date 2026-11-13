// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { narrationRequestId, VideoNarrationPanel } from './VideoNarrationPanel';

const api = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn(), generate: vi.fn(), narration: vi.fn(), adopt: vi.fn() }));
vi.mock('@/services/real/mcpSpeech', () => ({ listSpeechRuns: api.list, getSpeechCapabilities: api.capabilities, generateSpeech: api.generate }));
vi.mock('@/services/real/videoAgent', () => ({ getVideoNarrationReal: api.narration, adoptVideoNarrationReal: api.adopt }));
vi.mock('@/components/assets/AudioAssetPlayer', () => ({ AudioAssetPlayer: ({ url }: { url: string }) => <span data-audio-url={url}>私有音频试听</span> }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>正在处理</span> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onAdopt = vi.fn(async () => {});
const speech = { id: 'speech-1', title: '第一镜', text: '雨停了。', status: 'completed', stage: '已完成', audioUrl: '/api/mcp-speech/runs/speech-1/audio' };
const render = () => act(async () => root.render(<VideoNarrationPanel runId="run-1" sceneIndex={1} editable onClose={() => {}} onAdopt={onAdopt} />));
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent?.includes(text))!;
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.list.mockResolvedValue({ success: true, data: { items: [speech] } });
  api.capabilities.mockResolvedValue({ success: true, data: { profiles: [] } });
  api.narration.mockResolvedValue({ success: true, data: { items: [{ sceneIndex: 1, speechRunId: 'speech-1', text: speech.text, durationSeconds: 2.1, status: 'ready' }] } });
  api.adopt.mockResolvedValue({ success: true, data: true });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('逐镜配音与字幕', () => {
  it('已有PCM试听请求同归属的可播放封装，不生成新语音', async () => {
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...speech, format: 'pcm' }] } });
    await render();
    const select = host.querySelector<HTMLSelectElement>('[aria-label="已有语音"]')!;
    await act(async () => { select.value = speech.id; Simulate.change(select); });
    expect(host.querySelector('[data-audio-url]')?.getAttribute('data-audio-url'))
      .toBe('/api/mcp-speech/runs/speech-1/audio?playable=true');
    expect(api.generate).not.toHaveBeenCalled();
  });

  it('刷新只恢复已有配音与字幕，采用既有语音不提交TTS', async () => {
    await render();
    expect(host.textContent).toContain('已采用配音 · 2.10 秒');
    const select = host.querySelector<HTMLSelectElement>('[aria-label="已有语音"]')!;
    await act(async () => { select.value = speech.id; Simulate.change(select); });
    await act(async () => button('采用到此镜头').click());
    expect(api.adopt).toHaveBeenCalledWith('run-1', 1, 'speech-1');
    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(api.generate).not.toHaveBeenCalled();
  });
  it('超长配音失败展示可恢复原因，原已采用内容保留', async () => {
    api.adopt.mockResolvedValue({ success: false, error: { message: '配音超过镜头长度，请缩短配音。' } });
    await render();
    const select = host.querySelector<HTMLSelectElement>('[aria-label="已有语音"]')!;
    await act(async () => { select.value = speech.id; Simulate.change(select); });
    await act(async () => button('采用到此镜头').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('请缩短配音');
    expect(host.textContent).toContain('已采用配音');
    expect(onAdopt).not.toHaveBeenCalled();
    expect((button('采用到此镜头') as HTMLButtonElement).disabled).toBe(false);
  });
  it('断网后保留刷新入口，重连不会提交模型', async () => {
    api.list.mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('网络断开');
    await act(async () => button('刷新语音与状态').click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(api.generate).not.toHaveBeenCalled();
  });
  it('响应不明的重试复用请求标识，修改脚本或明确重新生成使用新标识', () => {
    const first = narrationRequestId('scene', 'same');
    expect(narrationRequestId('scene', 'same')).toBe(first);
    expect(narrationRequestId('scene', 'different')).not.toBe(first);
    const previous = narrationRequestId('scene', 'different');
    expect(narrationRequestId('scene', 'different', true)).not.toBe(previous);
  });
  it('失败语音的重新生成遇到网络响应丢失时，第二次点击仍提交同一请求标识', async () => {
    api.list.mockResolvedValue({ success: true, data: { items: [{ ...speech, status: 'failed' }] } });
    api.capabilities.mockResolvedValue({ success: true, data: { profiles: [{
      id: 'profile', revision: 1, available: true, isDefault: true, name: '当前语音', model: 'test',
      voices: [{ id: 'voice', name: '声音' }], defaultVoiceId: 'voice', defaultFormat: 'wav', maxTextChars: 100,
    }] } });
    api.generate.mockResolvedValueOnce({ success: false, error: { message: '网络响应丢失' } })
      .mockResolvedValueOnce({ success: true, data: { ...speech, id: 'retry', status: 'queued' } });
    await render();
    const select = host.querySelector<HTMLSelectElement>('[aria-label="已有语音"]')!;
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="此镜头配音脚本"]')!;
    await act(async () => { select.value = speech.id; Simulate.change(select); input.value = '修改后的旁白'; Simulate.change(input); });
    await act(async () => button('重新生成配音').click());
    await act(async () => button('重新生成配音').click());
    expect(api.generate).toHaveBeenCalledTimes(2);
    expect(api.generate.mock.calls[0][0].clientRequestId).toBe(api.generate.mock.calls[1][0].clientRequestId);
  });
});
