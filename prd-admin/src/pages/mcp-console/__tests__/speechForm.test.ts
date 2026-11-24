import { describe, expect, it } from 'vitest';
import type { SpeechProfile, SpeechPreset } from '@/services/contracts/mcpSpeech';
import { EMPTY_SPEECH_DRAFT, applySpeechPreset, isSpeechRunActive, selectSpeechProfile, speechDraftIssue, speechRunRequest } from '../speechForm';

export function speechProfile(overrides: Partial<SpeechProfile> = {}): SpeechProfile {
  return { id: 'future-voice-service', name: '测试语音', protocol: 'future-tts', model: 'voice-model', modelPoolId: 'pool-tts-future', revision: 4, enabled: true, available: true, isDefault: true, maxTextChars: 1000, voices: [{ id: 'voice-a', name: '测试声音', languages: ['zh'] }], formats: ['mp3'], supportsInstructions: true, supportsEmotion: false, emotions: [], minSpeed: 0.5, maxSpeed: 2, defaultVoiceId: 'voice-a', defaultFormat: 'mp3', dailyCharacterQuota: 20000, maxConcurrentRuns: 2, ...overrides };
}

describe('MCP 语音配置跨上游边界', () => {
  it('切换上游使用目标能力的默认值，不带走旧上游特性', () => {
    const original = { ...EMPTY_SPEECH_DRAFT, text: '原文不应被改写', voiceId: 'old-voice', format: 'wav', speed: 3, instructions: '舒缓地朗读', emotion: 'happy' };
    const next = selectSpeechProfile(original, speechProfile({ supportsInstructions: false, minSpeed: 1.2, maxSpeed: 1.8 }));
    expect(next).toMatchObject({ text: original.text, profileId: 'future-voice-service', profileRevision: 4, voiceId: 'voice-a', format: 'mp3', speed: 1.2, instructions: '', emotion: '' });
  });
  it('失效的预设保留原配置并明确拒绝，不能静默改用另一音色', () => {
    const preset: SpeechPreset = { id: 'preset', name: '我的声音', profileId: 'future-voice-service', profileRevision: 3, revision: 1, voiceId: 'voice-a', format: 'mp3', speed: 1, updatedAt: '2026-11-06T00:00:00Z' };
    const draft = applySpeechPreset({ ...EMPTY_SPEECH_DRAFT, text: '测试正文' }, preset);
    expect(draft.profileRevision).toBe(3);
    expect(speechDraftIssue(draft, speechProfile())).toContain('配置已更新');
  });
  it('声音被下线后阻止生成，重选能力才会使用新默认音色', () => {
    const profile = speechProfile();
    const draft = { ...selectSpeechProfile({ ...EMPTY_SPEECH_DRAFT, text: '生成语音' }, profile), voiceId: 'removed-voice' };
    expect(speechDraftIssue(draft, profile)).toContain('音色已不可用');
    expect(speechDraftIssue(selectSpeechProfile(draft, profile), profile)).toBeNull();
  });
  it('只提交用户确认的配置和当前版本，保留正文与幂等键', () => {
    const profile = speechProfile();
    const draft = selectSpeechProfile({ ...EMPTY_SPEECH_DRAFT, text: '  用户原文\n保持格式  ', title: '配音' }, profile);
    expect(speechRunRequest(draft, profile, 'same-submit')).toEqual({ text: draft.text, title: '配音', profileId: profile.id, profileRevision: 4, voiceId: 'voice-a', format: 'mp3', speed: 1, instructions: undefined, emotion: undefined, clientRequestId: 'same-submit' });
  });
  it('明确拒绝不支持的声音指令、情绪和异常语速', () => {
    const profile = speechProfile({ supportsInstructions: false });
    const draft = selectSpeechProfile({ ...EMPTY_SPEECH_DRAFT, text: '测试正文' }, profile);
    expect(speechDraftIssue({ ...draft, instructions: '温柔' }, profile)).toContain('不支持声音指令');
    expect(speechDraftIssue({ ...draft, emotion: 'happy' }, profile)).toContain('情绪配置已不可用');
    expect(speechDraftIssue({ ...draft, speed: NaN }, profile)).toContain('语速超出');
  });
  it('结果不明停止自动轮询，避免将未知任务表现为持续生成', () => {
    expect(isSpeechRunActive({ status: 'unknown' })).toBe(false);
    expect(isSpeechRunActive({ status: 'saving' })).toBe(true);
    expect(isSpeechRunActive({ status: 'completed' })).toBe(false);
  });
});
