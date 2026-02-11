import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

// ━━━ Types ━━━━━━━━

export interface SkillInputConfig {
  contextScope: string;
  acceptsUserInput: boolean;
  userInputPlaceholder?: string;
  acceptsAttachments: boolean;
  parameters: SkillParameter[];
}

export interface SkillParameter {
  key: string;
  label: string;
  type: string;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  required: boolean;
}

export interface SkillExecutionConfig {
  promptTemplate: string;
  systemPromptOverride?: string;
  appCallerCode?: string;
  modelType: string;
  expectedModel?: string;
  toolChain: SkillToolStep[];
}

export interface SkillToolStep {
  toolKey: string;
  config: Record<string, unknown>;
  optional: boolean;
}

export interface SkillOutputConfig {
  mode: string;
  fileNameTemplate?: string;
  mimeType?: string;
  echoToChat: boolean;
}

export interface AdminSkill {
  id: string;
  skillKey: string;
  title: string;
  description: string;
  icon?: string;
  category: string;
  tags: string[];
  visibility: string;
  ownerUserId?: string;
  roles: string[];
  order: number;
  input: SkillInputConfig;
  execution: SkillExecutionConfig;
  output: SkillOutputConfig;
  isEnabled: boolean;
  isBuiltIn: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCreateSkillRequest {
  skillKey?: string;
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  tags?: string[];
  roles?: string[];
  visibility?: string;
  order: number;
  isEnabled: boolean;
  isBuiltIn: boolean;
  input?: SkillInputConfig;
  execution?: SkillExecutionConfig;
  output?: SkillOutputConfig;
}

// ━━━ API Functions ━━━━━━━━

export async function listAdminSkills(visibility?: string) {
  const url = visibility
    ? `${api.skills.list()}?visibility=${encodeURIComponent(visibility)}`
    : api.skills.list();
  return apiRequest<{ skills: AdminSkill[] }>(url);
}

export async function getAdminSkill(skillKey: string) {
  return apiRequest<AdminSkill>(api.skills.byKey(skillKey));
}

export async function createAdminSkill(data: AdminCreateSkillRequest) {
  return apiRequest<{ skillKey: string }>(api.skills.list(), {
    method: 'POST',
    body: data,
  });
}

export async function updateAdminSkill(skillKey: string, data: AdminCreateSkillRequest) {
  return apiRequest<{ skillKey: string }>(api.skills.byKey(skillKey), {
    method: 'PUT',
    body: data,
  });
}

export async function deleteAdminSkill(skillKey: string) {
  return apiRequest<Record<string, never>>(api.skills.byKey(skillKey), {
    method: 'DELETE',
  });
}
