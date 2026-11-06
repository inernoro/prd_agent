// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, fail } from '@/types/api';
import { SpeechPanel } from '../SpeechPanel';
import type { SpeechProfile, SpeechRun } from '@/services/contracts/mcpSpeech';

const services = vi.hoisted(() => ({ getSpeechCapabilities: vi.fn(), getSpeechRun: vi.fn(), listSpeechRuns: vi.fn(), listSpeechPresets: vi.fn(), getSpeechSettings: vi.fn(), generateSpeech: vi.fn(), saveSpeechPreset: vi.fn(), saveSpeechSettings: vi.fn() }));
vi.mock('@/services/real/mcpSpeech', () => services);
vi.mock('@/components/assets/AudioAssetPlayer', () => ({ AudioAssetPlayer: ({ title }: { title: string }) => <div>音频：{title}</div> }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: ({ text }: { text: string }) => <div>{text}</div>, MapSpinner: () => <span aria-label="正在处理" /> }));
vi.mock('@/components/ui/RelativeTime', () => ({ RelativeTime: () => <span>刚刚</span> }));

const profile: SpeechProfile = { id: 'openai-profile', name: '声音指令模型', protocol: 'openai', model: 'test-tts', modelPoolId: 'test-pool', revision: 1, enabled: true, available: true, isDefault: true, maxTextChars: 1000, voices: [{ id: 'a', name: '女声A', languages: ['zh'] }], formats: ['mp3'], supportsInstructions: true, supportsEmotion: false, emotions: [], minSpeed: 0.5, maxSpeed: 2, defaultVoiceId: 'a', defaultFormat: 'mp3', dailyCharacterQuota: 20000, maxConcurrentRuns: 2 };
const completed: SpeechRun = { id: 'run-1', title: '产品介绍', status: 'completed', stage: '已完成', text: '欢迎使用MAP', profileId: profile.id, profileName: profile.name, voiceId: 'a', format: 'mp3', speed: 1, createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', assetId: 'asset-1', audioUrl: '/api/mcp-speech/runs/run-1/audio' };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.values(services).forEach(mock => mock.mockReset());
  services.getSpeechCapabilities.mockResolvedValue(ok({ environment: 'preview', profiles: [profile] }));
  services.listSpeechRuns.mockResolvedValue(ok({ items: [completed] }));
  services.listSpeechPresets.mockResolvedValue(ok({ items: [] }));
  services.getSpeechSettings.mockResolvedValue(ok({ environment: 'preview', revision: 1, profiles: [profile], canManage: false }));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
const render = (path = '/mcp-console?tab=speech') => act(async () => root.render(<MemoryRouter initialEntries={[path]}><SpeechPanel refreshToken={0} /></MemoryRouter>));

describe('MCP语音面板', () => {
  it('显示当前环境、音频历史和资产入口，普通用户不显示管理配置', async () => {
    await render();
    expect(host.textContent).toContain('当前环境：preview');
    expect(host.textContent).toContain('产品介绍');
    expect(host.querySelector('a[href="/my-assets?tab=audio"]')).not.toBeNull();
    expect(host.textContent).not.toContain('管理当前环境的语音能力');
  });
  it('按返回能力显示差异参数，切换上游不会留下旧指令输入', async () => {
    services.getSpeechCapabilities.mockResolvedValue(ok({ environment: 'preview', profiles: [profile, { ...profile, id: 'doubao-profile', name: '情绪模型', protocol: 'doubao-tts', supportsInstructions: false, supportsEmotion: true, emotions: ['happy'], isDefault: false }] }));
    await render();
    expect(host.textContent).toContain('声音指令（可选）');
    expect(host.textContent).not.toContain('情绪（可选）');
    const select = [...host.querySelectorAll('label')].find(label => label.textContent?.startsWith('语音能力'))?.querySelector('select');
    await act(async () => { select!.value = 'doubao-profile'; select!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).not.toContain('声音指令（可选）');
    expect(host.textContent).toContain('情绪（可选）');
  });
  it('能力不可用时仍保留历史，明确显示失败原因', async () => {
    services.getSpeechCapabilities.mockResolvedValue(ok({ environment: 'preview', profiles: [{ ...profile, available: false, unavailableReason: '当前模型池尚未配置，请联系管理员。' }] }));
    await render();
    expect(host.textContent).toContain('当前模型池尚未配置');
    expect(host.textContent).toContain('产品介绍');
    const submit = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('生成并保存语音'));
    expect(submit?.disabled).toBe(true);
  });
  it('历史查询失败不显示误导性的无历史空态', async () => {
    services.listSpeechRuns.mockResolvedValue(fail('UNAVAILABLE', '历史查询失败，请刷新重试。'));
    await render();
    expect(host.textContent).toContain('历史查询失败');
    expect(host.textContent).not.toContain('还没有语音任务');
  });
  it('上游结果不明时停止自动查询，重复生成按钮不可用', async () => {
    vi.useFakeTimers();
    services.listSpeechRuns.mockResolvedValue(ok({ items: [{ ...completed, status: 'unknown', audioUrl: undefined, assetId: undefined }] }));
    await render();
    await act(async () => vi.advanceTimersByTime(15000));
    expect(services.listSpeechRuns).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('结果待核查');
    const repeat = [...host.querySelectorAll('button')].find(button => button.textContent === '按此配置再次生成');
    expect(repeat?.disabled).toBe(true);
  });
  it('调用记录深链能读取不在最近列表中的指定任务', async () => {
    services.listSpeechRuns.mockResolvedValue(ok({ items: [] }));
    services.getSpeechRun.mockResolvedValue(ok(completed));
    await render('/mcp-console?tab=speech&run=run-1');
    expect(services.getSpeechRun).toHaveBeenCalledWith('run-1');
    expect(host.querySelector('#speech-run-run-1')?.textContent).toContain('产品介绍');
  });
  it('生成中持续刷新，拿到成品后停止轮询', async () => {
    vi.useFakeTimers();
    services.listSpeechRuns.mockResolvedValueOnce(ok({ items: [{ ...completed, status: 'generating', audioUrl: undefined, assetId: undefined }] })).mockResolvedValue(ok({ items: [completed] }));
    await render();
    await act(async () => vi.advanceTimersByTime(4000));
    expect(services.listSpeechRuns).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('已完成');
    await act(async () => vi.advanceTimersByTime(12000));
    expect(services.listSpeechRuns).toHaveBeenCalledTimes(2);
  });
  it('旧预设只有在用户明确载入最新配置后才更新绑定', async () => {
    services.listSpeechPresets.mockResolvedValue(ok({ items: [{ id: 'old-preset', name: '旧声音', profileId: profile.id, profileRevision: 0, revision: 1, voiceId: 'a', format: 'mp3', speed: 1 }] }));
    await render();
    const select = [...host.querySelectorAll('label')].find(label => label.textContent?.startsWith('我的声音预设'))?.querySelector('select');
    await act(async () => { select!.value = 'old-preset'; select!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('原声音配置已更新');
    const reload = [...host.querySelectorAll('button')].find(button => button.textContent === '载入最新声音配置');
    await act(async () => reload!.click());
    expect(host.textContent).not.toContain('原声音配置已更新');
  });
  it('按原文提交任务，结果不明确时重试沿用请求标识', async () => {
    services.generateSpeech.mockResolvedValueOnce(fail('UNCERTAIN', '提交结果待确认，请查询历史。')).mockResolvedValueOnce(ok({ ...completed, status: 'queued' }));
    await render();
    const textarea = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '  原文保持不变\n继续朗读  ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = [...host.querySelectorAll('button')].find(button => button.textContent === '生成并保存语音')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await act(async () => submit.click());
    expect(services.generateSpeech).toHaveBeenCalledTimes(2);
    const first = services.generateSpeech.mock.calls[0][0];
    const second = services.generateSpeech.mock.calls[1][0];
    expect(first).toMatchObject({ text: '  原文保持不变\n继续朗读  ', profileId: profile.id, profileRevision: 1, voiceId: 'a' });
    expect(first.clientRequestId).toBeTruthy();
    expect(second.clientRequestId).toBe(first.clientRequestId);
  });
});
