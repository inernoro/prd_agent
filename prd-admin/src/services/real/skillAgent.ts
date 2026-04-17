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
  /** 恢复用：阶段定义（用于前端渲染进度条） */
  stages?: SkillAgentStage[];
  /** 恢复用：是否已保存过至少一次（用于按钮文案切换） */
  hasSavedOnce?: boolean;
}

export interface SkillAgentSaveResponse {
  skillKey: string;
  title: string;
  message: string;
  /** 是否为更新路径（再次保存）；首次保存为 false */
  alreadySaved?: boolean;
}

export interface SkillAgentExportMdResponse {
  skillMd: string;
  fileName: string;
}

/** Personal skill item returned by list API */
export interface PersonalSkillItem {
  skillKey: string;
  title: string;
  description: string;
  icon?: string;
  category: string;
  tags: string[];
  visibility: string;
  isEnabled: boolean;
  isBuiltIn: boolean;
  usageCount: number;
  isPublic?: boolean;
  authorName?: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ━━━ Skill Agent Session APIs ━━━━━━━━

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

// ━━━ Personal Skills Management APIs ━━━━━━━━
// Uses existing PrdAgentSkillsController endpoints

const PERSONAL_SKILLS_BASE = '/api/prd-agent/skills';

export async function listPersonalSkills() {
  return apiRequest<PersonalSkillItem[]>(PERSONAL_SKILLS_BASE);
}

export async function deletePersonalSkill(skillKey: string) {
  return apiRequest<Record<string, never>>(`${PERSONAL_SKILLS_BASE}/${encodeURIComponent(skillKey)}`, {
    method: 'DELETE',
  });
}

export async function getSkillMd(skillKey: string) {
  return apiRequest<{ skillMd: string; skillKey: string }>(api.skillAgent.skillMd(skillKey));
}

/**
 * 按 skillKey 下载 zip 包的 URL（需 fetch + Authorization header）。
 * 同端点服务于「我的技能」owner 下载 + 「技能广场」已发布技能下载，后端统一做访问规则校验。
 */
export function getSkillZipUrl(skillKey: string) {
  return api.skillAgent.exportSkillZip(skillKey);
}

/** 未保存的草稿会话摘要（用于"我的技能"Tab 顶部的草稿列表） */
export interface SkillAgentDraftSummary {
  sessionId: string;
  title?: string;
  icon?: string;
  intentSummary?: string;
  currentStage: string;
  stageLabel: string;
  stageIndex: number;
  messagesCount: number;
  createdAt: string;
  lastActiveAt: string;
}

export async function listSkillAgentDrafts() {
  return apiRequest<{ drafts: SkillAgentDraftSummary[] }>(api.skillAgent.drafts());
}

export async function updateSkillFromMd(skillKey: string, skillMd: string) {
  return apiRequest<{ skillKey: string; title: string }>(api.skillAgent.skillMd(skillKey), {
    method: 'PUT',
    body: { skillMd },
  });
}

// ━━━ Skill Plaza APIs ━━━━━━━━

export interface PlazaSkillItem {
  skillKey: string;
  title: string;
  description: string;
  icon?: string;
  category: string;
  tags: string[];
  usageCount: number;
  authorName?: string;
  authorAvatar?: string;
  publishedAt?: string;
  isPublic: boolean;
  ownerUserId?: string;
}

export async function listPlazaSkills(params?: { category?: string; search?: string; page?: number }) {
  const qs = new URLSearchParams();
  if (params?.category && params.category !== 'all') qs.set('category', params.category);
  if (params?.search) qs.set('search', params.search);
  if (params?.page) qs.set('page', String(params.page));
  const url = `${api.skillAgent.plaza()}${qs.toString() ? '?' + qs.toString() : ''}`;
  return apiRequest<{ items: PlazaSkillItem[]; total: number; page: number; pageSize: number }>(url);
}

export async function publishSkill(skillKey: string) {
  return apiRequest<{ skillKey: string; published: boolean }>(api.skillAgent.publish(skillKey), { method: 'POST' });
}

export async function unpublishSkill(skillKey: string) {
  return apiRequest<{ skillKey: string; published: boolean }>(api.skillAgent.unpublish(skillKey), { method: 'POST' });
}
