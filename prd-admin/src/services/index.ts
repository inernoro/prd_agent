// 默认走真实后端；需要离线演示/开发时可通过 VITE_USE_MOCK=true 切到 mock 实现

import type { LoginContract } from '@/services/contracts/auth';
import type {
  GetUsersContract,
  GenerateInviteCodesContract,
  UpdateUserPasswordContract,
  UpdateUserRoleContract,
  UpdateUserStatusContract,
} from '@/services/contracts/adminUsers';
import type { GetActiveGroupsContract, GetGapStatsContract, GetMessageTrendContract, GetOverviewStatsContract, GetTokenUsageContract } from '@/services/contracts/adminStats';
import type { CreatePlatformContract, DeletePlatformContract, GetPlatformsContract, UpdatePlatformContract } from '@/services/contracts/platforms';
import type { ClearImageGenModelContract, ClearIntentModelContract, ClearVisionModelContract, CreateModelContract, DeleteModelContract, GetModelsContract, SetImageGenModelContract, SetIntentModelContract, SetMainModelContract, SetVisionModelContract, TestModelContract, UpdateModelContract } from '@/services/contracts/models';
import type { ActivateLLMConfigContract, CreateLLMConfigContract, DeleteLLMConfigContract, GetLLMConfigsContract, UpdateLLMConfigContract } from '@/services/contracts/llmConfigs';
import type { GetLlmLogDetailContract, GetLlmLogsContract, GetLlmLogsMetaContract } from '@/services/contracts/llmLogs';
import type { AdminImpersonateContract } from '@/services/contracts/lab';
import type {
  CreateModelLabExperimentContract,
  DeleteModelLabExperimentContract,
  GetModelLabExperimentContract,
  ListModelLabExperimentsContract,
  ListModelLabModelSetsContract,
  RunModelLabStreamContract,
  UpdateModelLabExperimentContract,
  UpsertModelLabModelSetContract,
} from '@/services/contracts/modelLab';
import type { DeleteModelLabGroupContract, ListModelLabGroupsContract, UpsertModelLabGroupContract } from '@/services/contracts/modelLabGroups';
import type {
  DeleteAdminGroupContract,
  GenerateAdminGapSummaryContract,
  GetAdminGroupGapsContract,
  GetAdminGroupMembersContract,
  GetAdminGroupMessagesContract,
  GetAdminGroupsContract,
  RegenerateAdminGroupInviteContract,
  RemoveAdminGroupMemberContract,
  UpdateAdminGapStatusContract,
  UpdateAdminGroupContract,
} from '@/services/contracts/adminGroups';
import { useAuthStore } from '@/stores/authStore';
import { fail, type ApiResponse } from '@/types/api';

import { loginMock } from '@/services/mock/impl/auth';
import { getUsersMock, generateInviteCodesMock, updateUserPasswordMock, updateUserRoleMock, updateUserStatusMock } from '@/services/mock/impl/adminUsers';
import { getActiveGroupsMock, getGapStatsMock, getMessageTrendMock, getOverviewStatsMock, getTokenUsageMock } from '@/services/mock/impl/adminStats';
import {
  deleteAdminGroupMock,
  generateAdminGapSummaryMock,
  getAdminGroupGapsMock,
  getAdminGroupMembersMock,
  getAdminGroupMessagesMock,
  getAdminGroupsMock,
  regenerateAdminGroupInviteMock,
  removeAdminGroupMemberMock,
  updateAdminGapStatusMock,
  updateAdminGroupMock,
} from '@/services/mock/impl/adminGroups';
import { createPlatformMock, deletePlatformMock, getPlatformsMock, updatePlatformMock } from '@/services/mock/impl/platforms';
import { clearImageGenModelMock, clearIntentModelMock, clearVisionModelMock, createModelMock, deleteModelMock, getModelsMock, setImageGenModelMock, setIntentModelMock, setMainModelMock, setVisionModelMock, testModelMock, updateModelMock } from '@/services/mock/impl/models';
import { activateLLMConfigMock, createLLMConfigMock, deleteLLMConfigMock, getLLMConfigsMock, updateLLMConfigMock } from '@/services/mock/impl/llmConfigs';
import { getLlmLogDetailMock, getLlmLogsMetaMock, getLlmLogsMock } from '@/services/mock/impl/llmLogs';
import { adminImpersonateMock } from '@/services/mock/impl/lab';
import {
  createModelLabExperimentMock,
  deleteModelLabExperimentMock,
  getModelLabExperimentMock,
  listModelLabExperimentsMock,
  listModelLabModelSetsMock,
  runModelLabStreamMock,
  updateModelLabExperimentMock,
  upsertModelLabModelSetMock,
} from '@/services/mock/impl/modelLab';
import { deleteModelLabGroupMock, listModelLabGroupsMock, upsertModelLabGroupMock } from '@/services/mock/impl/modelLabGroups';

