import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';

/**
 * 「我的风格」（后端 PersonalDesignStylesController）。
 * 只属于当前登录用户：别人的编号与不存在的一样返回 404。生成时把 styleId（personal:<id>）交给
 * createDesignArtifactRun，服务端按编号 + 当前用户取出风格正文——前端从不把风格正文当生成参数传。
 */

/** 可被标成「系统填写」的字段。 */
export type PersonalStyleField = 'name' | 'instruction' | 'swatches' | 'fonts' | 'baseDesignSystemId';

export interface PersonalStyle {
  id: string;
  /** 生成请求里用的编号：personal:<id>。 */
  styleId: string;
  name: string;
  instruction: string;
  /** [正文, 底色, 强调色]，#rrggbb；按描述建的风格可能为空。 */
  swatches: string[];
  fonts: string[];
  baseDesignSystemId: string;
  baseDesignSystemName: string | null;
  /** 骨架还在不在当前风格目录里；不在时生成会被拒，需要编辑换一个。 */
  baseDesignSystemAvailable: boolean;
  sourceSiteId: string | null;
  sourceSiteTitle: string | null;
  sourceNote: string | null;
  systemFilledFields: PersonalStyleField[];
  createdAt: string;
  updatedAt: string;
}

export interface PersonalStyleTrait {
  key: string;
  label: string;
  value: string;
}

/** 提取出来的草稿：审阅、可改，保存时才落库。 */
export interface PersonalStyleDraft {
  name: string;
  instruction: string;
  swatches: string[];
  fonts: string[];
  baseDesignSystemId: string;
  baseDesignSystemName: string;
  /** 系统为什么挑这个骨架（按配色就近 / 按描述匹配 / 默认）。 */
  baseReason: string;
  traits: PersonalStyleTrait[];
  /** 读了什么：几段样式、几个文件、多少条声明。 */
  evidence: string;
  sourceSiteId: string | null;
  sourceSiteTitle: string | null;
  sourceNote: string | null;
  systemFilledFields: PersonalStyleField[];
}

export interface PersonalStyleInput {
  name?: string;
  instruction?: string;
  swatches?: string[];
  fonts?: string[];
  baseDesignSystemId?: string;
  sourceSiteId?: string | null;
  sourceSiteTitle?: string | null;
  sourceNote?: string | null;
  systemFilledFields?: PersonalStyleField[];
}

export async function listPersonalStyles(): Promise<ApiResponse<{ items: PersonalStyle[]; limit: number }>> {
  return apiRequest(api.designArtifacts.personalStyles());
}

/** 从自己的一张网页和/或一段描述里提取风格草稿（确定性解析，不调模型）。apiRequest 自己序列化 body。 */
export async function derivePersonalStyle(input: { siteId?: string | null; note?: string | null }): Promise<ApiResponse<PersonalStyleDraft>> {
  return apiRequest(api.designArtifacts.personalStyleDerive(), {
    method: 'POST',
    body: { siteId: input.siteId || null, note: input.note?.trim() || null },
  });
}

export async function createPersonalStyle(input: PersonalStyleInput): Promise<ApiResponse<PersonalStyle>> {
  return apiRequest(api.designArtifacts.personalStyles(), { method: 'POST', body: input });
}

/** 部分修改：只提交改过的字段。 */
export async function updatePersonalStyle(id: string, input: PersonalStyleInput): Promise<ApiResponse<PersonalStyle>> {
  return apiRequest(api.designArtifacts.personalStyle(id), { method: 'PUT', body: input });
}

export async function deletePersonalStyle(id: string): Promise<ApiResponse<{ id: string; deleted: boolean }>> {
  return apiRequest(api.designArtifacts.personalStyle(id), { method: 'DELETE' });
}
