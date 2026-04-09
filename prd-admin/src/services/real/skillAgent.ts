import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

// ━━━ Types ━━━━━━━━

export interface SkillAgentStage {
  key: string;
  label: string;
  index: number;
}

export interface SkillAgentSessionResponse {
  sessionId: string;
  currentStage: string;
  stageLabel: string;
  stageIndex: number;
  stages: SkillAgentStage[];
  welcome: {
    message: string;
    stage: string;
    stageLabel: string;
  };
}

export interface SkillAgentSessionState {
  sessionId: string;
  currentStage: string;
  stageLabel: string;
  stageIndex: number;
  intent?: string;
  hasSkillDraft: boolean;
  skillPreview?: string;
  messages: { role: string; content: string }[];
}

export interface SkillAgentSaveResponse {
  skillKey: string;
  title: string;
  message: string;
}

export interface SkillAgentExportMdResponse {
  skillMd: string;
  fileName: string;
}

// ━━━ API Functions ━━━━━━━━

export async function createSkillAgentSession() {
  return apiRequest<SkillAgentSessionResponse>(api.skillAgent.createSession(), {
    method: 'POST',
  });
}

export async function getSkillAgentSession(sessionId: string) {
  return apiRequest<SkillAgentSessionState>(api.skillAgent.session(sessionId));
}

export async function saveSkillFromAgent(sessionId: string) {
  return apiRequest<SkillAgentSaveResponse>(api.skillAgent.save(sessionId), {
    method: 'POST',
  });
}

export async function exportSkillMd(sessionId: string) {
  return apiRequest<SkillAgentExportMdResponse>(api.skillAgent.exportMd(sessionId));
}

export function getExportZipUrl(sessionId: string) {
  return api.skillAgent.exportZip(sessionId);
}

export async function deleteSkillAgentSession(sessionId: string) {
  return apiRequest<{ deleted: boolean }>(api.skillAgent.session(sessionId), {
    method: 'DELETE',
  });
}