import { loginReal } from '@/services/real/auth';
import { getUsersReal, generateInviteCodesReal, updateUserPasswordReal, updateUserRoleReal, updateUserStatusReal } from '@/services/real/adminUsers';
import { getActiveGroupsReal, getGapStatsReal, getMessageTrendReal, getOverviewStatsReal, getTokenUsageReal } from '@/services/real/adminStats';
import { createPlatformReal, deletePlatformReal, getPlatformsReal, updatePlatformReal } from '@/services/real/platforms';
import { clearImageGenModelReal, clearIntentModelReal, clearVisionModelReal, createModelReal, deleteModelReal, getModelsReal, setImageGenModelReal, setIntentModelReal, setMainModelReal, setVisionModelReal, testModelReal, updateModelReal } from '@/services/real/models';
import { activateLLMConfigReal, createLLMConfigReal, deleteLLMConfigReal, getLLMConfigsReal, updateLLMConfigReal } from '@/services/real/llmConfigs';
import { getLlmLogDetailReal, getLlmLogsMetaReal, getLlmLogsReal } from '@/services/real/llmLogs';
import { adminImpersonateReal } from '@/services/real/lab';
import {
  createModelLabExperimentReal,
  deleteModelLabExperimentReal,
  getModelLabExperimentReal,
  listModelLabExperimentsReal,
  listModelLabModelSetsReal,
  runModelLabStreamReal,
  updateModelLabExperimentReal,
  upsertModelLabModelSetReal,
} from '@/services/real/modelLab';
import { deleteModelLabGroupReal, listModelLabGroupsReal, upsertModelLabGroupReal } from '@/services/real/modelLabGroups';
import {
  deleteAdminGroupReal,
  generateAdminGapSummaryReal,
  getAdminGroupGapsReal,
  getAdminGroupMembersReal,
  getAdminGroupMessagesReal,
  getAdminGroupsReal,
  regenerateAdminGroupInviteReal,
  removeAdminGroupMemberReal,
  updateAdminGapStatusReal,
  updateAdminGroupReal,
} from '@/services/real/adminGroups';

function withAuth<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<ApiResponse<TResult>>
) {
  return async (...args: TArgs): Promise<ApiResponse<TResult>> => {
    const token = useAuthStore.getState().token;
    if (!token) return fail('UNAUTHORIZED', '未登录');
    return await fn(...args);
  };
}

const useMock = ['1', 'true', 'yes'].includes(((import.meta.env.VITE_USE_MOCK as string | undefined) ?? '').toLowerCase());

export const isMockMode = useMock;

export const login: LoginContract = useMock ? loginMock : loginReal;

export const getUsers: GetUsersContract = withAuth(useMock ? getUsersMock : getUsersReal);
export const updateUserRole: UpdateUserRoleContract = withAuth(useMock ? updateUserRoleMock : updateUserRoleReal);
export const updateUserStatus: UpdateUserStatusContract = withAuth(useMock ? updateUserStatusMock : updateUserStatusReal);
export const updateUserPassword: UpdateUserPasswordContract = withAuth(useMock ? updateUserPasswordMock : updateUserPasswordReal);
export const generateInviteCodes: GenerateInviteCodesContract = withAuth(useMock ? generateInviteCodesMock : generateInviteCodesReal);

export const getOverviewStats: GetOverviewStatsContract = withAuth(useMock ? getOverviewStatsMock : getOverviewStatsReal);
export const getTokenUsage: GetTokenUsageContract = withAuth(useMock ? getTokenUsageMock : getTokenUsageReal);
export const getMessageTrend: GetMessageTrendContract = withAuth(useMock ? getMessageTrendMock : getMessageTrendReal);
export const getActiveGroups: GetActiveGroupsContract = withAuth(useMock ? getActiveGroupsMock : getActiveGroupsReal);
export const getGapStats: GetGapStatsContract = withAuth(useMock ? getGapStatsMock : getGapStatsReal);

export const getAdminGroups: GetAdminGroupsContract = withAuth(useMock ? getAdminGroupsMock : getAdminGroupsReal);
export const getAdminGroupMembers: GetAdminGroupMembersContract = withAuth(useMock ? getAdminGroupMembersMock : getAdminGroupMembersReal);
export const removeAdminGroupMember: RemoveAdminGroupMemberContract = withAuth(useMock ? removeAdminGroupMemberMock : removeAdminGroupMemberReal);
export const regenerateAdminGroupInvite: RegenerateAdminGroupInviteContract = withAuth(useMock ? regenerateAdminGroupInviteMock : regenerateAdminGroupInviteReal);
export const updateAdminGroup: UpdateAdminGroupContract = withAuth(useMock ? updateAdminGroupMock : updateAdminGroupReal);
export const deleteAdminGroup: DeleteAdminGroupContract = withAuth(useMock ? deleteAdminGroupMock : deleteAdminGroupReal);

// gaps 复用用户侧接口（/api/v1/groups/{groupId}/gaps），由后端做权限控制；后台仅聚合展示+状态变更
export const getAdminGroupGaps: GetAdminGroupGapsContract = withAuth(useMock ? getAdminGroupGapsMock : getAdminGroupGapsReal);
export const updateAdminGapStatus: UpdateAdminGapStatusContract = withAuth(useMock ? updateAdminGapStatusMock : updateAdminGapStatusReal);
export const generateAdminGapSummary: GenerateAdminGapSummaryContract = withAuth(useMock ? generateAdminGapSummaryMock : generateAdminGapSummaryReal);

