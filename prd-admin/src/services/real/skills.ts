import type {
  SkillsListData,
  SkillClientItem,
  GetSkillsContract,
  GetSkillContract,
  CreateSkillContract,
  UpdateSkillContract,
  DeleteSkillContract,
  CreateSkillInput,
  UpdateSkillInput,
} from '@/services/contracts/skills';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

export const getSkillsReal: GetSkillsContract = async (role?: string) => {
  const q = role ? `?role=${encodeURIComponent(role)}` : '';
  return await apiRequest<SkillsListData>(`${api.skills.list()}${q}`);
};

export const getSkillReal: GetSkillContract = async (skillId: string) => {
  return await apiRequest<SkillClientItem>(api.skills.detail(skillId));
};

export const createSkillReal: CreateSkillContract = async (input: CreateSkillInput) => {
  return await apiRequest<SkillClientItem>(api.skills.list(), {
    method: 'POST',
    body: input,
  });
};

export const updateSkillReal: UpdateSkillContract = async (skillId: string, input: UpdateSkillInput) => {
  return await apiRequest<SkillClientItem>(api.skills.detail(skillId), {
    method: 'PUT',
    body: input,
  });
};

export const deleteSkillReal: DeleteSkillContract = async (skillId: string) => {
  return await apiRequest<object>(api.skills.detail(skillId), {
    method: 'DELETE',
  });
};
