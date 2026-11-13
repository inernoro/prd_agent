import { apiRequest } from './apiClient';
import type { SpeechCapabilities, SpeechPreset, SpeechPresetInput, SpeechRun, SpeechRunInput, SpeechSettings } from '@/services/contracts/mcpSpeech';

const base = '/api/mcp-speech';
export const getSpeechCapabilities = () => apiRequest<SpeechCapabilities>(`${base}/capabilities`);
export const listSpeechRuns = () => apiRequest<{ items: SpeechRun[] }>(`${base}/runs?limit=30`);
export const getSpeechRun = (id: string) => apiRequest<SpeechRun>(`${base}/runs/${encodeURIComponent(id)}`);
export const generateSpeech = (body: SpeechRunInput) => apiRequest<SpeechRun>(`${base}/runs`, { method: 'POST', body });
export const listSpeechPresets = () => apiRequest<{ items: SpeechPreset[] }>(`${base}/presets`);
export const saveSpeechPreset = (body: SpeechPresetInput) => apiRequest<SpeechPreset>(`${base}/presets`, { method: 'POST', body });
export const getSpeechSettings = () => apiRequest<SpeechSettings>(`${base}/settings`);
export const saveSpeechSettings = (body: Pick<SpeechSettings, 'profiles' | 'revision'>) => apiRequest<SpeechSettings>(`${base}/settings`, { method: 'PUT', body });
