import type { ApiResponse } from '@/types/api';

export type SkillClientItem = {
  id: string;
  title: string;
  description: string;
  icon?: string | null;
  category: string;
  order: number;
  isBuiltIn: boolean;
  allowedRoles: string[];
  systemPromptTemplate?: string | null;
  userPromptTemplate?: string | null;
};

export type SkillsListData = {
  skills: SkillClientItem[];
};

export type CreateSkillInput = {
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  order?: number;
  systemPromptTemplate?: string;
  userPromptTemplate?: string;
  allowedRoles?: string[];
};

export type UpdateSkillInput = CreateSkillInput;

export type GetSkillsContract = (role?: string) => Promise<ApiResponse<SkillsListData>>;
export type GetSkillContract = (skillId: string) => Promise<ApiResponse<SkillClientItem>>;
export type CreateSkillContract = (input: CreateSkillInput) => Promise<ApiResponse<SkillClientItem>>;
export type UpdateSkillContract = (skillId: string, input: UpdateSkillInput) => Promise<ApiResponse<SkillClientItem>>;
export type DeleteSkillContract = (skillId: string) => Promise<ApiResponse<object>>;