export const getAdminGroupMessages: GetAdminGroupMessagesContract = withAuth(useMock ? getAdminGroupMessagesMock : getAdminGroupMessagesReal);

export const getPlatforms: GetPlatformsContract = withAuth(useMock ? getPlatformsMock : getPlatformsReal);
export const createPlatform: CreatePlatformContract = withAuth(useMock ? createPlatformMock : createPlatformReal);
export const updatePlatform: UpdatePlatformContract = withAuth(useMock ? updatePlatformMock : updatePlatformReal);
export const deletePlatform: DeletePlatformContract = withAuth(useMock ? deletePlatformMock : deletePlatformReal);

export const getModels: GetModelsContract = withAuth(useMock ? getModelsMock : getModelsReal);
export const createModel: CreateModelContract = withAuth(useMock ? createModelMock : createModelReal);
export const updateModel: UpdateModelContract = withAuth(useMock ? updateModelMock : updateModelReal);
export const deleteModel: DeleteModelContract = withAuth(useMock ? deleteModelMock : deleteModelReal);
export const testModel: TestModelContract = withAuth(useMock ? testModelMock : testModelReal);
export const setMainModel: SetMainModelContract = withAuth(useMock ? setMainModelMock : setMainModelReal);
export const setIntentModel: SetIntentModelContract = withAuth(useMock ? setIntentModelMock : setIntentModelReal);
export const clearIntentModel: ClearIntentModelContract = withAuth(useMock ? clearIntentModelMock : clearIntentModelReal);
export const setVisionModel: SetVisionModelContract = withAuth(useMock ? setVisionModelMock : setVisionModelReal);
export const clearVisionModel: ClearVisionModelContract = withAuth(useMock ? clearVisionModelMock : clearVisionModelReal);
export const setImageGenModel: SetImageGenModelContract = withAuth(useMock ? setImageGenModelMock : setImageGenModelReal);
export const clearImageGenModel: ClearImageGenModelContract = withAuth(useMock ? clearImageGenModelMock : clearImageGenModelReal);

export const getLLMConfigs: GetLLMConfigsContract = withAuth(useMock ? getLLMConfigsMock : getLLMConfigsReal);
export const createLLMConfig: CreateLLMConfigContract = withAuth(useMock ? createLLMConfigMock : createLLMConfigReal);
export const updateLLMConfig: UpdateLLMConfigContract = withAuth(useMock ? updateLLMConfigMock : updateLLMConfigReal);
export const deleteLLMConfig: DeleteLLMConfigContract = withAuth(useMock ? deleteLLMConfigMock : deleteLLMConfigReal);
export const activateLLMConfig: ActivateLLMConfigContract = withAuth(useMock ? activateLLMConfigMock : activateLLMConfigReal);

export const getLlmLogs: GetLlmLogsContract = withAuth(useMock ? getLlmLogsMock : getLlmLogsReal);
export const getLlmLogDetail: GetLlmLogDetailContract = withAuth(useMock ? getLlmLogDetailMock : getLlmLogDetailReal);
export const getLlmLogsMeta: GetLlmLogsMetaContract = withAuth(useMock ? getLlmLogsMetaMock : getLlmLogsMetaReal);

export const adminImpersonate: AdminImpersonateContract = withAuth(useMock ? adminImpersonateMock : adminImpersonateReal);

export const listModelLabExperiments: ListModelLabExperimentsContract = withAuth(useMock ? listModelLabExperimentsMock : listModelLabExperimentsReal);
export const createModelLabExperiment: CreateModelLabExperimentContract = withAuth(useMock ? createModelLabExperimentMock : createModelLabExperimentReal);
export const getModelLabExperiment: GetModelLabExperimentContract = withAuth(useMock ? getModelLabExperimentMock : getModelLabExperimentReal);
export const updateModelLabExperiment: UpdateModelLabExperimentContract = withAuth(useMock ? updateModelLabExperimentMock : updateModelLabExperimentReal);
export const deleteModelLabExperiment: DeleteModelLabExperimentContract = withAuth(useMock ? deleteModelLabExperimentMock : deleteModelLabExperimentReal);
export const listModelLabModelSets: ListModelLabModelSetsContract = withAuth(useMock ? listModelLabModelSetsMock : listModelLabModelSetsReal);
export const upsertModelLabModelSet: UpsertModelLabModelSetContract = withAuth(useMock ? upsertModelLabModelSetMock : upsertModelLabModelSetReal);
export const runModelLabStream: RunModelLabStreamContract = withAuth(useMock ? runModelLabStreamMock : runModelLabStreamReal);

export const listModelLabGroups: ListModelLabGroupsContract = withAuth(useMock ? listModelLabGroupsMock : listModelLabGroupsReal);
export const upsertModelLabGroup: UpsertModelLabGroupContract = withAuth(useMock ? upsertModelLabGroupMock : upsertModelLabGroupReal);
export const deleteModelLabGroup: DeleteModelLabGroupContract = withAuth(useMock ? deleteModelLabGroupMock : deleteModelLabGroupReal);
