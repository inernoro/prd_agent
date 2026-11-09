import type { SpeechProfile, SpeechRun, SpeechRunInput, SpeechPreset } from '@/services/contracts/mcpSpeech';

export interface SpeechDraft {
  text: string;
  title: string;
  profileId: string;
  profileRevision?: number;
  voiceId: string;
  format: string;
  speed: number;
  instructions: string;
  emotion: string;
}

export const EMPTY_SPEECH_DRAFT: SpeechDraft = { text: '', title: '', profileId: '', voiceId: '', format: '', speed: 1, instructions: '', emotion: '' };

/** Selecting a different provider starts with its declared defaults; special options never leak across providers. */
export function selectSpeechProfile(draft: SpeechDraft, profile: SpeechProfile): SpeechDraft {
  return { ...draft, profileId: profile.id, profileRevision: profile.revision, voiceId: profile.defaultVoiceId, format: profile.defaultFormat, speed: Math.min(profile.maxSpeed, Math.max(profile.minSpeed, 1)), instructions: '', emotion: '' };
}

export function applySpeechPreset(draft: SpeechDraft, preset: SpeechPreset): SpeechDraft {
  return { ...draft, profileId: preset.profileId, profileRevision: preset.profileRevision, voiceId: preset.voiceId, format: preset.format, speed: preset.speed, instructions: preset.instructions ?? '', emotion: preset.emotion ?? '' };
}

export function repeatSpeechRun(run: SpeechRun): SpeechDraft {
  return { text: run.text, title: run.title, profileId: run.profileId, profileRevision: run.profileRevision, voiceId: run.voiceId, format: run.format, speed: run.speed, instructions: run.instructions ?? '', emotion: run.emotion ?? '' };
}

export function speechDraftIssue(draft: SpeechDraft, profile?: SpeechProfile): string | null {
  if (!profile) return '请先选择当前环境中的语音能力。';
  if (!profile.available) return profile.unavailableReason || '此语音能力暂不可用，请联系管理员检查配置。';
  if (draft.profileRevision !== undefined && draft.profileRevision !== profile.revision) return '此声音配置已更新，请重新选择语音能力并确认音色后生成。';
  if (!draft.text.trim()) return '请输入需要朗读的文字。';
  if (Array.from(draft.text).length > profile.maxTextChars) return `文字超过此能力的 ${profile.maxTextChars} 字上限，请缩短后生成。`;
  if (!profile.voices.some(voice => voice.id === draft.voiceId)) return '原音色已不可用，请重新选择音色。';
  if (!profile.formats.includes(draft.format)) return '原输出格式已不可用，请重新选择格式。';
  if (!Number.isFinite(draft.speed) || draft.speed < profile.minSpeed || draft.speed > profile.maxSpeed) return '语速超出此能力支持的范围，请调整后生成。';
  if (draft.instructions.trim() && !profile.supportsInstructions) return '此能力不支持声音指令，请清空后生成。';
  if (draft.emotion && (!profile.supportsEmotion || !profile.emotions.includes(draft.emotion))) return '原情绪配置已不可用，请重新选择。';
  return null;
}

export function speechRunRequest(draft: SpeechDraft, profile: SpeechProfile, clientRequestId: string): SpeechRunInput {
  return { text: draft.text, title: draft.title.trim() || undefined, profileId: profile.id, profileRevision: profile.revision, voiceId: draft.voiceId, format: draft.format, speed: draft.speed, instructions: draft.instructions.trim() || undefined, emotion: draft.emotion || undefined, clientRequestId };
}

export function isSpeechRunActive(run: Pick<SpeechRun, 'status'>): boolean {
  return ['queued', 'preparing', 'generating', 'saving'].includes(run.status.toLowerCase());
}
