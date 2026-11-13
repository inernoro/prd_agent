/** Public speech capabilities are resolved by the server for the current deployment. */
export interface SpeechVoice {
  id: string;
  name: string;
  languages: string[];
  previewUrl?: string;
}

export interface SpeechProfile {
  id: string;
  name: string;
  protocol: string;
  model: string;
  modelPoolId: string;
  revision: number;
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  isDefault: boolean;
  maxTextChars: number;
  voices: SpeechVoice[];
  formats: string[];
  supportsInstructions: boolean;
  supportsEmotion: boolean;
  emotions: string[];
  minSpeed: number;
  maxSpeed: number;
  defaultVoiceId: string;
  defaultFormat: string;
  dailyCharacterQuota: number;
  maxConcurrentRuns: number;
}

export interface SpeechCapabilities {
  environment: string;
  profiles: SpeechProfile[];
}

export interface SpeechPresetInput {
  id?: string;
  name: string;
  profileId: string;
  profileRevision: number;
  revision?: number;
  voiceId: string;
  format: string;
  speed: number;
  instructions?: string;
  emotion?: string;
}

export interface SpeechPreset extends SpeechPresetInput {
  id: string;
  updatedAt: string;
}

export interface SpeechRunInput {
  text: string;
  title?: string;
  profileId?: string;
  profileRevision?: number;
  voiceId?: string;
  presetId?: string;
  format?: string;
  speed?: number;
  instructions?: string;
  emotion?: string;
  clientRequestId: string;
}

export interface SpeechRun {
  id: string;
  title: string;
  status: string;
  stage: string;
  text: string;
  profileId: string;
  profileName: string;
  profileRevision?: number;
  voiceId: string;
  format: string;
  speed: number;
  instructions?: string;
  emotion?: string;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  errorMessage?: string;
  assetId?: string;
  audioUrl?: string;
  logId?: string;
  actualModel?: string;
  actualPlatformName?: string;
  environment?: string;
  characterCount?: number;
  providerUsage?: Record<string, number>;
}

export interface SpeechSettings extends SpeechCapabilities {
  canManage: boolean;
  revision: number;
  directoryError?: string;
  modelPools?: Array<{ id: string; name: string; protocol?: string; model?: string }>;
}
