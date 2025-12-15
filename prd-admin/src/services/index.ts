// 运行期默认 mock（本次需求不连后端）

import type { LoginContract } from '@/services/contracts/auth';
import type { GetUsersContract, GenerateInviteCodesContract, UpdateUserRoleContract, UpdateUserStatusContract } from '@/services/contracts/adminUsers';
import type { GetActiveGroupsContract, GetGapStatsContract, GetMessageTrendContract, GetOverviewStatsContract, GetTokenUsageContract } from '@/services/contracts/adminStats';
import type { CreatePlatformContract, DeletePlatformContract, GetPlatformsContract, UpdatePlatformContract } from '@/services/contracts/platforms';
import type { CreateModelContract, DeleteModelContract, GetModelsContract, SetMainModelContract, TestModelContract, UpdateModelContract } from '@/services/contracts/models';
import type { ActivateLLMConfigContract, CreateLLMConfigContract, DeleteLLMConfigContract, GetLLMConfigsContract, UpdateLLMConfigContract } from '@/services/contracts/llmConfigs';
import { useAuthStore } from '@/stores/authStore';
import { fail, type ApiResponse } from '@/types/api';

import { loginMock } from '@/services/mock/impl/auth';
import { getUsersMock, generateInviteCodesMock, updateUserRoleMock, updateUserStatusMock } from '@/services/mock/impl/adminUsers';
import { getActiveGroupsMock, getGapStatsMock, getMessageTrendMock, getOverviewStatsMock, getTokenUsageMock } from '@/services/mock/impl/adminStats';
import { createPlatformMock, deletePlatformMock, getPlatformsMock, updatePlatformMock } from '@/services/mock/impl/platforms';
import { createModelMock, deleteModelMock, getModelsMock, setMainModelMock, testModelMock, updateModelMock } from '@/services/mock/impl/models';
import { activateLLMConfigMock, createLLMConfigMock, deleteLLMConfigMock, getLLMConfigsMock, updateLLMConfigMock } from '@/services/mock/impl/llmConfigs';

function withAuth<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<ApiResponse<TResult>>
) {
  return async (...args: TArgs): Promise<ApiResponse<TResult>> => {
    const token = useAuthStore.getState().token;
    if (!token) return fail('UNAUTHORIZED', '未登录');
    return await fn(...args);
  };
}

export const login: LoginContract = loginMock;

export const getUsers: GetUsersContract = withAuth(getUsersMock);
export const updateUserRole: UpdateUserRoleContract = withAuth(updateUserRoleMock);
export const updateUserStatus: UpdateUserStatusContract = withAuth(updateUserStatusMock);
export const generateInviteCodes: GenerateInviteCodesContract = withAuth(generateInviteCodesMock);

export const getOverviewStats: GetOverviewStatsContract = withAuth(getOverviewStatsMock);
export const getTokenUsage: GetTokenUsageContract = withAuth(getTokenUsageMock);
export const getMessageTrend: GetMessageTrendContract = withAuth(getMessageTrendMock);
export const getActiveGroups: GetActiveGroupsContract = withAuth(getActiveGroupsMock);
export const getGapStats: GetGapStatsContract = withAuth(getGapStatsMock);

export const getPlatforms: GetPlatformsContract = withAuth(getPlatformsMock);
export const createPlatform: CreatePlatformContract = withAuth(createPlatformMock);
export const updatePlatform: UpdatePlatformContract = withAuth(updatePlatformMock);
export const deletePlatform: DeletePlatformContract = withAuth(deletePlatformMock);

export const getModels: GetModelsContract = withAuth(getModelsMock);
export const createModel: CreateModelContract = withAuth(createModelMock);
export const updateModel: UpdateModelContract = withAuth(updateModelMock);
export const deleteModel: DeleteModelContract = withAuth(deleteModelMock);
export const testModel: TestModelContract = withAuth(testModelMock);
export const setMainModel: SetMainModelContract = withAuth(setMainModelMock);

export const getLLMConfigs: GetLLMConfigsContract = withAuth(getLLMConfigsMock);
export const createLLMConfig: CreateLLMConfigContract = withAuth(createLLMConfigMock);
export const updateLLMConfig: UpdateLLMConfigContract = withAuth(updateLLMConfigMock);
export const deleteLLMConfig: DeleteLLMConfigContract = withAuth(deleteLLMConfigMock);
export const activateLLMConfig: ActivateLLMConfigContract = withAuth(activateLLMConfigMock);
